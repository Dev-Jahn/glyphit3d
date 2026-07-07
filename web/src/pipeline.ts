import type { Atlas, Grid, GridCell } from '../../src/core/types.js';
import { gridRows } from '../../src/core/options.js';
import { imageDataToLinear } from './browser-image.js';
import type { Scene } from './scene.js';
import type { BandResult, ErrorResult, MatchBandRequest, SetAtlasRequest, SsimRequest, SsimResult } from './worker.js';

// 3D scenes have no intrinsic pixel aspect; render a near-square footprint and let
// the matcher pick rows from it (gridRows corrects for the non-square glyph cell).
const SCENE_ASPECT = 1;

export interface PipelineParams {
  cols: number;
  quality: 0 | 1 | 2 | 3 | 4;
  space: 'linear' | 'gamma';
  charset: string;
}

export interface Timings { resample: number; match: number; raster: number; ssim: number }
export interface PipelineOutput {
  grid: Grid;
  raster: { w: number; h: number; data: Uint8ClampedArray };
  ssim: number | null; // P1: null on interactive runs (SSIM skipped)
  timings: Timings & { render: number };
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

  // Render the scene to the grid footprint, linearize, band-match, assemble, and (on
  // non-interactive runs) score. `interactive` skips the SSIM round-trip (P1).
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
    };
  }
}
