// Pure, framework-free temporal-harness logic (feat/temporal-animation, DESIGN §4.9).
//
// Extracted so the four pieces that carry the harness's DECISIONS — (1) the stage-error
// classification that decides PENDING-vs-VIOLATION, (2) the DESIGN §4.9 δ-margin hysteresis
// ORACLE and its verdict, (3) the reference-frame drift / keyframe verdict, and (4) the
// invariant/reset CONFIG PLAN — are unit-testable WITHOUT the (not-yet-landed) GPU temporal
// runner and WITHOUT a browser/WebGPU context (see web/src/temporal-logic.test.ts).
// temporal-page.ts (in-page) and test-e2e/temporal.spec.ts (node driver) both consume these,
// so there is ONE source of truth for the sentinels, the verdict rules, and the frame/config
// plans. No import of browser or src/core types — everything operates on primitives.

// ── Stage-error classification ───────────────────────────────────────────────────────────────
// A temporal stage may throw for two categorically different reasons:
//   • the temporal path is NOT LANDED / the landed runner lacks a capability the harness needs
//     (a SHAPE MISMATCH) / WebGPU is unavailable — these are the honest PENDING states, and the
//     run exits 3 (unverified, not violated);
//   • ANYTHING ELSE thrown AFTER the runner resolved (a mid-orbit GPU device-lost, an OOM, a
//     defensive divergence throw, an assertion) is a real defect in a live temporal path and MUST
//     exit 1 — it is NOT the sanctioned pre-landing PENDING state.
// classifyStageError distinguishes the two by the sentinel PREFIXES the harness itself throws;
// the message may be wrapped by playwright ("page.evaluate: Error: <sentinel> …"), so match by
// substring. Any message NOT carrying a sentinel is a violation.
export const SENTINEL_NOT_LANDED = 'TEMPORAL API NOT LANDED';
export const SENTINEL_SHAPE_MISMATCH = 'TEMPORAL API SHAPE MISMATCH';
export const SENTINEL_NO_WEBGPU = 'TEMPORAL runner unavailable (WebGPU)';
export const PENDING_SENTINELS = [SENTINEL_NOT_LANDED, SENTINEL_SHAPE_MISMATCH, SENTINEL_NO_WEBGPU] as const;

export type StageErrorKind = 'pending' | 'violation';
export function classifyStageError(message: string | null | undefined): StageErrorKind {
  const m = message ?? '';
  for (const s of PENDING_SENTINELS) if (m.includes(s)) return 'pending';
  return 'violation';
}

export type Verdict = 'MET' | 'PARTIAL' | 'FALSIFIED' | 'PENDING';

// ── DESIGN §4.9 hysteresis ORACLE ────────────────────────────────────────────────────────────
// SSOT rule (DESIGN §4.9, verbatim): "새 후보가 마진 δ 이상 이길 때만 glyph 교체" — replace a
// retained glyph ONLY when a fresh candidate beats it by margin ≥ δ. Scores here are RESIDUALS
// (src/core/match.ts selects by argmin: lower = better), so "fresh beats retained by ≥ δ" is
//   margin := retainedScore − bestScore ≥ δ.
// The oracle is reprojection-aware (DESIGN §4.9: "motion vector로 이전 프레임 선택을 재투영"):
// each current cell names, via `srcIdx`, the PREDECESSOR cell its selection was reprojected from
// (or -1 for a cold / disoccluded cell that has no predecessor). `prevCh` is the glyph THAT
// reprojected predecessor painted — NOT the index-aligned prev cell.
export interface HysteresisCellInput {
  srcIdx: number; // reprojected predecessor index into prev grid, or -1 (cold / disoccluded)
  prevCh: string | null; // glyph the reprojected predecessor painted; null iff srcIdx < 0
  emittedCh: string; // glyph the temporal path actually emitted this frame
  bestCh: string; // fresh full-rematch winner (argmin) glyph for this cell
  retainedScore: number; // score of the retained (reprojected-predecessor) glyph rescored on this cell
  bestScore: number; // score of the fresh full-rematch winner on this cell
}

