import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildAtlas } from '../src/atlas/atlas.js';
import { matchGrid } from '../src/core/match.js';
import { rampGrid } from '../src/core/ramp.js';
import { buildFamily } from '../src/atlas/families.js';
import { srgbToLinear } from '../src/core/color.js';
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
    const grid = matchGrid(img, atlas, defaults({ quality: 2, fixedBg, space: 'linear' }));
    for (const cell of grid.cells) {
      expect(cell.bg).toEqual([expBg, expBg, expBg]);
    }
  });
});

describe('matchGrid gamma working space (predict-terminal, DESIGN §3.1)', () => {
  let atlas: Atlas;
  beforeAll(async () => {
    atlas = await buildAtlas(FONT, 16, 'blocks');
  }, 60000);

  it('reconstructs the exact half-block cell in gamma space (mirrors the linear match test)', () => {
    const half = Math.floor(atlas.cellH / 2);
    // pure white/black is transfer-invariant, so gamma mode must still pick the half-block.
    const img = makeImage(atlas, 2, (col, _lx, ly) => {
      const topWhite = col === 0 ? ly < half : ly >= half;
      const v = topWhite ? 1 : 0;
      return [v, v, v];
    });
    const grid = matchGrid(img, atlas, defaults({ quality: 3, space: 'gamma' }));
    const left = grid.cells[0]!;
    expect(['▀', '▄']).toContain(left.ch);
    expect(left.fg).not.toBeNull();
    expect(left.bg).not.toBeNull();
    const sse = cellSSE(atlas, left.ch, left.fg!, left.bg!, img, 0);
    expect(sse / (atlas.P * 3)).toBeLessThan(0.02);
  });

  it('round-trips gamma fit colors to u8 without re-encoding (no double sRGB pass)', () => {
    // A top/bottom split at gamma u8 200 / 20. In gamma mode the fit colors are the
    // working (already-encoded) values, so u8 = round(x·255) must recover ~200 / ~20.
    // A double-encode bug (linearToSrgb applied again) would yield ~229 / ~79 instead.
    const half = Math.floor(atlas.cellH / 2);
    const top = srgbToLinear(200), bot = srgbToLinear(20);
    const img = makeImage(atlas, 1, (_col, _lx, ly) => {
      const v = ly < half ? top : bot;
      return [v, v, v];
    });
    const cell = matchGrid(img, atlas, defaults({ quality: 3, space: 'gamma' })).cells[0]!;
    expect(['▀', '▄']).toContain(cell.ch);
    // colors are one of {~200} and {~20} (order depends on whether ▀ or ▄ won).
    const hi = Math.max(cell.fg![0], cell.bg![0]);
    const lo = Math.min(cell.fg![0], cell.bg![0]);
    expect(Math.abs(hi - 200)).toBeLessThanOrEqual(6);
    expect(Math.abs(lo - 20)).toBeLessThanOrEqual(6);
  });

  it('gated flat cell re-encodes its working-space mean straight to the source u8', () => {
    // Uniform gamma u8 128 → gate fires → bg = round(mean·255) = 128 (not 188 as a
    // double-encode would give).
    const v = srgbToLinear(128);
    const img = makeImage(atlas, 2, () => [v, v, v]);
    const grid = matchGrid(img, atlas, defaults({ quality: 3, space: 'gamma' }));
    for (const cell of grid.cells) {
      expect(cell.ch).toBe(' ');
      expect(cell.fg).toBeNull();
      for (const c of cell.bg!) expect(Math.abs(c - 128)).toBeLessThanOrEqual(1);
    }
  });
});

