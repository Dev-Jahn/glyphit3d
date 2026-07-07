import { describe, it, expect } from 'vitest';
import { matchGrid } from '../src/core/match.js';
import type { Atlas, Glyph, LinearImage, MatchOptions } from '../src/core/types.js';

// Round P — P0 gate-contract REGRESSION tests for the two regimes the original
// gate-contract.test.ts deliberately avoids, both confirmed defects of the first P0
// implementation:
//   (1) Q2 bright/saturated flat cells where the densest-ratio glyph's fitted fg clamps
//       (fg_c = m·sumA/sumAA > 1). The old closed form fixed the glyph to argmax
//       sumA²/sumAA, but the full scan scores each glyph with the CLAMPED fg, so the
//       full-scan argmin can flip to a different glyph.
//   (2) Q1/Q2 flat cells with a NONZERO fixedBg. The old closed forms were derived with
//       fbg=0 and dropped every fbg term, so they diverged from the full scan (which uses
//       fbg) — the gate stopped being a pure compute-saver.
// The gate's contract is "compute-saver only": on a flat cell the gated emit MUST equal
// the full exhaustive scan's argmin. These sweeps assert that now holds in both regimes.
//
// New test file — no existing test is modified.

function glyph(ch: string, cp: number, alpha: number[]): Glyph {
  const P = alpha.length;
  let sumA = 0, sumAA = 0;
  for (const v of alpha) { sumA += v; sumAA += v * v; }
  return { ch, cp, alpha: new Float32Array(alpha), dxA: new Float32Array(P), dyA: new Float32Array(P), sumA, sumAA, gradAA: 0, ink: 0 };
}

// Same 3×3 synthetic atlas as gate-contract.test.ts. Ratios (sumA²/sumAA): '#'=9, '='=6,
// '-'=3, '.'≈5.07, 'o'≈6.26. glyphs[0] is space.
function atlasWithFullBlock(): Atlas {
  const glyphs: Glyph[] = [
    glyph(' ', 0x20, [0, 0, 0, 0, 0, 0, 0, 0, 0]),
    glyph('#', 0x23, [1, 1, 1, 1, 1, 1, 1, 1, 1]),
    glyph('=', 0x3d, [1, 1, 1, 1, 1, 1, 0, 0, 0]),
    glyph('-', 0x2d, [1, 1, 1, 0, 0, 0, 0, 0, 0]),
    glyph('.', 0x2e, [0.5, 0.5, 0.5, 0.2, 0.2, 0.2, 0, 0, 0]),
    glyph('o', 0x6f, [0.8, 0.8, 0.8, 0.4, 0.4, 0.4, 0.1, 0.1, 0.1]),
  ];
  return { cellW: 3, cellH: 3, P: 9, fontPath: 'synthetic', fontSize: 9, ascent: 7, glyphs, inkMin: 0, inkMax: 1 };
}
// No full block — the densest glyph 'o' has s = sumA/sumAA ≈ 1.605 > 1, so a bright flat
// cell drives its fitted fg past 1 and clamps.
function atlasNoFullBlock(): Atlas {
  const a = atlasWithFullBlock();
  return { ...a, glyphs: a.glyphs.filter((g) => g.ch !== '#') };
}

function flatImage(atlas: Atlas, colors: [number, number, number][]): LinearImage {
  const { cellW, cellH } = atlas;
  const cols = colors.length;
  const w = cols * cellW, h = cellH;
  const data = new Float32Array(w * h * 3);
  for (let col = 0; col < cols; col++) {
    const [r, g, b] = colors[col]!;
    for (let ly = 0; ly < cellH; ly++) for (let lx = 0; lx < cellW; lx++) {
      const gi = (ly * w + (col * cellW + lx)) * 3;
      data[gi] = r; data[gi + 1] = g; data[gi + 2] = b;
    }
  }
  return { w, h, data };
}

function opts(
  quality: 1 | 2, space: 'linear' | 'gamma', gateTau: number,
  fixedBg: [number, number, number] = [0, 0, 0], fixedFg: [number, number, number] = [1, 1, 1],
): MatchOptions {
  return { quality, space, edgeLambda: 0.35, gateTau, mdlLambda: 0.02, fixedBg, fixedFg };
}

