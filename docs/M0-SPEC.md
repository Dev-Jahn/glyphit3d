# M0 Implementation Spec (implementation contract — read together with DESIGN.md §3, §5, §6, §8, §10)

Pure TypeScript/Node CPU implementation. Node 24, ESM (`"type": "module"`), npm.
Deps already installed: `@napi-rs/canvas` (glyph raster + PNG IO), `fontkit`
(font metrics/coverage), dev: `typescript`, `tsx`, `vitest`, `@types/node`, `@types/fontkit`.
Do NOT add dependencies. Run tests with `npx vitest run`.

Conventions: minimal comments (only non-obvious constraints), no speculative
abstraction, `Float32Array` flat buffers, math in plain number (f64). All
internal color math in **linear RGB, [0,1] floats**. sRGB only at IO boundaries.

## 0. Module ownership (one agent per group — do not touch other groups' files)

| Group | Files |
|---|---|
| SETUP+FIT | `tsconfig.json`, `.gitignore`, `src/core/types.ts`, `src/core/color.ts`, `src/core/fit.ts`, `test/fit.test.ts`, `test/color.test.ts` |
| ATLAS | `src/atlas/atlas.ts`, `src/atlas/charsets.ts`, `test/atlas.test.ts` |
| IMAGE | `src/image/image.ts`, `test/image.test.ts` |
| EXPORT | `src/render/ansi.ts`, `src/render/html.ts`, `src/render/raster.ts`, `src/metric/ssim.ts`, `src/metric/heatmap.ts`, `test/ssim.test.ts`, `test/render.test.ts` |
| MATCHER | `src/core/stats.ts`, `src/core/match.ts`, `src/core/ramp.ts`, `test/match.test.ts` |
| HARNESS | `src/cli.ts`, `scripts/gen-test-images.ts`, `scripts/ladder.ts` |
| GATE | `bench/chafa-gate.ts`, `bench/ansi-parse.ts`, `bench/README.md` |

## 1. `src/core/types.ts` (SETUP+FIT writes; everyone imports)

```ts
export interface LinearImage { w: number; h: number; data: Float32Array } // w*h*3, linear RGB, row-major

export interface FitStatsG { Saa: number; Sa1: number; S11: number } // glyph-side Gram entries (generalized)

export interface Glyph {
  ch: string; cp: number;
  alpha: Float32Array;                    // P = cellW*cellH, coverage [0,1]
  dxA: Float32Array; dyA: Float32Array;   // central-difference gradients of alpha, zero-padded at cell borders
  sumA: number;                            // Σα
  sumAA: number;                           // Σα²
  gradAA: number;                          // Σ(dxA²) + Σ(dyA²)
  ink: number;                             // Σ(|dxA|+|dyA|), then min-max normalized to [0,1] across atlas
}

export interface Atlas {
  cellW: number; cellH: number; P: number;
  fontPath: string; fontSize: number; ascent: number; // px at fontSize, from canvas TextMetrics
  glyphs: Glyph[];                          // glyphs[0] MUST be space (ch=' ')
}

export interface GridCell { ch: string; fg: [number,number,number] | null; bg: [number,number,number] | null } // sRGB 0..255 ints
export interface Grid { cols: number; rows: number; cells: GridCell[]; cellW: number; cellH: number; font: string }

export type ColorMode = 'mono' | 'fg' | 'fg-bg'
export interface MatchOptions {
  quality: 0|1|2|3|4;         // Q0..Q4 (DESIGN §6). quality implies colorMode: Q1=mono, Q2=fg, Q3/Q4=fg-bg
  edgeLambda: number;          // λ_e, only used at Q4. default 0.35
  gateTau: number;             // contrast gate threshold on E_AC per pixel (linear luma). default 2e-4
  mdlLambda: number;           // ink complexity penalty weight. default 0.02
  fixedBg: [number,number,number]; // linear RGB, for mono/fg modes and Q0. default [0,0,0]
  fixedFg: [number,number,number]; // linear RGB, for mono mode. default [1,1,1]
}
```

## 2. `src/core/color.ts` (SETUP+FIT)

- `srgbToLinear(u8: number): number` and `linearToSrgb(f: number): number`
  (exact sRGB transfer curve with the 0.0031308/0.04045 linear toe, clamp).
  Precompute a 256-entry LUT for decode.
