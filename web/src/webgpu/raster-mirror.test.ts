import { describe, it, expect } from 'vitest';
import type { Atlas, Grid, GridCell, LinearImage } from '../../../src/core/types.js';
import { rasterizeGrid } from '../../../src/render/raster.js';
import { srgbToLinear, linearToSrgb } from '../../../src/core/color.js';
import {
  buildGlyphIndex,
  packCells,
  needsRasterCellRealloc,
  needsRasterPixRealloc,
} from './gpu-raster.js';
import { RASTER_SENTINEL } from './raster-wgsl.js';

// JS mirror of raster-wgsl.ts (perf/gpu-rasterizer, SPEC §5.1). A faithful f32 hand-transcription
// of the WGSL blend/encode/pack, proven against toRGBA(rasterizeGrid(grid, atlas, space)) — the
// unmodified src/render/raster.ts reference — on random cells: 0 mismatches where α ∈ {0,1}
// (glyph-free interiors, gated/space cells, saturated cores, sentinel cells), |Δ| ≤ 1 u8 on the
// AA fringe. WGSL cannot run in node; the end-to-end SHADER↔CPU proof is agent D's parity
// harness. This suite guards the algebra + the CPU-side prep (packCells / last-wins glyph map).
//
// The mirror uses Math.fround at each op to mimic WGSL f32 (which has no f64). Its linearToSrgb
// uses Math.pow (f64) rounded to f32, NOT WGSL's native-f32 pow (implementation-defined); the
// two agree to well within the ±1 u8 criterion, and the ROUND-TRIP margin (~0.499) keeps
// α∈{0,1} exact in both — asserted directly below (all-256 identity).

const fr = Math.fround;

// Verbatim f32 transcription of src/core/color.ts linearToSrgb (see raster-wgsl.ts linearToSrgb).
function linearToSrgbF32(f: number): number {
  const c = f <= 0 ? 0 : f >= 1 ? 1 : f; // f already f32
  const s = c <= 0.0031308
    ? fr(c * 12.92)
    : fr(fr(1.055 * fr(Math.pow(c, fr(1 / 2.4)))) - 0.055);
  return fr(s * 255);
}

// Blend two f32 endpoints under coverage a and encode to u8, mirroring the WGSL kernel:
// t = a·f + (1−a)·b (f32); gamma → round+clamp of the integer-scale blend; linear → the
// same encode of linearToSrgb(t). Rounding is floor(x+0.5) (never round-half-even).
function blendEncodeF32(a: number, f: number, b: number, mode: 'linear' | 'gamma'): number {
  const ia = fr(1 - a);
  let t = fr(fr(a * f) + fr(ia * b));
  if (mode === 'linear') t = linearToSrgbF32(t);
  const r = Math.floor(fr(t + 0.5));
  return r < 0 ? 0 : r > 255 ? 255 : r;
}

// The GPU-path CPU raster reference (mirrors pipeline.ts toRGBA over rasterizeGrid's output).
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

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
}

// Build a small atlas with the exact runtime fields rasterizeGrid/packCells touch (ch, alpha).
// glyphs[0] is space (α ≡ 0) and glyphs[1] is solid (α ≡ 1) — the α∈{0,1} exact branch. The
// rest are random-coverage glyphs (the |Δ|≤1 fringe). A DUPLICATE ch 'D' with a DIFFERENT α
// exercises the last-wins glyph map (a first-wins bug would diverge from rasterizeGrid).
function makeAtlas(cellW: number, cellH: number, rng: () => number): Atlas {
  const P = cellW * cellH;
  const mk = (ch: string, fill: (i: number) => number) => {
    const alpha = new Float32Array(P);
    for (let i = 0; i < P; i++) alpha[i] = fill(i);
    return { ch, cp: ch.codePointAt(0) ?? 0, alpha } as unknown;
  };
  const glyphs = [
    mk(' ', () => 0),           // space: α ≡ 0
    mk('#', () => 1),           // solid: α ≡ 1
    mk('a', () => rng()),
    mk('b', () => rng()),
    mk('c', () => rng()),
    mk('D', () => rng() * 0.4), // first 'D'
    mk('D', () => rng()),       // duplicate 'D' — LAST wins
  ];
  return { cellW, cellH, P, glyphs } as unknown as Atlas;
}

