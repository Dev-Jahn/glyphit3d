import { describe, it, expect } from 'vitest';
import type { Atlas, Glyph, Grid, GridCell, LinearImage } from '../src/core/types.js';
import { rasterizeGrid } from '../src/render/raster.js';

// feat/temporal-animation (SPEC §3.4, verify-criteria): the OPTIONAL `dirty` parameter of
// rasterizeGrid must (1) be byte-identical to the full raster when ABSENT (the existing
// render.test.ts pins the exact pixel values; here we pin absent≡full over a multi-cell grid),
// and (2) when PRESENT, an incremental re-composite of exactly the changed cells over the retained
// previous-frame buffer must equal a full raster of the new grid. These are the two properties the
// temporal partial-raster path relies on for correctness.

function makeGlyph(ch: string, cellW: number, cellH: number, fill: number): Glyph {
  const P = cellW * cellH;
  const alpha = new Float32Array(P).fill(fill);
  return { ch, cp: ch.codePointAt(0)!, alpha, dxA: new Float32Array(P), dyA: new Float32Array(P), sumA: fill * P, sumAA: fill * fill * P, gradAA: 0, ink: 0 };
}

const CW = 3, CH = 2;
const atlas: Atlas = {
  cellW: CW, cellH: CH, P: CW * CH,
  fontPath: 'x', fontSize: 8, ascent: 6,
  glyphs: [makeGlyph(' ', CW, CH, 0), makeGlyph('#', CW, CH, 1), makeGlyph('.', CW, CH, 0.5)],
  inkMin: 0, inkMax: 1,
};

const COLS = 4, ROWS = 3;
function cell(ch: string, fg: [number, number, number] | null, bg: [number, number, number] | null): GridCell {
  return { ch, fg, bg };
}
function makeGrid(cells: GridCell[]): Grid {
  return { cols: COLS, rows: ROWS, cellW: CW, cellH: CH, font: 'Mono', cells };
}
// A deterministic grid keyed by a seed so we can build "before" and "after" frames that differ in
// a known subset of cells.
function gridForSeed(seed: number): Grid {
  const chs = [' ', '#', '.'];
  const cells: GridCell[] = [];
  for (let i = 0; i < COLS * ROWS; i++) {
    const k = (seed * 31 + i * 7) % 3;
    const fg: [number, number, number] = [(seed * 13 + i * 3) % 256, (i * 29) % 256, (seed * 5) % 256];
    const bg: [number, number, number] = [(i * 11) % 256, (seed * 17) % 256, (i * 23 + seed) % 256];
    cells.push(cell(chs[k]!, fg, bg));
  }
  return makeGrid(cells);
}
function copyLin(l: LinearImage): LinearImage { return { w: l.w, h: l.h, data: l.data.slice(0) }; }
function changedCells(a: Grid, b: Grid): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.cells.length; i++) {
    const x = a.cells[i]!, y = b.cells[i]!;
    const eqTri = (p: [number, number, number] | null, q: [number, number, number] | null): boolean =>
      (p === null || q === null) ? p === q : p[0] === q[0] && p[1] === q[1] && p[2] === q[2];
    if (x.ch !== y.ch || !eqTri(x.fg, y.fg) || !eqTri(x.bg, y.bg)) out.push(i);
  }
  return out;
}

describe('rasterizeGrid dirty-mask (feat/temporal-animation §3.4)', () => {
  for (const mode of ['linear', 'gamma'] as const) {
    it(`absent dirty ≡ a fresh full raster over a multi-cell grid (${mode})`, () => {
      const grid = gridForSeed(1);
      const a = rasterizeGrid(grid, atlas, mode);
      const b = rasterizeGrid(grid, atlas, mode);
      expect(Array.from(a.data)).toEqual(Array.from(b.data)); // deterministic + self-identical
    });

    it(`partial update over the retained buffer == full raster of the new grid (${mode})`, () => {
      const prevGrid = gridForSeed(2);
      // Change a genuine SUBSET of cells (indices 1, 5, 6, 10) so unchanged cells must survive
      // verbatim from the retained buffer.
      const nextCells = prevGrid.cells.map((cc) => ({ ...cc }));
      for (const j of [1, 5, 6, 10]) {
        nextCells[j] = cell(['#', '.', ' '][j % 3]!, [(j * 37) % 256, 12, 200], [7, (j * 19) % 256, 33]);
      }
      const nextGrid = makeGrid(nextCells);

      const prevFull = rasterizeGrid(prevGrid, atlas, mode);
      const retained = copyLin(prevFull); // the previous frame's raster (mutated in place by partial)
      const dirty = changedCells(prevGrid, nextGrid);
      expect(dirty.length).toBeGreaterThan(0);
      expect(dirty.length).toBeLessThan(COLS * ROWS); // a genuine subset, not the whole grid

      const partial = rasterizeGrid(nextGrid, atlas, mode, { indices: dirty, prev: retained });
      const fullNext = rasterizeGrid(nextGrid, atlas, mode);
      expect(Array.from(partial.data)).toEqual(Array.from(fullNext.data));
      // partial returns a container over the SAME retained buffer (in-place update, no realloc).
      expect(partial.data).toBe(retained.data);
    });
  }

  it('null-cell dirty index zeros its rect (matches full-raster null handling)', () => {
    const prevGrid = gridForSeed(3);
    const nextCells = prevGrid.cells.slice();
    nextCells[5] = undefined as unknown as GridCell; // a cell becomes absent
    const nextGrid = makeGrid(nextCells as GridCell[]);
    const retained = copyLin(rasterizeGrid(prevGrid, atlas, 'linear'));
    const partial = rasterizeGrid(nextGrid, atlas, 'linear', { indices: [5], prev: retained });
    const full = rasterizeGrid(nextGrid, atlas, 'linear');
    expect(Array.from(partial.data)).toEqual(Array.from(full.data));
  });

  it('throws on a retained buffer whose footprint no longer matches (stale-state guard)', () => {
    const grid = gridForSeed(4);
    const wrong: LinearImage = { w: 2, h: 2, data: new Float32Array(2 * 2 * 3) };
    expect(() => rasterizeGrid(grid, atlas, 'linear', { indices: [0], prev: wrong })).toThrow(/retained buffer/);
  });

  it('throws on an out-of-range dirty index', () => {
    const grid = gridForSeed(5);
    const retained = copyLin(rasterizeGrid(grid, atlas, 'linear'));
    expect(() => rasterizeGrid(grid, atlas, 'linear', { indices: [COLS * ROWS], prev: retained })).toThrow(/out of range/);
  });
});
