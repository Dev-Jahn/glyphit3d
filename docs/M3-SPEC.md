# M3 Implementation Spec — quality round: gate redesign, synthesized families, contour pass
(read with DESIGN.md §3.4/§3.6/§3.7/§4.3/§5.6, docs/M1-RESULTS.md, DESIGN §15.7)

Three quality mechanisms, each with a falsifiable prediction. Per the
selection-prior theorem (M1), only §1 and §2 may improve per-cell reconstruction;
§3 targets cross-cell structure and is measured by an edge metric under an
overall-SSIM guard.

## 0. Module ownership / phases

| Phase | Group | Files |
|---|---|---|
| 1 | GATE | `src/core/match.ts` gate path only (τ default), `scripts/washout-stress.ts` (new), `scripts/gate-sweep.ts` (new) |
| 1 | FAMILIES | `src/atlas/families.ts` (new), `src/core/match.ts` meta-selection integration, `src/core/types.ts` (options), `test/families.test.ts` |
| 1 | CONTOUR-PREP | `src/atlas/orientation.ts` (new), `src/core/contour.ts` (polyline extraction + Viterbi, standalone), `src/metric/edge-ssim.ts` (new), `test/contour.test.ts` |
| 2 | CONTOUR-INT | `src/core/match.ts` (topK hook + orientation prior), contour post-pass wiring in cli/ablate |
| 3 | ABLATION | `scripts/ablate.ts` extensions, full runs, verdicts |

GATE and FAMILIES both touch match.ts in phase 1 — GATE's change is one default
+ one comment; FAMILIES owns the file. CONTOUR-INT gets match.ts in phase 2.

## 1. GATE redesign — the gate becomes an outcome, not a prefilter

Finding (DESIGN §15.7): the remaining chafa deficit (~0.0045 object-cell SSIM,
synthetics) is localized in smooth object interiors that the current gate
(E_AC/(3P) < 2e-4 → forced flat) flattens.

Key observation: **the space glyph IS the flat fill** — its unconstrained fit is
b = mean, SSE = E_AC exactly. The exhaustive scan therefore always contains the
flat candidate, and the MDL term (λ·ink·scale) is the principled washout defense
(a faint complex glyph must beat space by more than its ink penalty). The
threshold gate is redundant as a QUALITY device; it is only a compute saver.

Change: `gateTau` default 2e-4 → **2e-5** (skip only near-exactly-flat cells).
Validation protocol (no other knobs):
1. `scripts/washout-stress.ts`: generate a washout-prone image — large smooth
   gradients + low-amplitude per-pixel noise (σ ≈ 1.5/255 in gamma), 512².
2. `scripts/gate-sweep.ts`: τ ∈ {0, 2e-5, 2e-4} × λ_mdl ∈ {0.02, 0.05} over
   {3 synthetics, washout-stress, DamagedHelmet}. Report per run:
   - overall + object-cell SSIM (existing machinery)
   - **invisible-ink fraction**: share of cells with E_AC/(3P) < 2e-4 that emit
     a non-space glyph whose |F−B| (max channel, u8) < 24 — the quantitative
     washout proxy. Must not exceed the τ=2e-4 baseline by more than 1%p.
   - wall time (the compute-saver cost of lowering τ).
3. Prediction: τ=2e-5 recovers ≈ +0.003 overall on synthetics (per the M0
   gateTau=0 experiment) with invisible-ink fraction held by MDL. If the proxy
   blows up, raise λ_mdl before raising τ — report the tradeoff table either way.
4. Re-run the 6-image chafa gate at the chosen defaults — margin must not shrink.

## 2. FAMILIES — synthesized ideal-mask families + exact region solver (DESIGN §3.6, §5.6)

Lands braille & exact-geometry blocks **independent of font coverage** (mixed
atlas: terminals synthesize these ranges themselves; bake mode rasterizes our
own masks — self-consistent in both).

### 2.1 Region model
A family = k disjoint fractional regions R_1..R_k (α_i ∈ [0,1]^P, Σ_i α_i ≤ 1
pointwise; build DISJOINT by partitioning supersamples) + implicit background.
Pattern S ⊆ {1..k} → coverage α_S = Σ_{i∈S} α_i.

| family | k | geometry (analytic, 8× supersample → cell res) | codepoint map |
|---|---|---|---|
| quadrant | 4 | 2×2 rectangles | pattern→{space,▘▝▖▗,▀▄▌▐,▚▞,▙▛▜▟,█} (all 16 exist) |
| sextant | 6 | 2×3 rectangles | U+1FB00−1 + pattern (skip empty/full→space/█; patterns 21,42 = ▌▐) |
| braille | 8 | 2×4 disks, diameter d = 0.42·cellW, centers on the 2×4 lattice | U+2800 + standard bit order (dots 1-3,7 left col top→bottom, 4-6,8 right col) |

### 2.2 Exact solver (fractional-correct, per cell)
Precompute per family (once): per region s_i = Σα_i, ss_i = Σα_i² (disjoint ⇒
S_α(S) = Σ_S s_i, S_αα(S) = Σ_S ss_i, no cross terms), per-region grad sums for
ink(S) = Σ_S ink_i.
Per cell per channel: k dot products d_i = Σ α_i·T (k ≤ 8 → ≤ 24 dots/cell).
Then for each of 2^k patterns: assemble the six stats in O(k) and use the
EXISTING fit machinery verbatim (fitFree → box-refit if out of gamut → full
quadratic SSE (2)). Total ≤ 256·O(k) per cell — trivial. Edge channels (Q4):
also precompute per-region gradient dot products; same composition as §3.5.

