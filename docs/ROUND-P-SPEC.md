# Round P — interactive performance + Q1/Q2 gate contract fix

Motivation (user feedback, 2026-07-06): realtime orbit shipped, but the glyph
refresh cadence during drag is too slow; and Q1/Q2 show sudden black holes in dark
gradients. Root causes traced before this spec was written; predictions are
on-record per project convention.

## P0 — gate contract fix (src/core/match.ts, shared node+web)

The contrast gate's contract (M3-SPEC §1) is "compute saver only: the flat
candidate is always in the scan, so gating cannot change quality." That premise
holds only for Q3+ (bg free → gated cell = flat fill at the cell mean). At Q1/Q2
the gated cell is emitted as `' '` on the FIXED (black) bg regardless of the cell
mean (match.ts:279-280) — a non-black low-variance cell snaps to pure black. That
is a contract violation and the "threshold-like" component of the dark-hole
artifact.

Fix: for gated cells, emit the best FLAT representation achievable under the
quality's color constraints, closed-form from per-glyph precomputed (sumA, sumAA):

- Q2 (fg fitted, bg fixed): per channel fg_c = m_c·sumA/sumAA (clamped to the
  working-space range); SSE(g) = |m|²·(P − sumA²/sumAA) → glyph =
  argmax sumA²/sumAA, a constant computed once per atlas. O(1) per gated cell.
- Q1 (fg fixed): SSE(g) = Σ_c (ffg_c²·sumAA − 2·ffg_c·m_c·sumA) + |m|²·P →
  argmin over glyphs using scalars only. O(G) per gated cell, no pixel loops —
  still ≪ the full scan. Dark cells naturally select low-ink glyphs (the classic
  ramp behavior emerges from the math).
- Q3+ gate path stays byte-identical.

Predictions:
1. The hard-threshold black holes at Q1/Q2 disappear (gated non-black cells become
   visible flat glyph fills). Residual dark-cell invisibility from the FITTED path
   (fg below visibility on black) remains — that is Round A's contrast-floor scope,
   not P0's.
2. Q3 two-color outputs and therefore `npx tsx bench/chafa-gate.ts` margins are
   unchanged to the last digit.
3. Unit test: for synthetically flat cells, the gated result equals the full
   exhaustive scan's argmin (within fp tolerance) at Q1 and Q2 — the contract,
   now actually true. New test file; no existing test modified.

## P1 — skip SSIM on interactive runs (web)

Measured on the e2e box: match ~390ms, ssim ~280ms, raster ~40ms. SSIM feeds only
the badge; during a drag it is pure waste.

- `MatchRequest.interactive?: boolean`; interactive → worker skips ssim (ssim:
  null in the result).
- main.ts `requestRematch(interactive)`: onOrbitMove → true, onOrbitEnd → false;
  controls/`__app.rematch` stay non-interactive. Coalescing keeps the strictest
  pending requirement: if any queued request was non-interactive, the drain run
  computes ssim. UI keeps the previous badge value when ssim is null.
- Direct `rematch()` resolves with ssim exactly as today (e2e checks 2/7 depend
  on it).

Prediction: interactive worker time drops by the ssim share (~40% on the e2e box).

## P2 — worker pool: band-parallel match+raster (web)

matchGrid and rasterizeGrid are per-cell independent on the web path (families=[],
no contour pass). Shard by contiguous cell-row bands across
N = min(hardwareConcurrency − 1, 8, rows) workers.

- Band image slices are TRANSFERRED (no full-image structured clones — a full
  grid frame is ~5.5MB; per-band copies then transfer).
- Atlas broadcast once per (charset, worker).
- Grid cells and raster bands assembled on the main thread; non-interactive runs
  then compute ssim once over the assembled raster+ref (one worker) BEFORE
  resolving, so busy semantics and e2e afterRematch are unchanged.
- The banding assumption must stay visible: if a web request ever carries options
  that enable cross-cell passes (families/contour), THROW — do not silently fall
  back to single-worker.

