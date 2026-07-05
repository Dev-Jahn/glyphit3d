import { describe, it, expect, beforeAll } from 'vitest';
import { buildAtlas } from '../src/atlas/atlas.js';
import { matchGrid, contourPostPass } from '../src/core/match.js';
import { extractPolylines, viterbiContour } from '../src/core/contour.js';
import { borderProfiles } from '../src/atlas/orientation.js';
import { srgbToLinear } from '../src/core/color.js';
import type { Atlas, MatchOptions, LinearImage } from '../src/core/types.js';

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';

function opts(over: Partial<MatchOptions>): MatchOptions {
  return {
    quality: 3, space: 'gamma', edgeLambda: 0.35, gateTau: 2e-5, mdlLambda: 0.02,
    fixedBg: [0, 0, 0], fixedFg: [1, 1, 1], ...over,
  };
}

// mulberry32 (matches the families golden generator) for a structured multi-cell image.
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('CONTOUR-INT: matchGrid topK hook (M3-SPEC §3.4)', () => {
  let atlas: Atlas;
  beforeAll(async () => { atlas = await buildAtlas(FONT, 16, 'blocks'); }, 60000);

  function structuredImage(cols: number, rows: number): LinearImage {
    const { cellW, cellH } = atlas;
    const w = cols * cellW, h = rows * cellH;
    const data = new Float32Array(w * h * 3);
    const rnd = mulberry32(4242);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const cx = x / w, cy = y / h;
      const r = 0.2 + 0.6 * cx + 0.15 * Math.sin(cy * 6.28) + 0.05 * (rnd() - 0.5);
      const g = 0.2 + 0.6 * cy + 0.15 * Math.cos(cx * 6.28) + 0.05 * (rnd() - 0.5);
      const b = 0.5 + 0.3 * Math.sin((cx + cy) * 6.28) + 0.05 * (rnd() - 0.5);
      const i = (y * w + x) * 3;
      data[i] = Math.max(0, Math.min(1, r));
      data[i + 1] = Math.max(0, Math.min(1, g));
      data[i + 2] = Math.max(0, Math.min(1, b));
    }
    return { w, h, data };
  }

  // §3.4 requires topK to be a pure OBSERVER: emitting candidates must not perturb the
  // grid. The default-off path is already covered by the families golden; here we assert
  // topK ON reproduces the topK OFF grid cell-for-cell, and that cands is dense.
  it('topK on is byte-identical to topK off (candidates are a pure add-on)', () => {
    const img = structuredImage(6, 3);
    const off = matchGrid(img, atlas, opts({}));
    const on = matchGrid(img, atlas, opts({ topK: 8 }));
    expect(off.cands).toBeUndefined();
    expect(on.cands).toBeDefined();
    expect(on.cands!.length).toBe(on.cols * on.rows);
    for (let i = 0; i < on.cands!.length; i++) expect(on.cands![i]).toBeDefined(); // dense
    expect(on.cells).toEqual(off.cells);
  });

  // Each candidate list is sorted best-first, capped at K, and its head reproduces the
  // emitted cell exactly (same glyph, same encoded colors) — so the contour post-pass
  // reading cand[0] is a no-op relative to the greedy winner.
  it('candidate lists are sorted, ≤K, and cand[0] reproduces the emitted winner', () => {
    const img = structuredImage(6, 3);
    const K = 8;
    const g = matchGrid(img, atlas, opts({ topK: K }));
    for (let i = 0; i < g.cells.length; i++) {
      const list = g.cands![i]!;
      expect(list.length).toBeGreaterThanOrEqual(1);
      expect(list.length).toBeLessThanOrEqual(K);
      for (let r = 1; r < list.length; r++) expect(list[r]!.score).toBeGreaterThanOrEqual(list[r - 1]!.score);
      const cell = g.cells[i]!;
      expect(atlas.glyphs[list[0]!.glyphIdx]!.ch).toBe(cell.ch);      // head glyph == emitted glyph
      if (cell.fg) expect(list[0]!.F).toEqual(cell.fg);               // head colors == emitted colors
      expect(list[0]!.B).toEqual(cell.bg);
    }
  });
});

