import { describe, it, expect } from 'vitest';
import {
  classifyStageError,
  SENTINEL_NOT_LANDED, SENTINEL_SHAPE_MISMATCH, SENTINEL_NO_WEBGPU,
  accumulateHysteresis, emptyHysteresisStats, hysteresisVerdict,
  type HysteresisCellInput,
  driftVerdict, isKeyframe, driftDivergenceFrac, DRIFT_KEYFRAMES,
  invariantPlan, INVARIANT_FRAMES,
} from './temporal-logic.js';

// Helper: build a per-cell hysteresis input. Scores are residuals (lower = better).
function cell(p: Partial<HysteresisCellInput>): HysteresisCellInput {
  return { srcIdx: 0, prevCh: 'a', emittedCh: 'a', bestCh: 'a', retainedScore: 1, bestScore: 1, ...p };
}
function score(cells: HysteresisCellInput[], delta: number) {
  return accumulateHysteresis(emptyHysteresisStats(), cells, delta);
}

// ── #2 exit-code classification: NOT-LANDED / SHAPE / no-WebGPU ⇒ pending; anything else ⇒ violation.
describe('classifyStageError (exit-code policy)', () => {
  it('maps the three PENDING sentinels (even playwright-wrapped) to pending', () => {
    expect(classifyStageError(`${SENTINEL_NOT_LANDED}: import failed`)).toBe('pending');
    expect(classifyStageError(`page.evaluate: Error: ${SENTINEL_NOT_LANDED}: x`)).toBe('pending');
    expect(classifyStageError(`${SENTINEL_SHAPE_MISMATCH}: no runTemporalScored`)).toBe('pending');
    expect(classifyStageError(`${SENTINEL_NO_WEBGPU} in this context`)).toBe('pending');
  });
  it('maps ANY non-sentinel error thrown after the runner resolved to violation (crash ≠ not-landed)', () => {
    // Precisely the finding: a crashing landed implementation must NOT dodge the exit-1 contract.
    expect(classifyStageError('Error: GPU device lost mid-orbit')).toBe('violation');
    expect(classifyStageError('RangeError: out of memory allocating temporal buffer')).toBe('violation');
    expect(classifyStageError('Error: temporal output diverged, refusing to continue')).toBe('violation');
    expect(classifyStageError('')).toBe('violation');
    expect(classifyStageError(null)).toBe('violation');
  });
});

