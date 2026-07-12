/// <reference lib="webworker" />
import type { Atlas, Grid, GridCell, LinearImage } from '../../src/core/types.js';
import { matchGrid } from '../../src/core/match.js';
import { rampGrid } from '../../src/core/ramp.js';
import { rasterizeGrid } from '../../src/render/raster.js';
import { ssim } from '../../src/metric/ssim.js';
import { linearToSrgb } from '../../src/core/color.js';
import { bandMatchOptions } from './band-opts.js';
import type { IdentityCoherence } from '../../src/core/identity-preset.js';
import { prepQ3 } from './webgpu/prep.js';
import type { PrepParams } from './webgpu/prep.js';

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
  contrastFloor?: number; // Round A ASCII-identity: per-cell, banding-safe (see below). 0/absent = off.
  // feat/identity-web-wiring: the ASCII-identity preset knobs threaded from the demo controls. `identity`
  // absent/false ⇒ byte-identical (bandMatchOptions skips the preset). identityCoherence carries the full
  // core union so the band-safety guard can reject banded 'smooth' — the web never SENDS smooth (its
  // dropdown excludes it), but the guard is the loud core-side defense (band-opts.ts).
  identity?: boolean; identityCoherence?: IdentityCoherence; identityColorDither?: boolean;
}
export interface SsimRequest {
  type: 'ssim'; id: number;
  a: { w: number; h: number; data: Float32Array };
  b: { w: number; h: number; data: Float32Array };
}
// perf/gpu-rasterizer R2 (SPEC §4.3): the Q3 prep loop relocated off the main thread. `img` is
// the grid-footprint ImageData (u8 RGBA, transferred in). `targetHost`/`cstatHost` are the
// caller's ping-pong spares (transferred in and filled without allocation); `wantLin` requests
// the full-image linear reference for the non-interactive SSIM path (§4.2). No atlas needed.
export interface PrepQ3Request {
  type: 'prepQ3'; id: number;
  img: { width: number; height: number; data: Uint8ClampedArray };
  params: PrepParams;
  wantLin: boolean;
  targetHost?: Float32Array;
  cstatHost?: Float32Array;
}
// R3 (SPEC §4.2): rasterize the GPU-assembled grid + score SSIM in ONE worker hop so the raster
// stays out of the main thread and the metric spans band seams. `ref` is the linear reference;
// atlas comes from the existing setAtlas broadcast. Result reuses SsimResult.
export interface RasterSsimRequest {
  type: 'rasterSsim'; id: number; charset: string; space: 'linear' | 'gamma';
  cols: number; rows: number; cells: GridCell[];
  ref: { w: number; h: number; data: Float32Array };
}
export type WorkerRequest = SetAtlasRequest | MatchBandRequest | SsimRequest | PrepQ3Request | RasterSsimRequest;

export interface BandTimings { match: number; raster: number }
export interface BandResult {
  type: 'band'; id: number; band: number; cols: number; rows: number;
  cells: GridCell[];
  raster: Uint8ClampedArray;   // RGBA, w × (bandRows·cellH), ready for the canvas
  rasterLin: Float32Array;     // working-space raster (LinearImage container) for SSIM assembly
  timings: BandTimings;
}
export interface SsimResult { type: 'ssim'; id: number; ssim: number }
// prepQ3 reply: the upload-ready buffers (transferred back) + CPU-decided gated cells. `lin` is
// present only when the request set wantLin.
export interface PrepResultMsg {
  type: 'prep'; id: number;
  targetHost: Float32Array; cstatHost: Float32Array;
  gated: (GridCell | undefined)[]; gatedCount: number;
  lin: Float32Array | null;
}
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
    if (msg.type === 'prepQ3') {
      const res = prepQ3(msg.img, msg.params, { targetHost: msg.targetHost, cstatHost: msg.cstatHost, wantLin: msg.wantLin });
      const transfer: Transferable[] = [res.targetHost.buffer, res.cstatHost.buffer];
      if (res.lin) transfer.push(res.lin.buffer);
      ctx.postMessage({
        type: 'prep', id: msg.id,
        targetHost: res.targetHost, cstatHost: res.cstatHost,
        gated: res.gated, gatedCount: res.gatedCount, lin: res.lin,
      } satisfies PrepResultMsg, transfer);
      return;
    }
    if (msg.type === 'rasterSsim') {
      const atlas = atlases.get(msg.charset);
      if (!atlas) throw new Error(`worker: no atlas set for charset '${msg.charset}' (setAtlas first)`);
      const grid: Grid = { cols: msg.cols, rows: msg.rows, cells: msg.cells, cellW: atlas.cellW, cellH: atlas.cellH, font: atlas.fontPath };
      // raster space MUST equal the fit space (M0 color-space lesson; matches pipeline runGpu).
      const out = rasterizeGrid(grid, atlas, msg.space);
      const s = ssim(out, { w: msg.ref.w, h: msg.ref.h, data: msg.ref.data });
      ctx.postMessage({ type: 'ssim', id: msg.id, ssim: s } satisfies SsimResult);
      return;
    }
    // matchBand — the charset atlas must already have been set for this worker.
    const atlas = atlases.get(msg.charset);
    if (!atlas) throw new Error(`worker: no atlas set for charset '${msg.charset}' (setAtlas first)`);
    const img: LinearImage = { w: msg.img.w, h: msg.img.h, data: msg.img.data };

    // Assemble the per-band MatchOptions (contrast floor + ASCII-identity preset) and enforce the
    // band-safety guard (cross-cell passes incl. banded 'smooth' coherence) — shared, unit-tested.
    const opts = bandMatchOptions(msg);

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