// ============================================================================
// §3.6 DP scenario, driven end-to-end through the REAL matchGrid topK path.
// A straight vertical contour of ▚/▞-checker cells: the 2-colour fit treats ▚ and
// ▞ as a near-tie (they partition the cell into the same two groups), so matchGrid's
// greedy argmin picks ONE of them UNIFORMLY down the whole column — a discontinuous
// stack. The contour Viterbi, using the border-continuity pairwise cost, flips
// alternate cells so the strokes chain into a continuous zigzag. Greedy cannot
// produce this; the DP does, in both traversal directions.
// ============================================================================
describe('CONTOUR-INT: §3.6 DP through real matchGrid (M3-SPEC §3.4/§3.6)', () => {
  let atlas: Atlas;
  beforeAll(async () => { atlas = await buildAtlas(FONT, 16, 'blocks'); }, 60000);

  const COLS = 3, ROWS = 6;
  function checkerScene() {
    const { cellW, cellH } = atlas;
    const w = COLS * cellW, h = ROWS * cellH;
    const data = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = 0.5;
      if (Math.floor(x / cellW) === 0) { // column 0 = the silhouette-boundary checker cells
        const lx = x % cellW, ly = y % cellH;
        const left = lx < cellW / 2, top = ly < cellH / 2;
        v = ((top && left) || (!top && !left)) ? 0.95 : 0.05; // ▚ diagonal (TL+BR bright)
      }
      const i = (y * w + x) * 3; data[i] = v; data[i + 1] = v; data[i + 2] = v;
    }
    const coverage = new Float32Array(COLS * ROWS);
    for (let r = 0; r < ROWS; r++) coverage[r * COLS + 0] = 1; // inside = column 0
    return { img: { w, h, data } as LinearImage, coverage };
  }

  it('greedy picks a uniform stack; Viterbi flips it to a continuous alternating chain', () => {
    const { img, coverage } = checkerScene();
    const chain = extractPolylines(coverage, COLS, ROWS, 0.5)[0]!;
    expect(chain).toEqual([0, 3, 6, 9, 12, 15]); // straight vertical column-0 contour

    const greedyGrid = matchGrid(img, atlas, opts({ topK: 8 }));
    const greedy = chain.map((i) => greedyGrid.cells[i]!.ch);
    // both candidates are quadrant diagonals, and greedy is UNIFORM (one wins every cell).
    for (const ch of greedy) expect(['▚', '▞']).toContain(ch);
    expect(new Set(greedy).size).toBe(1);

    // κ_c = 0 → Viterbi keeps the greedy argmin (no-op).
    const g0 = matchGrid(img, atlas, opts({ topK: 8 }));
    contourPostPass(g0, atlas, coverage, 0);
    expect(chain.map((i) => g0.cells[i]!.ch)).toEqual(greedy);

    // κ_c large → continuous zigzag: strictly alternating over exactly {▚,▞}, ≠ greedy.
    const gc = matchGrid(img, atlas, opts({ topK: 8 }));
    contourPostPass(gc, atlas, coverage, 2);
    const dp = chain.map((i) => gc.cells[i]!.ch);
    expect(new Set(dp)).toEqual(new Set(['▚', '▞']));
    for (let i = 1; i < dp.length; i++) expect(dp[i]).not.toBe(dp[i - 1]); // adjacent differ
    expect(dp).not.toEqual(greedy);

    // every DP choice is drawn from that cell's own candidate set (contourPostPass
    // mutates cells but leaves cands intact, so gc.cands is still the pre-pass list).
    for (const i of chain) {
      const chosen = gc.cells[i]!.ch;
      const allowed = gc.cands![i]!.map((c) => atlas.glyphs[c.glyphIdx]!.ch);
      expect(allowed).toContain(chosen);
    }
  });

  it('the contour pass is deterministic and direction-agnostic', () => {
    const { img, coverage } = checkerScene();
    const chain = extractPolylines(coverage, COLS, ROWS, 0.5)[0]!;
    const profiles = borderProfiles(atlas);

    const a = matchGrid(img, atlas, opts({ topK: 8 }));
    contourPostPass(a, atlas, coverage, 2);
    const b = matchGrid(img, atlas, opts({ topK: 8 }));
    contourPostPass(b, atlas, coverage, 2);
    expect(a.cells).toEqual(b.cells); // deterministic

    // Viterbi over the same candidates in both directions gives identical per-cell choices.
    const cands = matchGrid(img, atlas, opts({ topK: 8 })).cands!;
    const fwd = viterbiContour(chain, cands, profiles, COLS, 2);
    const rev = viterbiContour([...chain].reverse(), cands, profiles, COLS, 2);
    for (const i of chain) expect(rev.get(i)!.glyphIdx).toBe(fwd.get(i)!.glyphIdx);
  });

  it('contourPostPass requires topK candidates', () => {
    const { img, coverage } = checkerScene();
    const g = matchGrid(img, atlas, opts({})); // no topK
    expect(() => contourPostPass(g, atlas, coverage, 2)).toThrow(/topK/);
  });
});

