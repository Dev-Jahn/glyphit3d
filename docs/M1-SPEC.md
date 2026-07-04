# M1 Implementation Spec — 3D static bake + first 3D-native proof (read with DESIGN.md §4.1/§4.2/§4.5, §10, §12 M1)

New deps allowed (exactly these): `three` (pinned exact version), `playwright` (dev) + `npx playwright install chromium`. Everything else: M0 rules (ESM, strict TS, vitest, no other deps).

## 0. Module ownership

| Group | Files |
|---|---|
| RENDERER | `render3d/page.html`, `render3d/page.ts` (browser-side), `scripts/bake-aov.ts` (Playwright driver + static file server), `scripts/fetch-zoo.ts` |
| OPTIMIZER | `src/core/match.ts` (extend), `src/core/types.ts` (extend), `src/image/image.ts` (add `loadRaw`), `test/aov-match.test.ts` |
| INTEGRATION | `src/cli.ts` (add `bake` subcommand), `scripts/ablate.ts` |

## 1. AOV contract (RENDERER produces, OPTIMIZER consumes)

Per model, `bench/aov/<model>/` (gitignored):
- `shaded.png` — lit render, sRGB. Studio preset: key directional (warm, from camera-left-up), rim light (cool, back-right), low ambient; background = dark vertical gradient (match bench synthetic style, opaque).
- `albedo.png` — unlit baseColor (per-mesh `MeshBasicMaterial` with the original `map`/`color`), sRGB, same bg.
- `objectid.png` — per-mesh flat color, id = mesh traversal index+1 encoded in R (0 = background), G=B=0, **data (no sRGB semantics)**.
- `coverage.png` — geometry white on black (unlit), acts as object mask/alpha.
- `meta.json` — { model, cols, rows, cellW, cellH, gridW, gridH, camera:{yaw,pitch,dist}, threeVersion }.

All four PNGs are exactly `gridW×gridH = cols·cellW × rows·cellH` (default cols=120, DejaVu cell 10×19 → 1200×(rows·19)). **Aspect pre-warp = rendering at exactly this footprint with camera.aspect = gridW/gridH** (DESIGN §4.5; no extra warp — our raster pipeline models the cell shape already).

Camera auto-framing: bounding-sphere fit, yaw 30°, pitch −15°, distance so the sphere fills ~80% of the shorter view dimension. Deterministic (no randomness, no Date).

## 2. RENDERER

- `scripts/bake-aov.ts`: starts a tiny node http server rooted at the repo (serves node_modules + render3d + model files), launches Playwright chromium headless with software WebGL (`--use-angle=swiftshader`), loads `render3d/page.html`, calls an exposed `bake(modelUrl, opts)` page function, receives the four AOVs as data-URL PNGs, writes them + meta.json. CLI: `npx tsx scripts/bake-aov.ts <model.glb|.gltf> --cols 120 [--out bench/aov/<name>]`.
- `render3d/page.*`: import map for `three` + `GLTFLoader` from `/node_modules`. AOV passes = swap materials per pass (store/restore originals): shaded = original PBR materials + studio lights; albedo/id/coverage = per-mesh `MeshBasicMaterial` overrides. `renderer.setSize(gridW, gridH)`, `preserveDrawingBuffer:true`, read via `canvas.toDataURL('image/png')`.
- FIRST deliverable (before anything else): smoke script renders a lit default cube and asserts >5% non-background pixels — proves SwiftShader WebGL2 works headless. If it does not, STOP and report (do not build the rest on hope).
- `scripts/fetch-zoo.ts`: download the fixed zoo from KhronosGroup/glTF-Sample-Assets **"glTF" variant (separate .gltf+.bin+textures; no Draco, no KTX2)** into `bench/zoo/` (gitignored): DamagedHelmet, FlightHelmet, BoomBox, SciFiHelmet, Fox, Sponza. If a model's glTF variant is unavailable or fails to render in SwiftShader, substitute in this FIXED order and document: ABeautifulGame → Corset → Lantern. No result-based swapping.
- Fox: static bind pose is fine (load, no animation). Sponza: allow up to 120s bake; if it exceeds, substitute per the rule above and document.

## 3. OPTIMIZER extensions (all mechanisms are score-priors; the closed-form fit machinery is unchanged)

`MatchOptions` additions (all optional, all default off — M0 behavior unchanged):
```ts
aov?: {
  shadingLuma?: Float32Array   // gridW*gridH, working-space luma of the SHADED render (see below)
  objectId?: Uint16Array       // gridW*gridH, 0 = background
  albedo?: LinearImage         // for the stylization variant only
}
splitSelection?: number   // η ≥ 0, default 0 (off). §4.1 fidelity variant.
antibleedKappa?: number    // κ ≥ 0, default 0 (off). §4.2.
styleAlbedoColors?: boolean // default false. §4.1 stylization variant (visual only).
```