// Random grid over the atlas chars, sprinkled with the corner cases: null cells (→ black),
// unknown-ch cells (→ background, α≡0), and gated-style cells (fg=null, space glyph).
function makeGrid(cols: number, rows: number, atlas: Atlas, rng: () => number): Grid {
  const chars = atlas.glyphs.map((g) => g.ch);
  const u8 = () => Math.floor(rng() * 256);
  const col = (): [number, number, number] => [u8(), u8(), u8()];
  const cells: (GridCell | null)[] = [];
  for (let i = 0; i < cols * rows; i++) {
    const roll = rng();
    if (roll < 0.05) { cells.push(null); continue; }                                   // null cell
    if (roll < 0.10) { cells.push({ ch: '?', fg: col(), bg: col() }); continue; }       // unknown ch
    if (roll < 0.18) { cells.push({ ch: ' ', fg: null, bg: col() }); continue; }        // gated-style
    const ch = chars[Math.floor(rng() * chars.length)]!;
    const fg = rng() < 0.1 ? null : col();
    const bg = rng() < 0.1 ? null : col();
    cells.push({ ch, fg, bg });
  }
  return { cols, rows, cells: cells as GridCell[], cellW: atlas.cellW, cellH: atlas.cellH, font: 'test' } as Grid;
}

interface Tally { total: number; mismatch: number; maxDelta: number; zeroOneChecked: number; zeroOneMismatch: number }

// Compare the f32 mirror (fed by the REAL packCells + last-wins map) against the CPU reference,
// pixel by pixel, classifying α∈{0,1} pixels (must be exact) from the AA fringe (|Δ|≤1).
function compare(grid: Grid, atlas: Atlas, space: 'linear' | 'gamma', t: Tally): void {
  const ref = toRGBA(rasterizeGrid(grid, atlas, space));
  const glyphIndex = buildGlyphIndex(atlas);
  const { glyphIdx, fgbg } = packCells(grid, glyphIndex, space);
  const cellW = atlas.cellW, cellH = atlas.cellH, P = atlas.P;
  const w = grid.cols * cellW, h = grid.rows * cellH;
  for (let y = 0; y < h; y++) {
    const row = Math.floor(y / cellH);
    for (let x = 0; x < w; x++) {
      const cell = row * grid.cols + Math.floor(x / cellW);
      const gi = glyphIdx[cell]!;
      let a = 0;
      if (gi !== RASTER_SENTINEL) {
        const li = (y % cellH) * cellW + (x % cellW);
        a = atlas.glyphs[gi]!.alpha[li]!;
      }
      const o = cell * 6;
      const pix = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const got = blendEncodeF32(a, fgbg[o + c]!, fgbg[o + 3 + c]!, space);
        const want = ref[pix + c]!;
        const d = Math.abs(got - want);
        t.total++;
        if (d > t.maxDelta) t.maxDelta = d;
        if (d !== 0) t.mismatch++;
        if (a === 0 || a === 1) { t.zeroOneChecked++; if (d !== 0) t.zeroOneMismatch++; }
      }
    }
  }
}

