# GATE — chafa parity benchmark (DESIGN §10, M0 verify (c))

Hard gate: does our M0 image→glyph optimizer beat the reference terminal-image
tool [chafa](https://hpjansson.org/chafa/) at the **same task** — truecolor
character-cell art in a single monospace font — when both outputs are
re-rasterized through the *same* DejaVu Sans Mono atlas and scored by grayscale
SSIM against the same reference image?

Run: `npx tsx bench/chafa-gate.ts` (exit 0 = PASS, 1 = FAIL, 2 = setup error).

## chafa binary

Official static x86_64 Linux build, downloaded into `tools/chafa/` (should be
gitignored — `.gitignore` is owned by the SETUP+FIT group and currently does not
list `tools/`; add `tools/chafa/` there):

```
https://hpjansson.org/chafa/releases/static/chafa-1.18.2-1-x86_64-linux-gnu.tar.gz
```

Verified: `tools/chafa/chafa --version` → `Chafa version 1.18.2`.

## What is compared

Config: DejaVu Sans Mono @ 16px, `blocks` charset, 120 columns (rows derived from
each image's aspect and the 10×19 cell → 63 rows for the 512×512 benchmarks).

- **ours** — `matchGrid(..., Q3)` with **spec-default** `MatchOptions`
  (`space 'gamma'` — predict-terminal, the project default; `edgeLambda 0.35`,
  `gateTau 2e-4`, `mdlLambda 0.02`, `fixedBg [0,0,0]`, `fixedFg [1,1,1]`). No
  tuning: Q3 is run exactly as the ladder/CLI run it.
- **chafa builtin** — `chafa -w 9 --fill none --symbols <set> --colors full
  --size 120x63 --font-ratio 10/19 -f symbols img.png`, using chafa's own
  internal glyph coverage model.
- **chafa DejaVu** — the same invocation plus
  `--glyph-file /usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf`, so chafa
  optimizes against the *actual* DejaVu glyph bitmaps our atlas will render with
  (the fairest possible chafa — it removes any builtin-vs-DejaVu shape mismatch).

Both chafa variants are compared, and our result is gated against **chafa's best
variant** (`max` of the two means), as the spec requires.

### Scoring (identical for all three)

Each Grid is baked back to linear RGB through **our** `rasterizeGrid` +
DejaVu atlas (`pred = α·F + (1−α)·B` per pixel) — i.e. what a user's terminal
in this font would actually display. It is scored with `ssim()` (11×11 Gaussian,
K1=0.01, K2=0.03, L=255, gamma-encoded luma) against the *same* reference: the
original PNG area-resampled (exact, energy-preserving, in linear space) to the
grid's exact pixel footprint (1200×1197). All three methods share one reference
per image, so this is a clean three-way comparison.

## Symbol mapping — the fairness decision (documented)

Our `blocks` atlas retains **270 glyphs** after mono-advance filtering, ink-leak
dropping, and dedup. chafa is fed **exactly that repertoire** via explicit
code-point ranges:

```
20..5e+60..7e+2500..25a0+25aa..25ab+25b2..25b3+25b6+25ba+25bc..25bd+25c0+25c4+25c6..25c7+25c9+25ce..25cf
```

(built at runtime from `atlas.glyphs.map(g => g.cp)`).

Why code-point-exact rather than chafa's symbol *classes*
(`ascii+block+border+geometric`)?

1. **It is required for a valid re-rasterization.** Any glyph chafa picks that
   our atlas dropped would render as a blank cell in our renderer, silently
   penalizing chafa. Code-point-exact guarantees every chafa glyph is
   renderable by our atlas.
2. **It is the true apples-to-apples repertoire** — both engines choose from an
   identical glyph set.
3. **This choice is generous to chafa, not to us.** Measured: the class-based
   `ascii+block+border+geometric` mapping produces essentially identical chafa
   SSIM (sphere 0.9830, torus 0.9817, spheres 0.9780) because at work=9 chafa
   almost never leaves our repertoire (0, 1, and 5 unrenderable cells out of
   7560 on the three images). So the mapping choice does **not** move the verdict.

Note on excluded symbol classes: chafa's native edge cases are `sextant`,
`wedge`, and other Symbols-for-Legacy-Computing (U+1FB00…). DejaVu Sans Mono
contains none of them, so neither engine can use them — excluding them is fair,
not a handicap. `wide` (double-cell) glyphs are likewise absent: our atlas keeps
only mono-advance glyphs, so the repertoire is single-cell by construction.

`--font-ratio 10/19` is passed to chafa so its symbol selection assumes the same
pixel aspect as our 10×19 cell (fair geometry, matching our renderer).

## Results

chafa: Chafa version 1.18.2 · atlas: 270 glyphs, cell 10×19 · grid 120×63

| image   | ours Q3 (gamma) | chafa builtin | chafa DejaVu |
|---------|-----------------|---------------|--------------|
| sphere  | 0.9799          | 0.9830        | 0.9828       |
| torus   | 0.9813          | 0.9818        | 0.9817       |
| spheres | 0.9824          | 0.9780        | 0.9776       |
| **mean**| **0.9812**      | **0.9809**    | **0.9807**   |

chafa best variant: **builtin glyphs**, mean SSIM **0.9809**.
Ours (Q3, `space 'gamma'` predict-terminal — the project default) mean SSIM
**0.9812**.

### Verdict: **PASS** (ours − chafa best = +0.0003)

How this went from red to green, in order:

1. **Initial run — FAIL, −0.0011.** The first honest, un-tuned run used the old
   `linear` bake default (Q3, spec-default options): ours **0.9798** vs chafa
   best **0.9809**. We won `spheres` (+0.0023) but lost `sphere` (−0.0046) and
   `torus` (−0.0009). Nothing was tuned to rig it green — the golden rule is
   fairness, not a forced green light.

2. **Root cause — loss-space vs metric-space mismatch.** The gate metric
   `ssim()` scores in **gamma-encoded** luma (what the eye and a real terminal
   see), but the fit was minimising SSE in **linear** light. The per-cell
   least-squares optimum in linear light is not the optimum a gamma-space SSIM
   rewards. A **masked-SSIM** localization (object vs background via a per-image
   Otsu split) confirmed *where* the loss lived: the background half of the gap
   was the linear-vs-gamma compositing of glyph anti-aliasing — precisely the
   predict-terminal discrepancy of DESIGN §3.1 (most terminals blend glyph AA in
   gamma space, "wrongly").

3. **Fix — predict-terminal `gamma` mode → PASS, +0.0003, defaults intact.**
   Fitting *and* compositing in the same gamma-encoded space the terminal
   actually blends in (DESIGN §3.1) lifts ours to **0.9812** with **no other knob
   touched** (`gateTau 2e-4`, `mdlLambda 0.02`, `edgeLambda 0.35` all unchanged).
   This is now the project-wide default; `--space linear` remains for the bake
   path (PNG/HTML). Fit space and composite space are always paired.

4. **Rejected — `gateTau 0` (+0.0030).** Disabling the contrast gate scores
   higher still (run C below, **0.9840**), but the gate is the washout /
   degenerate-fit defense (DESIGN §3.4). Turning it off to win the benchmark
   would trade a real robustness property for a benchmark number, so it is
   **not shipped**.

5. **Adversarial-review corrections — input fairness + gate semantics → still
   PASS.** A later adversarial review found the +0.0003 margin was partly an
   artifact of an **unfair input**: ours fit the exact grid-footprint array it was
   graded on, while chafa was handed the 512px original — the two engines were
   optimizing *different pixels*. **Protocol correction:** the grid-footprint
   reference (`gridImg`, the same linear area-resample ours fits and `ssim()`
   grades against) is now saved to a temp PNG and fed to **both** chafa variants,
   so every contestant optimizes the pixels it is scored on. chafa's invocation
   flags are otherwise unchanged. Three correctness fixes landed in the same pass:
   (a) the contrast gate now thresholds the **full per-channel** patch AC energy
   `E_AC = Σ_c(STT_c − ST_c²/P)` per DESIGN §3.4, not luma-only AC — luma-only
   flattened isoluminant chroma structure to a muddy mean; (b) a `resampleArea`
   out-of-bounds read (float-rounding overrun of the last row/column) that put NaN
   in the bottom-right pixel of some grid footprints; (c) the masked-SSIM Otsu
   threshold is now derived from the per-cell-mean histogram it is actually applied
   to (diagnostic only). The gate-semantics change gates marginally **fewer** cells
   (chroma structure luma missed now survives the gate):

   | image | old luma-gate gated % | new per-channel gated % | Δ (pp) |
   |---|---|---|---|
   | sphere | 93.0 | 92.1 | −0.9 |
   | torus | 92.6 | 92.2 | −0.4 |
   | spheres | 93.7 | 92.7 | −1.0 |
   | DamagedHelmet | 45.5 | 45.0 | −0.6 |
   | FlightHelmet | 85.9 | 85.3 | −0.6 |
   | BoomBox | 67.1 | 65.9 | −1.1 |

#### Corrected-protocol verdict — 3 synthetic renders

chafa now fed the identical grid-footprint reference. Ours = Q3 `space 'gamma'`,
spec-default options (unchanged).

| image | ours Q3 (gamma) | chafa builtin (best raster) | chafa DejaVu (best raster) |
|---|---|---|---|
| sphere | 0.9802 | 0.9832 (linear) | 0.9830 (linear) |
| torus | 0.9814 | 0.9821 (gamma) | 0.9820 (gamma) |
| spheres | 0.9827 | 0.9783 (linear) | 0.9779 (linear) |
| **mean** | **0.9814** | **0.9812** | **0.9810** |

**Verdict: PASS**, ours − chafa best = **+0.0002**. The fairness fix lifted chafa
(0.9809 → 0.9812; it now fits the graded pixels) and the gate-semantics fix lifted
ours (0.9812 → 0.9814); the net honest margin narrows to **+0.0002** but stays
green. This is a thinner, fairer margin than the pre-correction +0.0003.

#### Corrected-protocol verdict — 6 images (3 synthetic + 3 Khronos zoo)

Adds the DESIGN §10 Khronos screenshot renders (DamagedHelmet, FlightHelmet,
BoomBox), fetched reproducibly by `scripts/fetch-bench-images.ts` (gitignored
`bench/images/`). The 3 smooth synthetic renders are the *least* favorable domain
for the continuous-coverage thesis; the textured Khronos renders are where the
margin widens.

| image | ours Q3 (gamma) | chafa builtin (best raster) | chafa DejaVu (best raster) |
|---|---|---|---|
| sphere | 0.9802 | 0.9832 (linear) | 0.9830 (linear) |
| torus | 0.9814 | 0.9821 (gamma) | 0.9820 (gamma) |
| spheres | 0.9827 | 0.9783 (linear) | 0.9779 (linear) |
| DamagedHelmet | 0.8651 | 0.8603 (gamma) | 0.8568 (gamma) |
| FlightHelmet | 0.9710 | 0.9697 (gamma) | 0.9691 (gamma) |
| BoomBox | 0.9277 | 0.9251 (gamma) | 0.9218 (gamma) |
| **mean** | **0.9513** | **0.9498** | **0.9484** |

**Verdict: PASS**, ours − chafa best = **+0.0015**. Ours wins every Khronos image
(DamagedHelmet +0.0048, FlightHelmet +0.0013, BoomBox +0.0026): the
continuous-coverage margin is *larger* on textured/edge-dense content than on the
smooth synthetic renders. Reproduce with
`npx tsx bench/chafa-gate.ts --images sphere,torus,spheres,DamagedHelmet,FlightHelmet,BoomBox`.

#### Full experiment matrix

chafa reference (constant across runs) = per-image `max(builtin, DejaVu)` × best
raster; mean **0.9809** is the gate target.

| run | quality | space | gateTau | edgeLambda | sphere | torus | spheres | mean | Δ vs chafa | verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| A (baseline re-run) | Q3 | linear | 0.0002 | — | 0.9784 | 0.9807 | 0.9803 | **0.9798** | -0.0011 | FAIL |
| B | Q3 | gamma | 0.0002 | — | 0.9799 | 0.9813 | 0.9824 | **0.9812** | +0.0003 | PASS |
| C | Q3 | gamma | 0 | — | 0.9841 | 0.9828 | 0.9850 | **0.9840** | +0.0030 | PASS |
| D | Q3 | linear | 0 | — | 0.9839 | 0.9823 | 0.9848 | **0.9837** | +0.0027 | PASS |
| E1 | Q4 | gamma | 0.0002 | 0.2 | 0.9799 | 0.9813 | 0.9824 | **0.9812** | +0.0003 | PASS |
| E2 | Q4 | gamma | 0.0002 | 0.35 | 0.9799 | 0.9813 | 0.9824 | **0.9812** | +0.0003 | PASS |
| E3 | Q4 | gamma | 0.0002 | 0.7 | 0.9799 | 0.9812 | 0.9824 | **0.9812** | +0.0002 | PASS |

Run **B** is the shipped default. Runs C/D confirm the gate, not the space, is
what most `mean` SSIM is left on the table by — but see §3.4: that number is not
free.

#### Masked-SSIM localization (object vs background)

Object mask = reference gamma-luma per-cell mean > Otsu threshold (per image),
dilated one cell so silhouette cells count as object. The spec's literal τ≈0.06
is degenerate here (marks 100% of these bright-gradient backgrounds as object),
so a data-driven Otsu split is used and reported:

| image | Otsu τ (gamma) | object-cell fraction |
|---|---|---|
| sphere | 0.424 | 39.8% |
| torus | 0.447 | 14.7% |
| spheres | 0.388 | 37.1% |

| target | region | sphere | torus | spheres | mean |
|---|---|---|---|---|---|
| ours Q3 linear (A) | object | 0.9685 | 0.8863 | 0.9604 | 0.9384 |
| ours Q3 linear (A) | background | 0.9851 | 0.9973 | 0.9923 | 0.9916 |
| ours Q3 gamma (B) | object | 0.9671 | 0.8874 | 0.9620 | 0.9388 |
| ours Q3 gamma (B) | background | 0.9886 | 0.9978 | 0.9948 | 0.9938 |
| chafa builtin | object | 0.9732 | 0.8906 | 0.9654 | 0.9431 |
| chafa builtin | background | 0.9896 | 0.9979 | 0.9856 | 0.9910 |

(Matrix + masked tables mirror `bench/out/gate-matrix.md`, which is gitignored;
regenerate with `npx tsx bench/chafa-gate.ts --matrix`.)

## Honest scope note (spec §9)

**(a) What this validates.** Only the **2D continuous-coverage least-squares
margin** (DESIGN §10). It says nothing about the eventual 3D pipeline. On flat 2D
shaded renders our M0 optimizer now edges a mature, heavily-optimized reference
tool (chafa 1.18.2) under a scrupulously fair, identical-repertoire,
identical-renderer comparison — a genuine, if narrow, M0 win.

**(b) Known open gap — object/lit cells.** The masked-SSIM table shows the PASS
comes entirely from the **background** (ours gamma **0.9938** vs chafa **0.9910**);
on **object** cells chafa still leads by **~0.004–0.005** mean (0.9431 vs
~0.9385), and *neither* the gamma fix nor `gateTau 0` moves that number. This is
recorded as an **open problem** (DESIGN §15), **not tuned away**.

## Files

- `bench/chafa-gate.ts` — runnable gate (atlas → our Q3 + two chafa variants →
  re-rasterize → SSIM → table + verdict).
- `bench/ansi-parse.ts` — `parseAnsiToGrid()`: chafa ANSI (SGR 0/39/49/38;2/48;2
  truecolor, 38;5/48;5 256-palette fallback, UTF-8 glyphs) → `Grid`.