- `luma(r,g,b)` = 0.2126r + 0.7152g + 0.0722b (linear-space inputs).
- Tests: round-trip u8→linear→u8 identity for all 256 values; toe boundary.

## 3. `src/core/fit.ts` (SETUP+FIT) — the heart. DESIGN §3.2–§3.5.

Model per channel: `pred = a·m + b·1ext` where m is the (possibly extended)
mask vector and `1ext` is the constant vector extended with **zeros** on
gradient channels. All fits reduce to the generalized 2×2 normal equations
with six sufficient statistics:

- glyph-side `FitStatsG`: `Saa = Σm²`, `Sa1 = Σ(m·1ext)`, `S11 = Σ1ext²`
  - plain (Q1–Q3): `Saa = sumAA`, `Sa1 = sumA`, `S11 = P`
  - edge-extended (Q4, λ): `Saa = sumAA + λ²·gradAA`, `Sa1 = sumA` (gradient
    channels contribute 0 — this is why the generalized form is REQUIRED;
    naively reusing the plain formulas with a bigger P is WRONG), `S11 = P`
- cell-side per channel: `SaT = Σm·T̂`, `S1T = Σ1ext·T̂` (= plain ΣT), `STT = ΣT̂²`
  where T̂ is the correspondingly extended target vector.

### API (exact)

```ts
export interface FitResult { a: number; b: number; sse: number }

// full quadratic SSE at ANY (a,b) — the only valid scorer off the OLS optimum (DESIGN §3.2 (2))
export function sseAt(g: FitStatsG, a: number, b: number, SaT: number, S1T: number, STT: number): number
// = STT - 2*(a*SaT + b*S1T) + (a*a*g.Saa + 2*a*b*g.Sa1 + b*b*g.S11)

// unconstrained OLS; uses the regression identity for sse (valid ONLY here)
export function fitFree(g: FitStatsG, SaT: number, S1T: number, STT: number): FitResult
// det = g.Saa*g.S11 - g.Sa1²; if det <= 1e-9 * g.Saa * g.S11 (or g.Saa === 0):
//   degenerate → a = 0, b = S1T/g.S11, sse = sseAt(...)
// else a = (g.S11*SaT - g.Sa1*S1T)/det, b = (g.Saa*S1T - g.Sa1*SaT)/det,
//   sse = STT - a*SaT - b*S1T   (identity; clamp tiny negatives to 0)

// B fixed (fg-only mode, Q2), solve F: substitute a = F-B, b = B:
export function fitFgOnly(g: FitStatsG, SaT: number, S1T: number, STT: number, B: number): FitResult
// minimize over a with b=B fixed: a* = (SaT - B*g.Sa1) / g.Saa  (g.Saa===0 → a=0)
// sse = sseAt(g, a*, B, ...)

// both fixed (mono, Q1): sse = sseAt(g, F-B, B, ...)

// box-constrained on F = a+b and B = b (DESIGN §3.4; exact convex-QP-over-box):
export function fitBox(g: FitStatsG, SaT: number, S1T: number, STT: number,
                       loF: number, hiF: number, loB: number, hiB: number): { F: number; B: number; sse: number }
```

`fitBox` exact algorithm (Hessian is a Gram matrix ⇒ convex; enumerate):
1. unconstrained `fitFree` → (F,B) = (a+b, b); if `loF≤F≤hiF && loB≤B≤hiB`, it's optimal.
2. else evaluate 4 edge candidates, each a 1-D convex quadratic solved then clamped
   (1-D solve-then-clamp IS exact):
   - B=loB and B=hiB: F* via `fitFgOnly` with that B, then F=clamp(F*, loF, hiF)
   - F=loF and F=hiF: with F fixed at f, minimize over b:
     `pred = f·m + b·(1ext−m)` ⇒ `b* = (S1T − SaT − f·(Sa1 − Saa)) / (S11 − 2·Sa1 + Saa)`
     (denominator = Σ(1ext−m)²; if 0 → b* = loB), then B=clamp(b*, loB, hiB)
3. score every candidate with `sseAt` (never the identity), return min.

### Tests (`test/fit.test.ts`) — M0 verify (a), non-negotiable

