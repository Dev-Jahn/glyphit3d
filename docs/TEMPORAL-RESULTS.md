# Temporal coherence — results & honest-reporting ledger

**Task:** `feat/temporal-animation` (DESIGN §4.9). Agent C (harness / metrics / results), wave-2 chain A.
**Harness:** `test-e2e/temporal.spec.ts` + `web/temporal.html` + `web/src/temporal-page.ts`.
**No-flag repro:** `npm run temporal` (≡ `npx tsx test-e2e/temporal.spec.ts`).

---

## ✅ Status: all contracts held — temporal path landed and verified end-to-end (exit 0)

The temporal rematch path (delta frames + glyph hysteresis, agents A/B) **landed** and was assembled
against this frozen harness. `npm run temporal` now **exits 0** (baseline was exit 3 PENDING) with
EVERY harness stage MET on the real Blackwell GPU via ANGLE-Vulkan. The measured numbers below
reproduce verbatim from the committed harness output.

- **runs and verifies the deterministic orbit substrate** (H0 below), and
- **runs the temporal invariant / hysteresis / drift-keyframe / speedup stages** through the wired
  seam (`getTemporalRunner` → `web/src/webgpu/gpu-temporal.ts`, factory `GpuTemporal.create`).

**Exit codes:** `0` all contracts held · `1` a CONTRACT was violated (byte-identity break, a broken
harness self-check, a keyframe that is not a full rematch, **or any non-sentinel error thrown after
the runner resolved** — a mid-orbit crash/device-lost/OOM is a real defect, NOT a pending state) ·
`3` PENDING (temporal path not landed / the landed runner lacks a capability the harness needs →
invariant unverified, *not* violated). **The last run exits `0`** — the wired `GpuTemporal` runner
satisfies the full EXPECTED CONTRACT (`runFull` / `runTemporal` / `runTemporalScored`, same-matcher-
path reference, keyframe I-frames, dims-mismatch reset).

### SSOT — spec §7 predictions reconciled (ASSEMBLE)

The governing spec (`scratchpad/spec-temporalAnimation.md`) was located during assemble; its §7
pre-registered predictions P1–P10 are reconciled against this harness in the "Spec §7 predictions"
section below. **Important measurement-integrity note (ssotConflict):** the FROZEN harness does NOT
implement the spec §6/§7 churn-reduction δ-sweep. The spec's H-T falsification test (P8/P9: "≥30%
glyph-churn reduction on the SLOW orbit within ΔSSIM ≤ 1e-3") is therefore **NOT measured** by the
committed harness — which only proves the δ-margin **rule is correctly implemented** (P-hysteresis
oracle: 0 ghosting / 0 sparkle / 0 stray, sticky > 0). The harness's `P-hysteresis → MET` is a
rule-correctness verdict, **not** a hypothesis-support verdict on H-T. The spec's orbit definitions
(SLOW 0.25°/frame, FAST 1°/frame) also differ from the frozen harness (SLOW 1°/frame, FAST 6°/frame).
The frozen harness is the enforced contract; the churn-reduction sweep + H-T verdict remain a
follow-up (registered below). See DESIGN §4.9 (the standing falsifiable SSOT) quoted verbatim next.

---

## SSOT under test — DESIGN §4.9 (quoted verbatim)

> ### 4.9 Temporal coherence [M4]
> - 3D 파이프라인의 공짜 **motion vector로 이전 프레임 선택을 재투영**한 뒤
>   hysteresis: 새 후보가 마진 δ 이상 이길 때만 glyph 교체. 회전 중 ghosting 없이
>   sparkle 제거. (과도하면 끈적임, 부족하면 sparkle — 튜닝 창이 좁다는 리스크.)
> - 멀티프레임 sprite는 프레임 간 **변경 셀만 delta 인코딩** (터미널 비디오 코덱).

---

## Honest-reporting table (last run — temporal path LANDED, `npm run temporal` exit 0)

Verbatim harness verdict table (copied EXACTLY from the `npm run temporal` stdout; no-flag repro
`npx tsx test-e2e/temporal.spec.ts`):

