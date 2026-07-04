import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildAtlas } from '../src/atlas/atlas.js';
import { matchGrid } from '../src/core/match.js';
import { linearToSrgb } from '../src/core/color.js';
import type { Atlas, MatchOptions, LinearImage, Grid } from '../src/core/types.js';

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';

function defaults(overrides: Partial<MatchOptions>): MatchOptions {
  return {
    quality: 3,
    edgeLambda: 0.35,
    gateTau: 2e-4,
    mdlLambda: 0.02,
    fixedBg: [0, 0, 0],
    fixedFg: [1, 1, 1],
    ...overrides,
  };
}

const u8 = (v: number) => Math.round(linearToSrgb(v));
const nearColor = (got: [number, number, number], want: [number, number, number], tol: number) =>
  got.every((c, i) => Math.abs(c - want[i]!) <= tol);

describe('AOV score-priors (M1-SPEC §3)', () => {
  let atlas: Atlas;
  beforeAll(async () => {
    atlas = await buildAtlas(FONT, 16, 'blocks');
  }, 60000);

  // ---- Test 3 (regression guard, written FIRST): defaults-off is bit-identical to M0 ----
  // The golden fixture was captured from matchGrid BEFORE the M1 extensions were added.
  // Regenerate the exact same input, run the extended matchGrid with all new options
  // absent, and require every cell to match the M0 output byte-for-byte.
  it('defaults-off output is bit-identical to the pre-extension M0 matchGrid', () => {
    const golden = JSON.parse(
      readFileSync(new URL('./fixtures/regression-grid.json', import.meta.url), 'utf8'),
    ) as { cols: number; rows: number; cellW: number; cellH: number; cells: Grid['cells'] };

    // must reproduce gen-fixture.ts EXACTLY (same PRNG, same call order).
    const mulberry32 = (seed: number) => () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const { cellW, cellH } = atlas;
    const cols = 6, rows = 3;
    const w = cols * cellW, h = rows * cellH;
    const data = new Float32Array(w * h * 3);
    const rnd = mulberry32(12345);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const cx = x / w, cy = y / h;
        const r = 0.2 + 0.6 * cx + 0.15 * Math.sin(cy * 6.28) + 0.05 * (rnd() - 0.5);
        const g = 0.2 + 0.6 * cy + 0.15 * Math.cos(cx * 6.28) + 0.05 * (rnd() - 0.5);
        const b = 0.5 + 0.3 * Math.sin((cx + cy) * 6.28) + 0.05 * (rnd() - 0.5);
        const i = (y * w + x) * 3;
        data[i] = Math.max(0, Math.min(1, r));
        data[i + 1] = Math.max(0, Math.min(1, g));
        data[i + 2] = Math.max(0, Math.min(1, b));
      }
    }
    const img: LinearImage = { w, h, data };

    const grid = matchGrid(img, atlas, defaults({ quality: 3 }));
    expect(grid.cols).toBe(golden.cols);
    expect(grid.rows).toBe(golden.rows);
    expect(grid.cells).toEqual(golden.cells);

    // and: options present-but-off must equal options absent (no zero-weight leakage).
    const objectId = new Uint16Array(w * h).fill(1);
    const shadingLuma = new Float32Array(w * h).fill(0.5);
    const off = matchGrid(img, atlas, defaults({
      quality: 3,
      splitSelection: 0,
      antibleedKappa: 0,
      styleAlbedoColors: false,
      aov: { shadingLuma, objectId },
    }));
    expect(off.cells).toEqual(golden.cells);
  });

  // ---- Test 1 (anti-bleed) ----
  // One cell: left/right halves = two flat object colors A|B, objectId split the same
  // way. A top/bright/bottom/dark luma perturbation (magnitude > the A|B contrast) makes
  // a NON-vertical-split glyph win the base scan. With κ on, the boundary-cell object-id
  // correlation bonus flips selection to the vertical half-block family, whose fg/bg then
  // resolve to the two object colors instead of a smeared average.
  it('anti-bleed: κ flips a boundary cell to the vertical half-block matching the object partition', () => {
    const A: [number, number, number] = [0.5, 0.35, 0.35];
    const B: [number, number, number] = [0.35, 0.35, 0.5];
    const s = 0.15;
    const { cellW, cellH } = atlas;
    const w = cellW, h = cellH;
    const data = new Float32Array(w * h * 3);
    const objectId = new Uint16Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const left = x * 2 < cellW;
        const top = y * 2 < cellH;
        const col = left ? A : B;
        const d = top ? s : -s; // ± perturbation cancels over each half → mean stays A / B
        const i = (y * w + x) * 3;
        data[i] = col[0] + d; data[i + 1] = col[1] + d; data[i + 2] = col[2] + d;
        objectId[y * w + x] = left ? 1 : 2;
      }
    }
    const img: LinearImage = { w, h, data };

    // linear working space so the per-half mean encodes cleanly back to the source color.
    const base = matchGrid(img, atlas, defaults({ space: 'linear' })).cells[0]!;
    const anti = matchGrid(img, atlas, defaults({
      space: 'linear', antibleedKappa: 2, aov: { objectId },
    })).cells[0]!;

    // OFF: base scan is pulled to the horizontal (top/bottom) structure, NOT a vertical split.
    expect(['▌', '▐']).not.toContain(base.ch);
    // ON: κ selects the vertical half-block family aligned with the object partition.
    expect(['▌', '▐']).toContain(anti.ch);

    // and its two colors reconstruct the two object colors (not an averaged smear).
    const expA: [number, number, number] = [u8(A[0]), u8(A[1]), u8(A[2])];
    const expB: [number, number, number] = [u8(B[0]), u8(B[1]), u8(B[2])];
    const fg = anti.fg!, bg = anti.bg!;
    const matched =
      (nearColor(fg, expA, 6) && nearColor(bg, expB, 6)) ||
      (nearColor(fg, expB, 6) && nearColor(bg, expA, 6));
    expect(matched).toBe(true);
  });

  // ---- Test 2 (splitSelection) ----
  // img RGB carry vertical-stripe "albedo texture" (a non-horizontal structure); the
  // separate shadingLuma buffer is a clean top-bright/bottom-dark split. η=0 selects a
  // vertical stripe-matching glyph; η>0 adds the shading-luma channel and flips selection
  // to the horizontal half-block aligned with the light.
  it('splitSelection: η pulls glyph choice toward the shading structure, away from albedo texture', () => {
    const { cellW, cellH } = atlas;
    const w = cellW, h = cellH;
    const data = new Float32Array(w * h * 3);
    const shadingLuma = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = x % 2 === 0 ? 0.85 : 0.15; // vertical stripes in the shaded RGB
        const i = (y * w + x) * 3;
        data[i] = v; data[i + 1] = v; data[i + 2] = v;
        shadingLuma[y * w + x] = y * 2 < cellH ? 1 : 0; // clean top/bottom light split
      }
    }
    const img: LinearImage = { w, h, data };

    const base = matchGrid(img, atlas, defaults({})).cells[0]!;
    const split = matchGrid(img, atlas, defaults({
      splitSelection: 0.5, aov: { shadingLuma },
    })).cells[0]!;

    // OFF: a vertical (stripe-matching) glyph, NOT a horizontal half-block.
    expect(['▀', '▄']).not.toContain(base.ch);
    // ON: the shading channel flips selection to the horizontal half-block.
    expect(['▀', '▄']).toContain(split.ch);
  });

  // ---- styleAlbedoColors (stylization variant, colors only) ----
  // The SELECTED glyph is unchanged, but fg/bg are refit against the albedo patch, so the
  // emitted colors track the albedo — not the (differently-lit) shaded reference.
  it('styleAlbedoColors: recolors the selected glyph from the albedo buffer, glyph unchanged', () => {
    const { cellW, cellH } = atlas;
    const w = cellW, h = cellH;
    // shaded: top white / bottom black → selects a half-block (drives glyph choice).
    // albedo: a single uniform material color, distinct from the white/black shading.
    const albc: [number, number, number] = [0.6, 0.3, 0.05];
    const data = new Float32Array(w * h * 3);
    const alb = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        const v = y * 2 < cellH ? 1 : 0;
        data[i] = v; data[i + 1] = v; data[i + 2] = v;
        alb[i] = albc[0]; alb[i + 1] = albc[1]; alb[i + 2] = albc[2];
      }
    }
    const img: LinearImage = { w, h, data };
    const albedo: LinearImage = { w, h, data: alb };

    const plain = matchGrid(img, atlas, defaults({ space: 'linear' })).cells[0]!;
    const styled = matchGrid(img, atlas, defaults({
      space: 'linear', styleAlbedoColors: true, aov: { albedo },
    })).cells[0]!;

    // glyph unchanged (the shaded structure still drives selection).
    expect(styled.ch).toBe(plain.ch);
    expect(['▀', '▄']).toContain(styled.ch);

    // plain fg/bg encode the white/black shaded halves; styling replaces BOTH with the
    // uniform albedo color (a constant target ⇒ fg ≈ bg ≈ the material color).
    const white: [number, number, number] = [255, 255, 255];
    const exp: [number, number, number] = [u8(albc[0]), u8(albc[1]), u8(albc[2])];
    expect(nearColor(plain.fg!, white, 1) || nearColor(plain.bg!, white, 1)).toBe(true);
    expect(nearColor(styled.fg!, exp, 2)).toBe(true);
    expect(nearColor(styled.bg!, exp, 2)).toBe(true);
  });
});
