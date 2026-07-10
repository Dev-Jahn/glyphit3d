import { describe, it, expect } from 'vitest';
import { formatPerf, type PerfTimings } from './perf.js';

// feat/temporal-animation (SPEC §6.2): the optional temporal cell readout is purely additive —
// absent ⇒ today's exact string; present ⇒ a trailing "temporal changed/total cells (pct%)".
const T: PerfTimings = { render: 1.23, resample: 4.56, match: 7.8, raster: 9.01, ssim: 2.34 };

describe('formatPerf temporal readout', () => {
  it('is byte-identical to the pre-temporal string when no temporal stats are supplied', () => {
    expect(formatPerf(T)).toBe(
      'render 1.2ms  resample 4.6ms  match 7.8ms  raster 9.0ms  ssim 2.3ms  → interactive 16.8ms',
    );
  });

  it('appends the changed/total cells fraction when supplied', () => {
    expect(formatPerf(T, { changed: 250, total: 1000 })).toBe(
      'render 1.2ms  resample 4.6ms  match 7.8ms  raster 9.0ms  ssim 2.3ms  → interactive 16.8ms  temporal 250/1000 cells (25.0%)',
    );
  });

  it('guards total=0 (no divide-by-zero)', () => {
    expect(formatPerf(T, { changed: 0, total: 0 })).toContain('temporal 0/0 cells (0.0%)');
  });
});
