import type { GridCell } from '../../../src/core/types.js';
import { srgbToLinear, linearToSrgb } from '../../../src/core/color.js';

// perf/gpu-rasterizer R2 (SPEC §4.3): the Q3 GPU-matcher prep loop, relocated OFF the main
// thread. The numerics here are the SAME JS as gpu-matcher.ts's inline prep — same Math.fround
// chains in cellStats' (ly,lx,c) order, same f64 eac + gate, same gammaU8/toU8 gated encode —
// so the uploaded T, the cstat block and the gated-cell colours stay BYTE-IDENTICAL to
// src/core/match.ts. The one substitution is the fused 2D work-LUT: the per-pixel
//   work = f32(linearToSrgb(a·srgbToLinear(v))/255)   (gamma)  /  f32(a·srgbToLinear(v)) (linear)
// is a pure function of the two u8s (alpha, value), so it is precomputed once per space
// (65,536 f32 entries) and indexed — removing the ~50ms Math.pow transform AND the separate
// linearize pass. Bit-identity to the two-stage (imageDataToLinear → working transform) chain
// is provable by exhaustive comparison over all 65,536 inputs (prep.test.ts).

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
// gamma working value (already sRGB-encoded [0,1]) → u8 directly (match.ts gammaU8).
function gammaU8(v: number): number { return Math.round(clamp01(v) * 255); }
// linear working value → sRGB u8 (match.ts toU8).
function toU8(v: number): number { const s = Math.round(linearToSrgb(v)); return s < 0 ? 0 : s > 255 ? 255 : s; }

export interface PrepParams {
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  P: number;
  space: 'linear' | 'gamma';
  gateTau: number;
}

// The prep loop's upload-ready outputs. targetHost / cstatHost mirror gpu-matcher's reused
// host scratch (numCells·3·P and numCells·16); gated carries the CPU-decided gated cells
// (already encoded), by cell index, so the assembler can splice them past the GPU winners.
export interface Prepped {
  targetHost: Float32Array;
  cstatHost: Float32Array;
  gated: (GridCell | undefined)[];
  gatedCount: number;
}

// prepQ3 additionally returns the full-image linear reference (for the non-interactive SSIM
// ref) only when requested; interactive runs never build it.
export interface PrepResult extends Prepped {
  lin: Float32Array | null;
}

// Reusable host-scratch, supplied by the ping-pong buffer owner. Each array MUST size on its
// OWN dimension (F2R-1): a (numCells, P) change that holds numCells·3·P constant while
// numCells grows leaves targetHost's length unchanged, so a piggybacked cstatHost would never
// realloc and drop the tail cells' stats silently. Independent conditions close the collision.
export interface PrepScratch {
  targetHost?: Float32Array;
  cstatHost?: Float32Array;
  wantLin?: boolean;
}

// Space-keyed 2D work-LUT cache (built once per space). Index = alpha·256 + value (both u8).
// gamma[i] = f32(linearToSrgb(f32(a·srgbToLinear(v)))/255); linear[i] = f32(a·srgbToLinear(v)).
// The inner f32 rounding of the linear value is deliberate — it reproduces the Float32Array
// store that imageDataToLinear performs before the working transform reads it back, so the
// LUT is byte-identical to the two-stage chain (proven exhaustively in prep.test.ts).
const LUT_CACHE = new Map<'linear' | 'gamma', Float32Array>();

export function buildWorkLut(space: 'linear' | 'gamma'): Float32Array {
  const lut = new Float32Array(65536);
  const scratch = new Float32Array(1); // forces the f32 store that mirrors LinearImage's Float32Array
  for (let a = 0; a < 256; a++) {
    const af = a / 255;
    for (let v = 0; v < 256; v++) {
      scratch[0] = af * srgbToLinear(v);        // f32 linear value (as imageDataToLinear stores)
      const linF32 = scratch[0]!;
      lut[a * 256 + v] = space === 'gamma' ? linearToSrgb(linF32) / 255 : linF32;
    }
  }
  return lut;
}

function getLut(space: 'linear' | 'gamma'): Float32Array {
  let lut = LUT_CACHE.get(space);
  if (!lut) { lut = buildWorkLut(space); LUT_CACHE.set(space, lut); }
  return lut;
}

