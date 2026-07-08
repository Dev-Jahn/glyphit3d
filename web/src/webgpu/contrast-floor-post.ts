import type { Atlas, FitStatsG, GridCell } from '../../../src/core/types.js';
import { fitFree, fitBox, contrastFloorFit } from '../../../src/core/fit.js';
import { linearToSrgb } from '../../../src/core/color.js';

// Round A contrast-floor post-pass for the WebGPU Q3 path (feat/contrast-floor-fill, MAJOR fix).
// The GPU matcher does the expensive per-cell glyph selection; this per-cell host pass applies
// the SAME contrast floor matchGrid's CPU path applies (src/core/match.ts §"Contrast floor"),
// so the floored default demo path keeps the GPU matcher instead of routing to the CPU pool.
//
// It is byte-for-byte identical to the CPU floored path BY CONSTRUCTION: for each non-gated cell
// it re-derives everything contrastFloorFit consumes from the SAME working-space target the GPU
// fit used (targetHost — the f32 gamma/linear patch the prep uploaded), using the SAME closed
// forms (fitFree/fitBox from fit.ts) and the SAME contrastFloorFit. Same winner + same stats +
// same math ⇒ same emit. The decision is taken on host f64 F/B (not the GPU's f32 output), so a
// cell that the CPU would floor is floored here regardless of the ±1 u8 GPU/CPU colour tolerance;
// a KEPT cell (contrastFloorFit → null) is left exactly as the GPU produced it.
//
// GPU is Q3-only (bg free, quality asserted by the matcher), so bgFixed is always false and Q1
// (mono, exempt) never reaches here.

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
// gamma working value (already sRGB-encoded [0,1]) → u8 (match.ts gammaU8).
function gammaU8(v: number): number { return Math.round(clamp01(v) * 255); }
// linear working value → sRGB u8 (match.ts toU8).
function toU8(v: number): number { const s = Math.round(linearToSrgb(v)); return s < 0 ? 0 : s > 255 ? 255 : s; }

type Vec3 = [number, number, number];

// Recompute the winner glyph's F/B for one channel exactly as match.ts channelFB does at Q3:
// unconstrained OLS, kept when both colours land inside the cell's [minT,maxT] box, else the
// box-constrained refit (DESIGN §3.4). All args are plain L2 (Q3 has no Q4 gradient augmentation).
function channelFbQ3(g: FitStatsG, saT: number, ST: number, STT: number, minTc: number, maxTc: number): [number, number] {
  const free = fitFree(g, saT, ST, STT);
  const F = free.a + free.b;
  const B = free.b;
  if (F >= minTc && F <= maxTc && B >= minTc && B <= maxTc) return [F, B];
  const box = fitBox(g, saT, ST, STT, minTc, maxTc, minTc, maxTc);
  return [box.F, box.B];
}

// Apply the contrast floor to the GPU-returned Q3 grid IN PLACE. `winners[cell]` is the GPU
// argmin glyph index; `gated[cell]` is truthy for cells the contrast gate already emitted as a
// flat cell (skipped — the floor is applied to fitted text winners only, matching match.ts).
// `targetHost` is the prep's working-space target, laid out cell-major as [cell*3*P + c*P + li];
// the values are the exact f32 T the CPU fit reads, so the re-derived sums are bit-identical.
export function applyContrastFloor(
  cells: GridCell[],
  winners: ArrayLike<number>,
  gated: ArrayLike<GridCell | undefined>,
  targetHost: Float32Array,
  atlas: Atlas,
  cols: number,
  rows: number,
  space: 'linear' | 'gamma',
  floor: number,
): void {
  if (!(floor > 0)) return;
  const { P, glyphs } = atlas;
  const numCells = cols * rows;
  const encode = space === 'gamma' ? gammaU8 : toU8;
  const fr = Math.fround;

  for (let cell = 0; cell < numCells; cell++) {
    if (gated[cell]) continue; // gated flat cells are exempt (as in matchGrid)
    const glyph = glyphs[winners[cell]!]!;
    const alpha = glyph.alpha;
    const tBase = cell * 3 * P;

    // Per-channel target stats over this cell's patch, re-derived in cellStats' pixel order and
    // f32 accumulation (ST/STT round to f32 each step; saT accumulates in f64) so they equal the
    // stats matchGrid fed contrastFloorFit for this winner.
    const ST: Vec3 = [0, 0, 0];
    const STT: Vec3 = [0, 0, 0];
    const minT: Vec3 = [Infinity, Infinity, Infinity];
    const maxT: Vec3 = [-Infinity, -Infinity, -Infinity];
    const saT: Vec3 = [0, 0, 0];
    for (let li = 0; li < P; li++) {
      const a = alpha[li]!;
      for (let c = 0; c < 3; c++) {
        const v = targetHost[tBase + c * P + li]!;
        ST[c] = fr(ST[c]! + v);
        STT[c] = fr(STT[c]! + v * v);
        if (v < minT[c]!) minT[c] = v;
        if (v > maxT[c]!) maxT[c] = v;
        saT[c] = saT[c]! + a * v;
      }
    }

    // Winner F/B (host f64) via the same Q3 channel fit the CPU path uses.
    const g: FitStatsG = { Saa: glyph.sumAA, Sa1: glyph.sumA, S11: P };
    const F: Vec3 = [0, 0, 0];
    const B: Vec3 = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const fb = channelFbQ3(g, saT[c]!, ST[c]!, STT[c]!, minT[c]!, maxT[c]!);
      F[c] = fb[0]; B[c] = fb[1];
    }

    // Same decision + colours as match.ts (Q3 branch, bgFixed=false). null ⇒ keep the GPU cell.
    const dec = contrastFloorFit(g, F, B, ST, STT, saT, P, floor, false);
    if (!dec) continue;
    cells[cell] = dec.space
      ? { ch: ' ', fg: null, bg: [encode(dec.mean[0]), encode(dec.mean[1]), encode(dec.mean[2])] }
      : { ch: glyph.ch, fg: [encode(dec.F[0]), encode(dec.F[1]), encode(dec.F[2])], bg: [encode(dec.B[0]), encode(dec.B[1]), encode(dec.B[2])] };
  }
}