Predictions: match wall-time ≈ today/N + overhead; interactive end-to-end
(match+raster) at cols=100 Q3 on the e2e box from ~430ms to <150ms. On that box
the SwiftShader render (~300ms) then dominates; on real-GPU clients (the actual
demo audience) the cadence gain is the full match-side factor.

## P3 — (optional) overlap render with match

Capture the next pose's frame at dirty-mark time so the main-thread render
overlaps the worker match. Implement only if measurement shows ≥15% additional
interactive gain; otherwise record the measurement and skip.

## Verification

- vitest fully green including the new P0 contract test; no existing test
  modified.
- e2e 9/9 with existing assertions untouched.
- bench: chafa-gate margins identical pre/post (P0 prediction 2).
- Live: drag cadence on the demo measured before/after (worker timings logged).

## Outcome (recorded after implement → adversarial review → fix)

**P0 predictions 1 & 3 — the closed form was falsified, then repaired.** The first
implementation used a constant argmax-sumA²/sumAA glyph (Q2) and an fbg-free scalar
SSE (Q1). Adversarial review proved both are the full-scan argmin ONLY when the
fitted fg never clamps AND fixedBg=0 — so on a bright flat cell with a non-solid
atlas (e.g. ascii, no U+2588) the closed form picks a suboptimal glyph, violating
the very contract prediction 3 asserts. Fix: the gated Q1/Q2 branch now scores every
glyph with the SAME per-channel scorer the full scan uses (channelSse on the flat-cell
scalar stats saT=m·sumA, S1T=P·m, STT=P·m²) and refits the winner's colour via
channelFB — provably equal to the full exhaustive scan's argmin, clamp and fbg
included, still O(G) scalars with no pixel loops. A new test/gate-contract-regime.test.ts
(12 cases, RED pre-fix / GREEN post-fix) pins the clamp and nonzero-fbg regimes the
base contract test avoided.

**P0 measured impact (headless before/after, ascii atlas, cols=100, gamma).** Q2
forced-black gated cells → best flat glyph:
- sphere: space cells 3542 → 0; washout-stress 78 → 0; DamagedHelmet 1522 → 0.
- Q1 rescues fewer (fixed white fg → dark cells still legitimately pick space):
  sphere 3856 → 3079.
Nuance worth recording: on the 3D DEMO's default pose the gated cells are almost all
pure-black (0,0,0) background, which correctly stays space both pre- and post-fix, so
P0's visible effect THERE is small. The gate-contract fix is real and proven; the
dark-region character-density / contrast-floor the user reported on the 3D demo is the
FITTED-path invisibility (dim fg on black), which is Round A's scope, not P0's.

**P0 prediction 2 — Q3 invariant.** Q3 grids are byte-hash-identical across HEAD, the
buggy-P0 tree, and the fixed tree over 28 configs (7 bench images × {blocks,ascii} ×
{gamma,linear}); chafa-gate still PASSES (ours 0.9835 vs chafa 0.9812).

**P1 + P2 — perf.** Banded match ~118ms (8-way pool) vs ~340ms single-worker (~2.9×);
interactive runs skip SSIM (~310ms). Measured drag cadence ~3.5 glyph updates/s on this
GPU-less SwiftShader box (render ~60ms is the CPU floor here); match-bound and higher on
real-GPU clients. P3 (render/match overlap) measured and SKIPPED — out of the fix scope
and marginal once render is small on real GPU.

**Correction (2026-07-07, gpu-reality round):** this box is NOT GPU-less — the SwiftShader
render "floor" was self-imposed by the e2e's `--use-angle=swiftshader` flags. With
`--use-angle=vulkan` render drops to ~33ms on the local Blackwell GPU (chore/e2e-gpu-rendering),
and the WebGPU matcher (perf/webgpu-matcher) cut match to ~1.25ms. The interactive analysis holds
directionally (match was the bottleneck); the absolute render figures were software artifacts.

**Q4 on web — DISABLED (user decision).** Q4's edge loss is a cross-cell pass; the band
matcher would corrupt at every seam, so the worker THROWS on a Q4 band (no silent
single-thread). The web ladder button is disabled and a #quality=4 fragment clamps to
Q3 (ui/ladder.ts, main.ts); the node CLI keeps Q4. Round A reworks this ladder.