// ============================================================================
// §3.4 cands fix: contourPostPass must reproduce EVERY winner kind at κ_c=0, and
// preserve fg:null. Pre-fix, family/collapse winners' cands leaked the text topK
// list so the pass reverted them, and gated/collapsed fg:null regained a phantom fg.
// ============================================================================
describe('CONTOUR-INT: §3.4 cands fix — family/collapse/gated winners survive the pass', () => {
  let atlas: Atlas;
  beforeAll(async () => { atlas = await buildAtlas(FONT, 16, 'blocks'); }, 60000);

  // 2-col scene: col 0 is the structured "inside" column (its per-cell fill drives the
  // winner kind), col 1 is flat "outside". coverage = col-0 inside → col 0 is a vertical
  // boundary polyline, so contourPostPass rewrites exactly those cells from their cand[0].
  const COLS = 2, ROWS = 6;
  function scene(fill0: (lx: number, ly: number) => number, fill1 = 0.5) {
    const { cellW, cellH } = atlas;
    const w = COLS * cellW, h = ROWS * cellH;
    const data = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const col = Math.floor(x / cellW);
      const v = col === 0 ? fill0(x % cellW, y % cellH) : fill1;
      const i = (y * w + x) * 3; data[i] = v; data[i + 1] = v; data[i + 2] = v;
    }
    const coverage = new Float32Array(COLS * ROWS);
    for (let r = 0; r < ROWS; r++) coverage[r * COLS + 0] = 1; // inside = col 0
    return { img: { w, h, data } as LinearImage, coverage };
  }
  // bright-dot 2×4 braille lattice (dark gaps) — braille strictly reconstructs it.
  function brailleLattice(lx: number, ly: number): number {
    const { cellW, cellH } = atlas;
    const r2 = (0.21 * cellW) ** 2;
    const cx = [0.25 * cellW, 0.75 * cellW], cy = [0.125 * cellH, 0.375 * cellH, 0.625 * cellH, 0.875 * cellH];
    for (const X of cx) for (const Y of cy) if ((lx + 0.5 - X) ** 2 + (ly + 0.5 - Y) ** 2 <= r2) return 0.95;
    return 0.05;
  }

  it('family wins are NOT reverted by contourPostPass(κ_c=0)', () => {
    const { img, coverage } = scene(brailleLattice);
    const g = matchGrid(img, atlas, opts({ families: ['braille'], topK: 8 }));
    const chain = extractPolylines(coverage, COLS, ROWS, 0.5)[0]!;
    expect(chain).toEqual([0, 2, 4, 6, 8, 10]); // col-0 vertical contour
    // the column really did emit family (braille U+2800..28FF) glyphs — else no coverage.
    const brailleCells = chain.filter((i) => { const cp = g.cells[i]!.ch.codePointAt(0)!; return cp >= 0x2800 && cp <= 0x28ff; });
    expect(brailleCells.length).toBeGreaterThan(0);

    const before = structuredClone(g.cells);
    contourPostPass(g, atlas, coverage, 0);
    expect(g.cells).toEqual(before); // byte-identical: family cands are single forced entries
  });

  it('invisibility-collapse winners are NOT resurrected by contourPostPass(κ_c=0)', () => {
    // faint 128/140 half-split → passes the gate, a half-block wins, |F−B|≈12 < 16 → collapse.
    const half = Math.floor(atlas.cellH / 2);
    const top = srgbToLinear(128), bot = srgbToLinear(140);
    const { img, coverage } = scene((_lx, ly) => (ly < half ? top : bot));
    const g = matchGrid(img, atlas, opts({ collapseThreshold: 16, topK: 8 }));
    const chain = extractPolylines(coverage, COLS, ROWS, 0.5)[0]!;
    // every col-0 cell collapsed to a space with fg:null (Q3 flat-fill convention).
    for (const i of chain) { expect(g.cells[i]!.ch).toBe(' '); expect(g.cells[i]!.fg).toBeNull(); }

    const before = structuredClone(g.cells);
    contourPostPass(g, atlas, coverage, 0);
    expect(g.cells).toEqual(before); // collapsed space (fg:null) preserved, glyph not resurrected
  });

  it('a gated boundary cell keeps fg:null through contourPostPass', () => {
    const { img, coverage } = scene(() => 0.5, 0.1); // col 0 flat gray → gate fires → space, fg null
    const g = matchGrid(img, atlas, opts({ topK: 8 }));
    const chain = extractPolylines(coverage, COLS, ROWS, 0.5)[0]!;
    for (const i of chain) { expect(g.cells[i]!.ch).toBe(' '); expect(g.cells[i]!.fg).toBeNull(); }
    contourPostPass(g, atlas, coverage, 0);
    for (const i of chain) expect(g.cells[i]!.fg).toBeNull(); // no phantom fg from the flat mean
  });
});

