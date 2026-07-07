import { describe, it, expect } from 'vitest';
import { matchGrid } from '../src/core/match.js';
import { linearToSrgb } from '../src/core/color.js';
import type { Atlas, Glyph, LinearImage, MatchOptions } from '../src/core/types.js';

// Round P — P0 gate-contract fix. The contrast gate promises to be a COMPUTE-SAVER
// ONLY: for a flat cell the gated emit must equal the FULL exhaustive scan's argmin
// under the quality's colour constraints. Pre-P0 this held only for Q3+ (bg free); at
// Q1/Q2 the gate snapped every flat cell to space-on-black, a contract violation. These
// tests build a tiny synthetic atlas (full control of sumA/sumAA), force the gate on/off
// via gateTau, and assert the flat-cell contract now holds at Q1 and Q2 too.
//
// New test file — no existing test is modified.

function glyph(ch: string, cp: number, alpha: number[]): Glyph {
  const P = alpha.length;
  let sumA = 0, sumAA = 0;
  for (const v of alpha) { sumA += v; sumAA += v * v; }
  // dxA/dyA/gradAA/ink are only consumed at Q4/orientation (off here) and by the MDL
  // term (× E_AC = 0 on flat cells), so zeros are exact for these Q1/Q2 flat-cell tests.
  return { ch, cp, alpha: new Float32Array(alpha), dxA: new Float32Array(P), dyA: new Float32Array(P), sumA, sumAA, gradAA: 0, ink: 0 };
}

// 3×3 cell (P=9). glyphs[0] is space (sumAA=0). Distinct sumA²/sumAA ratios so the Q2
// argmax and Q1 argmin are unambiguous. '#' (full block) is the unique constant-α glyph.
function atlasWithFullBlock(): Atlas {
  const glyphs: Glyph[] = [
    glyph(' ', 0x20, [0, 0, 0, 0, 0, 0, 0, 0, 0]),                 // space, ratio n/a
    glyph('#', 0x23, [1, 1, 1, 1, 1, 1, 1, 1, 1]),                 // full block, ratio 9
    glyph('=', 0x3d, [1, 1, 1, 1, 1, 1, 0, 0, 0]),                 // top 2/3, ratio 6
    glyph('-', 0x2d, [1, 1, 1, 0, 0, 0, 0, 0, 0]),                 // top 1/3, ratio 3
    glyph('.', 0x2e, [0.5, 0.5, 0.5, 0.2, 0.2, 0.2, 0, 0, 0]),     // graded, ratio ≈ 5.07
    glyph('o', 0x6f, [0.8, 0.8, 0.8, 0.4, 0.4, 0.4, 0.1, 0.1, 0.1]), // graded, ratio ≈ 6.26
  ];
  return { cellW: 3, cellH: 3, P: 9, fontPath: 'synthetic', fontSize: 9, ascent: 7, glyphs, inkMin: 0, inkMax: 1 };
}

// Same, minus the full block — forces the Q2 gated winner to be a PARTIAL glyph whose
// fg is scaled UP (fg_c = m·sumA/sumAA, s = sumA/sumAA > 1).
function atlasNoFullBlock(): Atlas {
  const a = atlasWithFullBlock();
  return { ...a, glyphs: a.glyphs.filter((g) => g.ch !== '#') };
}

// one row, one cell per colour, each cell perfectly flat (all P pixels identical).
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

function opts(quality: 0 | 1 | 2 | 3 | 4, space: 'linear' | 'gamma', gateTau: number): MatchOptions {
  return { quality, space, edgeLambda: 0.35, gateTau, mdlLambda: 0.02, fixedBg: [0, 0, 0], fixedFg: [1, 1, 1] };
}

// Pure black is intentionally excluded from the equality sweep: at m=0 the flat SSE is
// exactly 0 for BOTH space and the full block, so "the argmin" is a non-unique tie the
// exhaustive scan breaks to space (gi 0) and the closed form breaks to the densest glyph
// — both valid argmins, identical raster. Black is covered by the Q1 ramp test (no tie).
const GRAYS: [number, number, number][] = [
  [0.1, 0.1, 0.1], [0.25, 0.25, 0.25], [0.4, 0.4, 0.4], [0.5, 0.5, 0.5],
];
const COLORED: [number, number, number][] = [[0.3, 0.1, 0.05], [0.05, 0.4, 0.2], [0.2, 0.2, 0.45]];

