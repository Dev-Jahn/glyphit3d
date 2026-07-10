# Temporal coherence — results & honest-reporting ledger

**Task:** `feat/temporal-animation` (DESIGN §4.9). Agent C (harness / metrics / results), wave-2 chain A.
**Harness:** `test-e2e/temporal.spec.ts` + `web/temporal.html` + `web/src/temporal-page.ts`.
**No-flag repro:** `npm run temporal` (≡ `npx tsx test-e2e/temporal.spec.ts`).

---

## ⚠️ Status: PARTIAL — substrate verified, temporal contract UNVERIFIED (path not yet landed)

At the time this harness was authored the temporal rematch path (reprojection + hysteresis, agents
A/B) had **not landed** in the shared worktree — there is no temporal API surface in `web/src/pipeline.ts`,
`web/src/webgpu/*`, or `src/core/*` (which is frozen CPU truth and stays so). The harness therefore:

- **runs and verifies everything that does not depend on the temporal API** (the deterministic orbit
  substrate — see H0 below), on the real Blackwell GPU via ANGLE-Vulkan, and
- **reports the temporal invariant / hysteresis / speedup as PENDING** through one documented seam
  (`getTemporalRunner` in `temporal-page.ts`), throwing an explicit "TEMPORAL API NOT LANDED" error
  rather than silently skipping.

**Exit codes:** `0` all contracts held · `1` a CONTRACT was violated (byte-identity break, a broken
harness self-check, a keyframe that is not a full rematch, **or any non-sentinel error thrown after
the runner resolved** — a mid-orbit crash/device-lost/OOM is a real defect, NOT a pending state) ·
`3` PENDING (temporal path not landed / the landed runner lacks a capability the harness needs →
invariant unverified, *not* violated). With the temporal path still absent the last run exits **3**;
this redness of the `… && npm run temporal && …` gate chain is the honest reflection of the unlanded
feature (see the blocker below) — it is NOT masked to green, and it flips to `0` the moment a
conforming runner lands (verified end-to-end against a trivially-correct CPU stub during this fix).

### ⚠️ SSOT gap — spec §7 predictions could not be quoted verbatim

Agent C's brief requires *"every spec §7 prediction quoted verbatim with verdict."* The governing
spec file (`scratchpad/spec-temporalAnimation.md`, said to be written against `b49553a`) **does not
exist on disk** anywhere in the session scratchpad or the repo. Its §7 predictions cannot be quoted
verbatim from a file that is absent — fabricating them would be dishonest. The predictions below are
instead grounded in the **real SSOT, DESIGN §4.9, quoted verbatim**, plus the byte-identity contract
stated explicitly in the task brief. **Assemble must locate the spec and reconcile / replace the §7
verbatim block; if the spec is truly lost, DESIGN §4.9 is the standing falsifiable SSOT.**

---

## SSOT under test — DESIGN §4.9 (quoted verbatim)

> ### 4.9 Temporal coherence [M4]
> - 3D 파이프라인의 공짜 **motion vector로 이전 프레임 선택을 재투영**한 뒤
>   hysteresis: 새 후보가 마진 δ 이상 이길 때만 glyph 교체. 회전 중 ghosting 없이
>   sparkle 제거. (과도하면 끈적임, 부족하면 sparkle — 튜닝 창이 좁다는 리스크.)
> - 멀티프레임 sprite는 프레임 간 **변경 셀만 delta 인코딩** (터미널 비디오 코덱).

---

## Honest-reporting table (last run — temporal path not landed)

