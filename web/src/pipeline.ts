import type { Atlas, Grid, GridCell, LinearImage } from '../../src/core/types.js';
import { gridRows, defaultOptions } from '../../src/core/options.js';
import { rasterizeGrid } from '../../src/render/raster.js';
import { linearToSrgb } from '../../src/core/color.js';
import { imageDataToLinear } from './browser-image.js';
import { GpuMatcher } from './webgpu/gpu-matcher.js';
import type { Scene } from './scene.js';
import type { BandResult, ErrorResult, MatchBandRequest, SetAtlasRequest, SsimRequest, SsimResult } from './worker.js';

// LinearImage → sRGB u8 RGBA for the canvas (mirrors worker.ts toRGBA; used by the GPU
// path, which rasterizes on the main thread instead of in a band worker).
function toRGBA(img: LinearImage): Uint8ClampedArray {
  const n = img.w * img.h;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = Math.round(linearToSrgb(img.data[i * 3]!));
    out[i * 4 + 1] = Math.round(linearToSrgb(img.data[i * 3 + 1]!));
    out[i * 4 + 2] = Math.round(linearToSrgb(img.data[i * 3 + 2]!));
    out[i * 4 + 3] = 255;
  }
  return out;
}

// 3D scenes have no intrinsic pixel aspect; render a near-square footprint and let
// the matcher pick rows from it (gridRows corrects for the non-square glyph cell).
const SCENE_ASPECT = 1;

export interface PipelineParams {
  cols: number;
  quality: 0 | 1 | 2 | 3 | 4;
  space: 'linear' | 'gamma';
  charset: string;
  contrastFloor?: number; // Round A ASCII-identity dark-path floor (0/absent = off). Threaded to BOTH paths: the GPU matcher applies it as a host per-cell post-pass, the CPU pool inside matchGrid.
}

export interface Timings { resample: number; match: number; raster: number; ssim: number }
export interface PipelineOutput {
  grid: Grid;
  raster: { w: number; h: number; data: Uint8ClampedArray };
  ssim: number | null; // P1: null on interactive runs (SSIM skipped)
  timings: Timings & { render: number };
  matcher: 'gpu' | 'pool'; // which path produced this run (WebGPU Q3 matcher vs the CPU pool)
}

type WorkerResponse = BandResult | SsimResult | ErrorResult;

