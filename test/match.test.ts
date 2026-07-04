import { describe, it, expect, beforeAll } from 'vitest';
import { buildAtlas } from '../src/atlas/atlas.js';
import { matchGrid } from '../src/core/match.js';
import { rampGrid } from '../src/core/ramp.js';
import { srgbToLinear } from '../src/core/color.js';
import type { Atlas, MatchOptions, LinearImage } from '../src/core/types.js';

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

// build a single-row, `cols`-wide linear image from a per-cell fill fn
function makeImage(atlas: Atlas, cols: number, fill: (col: number, lx: number, ly: number) => [number, number, number]): LinearImage {
  const { cellW, cellH } = atlas;
  const w = cols * cellW;
  const h = cellH;
  const data = new Float32Array(w * h * 3);
  for (let col = 0; col < cols; col++) {
    for (let ly = 0; ly < cellH; ly++) {
      for (let lx = 0; lx < cellW; lx++) {
        const gx = col * cellW + lx;
        const [r, g, b] = fill(col, lx, ly);
        const gi = (ly * w + gx) * 3;
        data[gi] = r; data[gi + 1] = g; data[gi + 2] = b;
      }
    }
  }
  return { w, h, data };
}

// reconstruct a cell's prediction (linear) via glyph coverage α and stored sRGB colors
function cellSSE(atlas: Atlas, ch: string, fg: [number, number, number], bg: [number, number, number],
                img: LinearImage, col: number): number {
  const g = atlas.glyphs.find((gl) => gl.ch === ch)!;
  const { cellW, cellH } = atlas;
  const w = img.w;
  const F = [srgbToLinear(fg[0]), srgbToLinear(fg[1]), srgbToLinear(fg[2])];
  const B = [srgbToLinear(bg[0]), srgbToLinear(bg[1]), srgbToLinear(bg[2])];
  let sse = 0;
  for (let ly = 0; ly < cellH; ly++) {
    for (let lx = 0; lx < cellW; lx++) {
      const a = g.alpha[ly * cellW + lx]!;
      const gi = (ly * w + (col * cellW + lx)) * 3;
      for (let c = 0; c < 3; c++) {
        const pred = a * F[c]! + (1 - a) * B[c]!;
        const d = img.data[gi + c]! - pred;
        sse += d * d;
      }
    }
  }
  return sse;
}

describe('matchGrid', () => {
  let atlas: Atlas;
  beforeAll(async () => {
    atlas = await buildAtlas(FONT, 16, 'blocks');
  }, 60000);

  it('Q3 picks a half-block for a top-white/bottom-black cell and reconstructs near-perfectly', () => {
    const half = Math.floor(atlas.cellH / 2);
    // left cell: top half white, bottom half black; right cell: mirror image
    const img = makeImage(atlas, 2, (col, _lx, ly) => {
      const topWhite = col === 0 ? ly < half : ly >= half;
      const v = topWhite ? 1 : 0;
      return [v, v, v];
    });
    const grid = matchGrid(img, atlas, defaults({ quality: 3 }));
    expect(grid.cols).toBe(2);
    expect(grid.rows).toBe(1);

    const left = grid.cells[0]!;
    // exact upper/lower half blocks
    expect(['▀', '▄']).toContain(left.ch);
    expect(left.fg).not.toBeNull();
    expect(left.bg).not.toBeNull();
    const sse = cellSSE(atlas, left.ch, left.fg!, left.bg!, img, 0);
    // per-pixel-per-channel mean residual near zero (only AA at the split boundary)
    expect(sse / (atlas.P * 3)).toBeLessThan(0.02);
  });

  it('Q4 (edge channels) still picks a half-block and reconstructs well', () => {
    const half = Math.floor(atlas.cellH / 2);
    const img = makeImage(atlas, 1, (_col, _lx, ly) => {
      const v = ly < half ? 1 : 0;
      return [v, v, v];
    });
    const grid = matchGrid(img, atlas, defaults({ quality: 4 }));
    const cell = grid.cells[0]!;
    expect(['▀', '▄']).toContain(cell.ch);
    const sse = cellSSE(atlas, cell.ch, cell.fg!, cell.bg!, img, 0);
    expect(sse / (atlas.P * 3)).toBeLessThan(0.02);
  });

  it('flat gray → gate fires, all cells space with bg ≈ gray', () => {
    const gray = 0.5; // linear
    const img = makeImage(atlas, 3, () => [gray, gray, gray]);
    const grid = matchGrid(img, atlas, defaults({ quality: 3 }));
    const expBg = Math.round(255 * (1.055 * Math.pow(gray, 1 / 2.4) - 0.055));
    for (const cell of grid.cells) {
      expect(cell.ch).toBe(' ');
      expect(cell.fg).toBeNull();
      expect(cell.bg).not.toBeNull();
      for (const v of cell.bg!) expect(Math.abs(v - expBg)).toBeLessThanOrEqual(1);
    }
  });

  it('Q2 respects the fixed background on every cell', () => {
    const half = Math.floor(atlas.cellH / 2);
    const img = makeImage(atlas, 2, (col, _lx, ly) => {
      const topWhite = col === 0 ? ly < half : ly >= half;
      const v = topWhite ? 1 : 0;
      return [v, v, v];
    });
    const fixedBg: [number, number, number] = [0.1, 0.1, 0.1];
    const expBg = Math.round(255 * (1.055 * Math.pow(0.1, 1 / 2.4) - 0.055));
    const grid = matchGrid(img, atlas, defaults({ quality: 2, fixedBg }));
    for (const cell of grid.cells) {
      expect(cell.bg).toEqual([expBg, expBg, expBg]);
    }
  });
});

describe('rampGrid (Q0)', () => {
  let atlas: Atlas;
  beforeAll(async () => {
    atlas = await buildAtlas(FONT, 16, 'ascii');
  }, 60000);

  it('maps brightness to the ramp: black → space, white → densest glyph', () => {
    const black = makeImage(atlas, 1, () => [0, 0, 0]);
    const white = makeImage(atlas, 1, () => [1, 1, 1]);
    const gb = rampGrid(black, atlas, defaults({ quality: 0 }));
    const gw = rampGrid(white, atlas, defaults({ quality: 0 }));
    expect(gb.cells[0]!.ch).toBe(' ');
    expect(gw.cells[0]!.ch).toBe('@');
    // fg carries the mean color; bg is the fixed background
    expect(gw.cells[0]!.fg).toEqual([255, 255, 255]);
    expect(gb.cells[0]!.bg).toEqual([0, 0, 0]);
  });
});
