import type { Atlas, Grid, GridCell, LinearImage } from '../../src/core/types.js';
import { gridRows, defaultOptions } from '../../src/core/options.js';
import { imageDataToLinear } from './browser-image.js';
import { GpuMatcher } from './webgpu/gpu-matcher.js';
import { GpuRaster } from './webgpu/gpu-raster.js';
import type { PrepParams } from './webgpu/prep.js';
import type { Scene } from './scene.js';
import type {
  BandResult, ErrorResult, MatchBandRequest, PrepQ3Request, PrepResultMsg,
  RasterSsimRequest, SetAtlasRequest, SsimRequest, SsimResult,
} from './worker.js';

// 3D scenes have no intrinsic pixel aspect; render a near-square footprint and let
// the matcher pick rows from it (gridRows corrects for the non-square glyph cell).
const SCENE_ASPECT = 1;

// feat/temporal-animation (DESIGN §4.9, SPEC §4). Temporal rematch knobs threaded from main.ts's
// keyframe router. `epsilon`: working-space change-detector threshold (0 = exact delta). `delta`:
// hysteresis margin in eacScale units (0 = no hysteresis). `keyframe`: force a full recompute +
// temporal-state reset (first frame, any config change, model drop, device-lost, every
// non-interactive run — SPEC §4.4). Absent ⇒ today's stateless full rematch on both paths.
export interface TemporalParams { epsilon: number; delta: number; keyframe: boolean }

export interface PipelineParams {
  cols: number;
  quality: 0 | 1 | 2 | 3 | 4;
  space: 'linear' | 'gamma';
  charset: string;
  contrastFloor?: number; // Round A ASCII-identity dark-path floor (0/absent = off). Threaded to BOTH paths: the GPU matcher applies it as a host per-cell post-pass, the CPU pool inside matchGrid.
  temporal?: TemporalParams; // feat/temporal-animation: absent ⇒ full rematch (today's behavior).
}

export interface Timings { resample: number; match: number; raster: number; ssim: number }
export interface PipelineOutput {
  grid: Grid;
  raster: { w: number; h: number; data: Uint8ClampedArray };
  ssim: number | null; // P1: null on interactive runs (SSIM skipped)
  timings: Timings & { render: number; rasterGpuMs?: number };
  matcher: 'gpu' | 'pool'; // which path produced this run (WebGPU Q3 matcher vs the CPU pool)
  // feat/temporal-animation (SPEC §4.4 provenance): which temporal path emitted this frame. A
  // 'full' frame is byte-exact vs src/core/match.ts and is the ONLY provenance that may reach
  // exports / the SSIM badge (SPEC §5.3). 'delta'/'delta+hyst' are interactive-only reuse frames.
  temporal: 'full' | 'delta' | 'delta+hyst';
  // Optional changed/total cell counts for the perf readout on a delta frame (SPEC §6.2). Undefined
  // on a full frame; the temporal match path fills it once landed.
  temporalStats?: { changed: number; total: number };
}

type WorkerResponse = BandResult | SsimResult | PrepResultMsg | ErrorResult;
type WorkerRequestMsg = MatchBandRequest | SsimRequest | PrepQ3Request | RasterSsimRequest;