### 2.3 Meta-selection
Winner across {text scan, quadrant, sextant, braille} by (SSE + λ_mdl·ink·scale),
same score space. Options: `families: ('quadrant'|'sextant'|'braille')[]`
(default [] — off; M0/M2 behavior byte-identical when absent). Output GridCell.ch
from the codepoint maps. ANSI export unchanged (they're just codepoints); note
in bench/README that sextant/braille assume terminal-side synthesis or our raster.
Gated cells: gate check runs BEFORE families too (a flat cell stays space).

### 2.4 Tests (`test/families.test.ts`)
- Region partition: Σα_i + α_bg == 1 pointwise (≤1e-6); disjointness Σα_i·α_j = 0.
- Solver exactness: random 10×19 patches (seeded), each family: solver best ==
  brute force over all 2^k patterns with per-pattern brute-force color grid
  (reuse the M0 test pattern) within 1e-6.
- Meta-selection regression: `families:[]` → byte-identical grid to current
  matchGrid on a bench image (golden fixture).
- Braille dithers a gradient: a smooth vertical gradient cell at Q3 with braille
  on scores strictly lower SSE than blocks-only best.

## 3. CONTOUR — orientation prior + contour DP (DESIGN §4.3/§3.7) [3D-native thesis, round 2]

Selection-prior theorem applies: expect per-cell SSIM ≈ neutral-or-slightly-down;
the claim is CROSS-CELL edge structure. Honest metric defined below.

### 3.1 Atlas precompute (`src/atlas/orientation.ts`)
Per text glyph: structure tensor J = Σ[gx², gxgy; gxgy, gy²] over dxA/dyA →
dominant angle θ_g (π-periodic), anisotropy a_g = (λ1−λ2)/(λ1+λ2) ∈ [0,1].
Border profiles: for each border strip (top/bottom/left/right, 1px), ink mass
m_side and ink centroid position p_side ∈ [0,1] along that side.

### 3.2 Cell-side edge field (from AOVs; 2D fallback = Sobel on reference luma)
Boundary cells: coverage AOV crosses 0.5 within the cell, or ≥2 object ids
(reuse M1 boundary detection). Edge angle θ_e + strength w_e from the per-cell
structure tensor of the coverage (or luma) gradients.

### 3.3 Orientation prior (in-scan, option `orientKappa`, default 0)
For boundary cells only: score −= orientKappa · w_e · a_g · max(0, cos 2(θ_g−θ_e))
· eacScale. (Bonus form; π-periodic via cos 2Δ.)

### 3.4 Contour DP (post-pass, `src/core/contour.ts`)
- matchGrid option `topK: number` (default 0=off) → per cell also emit the top-K
  candidates {glyphIdx, score, F, B} (K=8; heap, no allocation per glyph).
- Polylines: marching squares on the coverage AOV at cell resolution (threshold
  0.5 of per-cell mean) → ordered boundary-cell sequences.
- Viterbi per polyline: states = the cell's top-K; unary = score; pairwise for
  consecutive cells sharing side e: κ_c · (|p_exit(g1,e) − p_entry(g2,e)| +
  0.5·|m_exit − m_entry|·norm). Replace those cells' choices with the Viterbi path.
- O(len · K²); deterministic.

### 3.5 Edge metric (`src/metric/edge-ssim.ts`)
edgeSSIM = SSIM computed on Sobel gradient-magnitude maps (gamma luma) of
output vs reference, mean over the boundary-cell band only (±1 cell dilation).
This is the primary metric for §3; overall SSIM is the guard.

### 3.6 Tests
Orientation: synthetic diagonal-edge cell → prior flips a near-tie to the
aligned glyph ('╲' family) and not when orientKappa=0. DP: synthetic straight
contour through 5 cells with engineered near-ties → DP picks the continuous
chain, greedy doesn't (assert both directions). edgeSSIM: identical → 1;
shifted-edge output scores lower.

## 4. ABLATION & verify criteria

`scripts/ablate.ts` gains `--families`, `--orient-kappa`, `--contour`, and an
edgeSSIM column. Runs on zoo 6 + synthetics 3, all at the §1-chosen gate defaults:
base / +families / +orient / +contour / +all.

M3 verify (report PASS/FAIL each, honest):
1. **GATE**: synthetic object-cell SSIM Δ ≥ +0.002 at new defaults; washout
   proxy within +1%p of baseline; zoo overall non-regression; chafa 6-image
   margin not smaller.
2. **FAMILIES**: overall SSIM improves on all 3 synthetics AND ≥4/6 zoo with
   families on; braille usage share reported per image; **chafa gate re-run
   with families on AND chafa given its braille/sextant symbol classes**
   (fairness both ways) — report the new margin.
3. **CONTOUR**: edgeSSIM improves on ≥4/6 zoo at κ_c,orientKappa defaults
   (fixed 3-value sweeps each, all reported) with overall SSIM ≥ base − 0.002;
   side-by-side PNGs for 육안.
4. Suite green (66+); all existing gates/harnesses PASS at new defaults.

Predictions on record: §1 recovers most of the ~0.0045 synthetic deficit;
§2 is the largest single quality win of the milestone (braille sub-cell
resolution); §3 improves edgeSSIM visibly but not overall SSIM — if §3 shows
nothing on edgeSSIM either, the cross-cell 3D-native claim joins the M1 null
and DESIGN §4.3 gets a retraction note.
