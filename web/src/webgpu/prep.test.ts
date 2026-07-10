import { describe, it, expect } from 'vitest';
import { buildWorkLut, prepQ3 } from './prep.js';
import type { PrepParams } from './prep.js';
import { imageDataToLinear } from '../browser-image.js';
import { srgbToLinear, linearToSrgb } from '../../../src/core/color.js';
import { cellStats } from '../../../src/core/stats.js';
import { matchGrid } from '../../../src/core/match.js';
import { defaultOptions } from '../../../src/core/options.js';
import type { Atlas, Glyph, LinearImage } from '../../../src/core/types.js';

// perf/gpu-rasterizer R2 (SPEC §4.3, §5.2, VERIFY (a)/(b)). Two claims are proven here:
//  (a) the fused 2D work-LUT is BYTE-IDENTICAL to the shipped two-stage chain (imageDataToLinear
//      → working-space transform) for all 65,536 (alpha, value) u8 pairs, in both spaces;
//  (b) prep.ts's per-cell ST/STT_c/minT/maxT/eac + gate set + gated bg are byte-equal to the
//      cellStats/matchGrid-derived reference on random fixtures (the prep loop moved verbatim).

// --- (a) exhaustive 65,536-entry LUT equality --------------------------------------------------
describe('work-LUT is bit-identical to imageDataToLinear + working transform (all 65,536 u8 pairs)', () => {
  for (const space of ['gamma', 'linear'] as const) {
    it(`space=${space}: 0 mismatches over 256×256 (alpha, value)`, () => {
      const lut = buildWorkLut(space);
      const px = new Uint8ClampedArray(4);
      const stage2 = new Float32Array(1); // forces the f32 store the working transform performs
      let mismatches = 0;
      const firstBad: string[] = [];
      for (let a = 0; a < 256; a++) {
        for (let v = 0; v < 256; v++) {
          px[0] = v; px[1] = v; px[2] = v; px[3] = a;
          // reference stage 1: the shipped browser linearize (f32 store of a·srgbToLinear(v)).
          const lin = imageDataToLinear({ width: 1, height: 1, data: px }).data[0]!;
          // reference stage 2: the working-space transform (gamma) / identity (linear), f32-stored.
          stage2[0] = space === 'gamma' ? linearToSrgb(lin) / 255 : lin;
          const ref = stage2[0]!;
          const got = lut[a * 256 + v]!;
          if (!Object.is(got, ref)) {
            mismatches++;
            if (firstBad.length < 5) firstBad.push(`(a=${a},v=${v}) lut=${got} ref=${ref}`);
          }
        }
      }
      expect(mismatches, firstBad.join('; ')).toBe(0);
    });
  }

  it('linear-space LUT equals a·srgbToLinear(v) as f32 (the SSIM-ref linear values)', () => {
    const lut = buildWorkLut('linear');
    const f = new Float32Array(1);
    let mismatches = 0;
    for (let a = 0; a < 256; a++) {
      for (let v = 0; v < 256; v++) {
        f[0] = (a / 255) * srgbToLinear(v);
        if (!Object.is(lut[a * 256 + v]!, f[0]!)) mismatches++;
      }
    }
    expect(mismatches).toBe(0);
  });
});

// --- (b) prep fields vs cellStats / matchGrid reference ---------------------------------------
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGlyph(ch: string, cp: number, P: number, fill: number, ink: number): Glyph {
  const alpha = new Float32Array(P).fill(fill);
  let sumA = 0, sumAA = 0;
  for (const a of alpha) { sumA += a; sumAA += a * a; }
  return { ch, cp, alpha, dxA: new Float32Array(P), dyA: new Float32Array(P), sumA, sumAA, gradAA: 0, ink };
}

function makeAtlas(cellW: number, cellH: number): Atlas {
  const P = cellW * cellH;
  return {
    cellW, cellH, P, fontPath: 'mock', fontSize: 16, ascent: 12,
    glyphs: [makeGlyph(' ', 32, P, 0, 0), makeGlyph('#', 35, P, 0.5, 0.4), makeGlyph('@', 64, P, 0.85, 1)],
    inkMin: 0, inkMax: 1,
  };
}

// A random u8 RGBA fixture over the exact grid footprint, with a band of internally-flat cells
// (rows 0..1) guaranteed to trip the contrast gate so both the gated and non-gated branches are
// exercised in one image.
function makeFixture(w: number, h: number, cellH: number, rng: () => number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const flatRow = Math.floor(y / cellH) < 2;
    const flatVal = 40 + Math.floor(y / cellH) * 30;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (flatRow) { rgba[i] = flatVal; rgba[i + 1] = flatVal; rgba[i + 2] = flatVal; }
      else { rgba[i] = (rng() * 256) | 0; rgba[i + 1] = (rng() * 256) | 0; rgba[i + 2] = (rng() * 256) | 0; }
      rgba[i + 3] = 255; // demo canvas is opaque
    }
  }
  return rgba;
}