describe('raster-mirror (raster-wgsl.ts f32 port) vs toRGBA(rasterizeGrid) — SPEC §5.1', () => {
  it('the u8 → srgbToLinear(f32) → linearToSrgb → round trip is the identity for all 256 (why gamma needs no GPU transfer fn; why α∈{0,1} is exact in linear)', () => {
    for (let u = 0; u < 256; u++) {
      const linF32 = fr(srgbToLinear(u));
      // f64 CPU reference (SPEC §5.2) and the f32 mirror both recover u exactly.
      expect(Math.round(linearToSrgb(linF32))).toBe(u);
      expect(Math.floor(fr(linearToSrgbF32(linF32) + 0.5))).toBe(u);
    }
  });

  for (const space of ['gamma', 'linear'] as const) {
    it(`${space}: 0 mismatches at α∈{0,1}, |Δ|≤1 on the fringe, mismatch fraction within bound`, () => {
      const rng = makeRng(space === 'gamma' ? 0x6a57e2 : 0x11cea2);
      const t: Tally = { total: 0, mismatch: 0, maxDelta: 0, zeroOneChecked: 0, zeroOneMismatch: 0 };
      const configs: Array<[number, number, number, number]> = [
        [5, 7, 8, 6], [4, 9, 10, 5], [7, 5, 6, 8], [3, 3, 12, 12],
      ];
      for (const [cw, ch, cols, rows] of configs) {
        for (let rep = 0; rep < 6; rep++) {
          const atlas = makeAtlas(cw, ch, rng);
          const grid = makeGrid(cols, rows, atlas, rng);
          compare(grid, atlas, space, t);
        }
      }
      // The AA fringe must be sampled (else the ≤1 branch is vacuous) and so must α∈{0,1}.
      expect(t.total).toBeGreaterThan(100000);
      expect(t.zeroOneChecked).toBeGreaterThan(10000);
      // Hard criteria (SPEC §5.1): exact at α∈{0,1}, never off by more than 1 elsewhere.
      expect(t.zeroOneMismatch).toBe(0);
      expect(t.maxDelta).toBeLessThanOrEqual(1);
      // Mismatch fraction under the published bounds (gamma ≤ 1e-4, linear ≤ 2e-3); the f32
      // mirror sits far under (f64-pow-rounded is closer to the f64 ref than WGSL native pow).
      const frac = t.mismatch / t.total;
      expect(frac).toBeLessThanOrEqual(space === 'gamma' ? 1e-4 : 2e-3);
    });
  }

  it('packCells: last-wins glyph map, sentinel for null/unknown, per-space endpoint transform', () => {
    const rng = makeRng(0xda7a);
    const atlas = makeAtlas(4, 4, rng);
    const glyphIndex = buildGlyphIndex(atlas);
    // 'D' appears at indices 5 and 6 → last wins (6). ' ' at 0, '#' at 1.
    expect(glyphIndex.get('D')).toBe(6);
    expect(glyphIndex.get(' ')).toBe(0);
    expect(glyphIndex.get('#')).toBe(1);

    const cells: (GridCell | null)[] = [
      null,                                  // → sentinel + zero endpoints
      { ch: '?', fg: [10, 20, 30], bg: [40, 50, 60] }, // unknown ch → sentinel, endpoints kept
      { ch: 'D', fg: [200, 100, 0], bg: null },        // known → index 6, null bg → zeros
      { ch: '#', fg: null, bg: [7, 8, 9] },            // null fg → zeros
    ];
    const grid = { cols: 4, rows: 1, cells: cells as GridCell[], cellW: 4, cellH: 4, font: 't' } as Grid;

    const gamma = packCells(grid, glyphIndex, 'gamma');
    expect(gamma.glyphIdx[0]).toBe(RASTER_SENTINEL);
    expect(gamma.glyphIdx[1]).toBe(RASTER_SENTINEL);
    expect(gamma.glyphIdx[2]).toBe(6);
    expect(gamma.glyphIdx[3]).toBe(1);
    // null cell → all-zero endpoints.
    expect(Array.from(gamma.fgbg.slice(0, 6))).toEqual([0, 0, 0, 0, 0, 0]);
    // unknown ch keeps its endpoints (α≡0 makes the pixel the background).
    expect(Array.from(gamma.fgbg.slice(6, 12))).toEqual([10, 20, 30, 40, 50, 60]);
    // gamma endpoints are u8-as-f32; null bg → zeros.
    expect(Array.from(gamma.fgbg.slice(12, 18))).toEqual([200, 100, 0, 0, 0, 0]);
    expect(Array.from(gamma.fgbg.slice(18, 24))).toEqual([0, 0, 0, 7, 8, 9]);

    const linear = packCells(grid, glyphIndex, 'linear');
    // linear endpoints are f32(srgbToLinear(u8)).
    expect(linear.fgbg[6]).toBe(fr(srgbToLinear(10)));
    expect(linear.fgbg[9]).toBe(fr(srgbToLinear(40)));
    expect(linear.fgbg[12]).toBe(fr(srgbToLinear(200)));
    expect(linear.fgbg[15]).toBe(0); // null bg
  });

  it('buffer-realloc predicates key on the right dimension (precedent: needsCellBufferRealloc)', () => {
    // Cell buffers depend ONLY on numCells (glyphIdx/fgbg are per-cell, P-independent).
    expect(needsRasterCellRealloc(null, 100)).toBe(true);
    expect(needsRasterCellRealloc({ numCells: 100 }, 100)).toBe(false);
    expect(needsRasterCellRealloc({ numCells: 100 }, 140)).toBe(true);
    // Pixel buffers depend on the pixel count w·h.
    expect(needsRasterPixRealloc(null, 1000)).toBe(true);
    expect(needsRasterPixRealloc({ pixels: 1000 }, 1000)).toBe(false);
    expect(needsRasterPixRealloc({ pixels: 1000 }, 1400)).toBe(true);
  });
});
