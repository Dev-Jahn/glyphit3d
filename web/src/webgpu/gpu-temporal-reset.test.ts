import { describe, it, expect } from 'vitest';
import { temporalResetNeeded } from './gpu-temporal.js';

// feat/temporal-animation §4.4 — the temporal-state RESET matrix as a pure predicate (no GPU, no
// browser). A missed reset reuses a stale reference emit under a NEW decision regime and silently
// corrupts output; the byte-identity contract (temporal-page.ts EXPECTED CONTRACT: "At epsilon=0 AND
// delta=0 this MUST reduce to runFull bit-for-bit") is UNCONDITIONAL on history, so every reset axis
// is pinned here — including the ε/δ axis a prior version omitted.

// A live, unchanged-config reference (config sig same, reference valid, not an explicit keyframe).
const live = { keyframe: false, sigDiffers: false, refInvalid: false };

describe('temporalResetNeeded — keyframe/reset matrix', () => {
  it('an explicit keyframe flag resets', () => {
    expect(temporalResetNeeded({ ...live, keyframe: true, refEpsilon: 0, refDelta: 0, epsilon: 0, delta: 0 })).toBe(true);
  });
  it('a config-signature change resets', () => {
    expect(temporalResetNeeded({ ...live, sigDiffers: true, refEpsilon: 0, refDelta: 0, epsilon: 0, delta: 0 })).toBe(true);
  });
  it('an invalid/absent/dim-mismatched reference resets', () => {
    expect(temporalResetNeeded({ ...live, refInvalid: true, refEpsilon: 0, refDelta: 0, epsilon: 0, delta: 0 })).toBe(true);
  });
  it('a live reference at IDENTICAL ε/δ does NOT reset (the delta-frame fast path)', () => {
    expect(temporalResetNeeded({ ...live, refEpsilon: 0, refDelta: 0, epsilon: 0, delta: 0 })).toBe(false);
    expect(temporalResetNeeded({ ...live, refEpsilon: 1 / 255, refDelta: 4e-3, epsilon: 1 / 255, delta: 4e-3 })).toBe(false);
  });

  // ── The finding-1 regression: switching δ (or ε) on an otherwise-unchanged config MUST reset. ──
  // Repro of the corruption path this guards: runTemporal(δ=0.5) makes a cell STICKY (emits the
  // predecessor glyph though the argmin differs) and stores that sticky emit in the reference; a
  // later runTemporal(ε=0, δ=0) on the SAME frame finds the cell bit-unchanged and would reuse the
  // sticky emit verbatim — a byte-identity break vs runFull. The δ change must force a keyframe.
  it('a δ change on an unchanged config resets (δ>0 → δ=0 sticky-glyph contamination)', () => {
    expect(temporalResetNeeded({ ...live, refEpsilon: 0, refDelta: 0.5, epsilon: 0, delta: 0 })).toBe(true);
    expect(temporalResetNeeded({ ...live, refEpsilon: 0, refDelta: 0, epsilon: 0, delta: 4e-3 })).toBe(true);
  });
  it('an ε change on an unchanged config resets (a coarser-ε skip carries a coarser decision)', () => {
    expect(temporalResetNeeded({ ...live, refEpsilon: 1 / 255, refDelta: 0, epsilon: 0, delta: 0 })).toBe(true);
    expect(temporalResetNeeded({ ...live, refEpsilon: 0, refDelta: 0, epsilon: 2 / 255, delta: 0 })).toBe(true);
  });
  it('no reference yet (NaN ε/δ) always resets — the first call is a cold keyframe', () => {
    expect(temporalResetNeeded({ ...live, refEpsilon: NaN, refDelta: NaN, epsilon: 0, delta: 0 })).toBe(true);
  });
});
