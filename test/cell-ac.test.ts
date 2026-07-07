import { describe, it, expect } from 'vitest';
import type { LinearImage } from '../src/core/types.js';
import {
  C2, cellCsMap, cellObjectMask, aovCellMask, percentile, aggregateCas, casReport,
  type CellMaps,
} from '../bench/cell-ac.js';

// Build a grayscale LinearImage (r=g=b=v linear) from a per-pixel value function.
function grayImg(cols: number, rows: number, cellW: number, cellH: number,
                 fn: (cc: number, cr: number, lx: number, ly: number) => number): LinearImage {
  const w = cols * cellW, h = rows * cellH;
  const data = new Float32Array(w * h * 3);
  for (let cr = 0; cr < rows; cr++) {
    for (let cc = 0; cc < cols; cc++) {
      for (let ly = 0; ly < cellH; ly++) {
        for (let lx = 0; lx < cellW; lx++) {
          const v = fn(cc, cr, lx, ly);
          const idx = ((cr * cellH + ly) * w + (cc * cellW + lx)) * 3;
          data[idx] = v; data[idx + 1] = v; data[idx + 2] = v;
        }
      }
    }
  }
  return { w, h, data };
}

const checker = (_cc: number, _cr: number, lx: number, ly: number) => ((lx + ly) % 2 === 0 ? 0 : 1);

describe('cellCsMap', () => {
  it('is 1 for identical images (exact AC match)', () => {
    const img = grayImg(3, 2, 2, 2, checker);
    const { cs } = cellCsMap(img, img, 2, 2);
    for (const v of cs) expect(v).toBeCloseTo(1, 10);
  });

  it('is 1 when both cells are flat, even with different mean colors (DC-invariance)', () => {
    const ref = grayImg(2, 2, 2, 2, () => 0.2);
    const out = grayImg(2, 2, 2, 2, () => 0.85);
    const { cs, acEnergy } = cellCsMap(out, ref, 2, 2);
    for (const v of cs) expect(v).toBeCloseTo(1, 10);       // flat vs flat → structure trivially matched
    for (const e of acEnergy) expect(e).toBeCloseTo(0, 10); // reference carries no AC energy
  });

  it('punishes structure HALLUCINATED into a flat reference cell (washout defect)', () => {
    const ref = grayImg(1, 1, 2, 2, () => 0.5);       // flat reference
    const out = grayImg(1, 1, 2, 2, checker);          // output invents 0/1 structure
    const { cs, acEnergy } = cellCsMap(out, ref, 2, 2);
    // σy=0 → cs = C2/(σx²+C2); σx² for {0,255} 2×2 = 16256.25 → cs ≈ 0.00359
    expect(cs[0]!).toBeGreaterThan(0);
    expect(cs[0]!).toBeLessThan(0.01);
    expect(acEnergy[0]!).toBeCloseTo(0, 10);            // flat REFERENCE ⇒ zero AC weight
  });

  it('punishes FAILURE to reproduce real reference structure (Q1 space-fill on a gradient)', () => {
    const ref = grayImg(1, 1, 2, 2, checker);          // real structure present
    const out = grayImg(1, 1, 2, 2, () => 0.5);         // flat output
    const { cs, acEnergy } = cellCsMap(out, ref, 2, 2);
    expect(cs[0]!).toBeGreaterThan(0);
    expect(cs[0]!).toBeLessThan(0.01);
    expect(acEnergy[0]!).toBeGreaterThan(C2);           // reference DOES carry structure to reproduce
  });

  it('rewards a faint-but-correct sub-cell gradient (invisible-ink respecting)', () => {
    // reference has a subtle gradient; output reproduces it faintly but with matching
    // contrast → cs≈1. Faintness alone is NOT punished; only contrast MISMATCH is.
    const grad = (_cc: number, _cr: number, lx: number) => 0.50 + lx * 0.02; // tiny 0.50/0.52 step
    const ref = grayImg(1, 1, 2, 2, grad);
    const out = grayImg(1, 1, 2, 2, grad);
    const { cs } = cellCsMap(out, ref, 2, 2);
    expect(cs[0]!).toBeCloseTo(1, 10);
  });
});

describe('percentile', () => {
  const a = [0, 1, 2, 3, 4];
  it('endpoints and interior', () => {
    expect(percentile(a, 0)).toBe(0);
    expect(percentile(a, 100)).toBe(4);
    expect(percentile(a, 50)).toBe(2);
    expect(percentile(a, 25)).toBeCloseTo(1, 10);
    expect(percentile(a, 10)).toBeCloseTo(0.4, 10);
  });
  it('handles singletons and empties', () => {
    expect(percentile([7], 33)).toBe(7);
    expect(Number.isNaN(percentile([], 50))).toBe(true);
  });
});

