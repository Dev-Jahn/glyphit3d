/// <reference lib="webworker" />
import type { Atlas, GridCell, LinearImage } from '../../src/core/types.js';
import { matchGrid } from '../../src/core/match.js';
import { rampGrid } from '../../src/core/ramp.js';
import { rasterizeGrid } from '../../src/render/raster.js';
import { ssim } from '../../src/metric/ssim.js';
import { linearToSrgb } from '../../src/core/color.js';
import { defaultOptions } from '../../src/core/options.js';

// Worker pool member (Round P / P2). The heavy CPU stages are the existing src/
// modules imported verbatim — no logic is forked here. Two request kinds:
//  - `matchBand`: resample-free match+raster over ONE contiguous cell-row band (the
//    band pixel slice is transferred in). matchGrid/rasterizeGrid are per-cell
//    independent on the web path (families=[]/no contour), so a band is exact for its
//    own rows; the assumption is asserted below and THROWS on cross-cell options.
//  - `ssim`: one-shot SSIM over the main-thread-ASSEMBLED raster + reference, so the
//    metric spans band seams (SSIM windows cross boundaries) — computed once per run.
// The atlas is decoded on the main thread and broadcast once per (charset, worker).

export interface SetAtlasRequest { type: 'setAtlas'; charset: string; atlas: Atlas }
export interface MatchBandRequest {
  type: 'matchBand'; id: number; band: number; charset: string;
  img: { w: number; h: number; data: Float32Array }; // band pixel slice, w × (bandRows·cellH)
  cols: number; quality: 0 | 1 | 2 | 3 | 4; space: 'linear' | 'gamma';
}
export interface SsimRequest {
  type: 'ssim'; id: number;
  a: { w: number; h: number; data: Float32Array };
  b: { w: number; h: number; data: Float32Array };
}
export type WorkerRequest = SetAtlasRequest | MatchBandRequest | SsimRequest;

export interface BandTimings { match: number; raster: number }
export interface BandResult {
  type: 'band'; id: number; band: number; cols: number; rows: number;
  cells: GridCell[];
  raster: Uint8ClampedArray;   // RGBA, w × (bandRows·cellH), ready for the canvas
  rasterLin: Float32Array;     // working-space raster (LinearImage container) for SSIM assembly
  timings: BandTimings;
}
export interface SsimResult { type: 'ssim'; id: number; ssim: number }
export interface ErrorResult { type: 'error'; id: number; message: string }

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// atlases keyed by charset; each is a decoded Atlas broadcast from the main thread.
const atlases = new Map<string, Atlas>();

function toRGBA(img: LinearImage): Uint8ClampedArray {
  const n = img.w * img.h;
  const out = new Uint8ClampedArray(n * 4); // Uint8Clamped rounds via assignment
  for (let i = 0; i < n; i++) {
    out[i * 4] = Math.round(linearToSrgb(img.data[i * 3]!));
    out[i * 4 + 1] = Math.round(linearToSrgb(img.data[i * 3 + 1]!));
    out[i * 4 + 2] = Math.round(linearToSrgb(img.data[i * 3 + 2]!));
    out[i * 4 + 3] = 255;
  }
  return out;
}

ctx.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === 'setAtlas') {
      atlases.set(msg.charset, msg.atlas);
      return;
    }
    if (msg.type === 'ssim') {
      const s = ssim({ w: msg.a.w, h: msg.a.h, data: msg.a.data }, { w: msg.b.w, h: msg.b.h, data: msg.b.data });
      ctx.postMessage({ type: 'ssim', id: msg.id, ssim: s } satisfies SsimResult);
      return;
    }
    // matchBand — the charset atlas must already have been set for this worker.
    const atlas = atlases.get(msg.charset);
    if (!atlas) throw new Error(`worker: no atlas set for charset '${msg.charset}' (setAtlas first)`);
    const img: LinearImage = { w: msg.img.w, h: msg.img.h, data: msg.img.data };

    const opts = defaultOptions(msg.quality);
    opts.space = msg.space;
    // P2 banding assumption, kept VISIBLE: families/contour/topK/orientation are cross-cell
    // passes that break per-band independence — never silently single-thread them. Q4's edge
    // loss is ALSO cross-cell: matchGrid reads the full-image vertical gradient (dyT/gradTT
    // from gradients()), which zero-pads at the band slice's top/bottom pixel rows — a FALSE
    // interior boundary at every band seam — so a banded Q4 raster diverges from the true
    // single-image Q4 along every seam. Reject it loudly rather than emit seam-corrupt output.
    if (opts.families?.length || opts.topK || opts.orientKappa || (opts.quality === 4 && opts.edgeLambda > 0))
      throw new Error('web band path does not support cross-cell passes (families/contour/Q4 edge loss)');

    const t1 = performance.now();
    // resample-free: the main thread renders exactly to the grid footprint and slices
    // cellH-aligned bands, so each band image is already at its target resolution.
    const grid = msg.quality === 0 ? rampGrid(img, atlas, opts) : matchGrid(img, atlas, opts);
    const t2 = performance.now();

    // raster space MUST equal the fit space; Q0 always bakes linear (§ cli parity).
    const rasterSpace = msg.quality === 0 ? 'linear' : msg.space;
    const out = rasterizeGrid(grid, atlas, rasterSpace);
    const t3 = performance.now();

    const rgba = toRGBA(out);
    const result: BandResult = {
      type: 'band', id: msg.id, band: msg.band, cols: grid.cols, rows: grid.rows,
      cells: grid.cells, raster: rgba, rasterLin: out.data,
      timings: { match: t2 - t1, raster: t3 - t2 },
    };
    ctx.postMessage(result, [rgba.buffer, out.data.buffer]);
  } catch (err) {
    const id = (msg as { id?: number }).id ?? -1;
    ctx.postMessage({ type: 'error', id, message: err instanceof Error ? err.message : String(err) } satisfies ErrorResult);
  }
};