// Worker pool (Round P / P2). matchGrid+rasterizeGrid are sharded across a fixed pool
// by contiguous cell-row bands; each run uses N = min(pool, rows) of them. Band pixel
// slices are COPIED then TRANSFERRED (never a full-frame structured clone per worker).
// Grid cells + raster bands are assembled by band index on the main thread; a
// non-interactive run then computes SSIM once over the assembled raster+ref (one worker)
// before resolving, so busy/e2e semantics are unchanged. Any worker error rejects the run.
export class Pipeline {
  private readonly workers: Worker[];
  private readonly poolSize: number;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }>();
  // WebGPU Q3 matcher (perf/webgpu-matcher). Resolves to null when WebGPU is unavailable
  // (non-secure origin / unsupported browser) → every run uses the CPU pool. Init is kicked
  // off in the constructor and awaited per run; the promise is already settled by then.
  private readonly gpuReady: Promise<GpuMatcher | null> = GpuMatcher.create().catch(() => null);
  // Q3 web-path defaults (gateTau/mdlLambda) the GPU matcher must use to match matchGrid.
  private readonly q3opts = defaultOptions(3);

  constructor() {
    // N = min(hardwareConcurrency − 1, 8, rows); the rows cap is applied per run.
    this.poolSize = Math.max(1, Math.min((navigator.hardwareConcurrency || 2) - 1, 8));
    this.workers = [];
    for (let i = 0; i < this.poolSize; i++) {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const r = e.data;
        const p = this.pending.get(r.id);
        if (!p) return;
        this.pending.delete(r.id);
        if (r.type === 'error') p.reject(new Error(r.message));
        else p.resolve(r);
      };
      // A hard worker failure must reject the run — fail every in-flight request so no
      // partial grid is ever assembled.
      w.onerror = (ev) => {
        const err = new Error(`worker crashed: ${ev.message}`);
        for (const [id, p] of this.pending) { this.pending.delete(id); p.reject(err); }
      };
      this.workers.push(w);
    }
  }

  // Broadcast once per (charset, worker). main.ts only calls this on a charset change.
  setAtlas(charset: string, atlas: Atlas): void {
    for (const w of this.workers) w.postMessage({ type: 'setAtlas', charset, atlas } satisfies SetAtlasRequest);
  }

  private request<T extends WorkerResponse>(worker: Worker, msg: MatchBandRequest | SsimRequest, transfer: Transferable[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(msg.id, { resolve: resolve as (r: WorkerResponse) => void, reject });
      worker.postMessage(msg, transfer);
    });
  }

  // Render the scene to the grid footprint, linearize, then match on the GPU (Q3 default
  // web path, secure-context WebGPU) or the CPU pool (everything else / WebGPU absent),
  // assemble, and (on non-interactive runs) score. `interactive` skips the SSIM round-trip.
  async run(scene: Scene, atlas: Atlas, params: PipelineParams, interactive: boolean): Promise<PipelineOutput> {
    const { cellW, cellH } = atlas;
    const gridW = params.cols * cellW;
    const rows = gridRows(params.cols, SCENE_ASPECT, 1, cellW, cellH);
    const gridH = rows * cellH;

    const tRender = performance.now();
    const imgData = scene.renderToImageData(gridW, gridH);
    const render = performance.now() - tRender;

    // grid-footprint linear reference (w×h == gridW×gridH — the render already matches it,
    // so no resample is needed and this stays the SSIM reference).
    const tPrep = performance.now();
    const lin = imageDataToLinear(imgData);

    // Route: Q3 default web path on a WebGPU-capable secure context → GPU matcher (a
    // capability boundary, not a masking fallback). Q0/Q1/Q2 and any WebGPU-absent context
    // → CPU pool. A mid-session GPU failure (device lost) falls back to the pool for that run.
    // The contrast floor is NOT a routing condition: the GPU matcher applies it as a host
    // per-cell post-pass (gpu-matcher.ts → contrast-floor-post.ts), byte-identical to the CPU
    // floored path, so the floored default demo path stays on the GPU matcher.
    const gpu = await this.gpuReady;
    if (gpu && gpu.available && params.quality === 3) {
      try {
        return await this.runGpu(gpu, lin, atlas, params, interactive, render, tPrep, rows);
      } catch (e) {
        console.warn('gpu matcher failed; falling back to CPU pool', e);
      }
    }
    return this.runPool(lin, atlas, params, interactive, render, tPrep, rows);
  }

  // GPU Q3 path: match on the GPU (async — main thread stays live), rasterize on the main
  // thread (reuse the CPU rasterizer), and score SSIM on the pool (as today). timings.match
  // is the GPU dispatch→readback wall-clock so e2e check 7 stays meaningful.
  private async runGpu(
    gpu: GpuMatcher, lin: LinearImage, atlas: Atlas, params: PipelineParams,
    interactive: boolean, render: number, tPrep: number, rows: number,
  ): Promise<PipelineOutput> {
    const { cellW, cellH } = atlas;
    const w = lin.w, h = lin.h;
    const res = await gpu.match(
      lin, atlas,
      { quality: 3, space: params.space, gateTau: this.q3opts.gateTau, mdlLambda: this.q3opts.mdlLambda, contrastFloor: params.contrastFloor },
      params.cols, rows,
    );
    // resample = main-thread prep (linearize + working-space transform + per-cell stats +
    // gate + upload) = wall-clock since tPrep, minus the GPU dispatch→readback slice.
    const resample = performance.now() - tPrep - res.matchMs;

    const grid: Grid = { cols: params.cols, rows, cells: res.cells, cellW, cellH, font: atlas.fontPath };

    // Rasterize in the fit space (Q3 always fits in `params.space`). Reuse the CPU rasterizer.
    const tR = performance.now();
    const out = rasterizeGrid(grid, atlas, params.space);
    const rgba = toRGBA(out);
    const raster = performance.now() - tR;

    let ssimVal: number | null = null;
    let ssimMs = 0;
    if (!interactive) {
      const tS = performance.now();
      const id = this.nextId++;
      const req: SsimRequest = { type: 'ssim', id, a: { w, h, data: out.data }, b: { w, h, data: lin.data } };
      const sr = await this.request<SsimResult>(this.workers[0]!, req, [out.data.buffer, lin.data.buffer]);
      ssimVal = sr.ssim;
      ssimMs = performance.now() - tS;
    }

    return {
      grid,
      raster: { w, h, data: rgba },
      ssim: ssimVal,
      timings: { render, resample, match: res.matchMs, raster, ssim: ssimMs },
      matcher: 'gpu',
    };
  }

  // CPU worker-pool path (unchanged Round P/P2 band matcher).
  private async runPool(
    lin: LinearImage, atlas: Atlas, params: PipelineParams,
    interactive: boolean, render: number, tPrep: number, rows: number,
  ): Promise<PipelineOutput> {
    const { cellW, cellH } = atlas;
    const w = lin.w, h = lin.h;
    const rowFloats = w * 3;

    const nBands = Math.max(1, Math.min(this.poolSize, rows));
    const baseRows = Math.floor(rows / nBands), extra = rows % nBands;
    const bandReqs: Promise<BandResult>[] = [];
    const layout: { r0: number; rows: number }[] = [];
    let r0 = 0;
    for (let b = 0; b < nBands; b++) {
      const br = baseRows + (b < extra ? 1 : 0);
      const pxStart = r0 * cellH * rowFloats;
      const pxLen = br * cellH * rowFloats;
      const slice = new Float32Array(pxLen);                       // per-band copy …
      slice.set(lin.data.subarray(pxStart, pxStart + pxLen));
      const id = this.nextId++;
      const req: MatchBandRequest = {
        type: 'matchBand', id, band: b, charset: params.charset,
        img: { w, h: br * cellH, data: slice }, cols: params.cols, quality: params.quality, space: params.space,
        contrastFloor: params.contrastFloor,
      };
      layout.push({ r0, rows: br });
      bandReqs.push(this.request<BandResult>(this.workers[b]!, req, [slice.buffer])); // … then transfer
      r0 += br;
    }
    const resample = performance.now() - tPrep; // main-thread prep (linearize + slice + dispatch)

    const results = await Promise.all(bandReqs);

    // assemble by band index (never arrival order). rasterLin is only needed for SSIM,
    // so its assembly is skipped on interactive runs.
    const cells: GridCell[] = new Array(params.cols * rows);
    const rgba = new Uint8ClampedArray(w * h * 4);
    const rasterLin = interactive ? null : new Float32Array(w * h * 3);
    let matchMax = 0, rasterMax = 0;
    for (const res of results) {
      const lay = layout[res.band]!;
      const cellOff = lay.r0 * params.cols;
      for (let i = 0; i < res.cells.length; i++) cells[cellOff + i] = res.cells[i]!;
      rgba.set(res.raster, lay.r0 * cellH * w * 4);
      if (rasterLin) rasterLin.set(res.rasterLin, lay.r0 * cellH * w * 3);
      if (res.timings.match > matchMax) matchMax = res.timings.match; // banded stage wall-clock
      if (res.timings.raster > rasterMax) rasterMax = res.timings.raster; // (critical path, not a per-band sum)
    }

    let ssimVal: number | null = null;
    let ssimMs = 0;
    if (!interactive && rasterLin) {
      const tS = performance.now();
      const id = this.nextId++;
      const req: SsimRequest = { type: 'ssim', id, a: { w, h, data: rasterLin }, b: { w, h, data: lin.data } };
      const sr = await this.request<SsimResult>(this.workers[0]!, req, [rasterLin.buffer, lin.data.buffer]);
      ssimVal = sr.ssim;
      ssimMs = performance.now() - tS;
    }

    const grid: Grid = { cols: params.cols, rows, cells, cellW, cellH, font: atlas.fontPath };
    return {
      grid,
      raster: { w, h, data: rgba },
      ssim: ssimVal,
      timings: { render, resample, match: matchMax, raster: rasterMax, ssim: ssimMs },
      matcher: 'pool',
    };
  }
}