describe('aggregateCas', () => {
  it('AC-energy-weighted mean is structure-dominant (flat cells carry zero weight)', () => {
    // two object cells: one structured (σy²=large, cs=0.5), one flat (σy²=0, cs=1).
    const maps: CellMaps = {
      cols: 2, rows: 1,
      cs: Float64Array.from([0.5, 1.0]),
      acEnergy: Float64Array.from([1000, 0]),
    };
    const mask = Uint8Array.from([1, 1]);
    const s = aggregateCas(maps, mask);
    expect(s.mean).toBeCloseTo(0.75, 10);   // plain mean is diluted upward by the flat cell
    expect(s.wmean).toBeCloseTo(0.5, 10);   // weighted mean tracks the structured cell only
    expect(s.nObj).toBe(2);
    expect(s.nStructured).toBe(1);          // only the σy²>C2 cell counts as structured
  });

  it('respects the mask (background cells excluded)', () => {
    const maps: CellMaps = {
      cols: 3, rows: 1,
      cs: Float64Array.from([0.2, 0.9, 0.0]),
      acEnergy: Float64Array.from([500, 500, 9999]),
    };
    const mask = Uint8Array.from([1, 1, 0]); // exclude the low-cs background cell
    const s = aggregateCas(maps, mask);
    expect(s.nObj).toBe(2);
    expect(s.mean).toBeCloseTo(0.55, 10);
    expect(s.p50).toBeCloseTo(0.55, 10);
  });
});

describe('object masks', () => {
  it('cellObjectMask selects the bright subject over a dark background', () => {
    // bright 2×2-cell square in the middle of a 6×6-cell dark field.
    const ref = grayImg(6, 6, 2, 2, (cc, cr) => (cc >= 2 && cc <= 3 && cr >= 2 && cr <= 3 ? 0.9 : 0.02));
    const { mask, cols, rows, objFrac } = cellObjectMask(ref, 2, 2);
    expect(cols).toBe(6); expect(rows).toBe(6);
    expect(mask[2 * 6 + 2]).toBe(1);   // a subject cell is object
    expect(mask[0]).toBe(0);            // a far corner is background
    expect(objFrac).toBeGreaterThan(4 / 36);   // ≥ the 2×2 core (dilation adds a ring)
    expect(objFrac).toBeLessThan(1);
  });

  it('cellObjectMask selects a DARK subject over a BRIGHT background (polarity self-calibration)', () => {
    // dark 2×2-cell square in the middle of a 6×6-cell bright field (dark-subject-on-bright-bg,
    // e.g. FlightHelmet/BoomBox). A fixed "object = brighter" rule would invert and score the
    // backdrop; the border-minority polarity must pick the dark subject as object.
    const ref = grayImg(6, 6, 2, 2, (cc, cr) => (cc >= 2 && cc <= 3 && cr >= 2 && cr <= 3 ? 0.02 : 0.9));
    const { mask, cols, rows, objFrac } = cellObjectMask(ref, 2, 2);
    expect(cols).toBe(6); expect(rows).toBe(6);
    expect(mask[2 * 6 + 2]).toBe(1);   // a dark subject cell is object
    expect(mask[0]).toBe(0);            // a bright far corner is background
    expect(objFrac).toBeGreaterThan(4 / 36);   // ≥ the 2×2 core (dilation adds a ring)
    expect(objFrac).toBeLessThan(1);
  });

  it('aovCellMask marks covered cells and dilates by one cell', () => {
    const cols = 5, rows = 1;
    const coverage = Float32Array.from([0, 0, 0.7, 0, 0]);
    const mask = aovCellMask(cols, rows, { coverage });
    expect(Array.from(mask)).toEqual([0, 1, 1, 1, 0]); // center covered + 1-cell dilation
  });
});

describe('casReport (end to end, 2D fallback)', () => {
  it('identical output and reference → all stats 1', () => {
    const img = grayImg(6, 6, 2, 2, (cc, cr, lx, ly) =>
      (cc >= 2 && cc <= 3 && cr >= 2 && cr <= 3 ? checker(cc, cr, lx, ly) : 0.02));
    const s = casReport(img, img, 2, 2);
    expect(s.mean).toBeCloseTo(1, 10);
    expect(s.p05).toBeCloseTo(1, 10);
    expect(s.wmean).toBeCloseTo(1, 10);
    expect(s.nObj).toBeGreaterThan(0);
  });
});
