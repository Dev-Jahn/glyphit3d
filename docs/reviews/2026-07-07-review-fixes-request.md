# Review Request — 2026-07-07-review-fixes (re-review)

The reviewer has the repository via git. This is a **re-review**: the previous packet
(`2026-07-07-gpu-reality`) produced 5 findings (F1–F5) + 3 open questions (O1–O3); this round
implements all of them. Confirm each is genuinely resolved and that no fix introduced a regression.
Keep the jahns-workflow harness out of scope.

- Project / Branch: glyphit3d / main
- Reviewing: `09447b1733ed296992d572ab13cd2abb455ad520` (diff against `78e478941ebb43f4da64b9d8120c11c3e4fef99b` — the pre-round tip). The substantive diff is commits `b7f9011` (ADR-0001) + `09447b1` (the fixes); `c2d6afb`/`c9a141e` on the path add only round-closeout + verbatim-feedback metadata. The closeout commit carrying this file adds only registry/PROGRESS metadata on top.

## What changed and why

Each prior finding was verified against code by an independent adversarial subagent before being
registered, then fixed by a parallel workflow (disjoint file ownership), then each fix was
adversarially verified against its git diff. Gates all green (see Evidence).

1. **F1 → fix/rematch-single-flight** (was High). `main.ts` rematch() had no run-generation guard;
   controls/ladder called it directly (bypassing the orbit-only coalescing), so a slow older run
   could resolve after a fast newer one and commit a grid/raster/SSIM/perf disagreeing with current
   params — to screen AND exports. Fix: a module-scoped monotonic `rematchSeq`; rematch() captures
   `mySeq` before the await and gates EVERY commit (last, canvas, #ssim, perf, and the #ssim-driven
   onOutput trigger) behind `mySeq === rematchSeq`, so a superseded run mutates nothing. saveJson now
   reads a consistent snapshot (grid + channels + charset from one run). Latest-wins ordering, not
   cancellation (a superseded GPU run still completes then is discarded — perf nuance, not
   correctness).
2. **F2 → fix/gpu-matcher-p-guard** (was High, latent). `ensureCellBuffers` keyed only on numCells;
   a same-numCells/larger-P atlas reused a too-small targetBuf → validation error → silent wrong
   output. Separately, the WGSL `sT: array<f32,768>` (=3·256) is OOB for P>256 from the first run.
   Fix: P (and cell dims) added to the reuse key; `assertPWithinScratch(P)` throws a catchable error
   at match() start when 3P>768; pipeline.ts's existing try/catch routes the throw to the CPU pool.
   Latent today (all bundled DejaVu profiles are P=190); reachable via §5.4 browser TTF profiling.
   10 pure-function unit tests (node has no WebGPU device — the live dispatch stays a parity-harness
   concern).
3. **F3 → fix/profile-hash-canonical** (was High → **decision**, ruled ADR-0001 Contract B). The
   profile hash covered only cp+coverage, but the matcher trusts stored scalar stats
   (sumA/sumAA/gradAA/ink), so a scalar tamper passed the hash yet changed matching. Ruling: scalars
   are objective truth; the hash must cover the full canonical payload. Fix: `verifyProfileHash`
   (web/src/profile.ts) and the exporter (scripts/export-atlas.ts) now hash version+font+cellW/cellH+
   ascent + per-glyph {ch,cp,coverage,sumA,sumAA,gradAA,ink}; a scalar-tamper-reject test added; the
   4 bundled dejavu-16 profiles regenerated (their old hashes were invalidated). decodeProfile keeps
   trusting stored scalars (Contract B).
4. **F4 → fix/e2e-liveness-frame-budget** (was Medium). check-7 claimed raster runs off-thread and
   asserted the vacuous `maxGap < dur`; the GPU path rasterizes on the main thread (~96ms). Fix:
   honest comment + two real assertions — `liveWindow = dur - maxGap > 20` (proves the async
   match/worker-SSIM windows yield) and `maxGap < 250` (loose stall ceiling, TODO tighten to a frame
   budget once perf/gpu-rasterizer moves raster to GPU). Root cause (main-thread raster) tracked by
   perf/gpu-rasterizer, out of this round.