| ID | Prediction (source) | Verdict | Measured |
|----|---------------------|---------|----------|
| **H0 harness-determinism** | The deterministic FAST/SLOW orbit renders reproducibly and `matchGrid` is byte-identical to itself — the substrate the invariant stands on. (harness self-check) | **MET** | 0 mismatched frames across both orbits (**122 frames**), on the real GPU context. |
| **P-invariant (CONTRACT)** | temporal rematch at **epsilon=0 AND delta=0** is **byte-identical** to the same-frame full rematch on all **61 frames × 2 orbits**, **INCLUDING across mid-orbit space→cols→charset changes** (state invalidation): reuse/hysteresis is suppressed AND stale temporal state must never survive a config change. (task brief + DESIGN §4.9) | **PENDING** | not runnable — `TEMPORAL API NOT LANDED` (`./gpu-temporal.js` absent). |
| **P-hysteresis** | DESIGN §4.9: *"새 후보가 마진 δ 이상 이길 때만 glyph 교체 … 회전 중 ghosting 없이 sparkle 제거"* — a **reprojection-aware δ-margin ORACLE** (rescoring prev-reprojected vs fresh winner per cell) counts ghosting (kept a decisive winner — *"과도하면 끈적임"*) and sparkle (swapped a near-tie — *"부족하면 sparkle"*) violations; **either FALSIFIES**. MET requires the rule held everywhere AND genuine stickiness (sticky > 0). | **PENDING** | not runnable — needs `runTemporalScored` (per-cell scores); `TEMPORAL API NOT LANDED`. |
| **P-drift (CONTRACT: keyframe)** | DESIGN §4.9 *"변경 셀만 delta 인코딩 (터미널 비디오 코덱)"* — at each keyframe the temporal output is a full recompute, **byte-identical** to the same-frame full rematch, so reference-frame drift on slowly-varying cells stays bounded (never accumulates past the ε per-frame threshold). A keyframe that differs = unbounded drift → **exit 1**. | **PENDING** | not runnable — `TEMPORAL API NOT LANDED`. |
| **P-reuse-speedup** | DESIGN §4.9: *"변경 셀만 delta 인코딩"* — reusing prior-frame selections on near-static cells makes a temporal rematch faster than a full rematch on the SLOW orbit. | **PENDING** | not runnable — `TEMPORAL API NOT LANDED`. |
| **P-tuning-window (risk)** | DESIGN §4.9 risk: *"과도하면 끈적임, 부족하면 sparkle — 튜닝 창이 좁다는 리스크"* — the usable δ band that removes sparkle without introducing ghosting (stickiness) may be narrow. | **PENDING** | requires a δ sweep once the path lands (see "Left for assemble"). |

Verdict legend: **MET** (prediction held) · **PARTIAL** (mixed / weak) · **FALSIFIED** (measured
against the prediction — a *publishable result*, never tuned away) · **PENDING** (not runnable yet).

---

## What the harness proves and how (design)

- **Canonical deterministic orbits** (`orbitPose`, shared by page + driver): 61 frames each.
  SLOW = 1°/frame yaw (0→60°, small per-frame motion — the reuse regime); FAST = 6°/frame yaw
  (0→360°, large per-frame motion — the ghosting stress). Pitch fixed at −15°. The pose is a pure
  function of `(mode, frame)`, identical in both harness halves.
- **ONE render per frame, shared across modes.** Each frame is rendered once to a `LinearImage`; the
  full-rematch reference and the temporal rematch both consume a copy of that identical image, so the
  invariant is not confounded by render nondeterminism.
- **Byte-identity = per-cell `GridCell` identity** on `ch` + `fg` + `bg` (the three fields that define
  what a cell paints) — `diffGrids` reports the count and the first differing cell verbatim.
- **Same-path invariant.** The byte-exact reference is `runner.runFull` — a full rematch through the
  **same matcher path** as `runner.runTemporal`. This makes the ε=0/δ=0 identity a property of the
  reuse/hysteresis *logic* alone, immune to CPU↔GPU f32 divergence (which would otherwise break a
  byte claim even with correct logic). Contract violation ⇒ exit 1.
- **State invalidation is inside the invariant**, not a separate config. `invariantPlan()` threads a
  single `prev` grid across an orbit whose config CHANGES at fixed points — space (frame 20), cols
  (frame 34), charset (frame 48) — so the ε=0/δ=0 byte-identity contract also certifies that a
  detector INVALIDATES on a config change and RESETS when the threaded prev's dimensions no longer
  match. A single frozen config (the pre-fix harness) could not catch a stale-state detector.
- **Hysteresis** is a δ>0 check against a **TRUE, reprojection-aware δ-margin ORACLE**: the runner
  exposes, per cell, the reprojection source index and the two scores the §4.9 rule compares
  (prev-reprojected rescored vs fresh winner). The oracle independently derives RETAIN/REPLACE and
  flags ghosting/sparkle rule violations — so a pure-ghosting runner (never replaces) is reported
  **FALSIFIED**, not MET. It is a logic check (never fails the run).
- **Reference-frame drift** is asserted in the ε>0 regime via **keyframe equality**: at DRIFT_KEYFRAMES
  (0,15,30,45,60) on the SLOW orbit the temporal output MUST byte-equal the same-frame full rematch
  (a codec I-frame full recompute) — the only output-correctness assertion the ε=0 invariant cannot
  make. A non-identical keyframe is unbounded drift → exit 1; between-keyframe divergence is reported.
- **Reuse-speedup** is a warm median of full vs temporal wall time on the SLOW orbit; a falsified
  speedup is reported as FALSIFIED and does **not** fail the run.