describe('prepQ3 ST/STT_c/minT/maxT/eac + gate set + gated bg equal the cellStats/matchGrid reference', () => {
  for (const space of ['gamma', 'linear'] as const) {
    it(`space=${space}: byte-equal per-cell stats, gate decisions and gated colours`, () => {
      const cellW = 4, cellH = 4, P = cellW * cellH;
      const cols = 6, rows = 5;
      const w = cols * cellW, h = rows * cellH;
      const rng = mulberry32(space === 'gamma' ? 0xabcdef : 0x123456);
      const rgba = makeFixture(w, h, cellH, rng);

      const atlas = makeAtlas(cellW, cellH);
      const opts = defaultOptions(3);
      opts.space = space;
      const params: PrepParams = { cols, rows, cellW, cellH, P, space, gateTau: opts.gateTau };

      const prep = prepQ3({ width: w, height: h, data: rgba }, params, { wantLin: true });

      // (i) lin reference: prepQ3's optional lin equals imageDataToLinear exactly.
      const lin = imageDataToLinear({ width: w, height: h, data: rgba });
      expect(prep.lin, 'wantLin buffer present').toBeTruthy();
      for (let i = 0; i < lin.data.length; i++) expect(Object.is(prep.lin![i]!, lin.data[i]!)).toBe(true);

      // Working-space image the reference stats are taken over (same recipe as match.ts).
      const work = new Float32Array(w * h * 3);
      if (space === 'gamma') { for (let i = 0; i < work.length; i++) work[i] = linearToSrgb(lin.data[i]!) / 255; }
      else work.set(lin.data);
      const workImg: LinearImage = { w, h, data: work };
      const zeros = new Float32Array(w * h * 3);

      // matchGrid on a copy of the linear reference — its gated cells (fg===null) are the gate truth.
      const grid = matchGrid({ w, h, data: lin.data.slice(0) }, atlas, opts);

      let gatedSeen = 0, nonGatedSeen = 0;
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const cell = row * cols + col;
          const cs = cellStats(workImg, zeros, zeros, cellW, cellH, col, row);
          const o = cell * 16;
          // ST (raw sum), min, max: byte-equal.
          for (let c = 0; c < 3; c++) {
            expect(Object.is(prep.cstatHost[o + c]!, cs.ST[c]!)).toBe(true);
            expect(Object.is(prep.cstatHost[o + 8 + c]!, cs.minT[c]!)).toBe(true);
            expect(Object.is(prep.cstatHost[o + 12 + c]!, cs.maxT[c]!)).toBe(true);
          }
          // STT_c (centered) and eac: the f64 centering of cellStats' f32 sums, then f32-stored
          // into cstatHost (the GPU upload). The GATE uses the f64 value (checked via the gated
          // decision below); cstatHost holds its f32 image.
          const sttc = [0, 0, 0].map((_, c) => cs.STT[c]! - (cs.ST[c]! * cs.ST[c]!) / P);
          const eac = sttc[0]! + sttc[1]! + sttc[2]!;
          for (let c = 0; c < 3; c++) expect(Object.is(prep.cstatHost[o + 4 + c]!, Math.fround(sttc[c]!))).toBe(true);
          expect(Object.is(prep.cstatHost[o + 3]!, Math.fround(eac))).toBe(true);
          // target patch: byte-equal, in cellStats' (c*P+li) layout.
          for (let k = 0; k < 3 * P; k++) expect(Object.is(prep.targetHost[cell * 3 * P + k]!, cs.T[k]!)).toBe(true);

          // gate decision + gated bg vs matchGrid (fg===null iff gated for Q3).
          const mgGated = grid.cells[cell]!.fg === null;
          const prepGated = prep.gated[cell] !== undefined;
          expect(prepGated).toBe(mgGated);
          if (prepGated) {
            gatedSeen++;
            expect(prep.gated[cell]!.ch).toBe(' ');
            expect(prep.gated[cell]!.fg).toBeNull();
            expect(prep.gated[cell]!.bg).toEqual(grid.cells[cell]!.bg);
          } else nonGatedSeen++;
        }
      }
      expect(prep.gatedCount).toBe(gatedSeen);
      // the fixture must actually stress both branches, or the equality is vacuous.
      expect(gatedSeen).toBeGreaterThan(0);
      expect(nonGatedSeen).toBeGreaterThan(0);
    });
  }
});