| ID | Prediction (source) | Verdict | Measured |
|----|---------------------|---------|----------|
| **H0 harness-determinism** | The deterministic FAST/SLOW orbit renders reproducibly and `matchGrid` is byte-identical to itself — the substrate the invariant stands on. (harness self-check) | **MET** | 0 mismatched frames across both orbits (**122 frames**), on the real GPU context. |
| **P-invariant (CONTRACT)** | temporal rematch at **epsilon=0 AND delta=0** is **byte-identical** to the same-frame full rematch on all **61 frames × 2 orbits**, **INCLUDING across mid-orbit space→cols→charset changes** (state invalidation): reuse/hysteresis is suppressed AND stale temporal state must never survive a config change. (task brief + DESIGN §4.9) | **MET** | **0 mismatched cells** across 2 orbits × 61 frames (122 frames); invalidation transitions exercised: **charset, cols, space** (both orbits `matcher=gpu`). |
| **P-hysteresis** | DESIGN §4.9: *"새 후보가 마진 δ 이상 이길 때만 glyph 교체 … 회전 중 ghosting 없이 sparkle 제거"* — a **reprojection-aware δ-margin ORACLE** (rescoring prev-reprojected vs fresh winner per cell) counts ghosting (kept a decisive winner — *"과도하면 끈적임"*) and sparkle (swapped a near-tie — *"부족하면 sparkle"*) violations; **either FALSIFIES**. MET requires the rule held everywhere AND genuine stickiness (sticky > 0). | **MET** | `hyst:fast δ=0.02`, 6 sampled frames: **4306 cells w/ predecessor, sticky 206 (4.78%)**, rule-violations **ghosting 0 / sparkle 0 / stray 0**. NOTE: this is a **rule-correctness** verdict, not the spec's H-T churn-reduction test (P8/P9 — not measured by the frozen harness). |
| **P-drift (CONTRACT: keyframe)** | DESIGN §4.9 *"변경 셀만 delta 인코딩 (터미널 비디오 코덱)"* — at each keyframe the temporal output is a full recompute, **byte-identical** to the same-frame full rematch, so reference-frame drift on slowly-varying cells stays bounded (never accumulates past the ε per-frame threshold). A keyframe that differs = unbounded drift → **exit 1**. | **MET** | `drift:slow ε=1e-4 δ=0.02`: **keyframe violations 0 (0 cells)**; max between-keyframe divergence **1.94%** over 56 non-keyframe frames (bounded, reported as DATA). |
| **P-reuse-speedup** | DESIGN §4.9: *"변경 셀만 delta 인코딩"* — reusing prior-frame selections on near-static cells makes a temporal rematch faster than a full rematch on the SLOW orbit. | **MET** | `perf:slow ε=1e-4 δ=0.02`: full **90.90 ms** vs temporal **75.40 ms** = **1.21×** (warm median of 20). |
| **P-tuning-window (risk)** | DESIGN §4.9 risk: *"과도하면 끈적임, 부족하면 sparkle — 튜닝 창이 좁다는 리스크"* — the usable δ band that removes sparkle without introducing ghosting (stickiness) may be narrow. | **PENDING** | the frozen harness runs a single δ=0.02 oracle check, not a δ sweep; the sparkle↔ghosting band width remains a follow-up (see below). |

Verdict legend: **MET** (prediction held) · **PARTIAL** (mixed / weak) · **FALSIFIED** (measured
against the prediction — a *publishable result*, never tuned away) · **PENDING** (not runnable yet).

**RESULT (verbatim from stdout):** `all contracts held.`

---

## Spec §7 predictions (verbatim) reconciled against the frozen harness

The spec pre-registered P1–P10. The **frozen** harness measures only a subset (byte-identity,
one δ oracle, drift-keyframe, one reuse-speedup point); the churn/ε/raster/H-T sweeps the spec §6
describes are **not implemented** in the committed harness, so those predictions are marked
**NOT MEASURED (harness gap)** rather than fabricated. Quoted verbatim:

- **P4 (exactness):** *"delta frames at epsilon=0, delta=0 produce grids byte-identical to a
  same-frame full rematch on 61/61 frames of BOTH orbits (122/122)."* → **MET** — 0 mismatched cells,
  122/122, incl. mid-orbit state-invalidation transitions (harness `P-invariant`).