// ── #3 / #8 hysteresis oracle + verdict: FALSIFIED branch exists; ghosting/sparkle are caught.
describe('hysteresis oracle & verdict (DESIGN §4.9 δ-margin rule)', () => {
  const delta = 0.02;

  it('FALSIFIES pure ghosting: a runner that NEVER replaces despite decisive margins', () => {
    // Every cell has a fresh winner beating the retained glyph by ≥ δ, yet the runner keeps prev.
    const cells = Array.from({ length: 50 }, (_, i) =>
      cell({ srcIdx: i, prevCh: 'a', bestCh: 'b', emittedCh: 'a', retainedScore: 1.0, bestScore: 0.5 }));
    const s = score(cells, delta);
    expect(s.ghostingViolations).toBe(50);
    expect(s.sticky).toBe(50); // maximal stickiness…
    // …which the PRE-FIX rule (stickyFrac>0 ? 'MET' : 'PARTIAL') would have reported MET.
    const prefixVerdict = s.sticky > 0 ? 'MET' : 'PARTIAL';
    expect(prefixVerdict).toBe('MET'); // documents the defect
    expect(hysteresisVerdict(s)).toBe('FALSIFIED'); // the fix
  });

  it('FALSIFIES sparkle: swapping a glyph on a near-tie (margin < δ)', () => {
    const cells = Array.from({ length: 10 }, (_, i) =>
      cell({ srcIdx: i, prevCh: 'a', bestCh: 'b', emittedCh: 'b', retainedScore: 1.0, bestScore: 0.995 }));
    const s = score(cells, delta);
    expect(s.sparkleViolations).toBe(10);
    expect(hysteresisVerdict(s)).toBe('FALSIFIED');
  });

  it('reports MET only when the rule holds AND genuine stickiness is observed', () => {
    const cells: HysteresisCellInput[] = [
      // near-tie → correctly retained (sticky, fresh winner differs)
      ...Array.from({ length: 8 }, (_, i) => cell({ srcIdx: i, prevCh: 'a', bestCh: 'b', emittedCh: 'a', retainedScore: 1.0, bestScore: 0.995 })),
      // decisive margin → correctly replaced
      ...Array.from({ length: 8 }, (_, i) => cell({ srcIdx: 8 + i, prevCh: 'a', bestCh: 'c', emittedCh: 'c', retainedScore: 1.0, bestScore: 0.5 })),
    ];
    const s = score(cells, delta);
    expect(s.ghostingViolations + s.sparkleViolations + s.strayEmissions).toBe(0);
    expect(s.sticky).toBe(8);
    expect(hysteresisVerdict(s)).toBe('MET');
  });

  it('a CORRECT replacement is NOT counted as a "disagreement" (pre-fix counter measured agreement)', () => {
    // full changed AND temporal also changed to the SAME fresh winner with a decisive margin: the
    // normal agreement case. Pre-fix `disagreements` (stuck!==oracleStuck && !stuck) incremented here.
    const cells = Array.from({ length: 20 }, (_, i) =>
      cell({ srcIdx: i, prevCh: 'a', bestCh: 'b', emittedCh: 'b', retainedScore: 1.0, bestScore: 0.5 }));
    const s = score(cells, delta);
    expect(s.ghostingViolations + s.sparkleViolations + s.strayEmissions).toBe(0); // true violations = 0
    expect(s.expectReplace).toBe(20);
  });

  it('is reprojection-aware: uses srcIdx (moved predecessor), not the index-aligned prev cell', () => {
    // Current cell 5 reprojects from predecessor 9; its prevCh is that predecessor's glyph.
    // A near-tie retain against the REPROJECTED predecessor is correct; an index-aligned oracle
    // (comparing to prev[5]) would misjudge it.
    const s = score([cell({ srcIdx: 9, prevCh: 'z', bestCh: 'q', emittedCh: 'z', retainedScore: 1.0, bestScore: 0.999 })], delta);
    expect(s.cellsWithPrev).toBe(1);
    expect(s.ghostingViolations + s.sparkleViolations).toBe(0);
    expect(s.sticky).toBe(1);
  });

  it('cold / disoccluded cells (srcIdx < 0) carry no hysteresis decision', () => {
    const s = score([cell({ srcIdx: -1, prevCh: null, bestCh: 'b', emittedCh: 'b' })], delta);
    expect(s.cellsWithPrev).toBe(0);
    expect(hysteresisVerdict(s)).toBe('PARTIAL');
  });

  it('does NOT flag ghosting when the fresh winner IS the predecessor glyph (no-op replacement)', () => {
    // Runner recomputed and got the SAME glyph as the predecessor. Even if it reports a decisive
    // margin, keeping that glyph is not ghosting — there is no different winner to switch to.
    const cells = Array.from({ length: 30 }, (_, i) =>
      cell({ srcIdx: i, prevCh: 'a', bestCh: 'a', emittedCh: 'a', retainedScore: 1.0, bestScore: 0.0 }));
    const s = score(cells, delta);
    expect(s.ghostingViolations).toBe(0);
    expect(s.sticky).toBe(0); // no genuine hysteresis hold (winner did not differ)
    expect(hysteresisVerdict(s)).toBe('PARTIAL');
  });

  it('FALSIFIES a stray emission (neither predecessor nor fresh winner)', () => {
    const s = score([cell({ srcIdx: 0, prevCh: 'a', bestCh: 'b', emittedCh: 'x', retainedScore: 1, bestScore: 1 })], delta);
    expect(s.strayEmissions).toBe(1);
    expect(hysteresisVerdict(s)).toBe('FALSIFIED');
  });
});

// ── #5 reference-frame drift / keyframe.
describe('drift / keyframe verdict', () => {
  it('keyframe indices and divergence fraction', () => {
    expect(DRIFT_KEYFRAMES.every((f) => isKeyframe(f))).toBe(true);
    expect(isKeyframe(7)).toBe(false);
    expect(driftDivergenceFrac(50, 200)).toBeCloseTo(0.25);
    expect(driftDivergenceFrac(0, 0)).toBe(0);
  });
  it('a keyframe that is not a full rematch FALSIFIES (unbounded reference-frame drift)', () => {
    expect(driftVerdict(1, 40)).toBe('FALSIFIED');
    expect(driftVerdict(0, 40)).toBe('MET');
    expect(driftVerdict(0, 0)).toBe('PARTIAL');
  });
});

// ── #6 / #7 invariant / state-invalidation config plan.
describe('invariantPlan (state-invalidation coverage)', () => {
  const plan = invariantPlan();
  it('spans exactly INVARIANT_FRAMES frames, indexed 0..N-1', () => {
    expect(plan.length).toBe(INVARIANT_FRAMES);
    expect(plan.map((s) => s.frame)).toEqual(Array.from({ length: INVARIANT_FRAMES }, (_, i) => i));
  });
  it('exercises a transition on EACH of space, cols, and charset (pre-fix: single frozen config)', () => {
    const axes = new Set(plan.filter((s) => s.transition !== 'none').map((s) => s.transition));
    expect(axes.has('space')).toBe(true);
    expect(axes.has('cols')).toBe(true);
    expect(axes.has('charset')).toBe(true);
  });
  it('holds each changed config for ≥1 further frame so the post-transition (stale-vs-fresh) frame is tested', () => {
    for (let i = 0; i < plan.length; i++) {
      if (plan[i]!.transition !== 'none') {
        expect(i + 1).toBeLessThan(plan.length);
        expect(plan[i + 1]!.transition).toBe('none');
        // same config as the transition frame → the reuse path is genuinely exercised
        expect(plan[i + 1]!.cfg).toEqual(plan[i]!.cfg);
      }
    }
  });
});