describe('P0 gate contract — gated flat cell equals the full exhaustive scan (Q1/Q2)', () => {
  const atlas = atlasWithFullBlock();
  const img = flatImage(atlas, [...GRAYS, ...COLORED]);

  // The contract, now actually true at Q1/Q2: gate ON (τ=1, fires on every flat cell,
  // E_AC=0) must equal gate OFF (τ=−1, never fires → exhaustive scan) cell-for-cell.
  for (const space of ['gamma', 'linear'] as const) {
    for (const q of [1, 2] as const) {
      it(`Q${q} ${space}: gate-on grid == full-scan grid, cell-for-cell`, () => {
        const gated = matchGrid(img, atlas, opts(q, space, 1));
        const scan = matchGrid(img, atlas, opts(q, space, -1));
        expect(gated.cells).toEqual(scan.cells);
      });
    }
  }

  // Q1 ramp behaviour emerges from the closed form: a pure-black flat cell selects space
  // (lowest ink), a pure-white flat cell selects the densest glyph (full block). Pre-P0
  // BOTH gated to space — so the white assertion is the P0 fix made visible.
  for (const space of ['gamma', 'linear'] as const) {
    it(`Q1 ${space}: black flat → space, white flat → densest glyph (gate ON)`, () => {
      const g = matchGrid(flatImage(atlas, [[0, 0, 0], [1, 1, 1]]), atlas, opts(1, space, 1));
      expect(g.cells[0]!.ch).toBe(' ');
      expect(g.cells[1]!.ch).toBe('#');
    });
  }

  // Q2 gated emits the densest glyph filled at the cell mean (not space-on-black). Hand
  // checked in gamma: fg u8 = round(linearToSrgb(m)); bg = fixed black.
  it('Q2 gamma: gated flat gray emits full block + fg=mean (not space/black)', () => {
    const m = 0.3;
    const g = matchGrid(flatImage(atlas, [[m, m, m]]), atlas, opts(2, 'gamma', 1)).cells[0]!;
    expect(g.ch).toBe('#');
    const expFg = Math.round(linearToSrgb(m));
    for (const v of g.fg!) expect(Math.abs(v - expFg)).toBeLessThanOrEqual(1);
    expect(g.bg).toEqual([0, 0, 0]);
  });
});

describe('P0 gate contract — Q2 with no full block scales fg (fg_c = m·sumA/sumAA)', () => {
  const atlas = atlasNoFullBlock();
  // m small enough that the winning glyph's F=m·sumA/sumAA does not clamp (s≈1.6 → m·s<1).
  const img = flatImage(atlas, [[0.4, 0.2, 0.1], [0.3, 0.3, 0.3]]);

  it('gate-on == full-scan, and the gated fg is the coverage-scaled mean', () => {
    const gated = matchGrid(img, atlas, opts(2, 'linear', 1));
    const scan = matchGrid(img, atlas, opts(2, 'linear', -1));
    expect(gated.cells).toEqual(scan.cells);
    // winner is a partial-coverage glyph (not space): fg is scaled UP past the raw mean.
    const cell = gated.cells[0]!;
    expect(cell.ch).not.toBe(' ');
    const wg = atlas.glyphs.find((g) => g.ch === cell.ch)!;
    const s = wg.sumA / wg.sumAA;
    expect(s).toBeGreaterThan(1);
    // channel 0: linear mean 0.4 → fg u8 = round(linearToSrgb(0.4·s)), clearly > round(linearToSrgb(0.4)).
    expect(cell.fg![0]).toBeGreaterThan(Math.round(linearToSrgb(0.4)));
  });
});

describe('P0 gate contract — gateTau actually engages the gate (non-vacuous)', () => {
  const atlas = atlasWithFullBlock();
  // A STRUCTURED cell (top row white, rest black): E_AC > 0. A high τ gates it (→ flat
  // closed-form: full block at the cell mean); τ=−1 runs the scan (→ the top-1/3 shape).
  // They MUST differ — proof the gate branch is what τ toggles, so the flat-cell equality
  // tests above are not both silently running the full scan.
  function structured(): LinearImage {
    const { cellW, cellH } = atlas;
    const w = cellW, h = cellH;
    const data = new Float32Array(w * h * 3);
    for (let ly = 0; ly < cellH; ly++) for (let lx = 0; lx < cellW; lx++) {
      const v = ly === 0 ? 1 : 0;
      const gi = (ly * w + lx) * 3;
      data[gi] = v; data[gi + 1] = v; data[gi + 2] = v;
    }
    return { w, h, data };
  }

  it('Q2 structured cell: high τ (gated flat) differs from τ=−1 (full scan shape)', () => {
    const img = structured();
    const gated = matchGrid(img, atlas, opts(2, 'linear', 10)).cells[0]!;
    const scan = matchGrid(img, atlas, opts(2, 'linear', -1)).cells[0]!;
    expect(gated.ch).toBe('#');        // gated → densest glyph at the cell mean
    expect(scan.ch).toBe('-');         // scan → the exact top-1/3 shape
    expect(gated.ch).not.toBe(scan.ch);
  });
});