5. **F5 → docs/wgsl-mirror-kahan-comment**; **O3 → docs/gpu-realtime-wording**; **O1 →
   chore/parity-adversarial-fixtures** (parity sweep 14→28 configs incl. high-DC/checker/grazing/
   steep + a first-wins-on-tie property in the JS mirror). **O2** was folded into the F3 ruling.

## Read these first

1. `web/src/main.ts` (rematch seq guard + commit gating) + `web/src/ui/exports.ts` (snapshot).
2. `web/src/webgpu/gpu-matcher.ts` (cache key + assertPWithinScratch) + `web/src/webgpu/matcher-wgsl.ts` (enforced-bound comment) + `web/src/webgpu/gpu-matcher-pguard.test.ts`.
3. `web/src/profile.ts` + `scripts/export-atlas.ts` (the two must build a BYTE-IDENTICAL canonical payload) + `test/profile.test.ts` + `docs/adr/ADR-0001-profile-stats-objective-contract.md`.
4. `test-e2e/demo.spec.ts` check 7; `web/src/webgpu/wgsl-mirror.test.ts` + `test-e2e/webgpu-parity.spec.ts` (O1 fixtures).

## Claims to attack

1. **F1 completeness**: find any commit path in rematch()/its callers where a stale run still
   mutates screen or export state, or where the seq guard breaks orbit realtime drag.
2. **F3 payload identity**: find a field the produce-side (export-atlas.ts) and verify-side
   (profile.ts) serialize differently (order, float encoding, missing field) so a valid profile
   fails to verify OR a tampered one passes. Confirm the regenerated bundled profiles actually load.
3. **F2 fallback**: find a P>256 (or P-changed) atlas path where the thrown error is NOT caught and
   crashes instead of falling back to the CPU pool with identical output.
4. **F4 honesty**: is `liveWindow > 20 && maxGap < 250` still gameable/vacuous, or does it now
   actually distinguish a main-thread-blocked rematch from a live one?
5. **No regression**: parity still byte-exact (now 28 configs), e2e still 9/9, matcher objective
   (src/core/*) unchanged.

## Evidence already produced (mine — inspect, don't trust)

| Gate | Command | Reading |
|---|---|---|
| Unit | `npm run test` | 143/143 (incl. F2 P-guard 10, F3 scalar-tamper, O1 property fixtures) |
| Parity | `npm run parity` | 28/28, glyph 100.0%, ΔSSIM 0, colorΔ≤1 |
| e2e | `npm run e2e` | 9/9 on NVIDIA RTX PRO 6000 Blackwell; check-7 now records liveWindow/maxGap |
| Web build | `npm run build` | bundles clean |
| tsc | `npx tsc --noEmit` | clean except 2 pre-existing `scripts/compose-hero.ts` errors (unrelated) |

## Known weak spots

- F2's P>256 guard and CPU-pool fallback cannot be driven end-to-end here — all bundled profiles are
  P=190; the live path is asserted by diff inspection + pure-fn tests, not a real >256 dispatch.
- F1 is latest-wins, not true cancellation; a superseded GPU run still burns compute before discard.
- F4's 250ms ceiling is loose by design (the ~96ms main-thread raster dominates until perf/gpu-rasterizer).

## Out of scope

The jahns-workflow harness; perf/gpu-rasterizer (the main-thread raster itself); the aesthetic/metric
redesign (Round A); the 2 pre-existing chores (compose-hero.ts types, braille==blocks charset no-op).

## Response wanted

Major/critical only. For each: concrete failure mechanism + where confirmed. Separate confirmed
findings, open questions, and residual risks.
