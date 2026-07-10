import { describe, it, expect } from 'vitest';
import { srgbToLinear } from '../src/core/color.js';
import type { Atlas, Grid, GridCell, LinearImage } from '../src/core/types.js';
import {
  readabilityRate, fullBlockRate, nearFloorRate, coverageLumaCorr, fgLumaCorr, fgSatCorr,
  rasterDcLumaError, identityProxies, pearson, TAU_VIS, FULL_BLOCK,
} from '../bench/identity-proxies.js';

// A 2x2 grid of 2x2 cells → 4x4 pixel images. All proxies are pure over Grid/LinearImage/mask,
// so we build them by hand and assert the exact contracts (no atlas/font IO except a tiny stub).

const CW = 2, CH = 2;

function grid(cells: GridCell[]): Grid {
  return { cols: 2, rows: 2, cells, cellW: CW, cellH: CH, font: 'test' };
}
function cell(ch: string, fg: [number, number, number] | null, bg: [number, number, number] | null): GridCell {
  return { ch, fg, bg };
}
// gray LinearImage where cell k (row-major) has constant linear value grays[k] on all channels.
function grayImage(grays: number[]): LinearImage {
  const w = 4, h = 4;
  const data = new Float32Array(w * h * 3);
  for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) {
    const v = grays[r * 2 + c]!;
    for (let ly = 0; ly < CH; ly++) for (let lx = 0; lx < CW; lx++) {
      const p = ((r * CH + ly) * w + (c * CW + lx)) * 3;
      data[p] = v; data[p + 1] = v; data[p + 2] = v;
    }
  }
  return { w, h, data };
}
// Minimal atlas: only ch→sumA and P are read by coverageLumaCorr.
function stubAtlas(cov: Record<string, number>, P = CW * CH): Atlas {
  const glyphs = Object.entries(cov).map(([ch, sumA]) => ({ ch, sumA })) as unknown as Atlas['glyphs'];
  return { P, glyphs } as unknown as Atlas;
}
const ALL = new Uint8Array([1, 1, 1, 1]);

describe('readabilityRate', () => {
  it('counts only non-space, non-full-block, |F−B|≥τ_vis object cells', () => {
    const g = grid([
      cell('A', [255, 255, 255], [0, 0, 0]),   // readable (contrast 255)
      cell(' ', [10, 10, 10], [0, 0, 0]),        // space → not readable
      cell('B', [20, 20, 20], [0, 0, 0]),        // faint (contrast 20 < 24) → not readable
      cell(FULL_BLOCK, [255, 255, 255], [0, 0, 0]), // full block → not readable
    ]);
    expect(readabilityRate(g, ALL)).toBeCloseTo(1 / 4, 12);
  });

  it('τ_vis is inclusive: contrast exactly 24 reads, 23 does not', () => {
    const at24 = grid([cell('A', [24, 0, 0], [0, 0, 0]), cell('A', [23, 0, 0], [0, 0, 0]),
      cell(' ', null, null), cell(' ', null, null)]);
    const mask = new Uint8Array([1, 1, 0, 0]);
    expect(TAU_VIS).toBe(24);
    expect(readabilityRate(at24, mask)).toBeCloseTo(1 / 2, 12);
  });

  it('denominator is object cells only — background cells are ignored', () => {
    const g = grid([
      cell('A', [255, 255, 255], [0, 0, 0]),   // object, readable
      cell('A', [255, 255, 255], [0, 0, 0]),   // BACKGROUND (masked out)
      cell(' ', null, null),                     // object, space
      cell(' ', null, null),                     // BACKGROUND
    ]);
    const mask = new Uint8Array([1, 0, 1, 0]);
    expect(readabilityRate(g, mask)).toBeCloseTo(1 / 2, 12); // 1 readable of 2 object cells
  });

  it('mask/grid size mismatch throws', () => {
    const g = grid([cell(' ', null, null), cell(' ', null, null), cell(' ', null, null), cell(' ', null, null)]);
    expect(() => readabilityRate(g, new Uint8Array([1, 1]))).toThrow(/mask length/);
  });
});

describe('fullBlockRate & nearFloorRate', () => {
  const g = grid([
    cell(FULL_BLOCK, [255, 255, 255], [0, 0, 0]), // full block
    cell('A', [10, 0, 0], [0, 0, 0]),               // faint glyph (contrast 10)
    cell('A', [255, 0, 0], [0, 0, 0]),              // visible glyph
    cell(' ', [5, 5, 5], [0, 0, 0]),                // space (not a faint glyph)
  ]);
  it('fullBlockRate counts only █', () => {
    expect(fullBlockRate(g, ALL)).toBeCloseTo(1 / 4, 12);
  });
  it('nearFloorRate counts non-space glyphs below τ_vis (not space, not full block, not visible)', () => {
    expect(nearFloorRate(g, ALL)).toBeCloseTo(1 / 4, 12);
  });
});