// Worker pool (Round P / P2). matchGrid+rasterizeGrid are sharded across a fixed pool
// by contiguous cell-row bands; each run uses N = min(pool, rows) of them. Band pixel
// slices are COPIED then TRANSFERRED (never a full-frame structured clone per worker).
// Grid cells + raster bands are assembled by band index on the main thread; a
// non-interactive run then computes SSIM once over the assembled raster+ref (one worker)
// before resolving, so busy/e2e semantics are unchanged. Any worker error rejects the run.
//
// perf/gpu-rasterizer (SPEC §4.5): the Q3 GPU path now keeps the main thread nearly idle —
// input prep (linearize + working transform + per-cell stats/gate/pack) is relocated to a pool
// worker (prepQ3), the match runs on the GPU (GpuMatcher), and the OUTPUT raster runs on the GPU
// too (GpuRaster). The main thread only renders the frame, uploads the prepped buffers, and
// commits the read-back RGBA — the two ~90ms synchronous blocks (prep + raster) are gone.
export class Pipeline {
  private readonly workers: Worker[];
  private readonly poolSize: number;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }>();
  // WebGPU Q3 matcher + raster (perf/webgpu-matcher, perf/gpu-rasterizer). Each resolves to null
  // when WebGPU is unavailable (non-secure origin / unsupported browser) → the run uses the CPU
  // pool. Both are kicked off in the constructor (pipeline compiled at construction so the first
  // rematch is not compile-bound — SPEC §9 cold-start) and awaited per run; already settled by then.
  private readonly gpuReady: Promise<GpuMatcher | null> = GpuMatcher.create().catch(() => null);
  private readonly gpuRasterReady: Promise<GpuRaster | null> = GpuRaster.create().catch(() => null);
  // Q3 web-path defaults (gateTau/mdlLambda) the GPU matcher must use to match matchGrid.
  private readonly q3opts = defaultOptions(3);
  // Ping-pong host-scratch for the prepQ3 worker hop (SPEC §4.3): the worker fills these
  // (targetHost 12MB + cstatHost 339KB) without allocating and transfers them back; we hand them
  // out again next run. Single-flight (main.ts coalescer) guarantees one prep in flight, so a
  // single spare pair suffices. Null before the first run / after a fallback.
  private prepSpare: { targetHost: Float32Array; cstatHost: Float32Array } | null = null;

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

  private request<T extends WorkerResponse>(worker: Worker, msg: WorkerRequestMsg, transfer: Transferable[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(msg.id, { resolve: resolve as (r: WorkerResponse) => void, reject });
      worker.postMessage(msg, transfer);
    });
  }

  // Render the scene to the grid footprint, then match on the GPU (Q3 default web path,
  // secure-context WebGPU) or the CPU pool (everything else / WebGPU absent), assemble, and (on
  // non-interactive runs) score. `interactive` skips the SSIM round-trip. The GPU path linearizes
  // in the prep worker (not here); only the pool path / fallback linearizes on the main thread.
  //
  // feat/temporal-animation SERIALIZATION DECISION (SPEC §4.4 / §2): NO Pipeline-level matcher
  // mutex is added. The spec's §2 race note ("__app.rematch() / drop-handler can overlap the
  // coalescing loop's in-flight run") predates the landed coalescer: main.ts now funnels EVERY
  // run() caller — orbit move/end, drop, initial render, and the __app.rematch surface — through
  // ONE createCoalescer single-flight (main.ts F1R-1), which guarantees at most one run() is ever
  // in flight. So no direct-caller interleaving path exists to guard; a Pipeline mutex would be
  // duplicate machinery over the coalescer. (No temporal reference state lives in the Pipeline today —
  // params.temporal is not consumed here yet, see runGpu; when the interactive temporal path is wired,
  // the same single-flight guarantee keeps its retained buffers touched by one run at a time. If a
  // future caller ever invokes pipeline.run() OUTSIDE the coalescer, that guard must be revisited.)
  async run(scene: Scene, atlas: Atlas, params: PipelineParams, interactive: boolean): Promise<PipelineOutput> {
    const { cellW, cellH } = atlas;
    const gridW = params.cols * cellW;
    const rows = gridRows(params.cols, SCENE_ASPECT, 1, cellW, cellH);
    const gridH = rows * cellH;

    const tRender = performance.now();
    const imgData = scene.renderToImageData(gridW, gridH);
    const render = performance.now() - tRender;

    // Route: Q3 default web path on a WebGPU-capable secure context → GPU matcher + GPU raster (a
    // capability boundary, not a masking fallback). Q0/Q1/Q2, WebGPU-absent, or a device that lost
    // either the matcher or the raster pipeline → CPU pool. A mid-run GPU failure falls back to the
    // pool for that whole run (match recomputed on CPU; SPEC §2). `gpuReady`/`gpuRasterReady` are
    // already settled (kicked off in the constructor) — the await is just a microtask boundary.
    // The contrast floor is NOT a routing condition: the GPU matcher applies it as a host per-cell
    // post-pass (gpu-matcher.ts → contrast-floor-post.ts), byte-identical to the CPU floored path,
    // so the floored default demo path stays on the GPU matcher.
    const gpu = await this.gpuReady;
    const gpuRaster = await this.gpuRasterReady;
    if (gpu && gpu.available && gpuRaster && gpuRaster.available && params.quality === 3) {
      try {
        return await this.runGpu(gpu, gpuRaster, imgData, atlas, params, interactive, render, rows);
      } catch (e) {
        console.warn('gpu path failed; falling back to CPU pool', e);
        // The prep worker consumed (transferred) imgData.data — re-render for the pool fallback.
        const fresh = scene.renderToImageData(gridW, gridH);
        const tPrep = performance.now();
        return this.runPool(imageDataToLinear(fresh), atlas, params, interactive, render, tPrep, rows);
      }
    }
    const tPrep = performance.now();
    return this.runPool(imageDataToLinear(imgData), atlas, params, interactive, render, tPrep, rows);
  }

  // Send the grid-footprint ImageData to a pool worker for the relocated Q3 prep (SPEC §4.3):
  // linearize + working-space transform (fused LUT) + per-cell stats/gate/pack, plus the SSIM
  // linear reference when wanted. Hands the worker our ping-pong spare so it fills without
  // allocating; the ImageData buffer and the spare are transferred in, the filled buffers back.
  private prepQ3(
    img: { width: number; height: number; data: Uint8ClampedArray }, params: PrepParams, wantLin: boolean,
  ): Promise<PrepResultMsg> {
    const id = this.nextId++;
    const spare = this.prepSpare;
    this.prepSpare = null; // ownership handed to the worker; restored after matchPrepped consumes it
    const req: PrepQ3Request = {
      type: 'prepQ3', id, img: { width: img.width, height: img.height, data: img.data }, params, wantLin,
      targetHost: spare?.targetHost, cstatHost: spare?.cstatHost,
    };
    const transfer: Transferable[] = [img.data.buffer];
    if (spare) { transfer.push(spare.targetHost.buffer, spare.cstatHost.buffer); }
    return this.request<PrepResultMsg>(this.workers[0]!, req, transfer);
  }

  // GPU Q3 path (SPEC §4.5): render → worker prep → writeBuffer + GPU match + assemble → GPU raster
  // → commit. timings.match is the matcher dispatch→readback wall; timings.raster is the raster
  // dispatch→readback wall + staging copy; timings.resample is the prep stage wall (mostly off the
  // main thread now) minus the match dispatch→readback slice — so check-7's `match+raster < 500`
  // stays meaningful.
  private async runGpu(
    gpu: GpuMatcher, gpuRaster: GpuRaster, img: { width: number; height: number; data: Uint8ClampedArray },
    atlas: Atlas, params: PipelineParams, interactive: boolean, render: number, rows: number,
  ): Promise<PipelineOutput> {
    const { cellW, cellH } = atlas;
    const cols = params.cols;
    const w = img.width, h = img.height;

    // R2: prep off the main thread. Non-interactive runs also ask for the linear SSIM reference.
    const tPrep = performance.now();
    const prep = await this.prepQ3(
      img, { cols, rows, cellW, cellH, P: atlas.P, space: params.space, gateTau: this.q3opts.gateTau }, !interactive,
    );

    // Upstream match: upload (writeBuffer) + GPU dispatch → readback + assemble GridCell[].
    const res = await gpu.matchPrepped(
      { targetHost: prep.targetHost, cstatHost: prep.cstatHost, gated: prep.gated, gatedCount: prep.gatedCount },
      atlas, { quality: 3, space: params.space, gateTau: this.q3opts.gateTau, mdlLambda: this.q3opts.mdlLambda, contrastFloor: params.contrastFloor },
      cols, rows,
    );
    // resample := prep-stage wall (worker prep + transfer + writeBuffer + assemble), minus the
    // GPU dispatch→readback slice (that is timings.match). Mirrors the pre-split formula.
    const resample = performance.now() - tPrep - res.matchMs;
    // The prep host buffers are done being uploaded — return them to the ping-pong spare (single-
    // flight guarantees no other run is using them) so the next run's worker fills in place.
    this.prepSpare = { targetHost: prep.targetHost, cstatHost: prep.cstatHost };

    const grid: Grid = { cols, rows, cells: res.cells, cellW, cellH, font: atlas.fontPath };

    // R1: GPU output raster (fit space == raster space — ledger pairing rule). rasterWallMs is the
    // dispatch→readback wall + staging copy; the display commit (putImageData) stays in main.ts.
    const rr = await gpuRaster.render(grid, atlas, params.space);
    const raster = rr.rasterWallMs;

    // R3: non-interactive runs score SSIM in ONE worker hop (rasterizeGrid + ssim), bitwise
    // identical to the CPU path, using the worker-produced linear reference. `cells` are structured-
    // cloned (still needed in `grid`); only the linear ref buffer is transferred.
    let ssimVal: number | null = null;
    let ssimMs = 0;
    if (!interactive && prep.lin) {
      const tS = performance.now();
      const id = this.nextId++;
      const req: RasterSsimRequest = {
        type: 'rasterSsim', id, charset: params.charset, space: params.space,
        cols, rows, cells: res.cells, ref: { w, h, data: prep.lin },
      };
      const sr = await this.request<SsimResult>(this.workers[0]!, req, [prep.lin.buffer]);
      ssimVal = sr.ssim;
      ssimMs = performance.now() - tS;
    }

    return {
      grid,
      raster: { w: rr.w, h: rr.h, data: rr.data },
      ssim: ssimVal,
      timings: { render, resample, match: res.matchMs, raster, ssim: ssimMs, rasterGpuMs: rr.rasterGpuMs },
      matcher: 'gpu',
      // Provenance (SPEC §4.4): this is a full same-frame rematch — byte-exact vs src/core/match.ts
      // and safe for exports/SSIM. HONEST STATUS: the Pipeline does NOT consume params.temporal — the
      // interactive delta/delta+hyst routing (SPEC §4.4/§8 Agent B) is UNLANDED, so every Pipeline run
      // is a full rematch and this tag is always 'full' (temporalStats stays undefined). The landed
      // temporal engine (GpuMatcher.matchPreppedTemporal / the GpuTemporal wrapper) is exercised only
      // by the temporal harness (test-e2e/temporal.spec.ts drives GpuTemporal directly, bypassing the
      // Pipeline). Wiring it into the interactive path — retained reference state driven off the worker
      // prep + GpuRaster partial-cell upload — is the registered follow-up feat/temporal-interactive-
      // wiring (see honestReport); until it lands, params.temporal is accepted but ignored here.
      temporal: 'full',
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
      // The CPU pool is a capability boundary with no temporal mode (SPEC §4.4): it always emits a
      // full rematch, exactly today's output.
      temporal: 'full',
    };
  }
}