- Random trials (≥200, seeded PRNG): P=16, random α∈[0,1]^16 (include some
  binary and some constant masks), random T∈[0,1]^16.
  - `fitFree` vs brute force over a,b grid (F,B∈[-0.5,1.5] step 1/128 mapped to a,b):
    closed-form sse ≤ grid-best sse + 1e-6, and sseAt(a*,b*) === fitFree.sse within 1e-9.
  - `fitBox` (box = per-trial random sub-box of [0,1]²) vs brute force restricted
    to the box (step 1/128): closed-form sse ≤ grid best + 1e-6.
  - Edge-extended stats (random λ∈{0.35,1}): build extended vectors explicitly
    (concatenate α,λ·dxA,λ·dyA and T,λ·dxT,λ·dyT with 1ext=[1..1,0..0]),
    compute reference OLS via explicit 2×2 solve on those vectors, compare to
    `fitFree` on composed stats: agree within 1e-9.
  - Degenerate: α constant (all 0, all 1, all 0.5) → no NaN/Inf, b = mean(T), sse = variance·P.
- `tsconfig.json`: strict, ES2022, moduleResolution bundler/nodenext (agent's choice, must compile with tsx).
- `.gitignore`: node_modules/, bench/out/, out/, *.tsbuildinfo.

## 4. `src/atlas/*` (ATLAS) — DESIGN §5.1/§5.2

`charsets.ts`: `export const CHARSETS: Record<'ascii'|'blocks'|'braille'|'full', number[]>`
- ascii: 0x20–0x7E
- blocks: ascii + U+2500–257F (box drawing) + U+2580–259F (block elements incl. shades)
  + selected geometric U+25A0–25CF (■□▲►▼◄◆●○ etc. — pick ~20 with mono coverage)
- braille: blocks + U+2800–28FF
- full: braille + Latin-1 printable (0xA1–0xFF)

`atlas.ts`: `export async function buildAtlas(fontPath: string, fontSize: number, charset: keyof typeof CHARSETS): Promise<Atlas>`
1. fontkit: open font; mono advance = advance of 'M'. Keep cp only if
   `font.hasGlyphForCodePoint(cp)` AND glyph advance === mono advance (font units, exact).
2. Cell dims via @napi-rs/canvas at fontSize: `cellW = round(measureText('M').width)`,
   `cellH = round(fontBoundingBoxAscent + fontBoundingBoxDescent)`; store ascent.
3. Rasterize each glyph at SS=4 supersample: canvas (cellW·4 × cellH·4), black fill,
   white text `fillText(ch, xOff, ascent·4)` with font at fontSize·4
   (xOff centers the true advance in the cell), read R channel → box-average 4×4
   → α[P]∈[0,1]. Treat R/255 directly as coverage (white-on-black ⇒ value = coverage
   under any transfer curve).
4. Drop glyphs whose ink leaks: any α>1e-3 in the outermost supersampled column/row
   beyond the advance? Simplification: drop if Σα of the 1-px border exceeds 20% of Σα
   total AND the glyph is not in the block/box ranges (blocks legitimately touch borders).
5. Compute dxA/dyA (central differences, zero-padded), sumA, sumAA, gradAA, ink;
   min-max normalize ink across the atlas. Ensure space (0x20) survives filtering
   and sits at glyphs[0].
6. Dedup: if two glyphs have identical α within max-abs 1/255, keep the first
   (prefer lower cp; keeps output charset-stable).
- Tests: DejaVu Sans Mono (`/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf`):
  atlas('ascii') has ≥ 90 glyphs, space present with sumA≈0; '█' (U+2588) in
  'blocks' has mean α ≥ 0.9; '▀' upper-half coverage: top-half mean ≥ 0.85,
  bottom-half mean ≤ 0.1; no NaN anywhere.

## 5. `src/image/image.ts` (IMAGE)

- `export async function loadLinear(path: string): Promise<LinearImage>` — @napi-rs/canvas
  `loadImage` + draw at native size + getImageData; sRGB→linear LUT; alpha
  composited over black BEFORE linearization is WRONG — composite in linear:
  out = a·linear(rgb) (straight alpha over black).
- `export function resampleArea(img: LinearImage, w: number, h: number): LinearImage` —
  exact area (box) resampling in linear space, arbitrary ratios, energy-preserving
  (weighted by overlap area). Downscale is the only required direction.
- `export function gradients(img: LinearImage): { dx: Float32Array; dy: Float32Array }` —
  central differences per channel on the FULL image (this is the "target = full
  support" side of DESIGN §3.5's boundary convention), zero-padded at image borders.
- Tests: constant image → resample exact; 2×1 checker downsampled to 1×1 = mean
  (in linear space); energy preservation Σ(pixel·area) within 1e-4.

## 6. `src/core/stats.ts` + `src/core/match.ts` + `src/core/ramp.ts` (MATCHER) — DESIGN §3.3–§3.6, §6

`stats.ts`: from the resampled `LinearImage` (size cols·cellW × rows·cellH) and its
full-image gradients, extract per cell (row-major cells, channel-separated):
patch `T[3][P]`, `dxT[3][P]`, `dyT[3][P]` (crop from full-image gradients),
`ST[3]`, `STT[3]`, `minT[3]`, `maxT[3]`, `gradTT[3]` (=Σdx²+Σdy² per channel),
`EacLuma` = Σ(Y−Ȳ)² with Y = luma per pixel.

`match.ts`: `export function matchGrid(img: LinearImage, atlas: Atlas, opts: MatchOptions): Grid`
- Per cell:
  1. Contrast gate: if `EacLuma / P < opts.gateTau` → emit `{ch:' ', fg:null, bg:mean}`
     (mean = per-channel ST/P) and skip the scan. (fg-bg mode; for mono/fg emit
     nearest representable: mono → space; fg → space with fixed bg.)
  2. Scan all glyphs. Per channel c compose cell-side stats:
     - Q1–Q3: `SaT = Σα·T_c`, `S1T = ST[c]`, `STT = STT[c]` with plain FitStatsG.
     - Q4: `SaT = Σα·T_c + λ²(Σ dxA·dxT_c + Σ dyA·dyT_c)`, `S1T = ST[c]`,
       `STT = STT[c] + λ²·gradTT[c]`, FitStatsG edge-composed (§3 above).
     Fit by mode: Q1 `sseAt(F=fixedFg,B=fixedBg)`; Q2 `fitFgOnly(B=fixedBg)` then
     clamp F to [minT,maxT]∪{fixedBg}-safe → actually: clamp F to [0,1] only;
     Q3/Q4 `fitFree`, and if (F,B) outside per-channel [minT[c],maxT[c]] box →
     `fitBox` with that box. Total score = Σ_c sse_c + opts.mdlLambda · glyph.ink · EacLumaScale
     where EacLumaScale = Σ_c STT[c] − ST[c]²/P (keeps the penalty scale-relative).
  3. argmin → colors: convert linear→sRGB u8. Q1: fg=fixedFg,bg=fixedBg (sRGB).
- Mode mapping (DESIGN §6): Q1 mono / Q2 fg / Q3 fg-bg / Q4 fg-bg + edge channels.
- Perf: flat loops, no allocation inside the glyph loop; budget ≤ ~30s for
  120×40 cells × 400 glyphs. (M0 correctness first; DESIGN §7 says CPU naive ~1s
  is the SIMD budget, JS slower is acceptable.)

`ramp.ts` (Q0 strawman, DESIGN §6): charset `" .:-=+*#%@"`, index = round(meanLuma^(1/2.2) · 9)
(gamma-encoded luma → perceptual ramp), fg = patch mean color (sRGB), bg = fixedBg.

- Tests (`test/match.test.ts`): synthetic 2-cell image where left cell is exactly
  '▀' pattern (top white, bottom black) → Q3 with blocks charset picks '▀' (or
  complement '▄' with swapped colors — accept either, assert reconstruction SSE ≈ 0);
  flat gray image → gate fires, all cells space with bg≈gray; Q2 respects fixed bg.

## 7. EXPORT group — DESIGN §8, §10, §5.6

`raster.ts`: `export function rasterizeGrid(grid: Grid, atlas: Atlas): LinearImage` —
bake mode: per cell per pixel `pred = α·F + (1−α)·B` in linear RGB (null fg/bg →
use [0,0,0] linear unless bg null → treat as fixedBg black). This is the golden-metric
renderer (DESIGN §10) AND the PNG preview (encode via linearToSrgb → @napi-rs/canvas PNG).
Also `export function savePng(img: LinearImage, path: string): Promise<void>`.

`ansi.ts`: `export function toAnsi(grid: Grid): string` — truecolor, SGR state
reuse (emit 38;2/48;2 only on change; semicolon form), `bg:null` → SGR 49,
`fg:null` → SGR 39, row end = `\x1b[0m\r\n` (DESIGN §5.6: no auto-wrap reliance).

`html.ts`: `export function toHtml(grid: Grid): string` — self-contained:
`<pre>` with explicit `font-family` (quote grid.font + monospace fallback),
`font-size`, `line-height: {cellH}px`, `letter-spacing:0`, `font-kerning:none`,
`font-variant-ligatures:none`, `font-synthesis:none`; one `<div style="height:{cellH}px">`
per row; adjacent same-style cells merged into one `<span>` (background stripe
hazard: spans must NOT rely on inline background — set `display:inline-block;
height:{cellH}px; vertical-align:top` on colored spans). Escape HTML entities.

`ssim.ts`: `export function ssim(a: LinearImage, b: LinearImage): number` —
grayscale SSIM: convert both to gamma-encoded luma u8 (linearToSrgb of luma),
11×11 Gaussian σ=1.5 window (valid region only), K1=0.01, K2=0.03, L=255,
return mean SSIM. Dimensions must match (throw otherwise).
Tests: ssim(x,x)=1; ssim decreases monotonically with increasing added noise
(3 noise levels); known asymmetry sanity (blur < noise at equal MSE not required — skip).

`heatmap.ts`: `export function cellDiffHeatmap(ref: LinearImage, out: LinearImage, grid: Grid): LinearImage` —
per-cell mean abs luma diff → green(0)→red(max) tinting, cell-sized tiles.

## 8. HARNESS — DESIGN §12 M0 verify (b)

`scripts/gen-test-images.ts`: generate `bench/images/*.png` 512×512, no deps:
(1) lambert+specular shaded sphere on dark gradient bg, (2) torus (raymarched or
analytic normal), (3) three overlapping matte spheres with distinct hues.
Write with @napi-rs/canvas (do the shading math in linear, encode to sRGB).

`src/cli.ts` (node:util parseArgs):
`npx tsx src/cli.ts image <input.png> --cols 120 --quality 3 --charset blocks
--font /usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf --font-size 16
[-o out.ansi] [--html out.html] [--png out.png] [--diff diff.png] [--stats]`
rows = round(cols · (imgH/imgW) · cellW/cellH). `--stats` prints SSIM
(rasterized output vs reference resampled to the same grid-pixel size) + timing.

`scripts/ladder.ts`: for each bench image: run Q0..Q4 (blocks charset, defaults),
compose one side-by-side PNG (reference + Q0..Q4, labeled) into `bench/out/ladder-<name>.png`,
print a markdown SSIM table (image × Q0..Q4). Exit non-zero if SSIM is not
monotone Q0<Q3 on every image (weak sanity gate; Q4 may tie/dip slightly vs Q3 — allowed at M0, we tune λ later).

## 9. GATE — DESIGN §12 M0 verify (c)

`bench/chafa-gate.ts` + `bench/ansi-parse.ts`:
- Obtain chafa: download official static x86_64 Linux build (hpjansson.org/chafa
  releases) into `tools/chafa/` (gitignored); verify it runs `--version`.
- For each bench image: run our Q3 (blocks) AND
  `chafa -w 9 --fill none --symbols <mapped set> --colors full --size {cols}x{rows} --format symbols`
  (consult `chafa --help`/man in the tarball; choose the symbol-class mapping that
  best matches our blocks charset — document the exact mapping and any mismatch
  in bench/README.md). If the build supports `--font`, also run a second chafa
  variant with DejaVu loaded, and report both.
- Parse chafa's ANSI (SGR 0/39/49/38;2/48;2/38;5/48;5 + UTF-8 chars per row) → Grid.
- Re-rasterize BOTH grids through OUR DejaVu atlas (same renderer, same font —
  what a user's terminal would show), SSIM vs the same reference. Print table +
  mean; state PASS/FAIL of the hard gate (our mean SSIM > chafa's best variant).
- Honest scope note in bench/README.md: this validates the 2D continuous-coverage
  LS margin only (DESIGN §10).