describe('coverageLumaCorr (feat A signature)', () => {
  it('+1 when glyph coverage increases monotonically with cell luma', () => {
    // brighter cells get higher-coverage glyphs → positive correlation.
    const g = grid([cell(' ', null, null), cell('a', [1, 1, 1], [0, 0, 0]),
      cell('b', [1, 1, 1], [0, 0, 0]), cell(FULL_BLOCK, [1, 1, 1], [0, 0, 0])]);
    const atlas = stubAtlas({ ' ': 0, a: 1, b: 2, [FULL_BLOCK]: 4 });
    // ref gamma-luma set affine to coverage (Σα/P = 0,.25,.5,1) so the correlation is exactly +1.
    const ref = grayImage([0, 64, 128, 255].map(srgbToLinear));
    expect(coverageLumaCorr(g, ref, atlas, ALL)).toBeCloseTo(1, 3);
  });

  it('skips glyphs absent from the atlas (family glyphs)', () => {
    const g = grid([cell('a', [1, 1, 1], [0, 0, 0]), cell('a', [1, 1, 1], [0, 0, 0]),
      cell('⠿', [1, 1, 1], [0, 0, 0]), cell('⠿', [1, 1, 1], [0, 0, 0])]); // ⠿ not in atlas
    const atlas = stubAtlas({ a: 1 });
    const ref = grayImage([0.1, 0.9, 0.5, 0.5]);
    // only the two 'a' cells resolve; both coverage 1 → zero variance → NaN.
    expect(Number.isNaN(coverageLumaCorr(g, ref, atlas, ALL))).toBe(true);
  });
});

describe('fgLumaCorr (feat B signature) — readable-cell population', () => {
  it('+1 when fg lightness tracks ref luma, −1 when anti-correlated', () => {
    // readable gray cells (contrast ≥ τ_vis vs black bg). ref cell linear = srgbToLinear(fgU8) so
    // ref gamma-luma == fg gamma-luma exactly → the reversed fg is affine in ref → corr is exactly ±1.
    const ref = grayImage([64, 128, 192, 255].map(srgbToLinear));
    const gPos = grid([cell('a', [64, 64, 64], [0, 0, 0]), cell('a', [128, 128, 128], [0, 0, 0]),
      cell('a', [192, 192, 192], [0, 0, 0]), cell('a', [255, 255, 255], [0, 0, 0])]);
    expect(fgLumaCorr(gPos, ref, ALL)).toBeCloseTo(1, 6);
    const gNeg = grid([cell('a', [255, 255, 255], [0, 0, 0]), cell('a', [192, 192, 192], [0, 0, 0]),
      cell('a', [128, 128, 128], [0, 0, 0]), cell('a', [64, 64, 64], [0, 0, 0])]);
    expect(fgLumaCorr(gNeg, ref, ALL)).toBeCloseTo(-1, 4); // sub-u8 transfer float; −0.99997 ≈ perfect
  });

  it('excludes full-block and gated/near-floor cells (the finding: fg==DC saturates the corr)', () => {
    // Two READABLE cells define a perfectly increasing fg↔ref line (+1). The other two are POISON
    // that the pre-fix population (only `if (!fg) continue`) would have included, dragging the corr
    // negative: a full-block cell with a BRIGHT fg over a DARK ref, and a GATED cell (ch=space with a
    // non-null fg == cell mean, as match.ts Q2 emits) with a DARK fg over a BRIGHT ref. isReadable
    // excludes both, so the corr stays +1 — the proxy is not blinded by DC-reproduction cells.
    const g = grid([
      cell('a', [64, 64, 64], [0, 0, 0]),            // readable, ref .25
      cell('a', [192, 192, 192], [0, 0, 0]),         // readable, ref .75
      cell(FULL_BLOCK, [255, 255, 255], [0, 0, 0]),  // full-block poison: bright fg over DARK ref
      cell(' ', [10, 10, 10], [0, 0, 0]),            // gated poison: dark fg over BRIGHT ref
    ]);
    // LINEAR cell values; the two readable cells (dark fg / bright fg) get dark / bright ref → +1.
    // The poison cells sit OFF that line (bright fg@dark ref, dark fg@bright ref): including them (as
    // the pre-fix `if(!fg)continue` population did) drives the corr sharply negative.
    const ref = grayImage([0.05, 0.6, 0.02, 0.95]);
    expect(fgLumaCorr(g, ref, ALL)).toBeCloseTo(1, 6);
  });
});