// ============================================================================
// §3.3 orientation prior, driven in-scan through the REAL matchGrid path.
// ============================================================================
describe('CONTOUR-INT: §3.3 orientation prior in matchGrid', () => {
  let atlas: Atlas;
  beforeAll(async () => { atlas = await buildAtlas(FONT, 16, 'blocks'); }, 60000);

  // A single cell straddling a ╲-oriented silhouette edge (bright below the x=y line).
  function diagCell(): { img: LinearImage; coverage: Float32Array } {
    const { cellW: w, cellH: h } = atlas;
    const data = new Float32Array(w * h * 3);
    const coverage = new Float32Array(w * h); // PER-PIXEL silhouette AOV (§3.2)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const t = x / (w - 1) - y / (h - 1); // >0 lower-right of the ╲ line
      const v = t > 0 ? 0.9 : 0.1;
      const i = (y * w + x) * 3; data[i] = v; data[i + 1] = v; data[i + 2] = v;
      coverage[y * w + x] = t > 0 ? 1 : 0; // crosses 0.5 across the cell → boundary cell
    }
    return { img: { w, h, data }, coverage };
  }

  it('a ╲ boundary cell flips to the aligned diagonal glyph when κ>0, byte-identical when off', () => {
    const { img, coverage } = diagCell();
    const base = matchGrid(img, atlas, opts({})).cells[0]!.ch;
    const off = matchGrid(img, atlas, opts({ orientKappa: 0, aov: { coverage } })).cells[0]!.ch;
    expect(off).toBe(base); // κ=0 with the AOV present is byte-identical to the plain path

    const on = matchGrid(img, atlas, opts({ orientKappa: 1, aov: { coverage } })).cells[0]!.ch;
    expect(on).not.toBe(base);   // the prior moved the argmin
    expect(on).toBe('╲');        // …onto the ╲-aligned glyph (U+2572)

    // 2D fallback (no coverage AOV): the luma edge field drives the same flip.
    const twoD = matchGrid(img, atlas, opts({ orientKappa: 1 })).cells[0]!.ch;
    expect(twoD).toBe('╲');
  });

  // Boundary-only gate: a cell whose coverage is entirely inside (never crosses 0.5) is
  // NOT a boundary cell, so the prior must leave it byte-identical regardless of κ.
  it('a fully-covered (non-boundary) cell is untouched by the prior', () => {
    const { img } = diagCell();
    const coverage = new Float32Array(img.w * img.h).fill(1); // all inside → no 0.5 crossing
    const base = matchGrid(img, atlas, opts({})).cells[0]!.ch;
    const on = matchGrid(img, atlas, opts({ orientKappa: 10, aov: { coverage } })).cells[0]!.ch;
    expect(on).toBe(base);
  });
});