describe('contrast gate uses full per-channel E_AC (DESIGN §3.4)', () => {
  let atlas: Atlas;
  beforeAll(async () => {
    atlas = await buildAtlas(FONT, 16, 'blocks');
  }, 60000);

  it('does NOT gate an isoluminant red/green split (luma-only would flatten it to a mean)', () => {
    const half = Math.floor(atlas.cellH / 2);
    // top pure red, bottom green scaled to the SAME linear luma → per-pixel luma is
    // constant, so a luma-only gate (EacLuma≈0) fires and washes the split into a muddy
    // mean. The full per-channel E_AC is large (red 1→0, green 0→g), so the correct gate
    // keeps the cell and the scan reconstructs the split with a half-block.
    const g = 0.2126 / 0.7152; // luma(0,g,0) === luma(1,0,0)
    const img = makeImage(atlas, 1, (_col, _lx, ly) => (ly < half ? [1, 0, 0] : [0, g, 0]));
    const cell = matchGrid(img, atlas, defaults({ quality: 3, space: 'linear' })).cells[0]!;
    expect(cell.ch).not.toBe(' ');          // NOT gated
    expect(['▀', '▄']).toContain(cell.ch);  // reconstructs the split with a half-block
    expect(cell.fg).not.toBeNull();
    expect(cell.bg).not.toBeNull();
    const sse = cellSSE(atlas, cell.ch, cell.fg!, cell.bg!, img, 0);
    expect(sse / (atlas.P * 3)).toBeLessThan(0.02);
  });

  it('still gates a genuinely flat gray cell (per-channel E_AC ≈ 0)', () => {
    const v = 0.5;
    const img = makeImage(atlas, 2, () => [v, v, v]);
    const grid = matchGrid(img, atlas, defaults({ quality: 3, space: 'linear' }));
    for (const cell of grid.cells) {
      expect(cell.ch).toBe(' ');
      expect(cell.fg).toBeNull();
    }
  });
});

describe('matchGrid fixedBg working-space contract (linear-RGB option, space-invariant)', () => {
  let atlas: Atlas;
  beforeAll(async () => {
    atlas = await buildAtlas(FONT, 16, 'blocks');
  }, 60000);

  // fixedBg is documented linear RGB. linear 0.1 → sRGB u8 89. The EMITTED u8 must be 89
  // regardless of working space; only the internal fit converts. Pre-fix, gamma mode
  // consumed 0.1 raw as a gamma value → emitted 26.
  it('Q2 fixedBg=[0.1,0.1,0.1] emits bg [89,89,89] in BOTH gamma (default) and linear space', () => {
    const half = Math.floor(atlas.cellH / 2);
    const img = makeImage(atlas, 2, (col, _lx, ly) => {
      const topWhite = col === 0 ? ly < half : ly >= half;
      const v = topWhite ? 1 : 0;
      return [v, v, v];
    });
    const fixedBg: [number, number, number] = [0.1, 0.1, 0.1];
    for (const space of ['gamma', 'linear'] as const) {
      const grid = matchGrid(img, atlas, defaults({ quality: 2, fixedBg, space }));
      for (const cell of grid.cells) {
        expect(cell.bg).toEqual([89, 89, 89]);
      }
    }
  });
});