describe('fgSatCorr (feat B signature) — fg saturation ↔ ref luma over readable cells', () => {
  it('+1 when fg saturation tracks ref luma, −1 when anti-correlated', () => {
    // fg saturation = (max−min)/max. These reds give sat = 0.2,0.4,0.6,0.8 exactly; ref cell luma set
    // to the same ladder (grayImage of srgbToLinear(51·k)) so sat is affine in ref → corr ±1.
    const sat = (mn: number) => cell('a', [255, mn, mn], [0, 0, 0]); // sat = (255−mn)/255
    const gPos = grid([sat(204), sat(153), sat(102), sat(51)]);      // 0.2,0.4,0.6,0.8
    const ref = grayImage([51, 102, 153, 204].map(srgbToLinear));    // ref luma 0.2,0.4,0.6,0.8
    expect(fgSatCorr(gPos, ref, ALL)).toBeCloseTo(1, 6);
    const gNeg = grid([sat(51), sat(102), sat(153), sat(204)]);      // 0.8,0.6,0.4,0.2
    expect(fgSatCorr(gNeg, ref, ALL)).toBeCloseTo(-1, 6);
  });

  it('excludes full-block / gated cells (same readable population as fgLumaCorr)', () => {
    // two readable reds (+1 sat↔ref line) + a full-block with high saturation over low ref + a gated
    // low-sat fg over high ref: pre-fix inclusion would flip the sign; readable-only keeps it +1.
    const g = grid([
      cell('a', [255, 204, 204], [0, 0, 0]),         // readable sat 0.2, ref .2
      cell('a', [255, 102, 102], [0, 0, 0]),         // readable sat 0.6, ref .6
      cell(FULL_BLOCK, [255, 0, 0], [0, 0, 0]),      // poison sat 1.0 over DARK ref
      cell(' ', [80, 78, 78], [0, 0, 0]),            // gated poison sat ~.025 over BRIGHT ref
    ]);
    // LINEAR cell values; readable cells (sat .2 / .6) get dark / bright ref → +1. Poison cells sit
    // OFF the line (sat 1.0@dark ref, sat ~0@bright ref) → including them flips the sign.
    const ref = grayImage([0.05, 0.6, 0.02, 0.95]);
    expect(fgSatCorr(g, ref, ALL)).toBeCloseTo(1, 6);
  });
});

describe('rasterDcLumaError', () => {
  it('0 when raster equals reference', () => {
    const ref = grayImage([0.1, 0.4, 0.7, 1.0]);
    expect(rasterDcLumaError(ref, ref, CW, CH, ALL)).toBeCloseTo(0, 9);
  });
  it('mean absolute cell-mean gamma-luma error in u8, object cells only', () => {
    const ref = grayImage([0, 0, 0, 0]);
    const ras = grayImage([1, 1, 0, 0]); // linear 1 → gamma-luma 255; two object cells differ by 255, but masked
    const mask = new Uint8Array([1, 0, 1, 0]); // one differing (255) + one equal (0) → mean 127.5
    expect(rasterDcLumaError(ras, ref, CW, CH, mask)).toBeCloseTo(127.5, 6);
  });
});

describe('pearson', () => {
  it('NaN for <2 points or zero variance', () => {
    expect(Number.isNaN(pearson([1], [1]))).toBe(true);
    expect(Number.isNaN(pearson([2, 2, 2], [1, 2, 3]))).toBe(true);
  });
});

describe('identityProxies aggregate', () => {
  it('returns all seven proxies with the object-cell count', () => {
    // two readable cells with DISTINCT saturation (so fgLumaCorr AND fgSatCorr are finite over the
    // readable population), one near-floor faint 'A', one full block.
    const g = grid([cell('A', [255, 180, 180], [0, 0, 0]), cell('A', [120, 120, 180], [0, 0, 0]),
      cell('A', [10, 10, 10], [0, 0, 0]), cell(FULL_BLOCK, [255, 255, 255], [0, 0, 0])]);
    const atlas = stubAtlas({ ' ': 0, A: 2, [FULL_BLOCK]: 4 });
    const ref = grayImage([1.0, 0.0, 0.3, 0.8]);
    const raster = grayImage([1.0, 0.0, 0.3, 0.8]);
    const r = identityProxies(g, raster, ref, atlas, ALL);
    expect(r.nObj).toBe(4);
    expect(r.readabilityRate).toBeCloseTo(2 / 4, 12); // two readable 'A' cells
    expect(r.fullBlockRate).toBeCloseTo(1 / 4, 12);
    expect(r.nearFloorRate).toBeCloseTo(1 / 4, 12); // the faint 'A' (contrast 10)
    expect(r.rasterDcLumaError).toBeCloseTo(0, 9);
    expect(Number.isFinite(r.coverageLumaCorr)).toBe(true);
    expect(Number.isFinite(r.fgLumaCorr)).toBe(true);
    expect(Number.isFinite(r.fgSatCorr)).toBe(true);
  });
});