- **P5 (match-stage savings):** *"delta epsilon=0 mean match-stage cost … on the FAST orbit is at
  least 1.8x lower than full rematch."* → **NOT MEASURED as specified.** The harness measures full-vs-
  temporal **wall** time on the **SLOW** orbit (differently-defined) = **1.21×**, not the FAST
  match-stage 1.8× the spec pre-registered. Direction confirmed (temporal faster); the 1.8× FAST
  match-stage target is unverified by this harness.
- **P8 (H-T support):** *"there exists delta* … achieving glyph-churn reduction ≥ 50% on SLOW and
  ≥ 25% on FAST, with mean per-frame ΔSSIM ≤ 5e-4 … and revert-rate reduction ≥ 60% at delta* on
  SLOW."* → **NOT MEASURED (harness gap).** The frozen harness has no churn/revert/ΔSSIM sweep; it
  proves only the δ-margin **rule** is correctly implemented (0 ghosting/sparkle/stray, sticky>0).
- **P9 (H-T falsification criterion):** *"if NO delta in the sweep achieves ≥ 30% churn reduction on
  the SLOW orbit within mean ΔSSIM ≤ 1e-3, the temporal-hysteresis hypothesis … is FALSIFIED."* →
  **NOT EVALUATED** — the sweep it references is not in the frozen harness. **H-T remains untested**;
  neither supported nor falsified. Registered as the follow-up churn-sweep task `chore/temporal-churn-sweep-instrument`.
- **P10 (gates hold):** *"npm run parity stays 28/28 byte-exact …, vitest stays green …, npm run e2e
  stays 9/9."* → **MET** — parity 28/28 + raster 13/13, vitest 267/267 (33 files), e2e 9/9, tsc 0
  errors (all re-run at assemble; see the assemble report).
- **P1–P3, P6, P7** (motion-vector unobtainability; changed-fraction interval; ε uselessness; partial-
  raster ≤55%; baseline churn interval): **NOT MEASURED (harness gap)** — these need the §6 metrics
  harness (changed%, churn%, revert%, raster ms) which the frozen `temporal.spec.ts` does not compute.
  P1 is a code-verified fact (recorded in `gpu-temporal.ts`: identity reprojection, no velocity AOV).

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

## Assemble — DONE, and follow-ups that remain

Assemble wired and drove the landed path to real verdicts:

1. ✅ **`getTemporalRunner` wired** — `web/src/temporal-page.ts` was already pointed at
   `./webgpu/gpu-temporal.js`; agent A's landed `GpuTemporal.create` factory satisfies the EXPECTED
   CONTRACT exactly (`runFull` / `runTemporal(…, {epsilon, delta, keyframe})` / `runTemporalScored`,
   same-matcher-path reference, keyframe I-frame, dims-mismatch reset). No harness edit needed.
2. ✅ **`npm run temporal` exits 0** — ε=0/δ=0 byte-identity (incl. across all three state-
   invalidation transitions), keyframe equality, hysteresis oracle, drift, and speedup all MET.
3. ✅ **This table filled** with the measured hysteresis counts / sticky fraction, max between-
   keyframe divergence, and speedup (above).

Remaining follow-ups (registered, NOT done by assemble — they need harness code the frozen contract
does not contain, i.e. out of glue-level scope):

4. **δ sweep + §6 metrics harness** for `P-tuning-window` AND the spec's **H-T test (P8/P9)**: the
   frozen `temporal.spec.ts` runs a single δ=0.02 oracle check, not the churn/revert/ΔSSIM δ-sweep
   the spec §6/§7 pre-registered. **H-T (hysteresis stability hypothesis) is therefore UNTESTED —
   neither supported nor falsified.** Registered as `chore/temporal-churn-sweep-instrument` to build
   the metrics harness and render the H-T verdict; only then can DESIGN §4.9 be ratified or amended by ADR.
5. **Spec ↔ harness orbit reconciliation:** the frozen harness orbits (SLOW 1°/frame 0→60°, FAST
   6°/frame 0→360°) differ from spec §6.1 (SLOW 0.25°/frame, FAST 1°/frame). The frozen harness is
   the enforced contract; the spec's numeric intervals (P2/P5/P7) are keyed to its own orbit defs and
   are not comparable to harness numbers. Reconcile via the round/ADR process.

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