export interface HysteresisStats {
  cellsWithPrev: number; // cells that HAVE a predecessor (a hysteresis decision was possible)
  expectRetain: number; // margin < δ  → SSOT says keep the predecessor glyph
  expectReplace: number; // margin ≥ δ  → SSOT says swap to the fresh winner
  sticky: number; // observed RETAIN where the fresh winner differs → hysteresis genuinely held a near-tie
  ghostingViolations: number; // margin ≥ δ yet kept old glyph — DESIGN §4.9 "과도하면 끈적임"
  sparkleViolations: number; // margin < δ yet swapped glyph — DESIGN §4.9 "부족하면 sparkle"
  strayEmissions: number; // emitted a glyph that is NEITHER the predecessor NOR the fresh winner (malformed)
}

export function emptyHysteresisStats(): HysteresisStats {
  return { cellsWithPrev: 0, expectRetain: 0, expectReplace: 0, sticky: 0, ghostingViolations: 0, sparkleViolations: 0, strayEmissions: 0 };
}

export function accumulateHysteresis(agg: HysteresisStats, cells: HysteresisCellInput[], delta: number): HysteresisStats {
  for (const c of cells) {
    if (c.srcIdx < 0 || c.prevCh === null) continue; // cold / disoccluded → full rematch, no hysteresis decision
    agg.cellsWithPrev++;
    const margin = c.retainedScore - c.bestScore; // > 0 ⇒ fresh candidate is strictly better (lower residual)
    const expectReplaceCell = margin >= delta; // DESIGN §4.9 δ-margin rule
    if (expectReplaceCell) agg.expectReplace++; else agg.expectRetain++;
    const winnerDiffers = c.bestCh !== c.prevCh; // there is actually a DIFFERENT glyph to switch to
    const observedRetain = c.emittedCh === c.prevCh;
    const observedReplace = c.emittedCh === c.bestCh && c.emittedCh !== c.prevCh;
    // Ghosting requires a genuinely different decisive winner that was NOT taken; when the fresh
    // winner IS the predecessor glyph (winnerDiffers=false) keeping it is a no-op, never ghosting.
    if (expectReplaceCell && observedRetain && winnerDiffers) agg.ghostingViolations++;
    if (!expectReplaceCell && observedReplace) agg.sparkleViolations++;
    if (!observedRetain && !observedReplace) agg.strayEmissions++;
    if (observedRetain && winnerDiffers) agg.sticky++;
  }
  return agg;
}

// Verdict for P-hysteresis. Crucially has a FALSIFIED branch: any δ-margin rule violation
// (ghosting = excessive stickiness, sparkle = premature swap, or a stray emission) FALSIFIES the
// prediction — a runner that NEVER replaces (maximal ghosting, the exact DESIGN §4.9 failure mode)
// necessarily produces ghostingViolations on every decisive-margin cell and is reported FALSIFIED,
// not MET. MET requires BOTH: the rule held everywhere AND genuine hysteresis stickiness was
// observed (sticky > 0). Rule-respected-but-no-stickiness is PARTIAL (δ too small / no near-ties).
export function hysteresisVerdict(s: HysteresisStats): Verdict {
  if (s.cellsWithPrev === 0) return 'PARTIAL'; // no predecessors → nothing to decide
  if (s.ghostingViolations > 0 || s.sparkleViolations > 0 || s.strayEmissions > 0) return 'FALSIFIED';
  if (s.sticky === 0) return 'PARTIAL'; // rule respected but hysteresis never exercised
  return 'MET';
}

