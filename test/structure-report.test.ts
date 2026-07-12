import { describe, it, expect } from 'vitest';
import { effectSize } from '../bench/structure-report.js';

// ours-Q3 − chafa per-image margins from the published headline table
// (bench/out/structure-report.md "Headline" section): CAS wmean row + SSIM row.
const CAS_WMEAN = [0.0130, 0.0119, 0.0258, 0.0222, 0.0179, 0.0240];
const SSIM = [0.0003, 0.0003, 0.0066, 0.0074, 0.0020, 0.0049];

function mean(xs: number[]): number { return xs.reduce((a, b) => a + b, 0) / xs.length; }

describe('effectSize — standardized margin d = mean/std (sample std, n−1)', () => {
  it('equals mean/sample-std on the published wmean margins', () => {
    const m = mean(CAS_WMEAN);
    const sd = Math.sqrt(CAS_WMEAN.reduce((a, x) => a + (x - m) ** 2, 0) / (CAS_WMEAN.length - 1));
    expect(effectSize(CAS_WMEAN)).toBeCloseTo(m / sd, 12);
  });

  // The crux of fix/cas-multiplier-claim: under an affine re-expression CAS' = a·CAS (+b),
  // every margin (a difference between conditions) scales by a, so mean and std both scale
  // by |a| and d is invariant. A metric summary must not change when the metric is merely
  // re-unitized — d is therefore legitimately comparable across metrics.
  it('is invariant under rescaling of the metric', () => {
    const d = effectSize(CAS_WMEAN);
    expect(effectSize(CAS_WMEAN.map((x) => 2 * x))).toBeCloseTo(d, 12);
    expect(effectSize(CAS_WMEAN.map((x) => 0.5 * x))).toBeCloseTo(d, 12);
  });

  // The retracted "× vs SSIM" column was mean(CAS margins)/mean(SSIM margins) — a cross-metric
  // ratio of RAW margins. Demonstrate it is NOT scale-invariant: halving CAS's scale halves the
  // "multiplier", so the old 5.3–5.9× numbers were unit-dependent and meaningless as stated.
  it('old cross-metric raw-margin ratio is NOT scale-invariant (the retracted claim)', () => {
    const oldRatio = (casMargins: number[]) => mean(casMargins) / mean(SSIM);
    expect(oldRatio(CAS_WMEAN.map((x) => 0.5 * x))).toBeCloseTo(0.5 * oldRatio(CAS_WMEAN), 12);
    expect(Math.abs(oldRatio(CAS_WMEAN.map((x) => 0.5 * x)) - oldRatio(CAS_WMEAN)))
      .toBeGreaterThan(1); // shifts by whole multiples — nowhere near invariant
  });
});