## Design mapping vs the (moved) spec — deltas recorded

The spec was written against `b49553a`; the worktree moved. Agent C's own surface (harness/page/docs)
does not touch the pipeline, so the two context deltas affect only what the harness *targets*:

1. **§4.4 pipeline-level mutex vs the single-flight coalescer (commit 9a20027).** The harness drives
   the temporal path **directly** (via `getTemporalRunner`), one call at a time, awaiting each — it
   never races two rematches. So the harness neither needs nor asserts the app-level coalescer, and
   introduces **no** duplicate serialization machinery. Whether direct `pipeline.run` callers can still
   interleave in the *app* is A/B's concern, out of Agent C's ownership.
2. **§3.4 dirty-rect vs the GPU raster path (gpu-rasterizer reshape).** The temporal invariant is
   matcher-path-agnostic by construction (same-path reference), so it holds regardless of whether the
   landed path expresses partial update as a CPU dirty-rect or a GPU changed-cell buffer upload. The
   harness asserts the *observable* contract (emitted cells identical at ε=0/δ=0), not the internal
   update mechanism.

## Left for assemble (after A/B land the temporal path)

The EXPECTED CONTRACT in `web/src/temporal-page.ts` now demands FOUR things beyond a bare
full/temporal pair — each is the minimum needed to falsify a DESIGN §4.9 clause, and each was
verified end-to-end during this fix against a trivially-correct CPU stub runner (all contract stages
PASS → exit 0; hysteresis reports PARTIAL for a no-hysteresis runner; a crashing stub exits 1):

1. **Wire `getTemporalRunner`** to the landed module (single seam). The landed runner must expose:
   - `runFull` / `runTemporal(…, prev, {epsilon, delta, keyframe})` returning a `Grid`. `keyframe:true`
     ⇒ ignore prev, emit a full recompute (codec I-frame). A prev whose dims no longer match ⇒ reset.
   - `runTemporalScored(…)` returning `{ grid, stats }` where `stats[i] = {srcIdx, retainedScore,
     bestScore, bestCh}` — the reprojection source and the two scores the §4.9 δ-margin rule compares.
     Without it the hysteresis stage reports **SHAPE MISMATCH → PENDING** (never a fabricated MET).
   - `runFull` MUST be the same matcher path as `runTemporal`.
2. **Re-run `npm run temporal`.** ε=0/δ=0 identity (incl. across state-invalidation transitions) and
   keyframe equality flip MET → exit 0; any byte-identity/keyframe break, or a non-sentinel crash
   after the runner resolved, exits 1 (a real, reportable violation — no longer masked as PENDING).
3. **Fill this table** with the measured hysteresis ghosting/sparkle counts + sticky fraction, the
   max between-keyframe divergence, and the full-vs-temporal speedup; record MET/PARTIAL/**FALSIFIED**.
4. **δ sweep** for `P-tuning-window`: sweep δ and record the sparkle↔ghosting band width — the §4.9
   "튜닝 창이 좁다" risk is the last unfalsified claim.
5. **Locate the missing spec** and reconcile its §7 verbatim predictions against this table, or ratify
   DESIGN §4.9 as the standing SSOT via the round/ADR process (registry/ADR is the orchestrator's job,
   not Agent C's).

### Spec-BLOCKED coverage (registered here so it is not silently omitted — needs a ruling, not code)

The following gates are **required** but their correct shape depends on decisions the absent spec must
make; they are declared here rather than fabricated against guessed semantics (fabricating them would
repeat the post-hoc-prediction hazard the blocker names):

- **Exact ε reference-frame semantics & norm.** The keyframe-equality gate bounds drift structurally,
  but the *per-frame* ε threshold (previous-frame vs reference-frame comparison, and the norm used)
  is undefined by DESIGN §4.9. Ratify the ε contract, then add the matching between-keyframe bound.
- **quality / device-lost reset axes.** The state-invalidation plan covers space/cols/charset (the
  runner's current inputs). Whether `quality` (Q-level) and a WebGPU **device-lost** recovery are
  temporal-buffer-invalidating is a runner-contract decision; add them to `invariantPlan` once fixed.
- **coalescer × temporal (reset + mutex).** The harness drives the runner directly and does not
  exercise the single-flight coalescer (commit `9a20027`). Whether a keyframe/reset request coalescing
  with an interactive delta request must be mutually-exclusive OR reset-wins is out of Agent C's
  ownership (A/B + the coalescer lane); this is a required app-level test once the interaction is ruled.