// ── Reference-frame drift / keyframe (DESIGN §4.9 "변경 셀만 delta 인코딩 (터미널 비디오 코덱)") ──
// A previous-frame change detector with a per-frame threshold accumulates UNBOUNDED drift on
// slowly-varying cells (per-frame change stays < ε forever while cumulative change diverges).
// The video-codec analogy in §4.9 implies periodic I-frames: at a KEYFRAME the temporal output
// MUST be a full recompute — byte-identical to the same-frame full rematch — which snaps any
// accumulated drift back to ground truth. Keyframe equality is the ε>0 correctness assertion the
// ε=0 invariant cannot make (at ε=0 previous-frame and reference-frame semantics coincide).
export const DRIFT_KEYFRAMES = [0, 15, 30, 45, 60] as const;
export function isKeyframe(f: number): boolean { return (DRIFT_KEYFRAMES as readonly number[]).includes(f); }
export function driftDivergenceFrac(mismatchCells: number, totalCells: number): number {
  return totalCells > 0 ? mismatchCells / totalCells : 0;
}
// keyframeViolations > 0 ⇒ a keyframe was NOT a full rematch ⇒ hard drift bug (also exit-gating in
// the driver). Otherwise MET (drift is bounded by the keyframe resets); PARTIAL only if no
// between-keyframe frame was measured. The measured max between-keyframe divergence is reported
// verbatim as DATA (no arbitrary pass threshold).
export function driftVerdict(keyframeViolations: number, nonKeyframeFramesMeasured: number): Verdict {
  if (keyframeViolations > 0) return 'FALSIFIED';
  if (nonKeyframeFramesMeasured === 0) return 'PARTIAL';
  return 'MET';
}

// ── Invariant / state-invalidation CONFIG PLAN (ε=0 / δ=0 byte-identity contract) ──────────────
// The ε=0/δ=0 invariant is byte-identity to the full same-frame rematch. Holding a SINGLE frozen
// config for a whole orbit lets a detector keyed only on per-cell pixel stats pass while it would
// serve STALE glyphs on the first mid-animation config change (the stale-state bug class). This
// plan threads one prev grid across an orbit whose config CHANGES at fixed points — on each of the
// space, cols, and charset axes — so the byte-identity contract also certifies temporal-state
// INVALIDATION: a detector that fails to invalidate on a config change (or fails to reset when the
// threaded prev's dimensions no longer match) produces a byte-identity break → exit 1. Each
// segment is ≥ 2 frames so the FIRST post-transition frame (where a stale detector could reuse the
// now-current config) is also exercised with a threaded prev.
export type Charset = 'ascii' | 'blocks' | 'braille' | 'full';
export type Space = 'linear' | 'gamma';
export interface HarnessCfg { charset: Charset; cols: number; space: Space }
export type TransitionAxis = 'none' | 'space' | 'cols' | 'charset';
export interface PlanStep { frame: number; cfg: HarnessCfg; transition: TransitionAxis }

export const INVARIANT_FRAMES = 61;
export function invariantPlan(): PlanStep[] {
  // Segments sum to INVARIANT_FRAMES. Each segment's FIRST frame carries the axis that changed
  // versus the previous segment; the reverts at the end also change config (extra invalidation)
  // but are not tagged (the coverage assertion only needs each axis to appear once as the change).
  const segs: { len: number; transition: TransitionAxis; cfg: HarnessCfg }[] = [
    { len: 20, transition: 'none', cfg: { charset: 'blocks', cols: 100, space: 'gamma' } },
    { len: 14, transition: 'space', cfg: { charset: 'blocks', cols: 100, space: 'linear' } },
    { len: 14, transition: 'cols', cfg: { charset: 'blocks', cols: 80, space: 'linear' } },
    { len: 13, transition: 'charset', cfg: { charset: 'ascii', cols: 80, space: 'linear' } },
  ];
  const steps: PlanStep[] = [];
  let f = 0;
  for (const seg of segs) {
    for (let i = 0; i < seg.len; i++) {
      steps.push({ frame: f, cfg: { ...seg.cfg }, transition: i === 0 ? seg.transition : 'none' });
      f++;
    }
  }
  return steps;
}