- **§4.1 fidelity variant (`splitSelection = η`)**: stack ONE extra scoring channel: the shading-luma patch (already in the working space, weight η) fit per glyph with its own closed-form (a,b) via the existing `fitFree`; add its SSE·η to the selection score. Its fitted colors are DISCARDED (colors still come from the 3 RGB channels of the shaded image). Effect: glyph choice is pulled toward the structure of LIGHT, robust to albedo/texture noise inside the cell. Note: shadingLuma in M1 comes from the shaded render's luma (a true separate shading buffer would need a white-override pass — acceptable simplification, document it; the signal differs from the RGB channels only in weighting, so expect a mild effect and say so honestly in the harness).
  - IMPORTANT correction to the above (implement THIS): a shaded-luma extra channel is nearly redundant with RGB. The REAL §4.1 signal must be the **albedo-free shading**: add a fifth render pass in RENDERER — `shading.png` = the scene with all materials overridden to pure white `MeshStandardMaterial({color:#fff, roughness:1, metalness:0})` under the same lights (Lambert-like light-only image), sRGB. OPTIMIZER consumes ITS luma as `shadingLuma`. This is the true "문자는 빛을 인코딩" channel.
- **§4.2 anti-bleed (`antibleedKappa = κ`)**: per cell, from the objectId patch compute the majority id A and second id B over covered pixels (coverage>0). If the B-fraction ≥ 15% the cell is a boundary cell: build the binary indicator vector `idm` (1 where id==A). For each glyph compute the centered correlation ρ_id = corr(α̃, ĩdm) (reuse the DC/AC machinery: needs one extra dot product Σα·idm per (glyph,cell) — acceptable at M1 CPU scale). Add `−κ·|ρ_id|·eacScale` to the glyph's score (bonus for masks whose ink partition matches the object partition). Non-boundary cells: no change.
- **Stylization variant (`styleAlbedoColors`)**: after glyph selection (whatever priors), recompute fg/bg by fitting the SELECTED glyph's α against the ALBEDO patch (closed form, box-constrained as usual). Output no longer approximates the shaded reference — never enters SSIM tables; visual side-by-side only.
- `loadRaw(path): {w,h,data:Uint8Array}` in image.ts — PNG → raw u8 (R channel), NO sRGB decode (for objectid/coverage).
- Tests (`test/aov-match.test.ts`), synthetic AOVs on a 1-2 cell grid:
  1. anti-bleed: cell = left/right halves two flat colors + objectId splitting the same way, with a *slightly perturbed* shaded patch such that base Q3 picks a non-split glyph (construct it: e.g. add luma texture noise that makes '▒' win by a hair); with κ on, '▌'/'▐' family wins and fg/bg ≈ the two object colors.
  2. splitSelection: cell where albedo has high-frequency noise but shading is a clean top-bright/bottom-dark gradient; η=0 picks a noise-matching glyph, η>0 flips selection to a half-block-like glyph aligned with the shading structure. (Construct the synthetic shadingLuma directly.)
  3. defaults-off: with all new options absent, output is bit-identical to M0 matchGrid on the same input (regression guard).

## 4. INTEGRATION

- `src/cli.ts bake` subcommand: `ascii3d bake <model|aov-dir> --cols 120 --quality 3 [--split N] [--antibleed N] [--style-albedo] [-o/--html/--png/--diff/--stats]`. If given a model file, invoke bake-aov first (child process); if given an existing AOV dir, skip rendering.
- `scripts/ablate.ts` — per zoo model, 4 runs: base Q3 / +split(η=0.5) / +antibleed(κ) / +both. κ from a FIXED 3-value sweep {0.02, 0.05, 0.1} run on ALL models, ALL results reported, one κ chosen by mean boundary-cell improvement subject to the regression guard (state the choice rule in the output).
  Metrics per run (all vs the shaded reference resampled to grid footprint — reuse the M0 golden-metric pipeline):
  - overall SSIM
  - object-cell masked SSIM (mask: per-cell mean coverage > 0.3; reuse bench/masked-ssim.ts machinery)
  - boundary-cell masked SSIM (mask: the §4.2 boundary-cell definition)
  Output: markdown tables (per model × run × 3 metrics) to bench/out/ablate.md + stdout; side-by-side PNGs (reference | base | +split | +antibleed | +both) per model to bench/out/.
- **M1 verify criteria (report PASS/FAIL per criterion, no tuning beyond the fixed κ sweep):**
  1. Regression guard: every feature-on run keeps overall SSIM within −0.002 of base on every model.
  2. §4.2: boundary-cell SSIM improves on ≥4 of 6 models at the chosen κ.
  3. §4.1: object-cell SSIM change reported per model (hypothesis: helps on textured models — DamagedHelmet/BoomBox/FlightHelmet); PASS if it improves object-cell SSIM on ≥2 of the 3 textured models without violating the guard.
  4. Zoo bake completes end-to-end on ≥5 of 6 models with re-rasterize SSIM recorded.
  If a criterion FAILS, report honestly — DESIGN M1 says a null 3D-native result forces a thesis review, and that is the point of the ablation.
