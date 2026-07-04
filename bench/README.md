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
  (`edgeLambda 0.35`, `gateTau 2e-4`, `mdlLambda 0.02`, `fixedBg [0,0,0]`,
  `fixedFg [1,1,1]`). No tuning: Q3 is run exactly as the ladder/CLI run it.
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

| image   | ours Q3 | chafa builtin | chafa DejaVu |
|---------|---------|---------------|--------------|
| sphere  | 0.9784  | 0.9830        | 0.9828       |
| torus   | 0.9807  | 0.9816        | 0.9816       |
| spheres | 0.9803  | 0.9780        | 0.9776       |
| **mean**| **0.9798** | **0.9809**  | **0.9807**   |

chafa best variant: **builtin glyphs**, mean SSIM **0.9809**.
Ours mean SSIM **0.9798**.

### Verdict: **FAIL** (ours − chafa best = −0.0011)

Our M0 Q3 narrowly trails chafa's best variant at M0: we win `spheres`
(+0.0023) but lose `sphere` (−0.0046) and `torus` (−0.0009). The two chafa
variants are within 0.0002 of each other (builtin ≈ DejaVu), so the builtin/real-
glyph distinction is not the deciding factor.

This is an **honest, un-tuned** result: Q3 is run with spec-default options. The
gap is *not* rigged away — the golden rule here is fairness and correctness, not
forcing a green light. Two contributors to the gap, both legitimate M0 behavior:

- On these images 92–96% of cells are near-black background that our contrast
  gate (`gateTau`) correctly blanks to a flat `bg=mean` cell — identical in
  spirit to what chafa does on flat regions. The SSIM difference lives entirely
  in the ~5–8% of cells covering the lit object.
- The MDL ink penalty (`mdlLambda`) biases us toward simpler glyphs on
  high-AC-energy object cells; chafa has no such complexity prior. This is a Q3
  regularizer we tune later, not at M0.

## Honest scope note (spec §9)

This gate validates **only the 2D continuous-coverage least-squares margin**
(DESIGN §10). It says nothing about the eventual 3D pipeline. It shows that on
flat 2D shaded renders, our M0 optimizer is already *within ~0.1% SSIM* of a
mature, heavily-optimized reference tool (chafa 1.18.2) under a scrupulously
fair, identical-repertoire, identical-renderer comparison — a strong M0 baseline,
narrowly short of the hard gate pending Q3/Q4 λ tuning.

## Files

- `bench/chafa-gate.ts` — runnable gate (atlas → our Q3 + two chafa variants →
  re-rasterize → SSIM → table + verdict).
- `bench/ansi-parse.ts` — `parseAnsiToGrid()`: chafa ANSI (SGR 0/39/49/38;2/48;2
  truecolor, 38;5/48;5 256-palette fallback, UTF-8 glyphs) → `Grid`.