// gate ON (τ=1 fires on every flat cell, E_AC=0) must equal gate OFF (τ=−1 → exhaustive
// scan) cell-for-cell.
function assertGateEqualsFullScan(img: LinearImage, atlas: Atlas, o: (tau: number) => MatchOptions): void {
  const gated = matchGrid(img, atlas, o(1));
  const scan = matchGrid(img, atlas, o(-1));
  expect(gated.cells).toEqual(scan.cells);
}

describe('P0 gate contract — Q2 clamp regime (bright/saturated flat cells, no full block)', () => {
  const atlas = atlasNoFullBlock();
  // Bright + saturated flats: at these means the densest glyph 'o' (s≈1.605) fits fg>1 and
  // clamps, so a constant-glyph closed form is NOT the full-scan argmin.
  const BRIGHT: [number, number, number][] = [
    [0.7, 0.7, 0.7], [0.9, 0.9, 0.9], [1, 1, 1],
    [0.95, 0.2, 0.1], [0.1, 0.9, 0.4], [0.85, 0.85, 0.3],
  ];
  const img = flatImage(atlas, BRIGHT);

  for (const space of ['linear', 'gamma'] as const) {
    it(`Q2 ${space}: gated == full scan across the clamp regime`, () => {
      assertGateEqualsFullScan(img, atlas, (tau) => opts(2, space, tau));
    });
  }

  // The reviewer's exact counterexample: a flat gray m=0.9 in linear space. The old closed
  // form emitted 'o' (argmax ratio); the full scan picks '=' (its unclamped fg beats o's
  // clamped fg). The fixed gate must agree with the full scan and pick '='.
  it("Q2 linear m=0.9: gated winner == full-scan winner == '=' (not the argmax-ratio 'o')", () => {
    const one = flatImage(atlas, [[0.9, 0.9, 0.9]]);
    const gated = matchGrid(one, atlas, opts(2, 'linear', 1)).cells[0]!;
    const scan = matchGrid(one, atlas, opts(2, 'linear', -1)).cells[0]!;
    expect(gated).toEqual(scan);
    expect(gated.ch).toBe('=');
  });
});

describe('P0 gate contract — nonzero fixedBg (gate must still equal the full scan)', () => {
  const withBlock = atlasWithFullBlock();
  const noBlock = atlasNoFullBlock();
  const FBG: [number, number, number] = [0.5, 0.5, 0.5];
  // m == fbg on every channel is intentionally excluded: there the fitted residual is zero
  // for ALL glyphs (each fits fg = bg = the mean → SSE 0), a non-unique argmin the full scan
  // breaks by fp noise while the closed form breaks to space — both valid, identical raster
  // (same rule the base test applies to pure black at fbg=0). Every color below has m ≠ fbg.
  const FLATS: [number, number, number][] = [
    [0.2, 0.2, 0.2], [0.7, 0.7, 0.7], [0.85, 0.85, 0.85],
    [0.3, 0.6, 0.75], [0.9, 0.1, 0.5],
  ];

  for (const space of ['linear', 'gamma'] as const) {
    for (const q of [1, 2] as const) {
      for (const [name, atlas] of [['withBlock', withBlock], ['noBlock', noBlock]] as const) {
        it(`Q${q} ${space} ${name} fbg=[.5,.5,.5]: gated == full scan`, () => {
          const img = flatImage(atlas, FLATS);
          assertGateEqualsFullScan(img, atlas, (tau) => opts(q, space, tau, FBG));
        });
      }
    }
  }

  // Pinned non-tie divergence for the Q1 fbg defect: ffg=[1,1,1], fbg=[.5,.5,.5], flat
  // m=[.7,.7,.7], full-block atlas, linear. Full-scan argmin is '.'; the old fbg-free closed
  // form picked '#'. The fixed gate must pick '.'.
  it("Q1 linear fbg=[.5,.5,.5] m=0.7: gated winner == full-scan winner == '.' (not '#')", () => {
    const img = flatImage(withBlock, [[0.7, 0.7, 0.7]]);
    const gated = matchGrid(img, withBlock, opts(1, 'linear', 1, FBG)).cells[0]!;
    const scan = matchGrid(img, withBlock, opts(1, 'linear', -1, FBG)).cells[0]!;
    expect(gated).toEqual(scan);
    expect(gated.ch).toBe('.');
  });
});