// mulberry32 (must match test/fixtures/regression-grid.json generator EXACTLY)
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('post-selection invisibility collapse (replaces the falsified MDL washout defense)', () => {
  let atlas: Atlas;
  beforeAll(async () => { atlas = await buildAtlas(FONT, 16, 'blocks'); }, 60000);

  // A 12-u8 gamma half-split passes the gate (τ=2e-5) so the scan runs and a half-block
  // wins, but its fitted fg/bg are only 12 u8 apart — a faint winner. collapseThreshold 16
  // must replace it with space + the coverage-weighted flat mean (sumA·F+(P−sumA)·B)/P.
  it('collapses a faint text winner to space with the coverage-weighted-mean bg', () => {
    const half = Math.floor(atlas.cellH / 2);
    const top = srgbToLinear(128), bot = srgbToLinear(140);
    const img = makeImage(atlas, 1, (_c, _lx, ly) => { const v = ly < half ? top : bot; return [v, v, v]; });

    const off = matchGrid(img, atlas, defaults({ quality: 3, space: 'gamma', gateTau: 2e-5, collapseThreshold: 0 })).cells[0]!;
    expect(off.ch).not.toBe(' ');
    expect(off.fg).not.toBeNull();
    expect(off.bg).not.toBeNull();
    const d = Math.max(
      Math.abs(off.fg![0] - off.bg![0]), Math.abs(off.fg![1] - off.bg![1]), Math.abs(off.fg![2] - off.bg![2]),
    );
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(16); // faint enough for threshold 16 to catch it

    // weighted mean from the winning glyph's coverage and the OFF winner's fitted colors
    const g = atlas.glyphs.find((gl) => gl.ch === off.ch)!;
    const expMean = [0, 1, 2].map((c) => Math.round((g.sumA * off.fg![c]! + (atlas.P - g.sumA) * off.bg![c]!) / atlas.P));

    const on = matchGrid(img, atlas, defaults({ quality: 3, space: 'gamma', gateTau: 2e-5, collapseThreshold: 16 })).cells[0]!;
    expect(on.ch).toBe(' ');
    expect(on.fg).toBeNull();               // Q3 flat cell convention: bg carries the fill
    expect(on.bg).not.toBeNull();
    for (let c = 0; c < 3; c++) expect(Math.abs(on.bg![c]! - expMean[c]!)).toBeLessThanOrEqual(1);
  });

  // A 20/235 half-split has |F−B| ≈ 214 u8 → far above any tested threshold → untouched.
  it('leaves a high-contrast winner untouched', () => {
    const half = Math.floor(atlas.cellH / 2);
    const img = makeImage(atlas, 1, (_c, _lx, ly) => { const v = ly < half ? srgbToLinear(20) : srgbToLinear(235); return [v, v, v]; });
    const off = matchGrid(img, atlas, defaults({ quality: 3, space: 'gamma', gateTau: 2e-5, collapseThreshold: 0 })).cells[0]!;
    const on = matchGrid(img, atlas, defaults({ quality: 3, space: 'gamma', gateTau: 2e-5, collapseThreshold: 16 })).cells[0]!;
    expect(on.ch).not.toBe(' ');
    expect(on.ch).toBe(off.ch);
    expect(on.fg).toEqual(off.fg);
    expect(on.bg).toEqual(off.bg);
  });

  // Regression guard: collapseThreshold 0 (and absent) must be byte-identical to the frozen
  // M0 golden grid — the collapse is a strict no-op when off. Reuses the shared fixture.
  it('collapseThreshold 0 (and absent) reproduces the M0 golden grid byte-for-byte', () => {
    const golden = JSON.parse(
      readFileSync(new URL('./fixtures/regression-grid.json', import.meta.url), 'utf8'),
    ) as { cells: Grid['cells'] };
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
    expect(matchGrid(img, atlas, defaults({ collapseThreshold: 0 })).cells).toEqual(golden.cells);
    expect(matchGrid(img, atlas, defaults({})).cells).toEqual(golden.cells);
  });

  // Family-winner collapse path: a low-amplitude braille-lattice cell (dots gamma 145, gaps
  // 120) → the braille region solve strictly wins (a codepoint NOT in the blocks atlas, so it
  // can only come from the family solver), yet |F−B| is faint → collapses to space + the
  // pattern's coverage-weighted mean.
  it('collapses a faint family (braille) winner to space via the family path', () => {
    const { cellW, cellH, P } = atlas;
    const r2 = (0.21 * cellW) ** 2;
    const cx = [0.25 * cellW, 0.75 * cellW];
    const cy = [0.125 * cellH, 0.375 * cellH, 0.625 * cellH, 0.875 * cellH];
    const img = makeImage(atlas, 1, (_c, lx, ly) => {
      let on = false;
      for (const X of cx) for (const Y of cy) if ((lx + 0.5 - X) ** 2 + (ly + 0.5 - Y) ** 2 <= r2) on = true;
      const v = srgbToLinear(on ? 145 : 120);
      return [v, v, v];
    });
    const optsF = (T: number): MatchOptions =>
      defaults({ quality: 3, space: 'gamma', gateTau: 2e-5, families: ['braille'], collapseThreshold: T });

    const off = matchGrid(img, atlas, optsF(0)).cells[0]!;
    const cp = off.ch.codePointAt(0)!;
    expect(cp).toBeGreaterThanOrEqual(0x2800); // braille block ⇒ produced by the family solver
    expect(cp).toBeLessThanOrEqual(0x28ff);
    expect(off.fg).not.toBeNull();
    expect(off.bg).not.toBeNull();
    const d = Math.max(
      Math.abs(off.fg![0] - off.bg![0]), Math.abs(off.fg![1] - off.bg![1]), Math.abs(off.fg![2] - off.bg![2]),
    );

    const fam = buildFamily('braille', cellW, cellH);
    const sumA = fam.sumA[fam.ch.indexOf(off.ch)]!;
    const expMean = [0, 1, 2].map((c) => Math.round((sumA * off.fg![c]! + (P - sumA) * off.bg![c]!) / P));

    const on = matchGrid(img, atlas, optsF(d + 4)).cells[0]!; // threshold just above the winner's |F−B|
    expect(on.ch).toBe(' ');
    expect(on.fg).toBeNull();
    for (let c = 0; c < 3; c++) expect(Math.abs(on.bg![c]! - expMean[c]!)).toBeLessThanOrEqual(1);
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
