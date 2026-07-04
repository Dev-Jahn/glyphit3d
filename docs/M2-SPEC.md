# M2 Implementation Spec — interactive web demo, CPU-first (read with DESIGN.md §9, §12 M2)

**Architecture decision (2026-07-04)**: this environment has no WebGPU (headless
Chromium: `navigator.gpu` absent under all flag combinations). M2 therefore ships
the **CPU matcher demo** — the existing TS matcher is already interactive-class
(~284ms @ 120col×270 glyphs in node) and covers every browser including Firefox
Linux. The WGSL GEMM fast path is deferred to M2.5 (when GPU hardware is
accessible for verification — we do not ship unverifiable kernels). DESIGN §12
M2's "60fps" criterion is restated for CPU: interactive re-render < 500ms at
default settings, measured headless.

New deps allowed: `vite` (dev). `three` already present. Nothing else.

## 0. Module ownership

| Group | Files |
|---|---|
| PROFILE | `scripts/export-atlas.ts`, `web/src/profile.ts` (loader), `web/src/browser-image.ts`, `test/profile.test.ts` |
| APP | `web/index.html`, `web/vite.config.ts`, `web/src/main.ts`, `web/src/scene.ts` (three.js), `web/src/pipeline.ts`, `web/src/worker.ts` |
| UI | `web/src/ui/*.ts(x?)` — scrubber, ladder, exports, permalink (plain TS + DOM; no UI framework) |
| E2E | `test-e2e/demo.spec.ts` (Playwright), `web/src/perf.ts` |

## 1. Font profile artifact (PROFILE) — DESIGN §5.4 landing early

- `scripts/export-atlas.ts`: node script serializing `buildAtlas(DejaVu, 16, preset)`
  for all four presets into `web/public/profiles/dejavu-16-<preset>.json`:
  `{ version:1, font:{family,size}, cellW, cellH, ascent, profileHash,
     glyphs:[{ch, cp, sumA, sumAA, gradAA, ink, alphaB64}] }`
  - `alphaB64` = base64 of `Uint8Array(round(α·255))` (u8 quantization is fine:
    atlas α comes from 4× supersampling). `profileHash` = sha256 of the glyph
    payload (node:crypto).
- `web/src/profile.ts`: fetch + decode into the exact `Atlas` shape `matchGrid`
  consumes; recompute `dxA/dyA` from the decoded α (same central-difference/2,
  zero-padded convention as `src/atlas/atlas.ts` — copy the loop, do not import
  node code).
- `web/src/browser-image.ts`: browser replacements for image IO —
  `imageDataToLinear(ImageData): LinearImage` (sRGB LUT decode, alpha over black
  in linear — mirror `loadLinear` semantics exactly).
- `test/profile.test.ts` (node vitest): export → decode round-trip: α max abs
  error ≤ 1/255 vs the live atlas; stats equal within f32; dx/dy recompute
  matches atlas values within 1e-6; matchGrid on a small synthetic image with
  the decoded atlas == with the live atlas (same glyph choices; colors within ±1 u8).

## 2. APP — vite app, three.js reference, worker pipeline

- `web/vite.config.ts`: root `web/`, base './' (Pages-friendly), no plugins needed;
  vitest must keep running from the repo root untouched.
- `web/src/scene.ts`: three.js **WebGLRenderer** (works under SwiftShader headless —
  proven in M1). Default scene: TorusKnotGeometry with MeshStandardMaterial +
  the M1 studio light preset (reuse constants). Drag&drop `.glb/.gltf` replaces
  the model (GLTFLoader; bounding-sphere auto-frame, yaw/pitch from mouse orbit —
  simple custom orbit, render-on-demand only). Render target sized to the grid
  footprint (cols·cellW × rows·cellH), `preserveDrawingBuffer`, readPixels →
  ImageData.
- `web/src/pipeline.ts` + `worker.ts`: on parameter change or orbit release:
  scene render → `imageDataToLinear` → transfer to worker → worker runs
  `resampleArea`(identity if already grid-sized) + `matchGrid`/`rampGrid` +
  `rasterizeGrid` + `ssim` (all existing src/ modules — they are pure TS and must
  import cleanly in the worker; if any node-ism blocks the import, fix by
  splitting the node-only IO out, NOT by forking logic) → transfer back
  {grid, rasterPixels, ssim, timings}.
- Defaults: cols=100, quality=3, charset=blocks, space=gamma. Live timing readout
  (render / match / raster / ssim ms) via `web/src/perf.ts`.

## 3. UI — the proof devices (DESIGN §9)

Plain DOM/TS, one dark stylesheet, no framework.
- **Un-blur reveal scrubber**: one canvas compositing native render (left) and
  glyph raster (right) split at a draggable divider; both layers pre-scaled to
  the same footprint. "Squint" toggle applies identical `filter: blur(6px)` to
  both halves (CSS on stacked canvases is fine).
- **Q-ladder**: buttons Q0–Q4; on switch, re-match and update a large SSIM badge
  (4 decimals) + per-rung one-line caption (from DESIGN §6 table).
- **Diff heatmap** toggle: overlay from `cellDiffHeatmap` (existing module).
- Controls: charset select (ascii/blocks/braille/full — loads the matching
  profile), cols slider (60–160), space toggle (gamma/linear).
- **Exports**: download .ans (existing `toAnsi`), copy-to-clipboard, download
  .png (raster canvas), download grid .json (`{version:1, cols, rows, cell,
  font+profileHash, color, cells}` per DESIGN §8 — implement the serializer
  faithfully: bg:null for terminal-default, color.channels/depth split).
- **Permalink**: settings only (model='torusknot'|'custom', cols, quality,
  charset, space, camera yaw/pitch) in the URL fragment; applied on load.
  Custom dropped files are NOT encoded (note in UI).

## 4. E2E (Playwright, runs headless HERE — this is the M2 verify instrument)

`test-e2e/demo.spec.ts` (separate script `npm run e2e`, launches vite dev server
or preview build; NOT part of vitest):
1. Page loads, default torus knot renders (canvas non-blank via pixel probe).
2. Ladder: Q0 → Q3 produces different grids and SSIM(Q3) > SSIM(Q0); badge updates.
3. Charset switch to braille loads profile and re-renders (glyph repertoire in
   the ANSI export changes).
4. ANSI export: non-empty, starts with ESC, row count == rows; JSON export
   validates against the §3 shape; PNG download non-empty.
5. Scrubber divider drag changes the composite (pixel probe both sides).
6. Permalink round-trip: set params → reload with fragment → same settings applied.
7. Perf: record {render, match, raster} ms at defaults; assert match+raster < 500ms
   (SwiftShader CPU here is the slow floor; a real machine is faster).
8. `vite build` succeeds and `vite preview` serves a working page (spot-check 1).

## 5. Verify criteria (M2 done =)

1. All e2e specs green headless in this environment.
2. Interactive re-render (match+raster) < 500ms at defaults (measured, reported).
3. In-browser ladder SSIM monotone Q0<Q3 on the default scene.
4. Node/browser consistency: same grid JSON for the same LinearImage input
   (golden cross-check in test/profile.test.ts using the decoded profile).
5. Static build artifact works (vite build + preview e2e).

Out of scope (explicit): WebGPU kernel (M2.5), gallery/model-zoo UI, asciinema,
SGR attributes, image-input UI (3D only — identity guard per DESIGN §12).
