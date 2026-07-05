/// <reference lib="webworker" />
import type { Atlas, Grid, LinearImage } from '../../src/core/types.js';
import { resampleArea } from '../../src/image/image.js';
import { matchGrid } from '../../src/core/match.js';
import { rampGrid } from '../../src/core/ramp.js';
import { rasterizeGrid } from '../../src/render/raster.js';
import { ssim } from '../../src/metric/ssim.js';
import { linearToSrgb } from '../../src/core/color.js';
import { defaultOptions } from '../../src/core/options.js';

// Worker pipeline (M2-SPEC §2). The heavy CPU stages (resampleArea + matchGrid/
// rampGrid + rasterizeGrid + ssim) are the existing src/ modules imported verbatim —
// no logic is forked here. The atlas is decoded on the main thread (PROFILE loader)
// and handed over once per charset via `setAtlas`, then reused for every `match`.

export interface MatchRequest {
  type: 'match';
  id: number;
  charset: string; // names the atlas to match against (set earlier via setAtlas)
  img: { w: number; h: number; data: Float32Array }; // LinearImage, grid-sized
  cols: number;
  quality: 0 | 1 | 2 | 3 | 4;
  space: 'linear' | 'gamma';
}
export interface SetAtlasRequest {
  type: 'setAtlas';
  charset: string;
  atlas: Atlas;
}
export type WorkerRequest = MatchRequest | SetAtlasRequest;

export interface Timings { resample: number; match: number; raster: number; ssim: number }
export interface MatchResult {
  type: 'result';
  id: number;
  grid: Grid;
  raster: { w: number; h: number; data: Uint8ClampedArray }; // sRGB RGBA, ready for putImageData
  ssim: number;
  timings: Timings;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// atlases keyed by charset; each is a decoded Atlas transferred from the main thread.
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
  if (msg.type === 'setAtlas') {
    atlases.set(msg.charset, msg.atlas);
    return;
  }
  // Maps keep FIRST-insertion order, so "last key" would re-select a stale atlas when
  // a charset is re-used (blocks→ascii→blocks). Match against the charset the request
  // names — the atlas must already have been set for it.
  const atlas = atlases.get(msg.charset);
  if (!atlas) throw new Error(`worker: no atlas set for charset '${msg.charset}' (setAtlas first)`);

  const img: LinearImage = { w: msg.img.w, h: msg.img.h, data: msg.img.data };

  const t0 = performance.now();
  // identity when the render already matches the grid footprint (the default path).
  const targetW = msg.cols * atlas.cellW;
  const targetH = Math.floor(img.h / atlas.cellH) * atlas.cellH;
  const ref = (img.w === targetW && img.h === targetH) ? img : resampleArea(img, targetW, targetH);
  const t1 = performance.now();

  const opts = defaultOptions(msg.quality);
  opts.space = msg.space;
  const grid = msg.quality === 0 ? rampGrid(ref, atlas, opts) : matchGrid(ref, atlas, opts);
  const t2 = performance.now();

  // raster space MUST equal the fit space; Q0 always bakes linear (§ cli parity).
  const rasterSpace = msg.quality === 0 ? 'linear' : msg.space;
  const out = rasterizeGrid(grid, atlas, rasterSpace);
  const t3 = performance.now();

  const s = ssim(out, ref);
  const t4 = performance.now();

  const rgba = toRGBA(out);
  const result: MatchResult = {
    type: 'result',
    id: msg.id,
    grid,
    raster: { w: out.w, h: out.h, data: rgba },
    ssim: s,
    timings: { resample: t1 - t0, match: t2 - t1, raster: t3 - t2, ssim: t4 - t3 },
  };
  ctx.postMessage(result, [rgba.buffer]);
};