// The verbatim per-cell scan (gpu-matcher.ts prep loop). Packs each cell's target patch into
// targetHost and accumulates ST/STT/minT/maxT in cellStats' EXACT (ly,lx,c) fround order, then
// centres (STT_c = STT − ST²/P, f64), computes eac (f64), applies the contrast gate and emits
// gated cells (space + working-space flat mean, encoded per space). `work` is the full-image
// working-space buffer (w = cols·cellW). Reused scratch reallocs on its own dimension.
export function scanCells(work: Float32Array, w: number, params: PrepParams, scratch?: PrepScratch): Prepped {
  const { cols, rows, cellW, cellH, P, space, gateTau } = params;
  const numCells = cols * rows;
  const encode = space === 'gamma' ? gammaU8 : toU8;

  let targetHost = scratch?.targetHost;
  if (!targetHost || targetHost.length !== numCells * 3 * P) targetHost = new Float32Array(numCells * 3 * P);
  let cstatHost = scratch?.cstatHost;
  if (!cstatHost || cstatHost.length !== numCells * 16) cstatHost = new Float32Array(numCells * 16);

  const gated: (GridCell | undefined)[] = new Array(numCells);
  let gatedCount = 0;
  const fr = Math.fround;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cell = row * cols + col;
      const tBase = cell * 3 * P;
      const x0 = col * cellW, y0 = row * cellH;
      let st0 = 0, st1 = 0, st2 = 0, stt0 = 0, stt1 = 0, stt2 = 0;
      let mn0 = Infinity, mn1 = Infinity, mn2 = Infinity, mx0 = -Infinity, mx1 = -Infinity, mx2 = -Infinity;
      for (let ly = 0; ly < cellH; ly++) {
        const gy = y0 + ly;
        for (let lx = 0; lx < cellW; lx++) {
          const gidx = (gy * w + (x0 + lx)) * 3;
          const li = ly * cellW + lx;
          const v0 = work[gidx]!, v1 = work[gidx + 1]!, v2 = work[gidx + 2]!;
          targetHost[tBase + li] = v0;
          targetHost[tBase + P + li] = v1;
          targetHost[tBase + 2 * P + li] = v2;
          st0 = fr(st0 + v0); st1 = fr(st1 + v1); st2 = fr(st2 + v2);
          stt0 = fr(stt0 + v0 * v0); stt1 = fr(stt1 + v1 * v1); stt2 = fr(stt2 + v2 * v2);
          if (v0 < mn0) mn0 = v0; if (v0 > mx0) mx0 = v0;
          if (v1 < mn1) mn1 = v1; if (v1 > mx1) mx1 = v1;
          if (v2 < mn2) mn2 = v2; if (v2 > mx2) mx2 = v2;
        }
      }
      const sttc0 = stt0 - (st0 * st0) / P;
      const sttc1 = stt1 - (st1 * st1) / P;
      const sttc2 = stt2 - (st2 * st2) / P;
      const eac = sttc0 + sttc1 + sttc2;
      const o = cell * 16;
      cstatHost[o] = st0; cstatHost[o + 1] = st1; cstatHost[o + 2] = st2; cstatHost[o + 3] = eac;
      cstatHost[o + 4] = sttc0; cstatHost[o + 5] = sttc1; cstatHost[o + 6] = sttc2;
      cstatHost[o + 8] = mn0; cstatHost[o + 9] = mn1; cstatHost[o + 10] = mn2;
      cstatHost[o + 12] = mx0; cstatHost[o + 13] = mx1; cstatHost[o + 14] = mx2;
      if (eac / (3 * P) < gateTau) {
        gated[cell] = { ch: ' ', fg: null, bg: [encode(st0 / P), encode(st1 / P), encode(st2 / P)] };
        gatedCount++;
      }
    }
  }
  return { targetHost, cstatHost, gated, gatedCount };
}

// Full Q3 prep from an ImageData (u8 RGBA), for the relocated worker path. Builds the
// working-space image via the fused work-LUT, runs the per-cell scan, and optionally builds
// the full-image linear reference (SSIM) via the linear LUT in the same pixel pass.
export function prepQ3(
  img: { width: number; height: number; data: Uint8ClampedArray },
  params: PrepParams,
  scratch?: PrepScratch,
): PrepResult {
  const w = img.width, h = img.height;
  const rgba = img.data;
  const npx = w * h;
  const workLut = getLut(params.space);
  const wantLin = scratch?.wantLin ?? false;
  const linLut = wantLin ? getLut('linear') : null;

  const work = new Float32Array(npx * 3);
  const lin = wantLin ? new Float32Array(npx * 3) : null;
  for (let p = 0; p < npx; p++) {
    const base = rgba[p * 4 + 3]! * 256; // alpha·256
    const q = p * 3, r = p * 4;
    const v0 = rgba[r]!, v1 = rgba[r + 1]!, v2 = rgba[r + 2]!;
    work[q] = workLut[base + v0]!;
    work[q + 1] = workLut[base + v1]!;
    work[q + 2] = workLut[base + v2]!;
    if (lin) {
      lin[q] = linLut![base + v0]!;
      lin[q + 1] = linLut![base + v1]!;
      lin[q + 2] = linLut![base + v2]!;
    }
  }

  const prepped = scanCells(work, w, params, scratch);
  return { ...prepped, lin };
}
