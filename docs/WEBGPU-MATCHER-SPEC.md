# WEBGPU-MATCHER-SPEC — GPU compute matcher for the Q3 web path

Task: `perf/webgpu-matcher`. SSOT anchor: DESIGN §7 (performance), §3 (closed-form
cell model). On-record predictions per project convention (verify against committed
code, no announced number without a no-flag reproduction command).

## 0. Why now (record correction)

The prior "no GPU on this machine → M2.5 deferred" was a misdiagnosis. This box has
8× NVIDIA RTX PRO 6000 Blackwell; WebGPU works in headless Chromium on a **secure
context** (localhost/https) — verified: `requestAdapter` returns vendor `nvidia`,
architecture `blackwell`, device creation succeeds. So the GPU matcher is buildable
AND verifiable here, and real users' browsers already expose WebGPU.

## 1. Scope (round 1 — MVP)

**In:** a WebGPU compute matcher that reproduces the **Q3 default web path** of
`matchGrid` — `families=[]`, no contour (`topK=0`, `orientKappa=0`), no AOV priors,
`collapseThreshold=0`, `quality===3` (fg/bg both free), working space as requested
(gamma default). This is exactly what the demo runs by default and what the worker
pool computes today.

**Out (round 1 — stays on the CPU worker pool):** Q0/Q1/Q2/Q4, families, contour,
AOV/orientation priors, the invisibility collapse. Any request carrying those routes
to the existing CPU pool. This is a **capability boundary, not a masking fallback**:
the GPU path advertises exactly what it implements and defers everything else.

**Availability fallback:** if `navigator.gpu` is absent or adapter/device request
fails, use the CPU worker pool. Legitimate — WebGPU genuinely may be unavailable in a
viewer's browser or a non-secure origin. Never silently produce wrong output.

## 2. Module ownership (must stay disjoint from the e2e-gpu stream)

- **New:** `web/src/webgpu/matcher.wgsl` (or inlined as a TS string), `web/src/webgpu/gpu-matcher.ts` (device init, atlas upload, per-run dispatch, readback → Grid cells).
- **Touched:** `web/src/pipeline.ts` (detect WebGPU + Q3-web-path eligibility; route to the GPU matcher else the pool; keep timings shape for e2e check 7), `web/src/worker.ts` only if a shared type moves. `web/src/main.ts` only if device init needs a lifecycle hook.
- **Do NOT touch:** `test-e2e/demo.spec.ts` (owned by `chore/e2e-gpu-rendering`), `scene.ts`, `src/core/*` (the GPU path must MATCH `src/core/match.ts`, not change it).

## 3. What the kernel computes (parity target = the CPU Q3 web path)

Per cell (P = cellW·cellH pixels, 3 linear channels), working space already applied to
the target `T` (same as the CPU path: the worker converts to working space before the
scan). Per-cell scalars: `ST_c = Σ T_c`, `STT_c = Σ T_c²`, `minT_c`, `maxT_c`,
`eacScale = Σ_c (STT_c − ST_c²/P)`.

**Gate (unchanged semantics):** if `eacScale/(3P) < gateTau` → emit the gated Q3 cell
(`ch=' '`, `fg=null`, `bg=` cell working-space mean encoded). Must byte-match the CPU
gate for Q3.

**Scan (non-gated):** for each glyph g (atlas order; `glyphs[0]` = space), with
`Saa=sumAA, Sa1=sumA, S11=P`:
- per channel c: `saT_c = Σ_i α_g[i]·T_c[i]` (the heavy inner product),
- `score += channelSse(Saa,Sa1,S11, saT_c, ST_c, STT_c, quality=3, minT_c, maxT_c, ffg_c, fbg_c)`,
- `score += mdlLambda · g.ink · eacScale`.
Track argmin. Then for the winner recompute `(F_c,B_c) = channelFB(...)` per channel and
encode to sRGB u8. `channelSse`/`channelFB` are `src/core/fit.ts` — port them to WGSL
**verbatim in form** (same clamps to `[minT_c,maxT_c]`, same degenerate-case handling).
The mdl term uses `g.ink` (normalized) exactly as the CPU path.

Ties: the CPU keeps the FIRST glyph reaching a strictly-smaller score (`<`). The WGSL
reduction MUST replicate first-wins-on-tie deterministically (argmin with `< bestScore`
scanning gi ascending), or ties will diverge from the CPU.

## 4. Data layout (guidance, implementer may refine)

- Atlas (upload once per charset): coverage `α` as a storage buffer `[G·P] f32` (glyph-major); per-glyph `sumA, sumAA, ink` as `[G] f32`. G≈95 (ascii) / 270 (blocks); P from the profile cell.
- Target (per run): pack the grid into per-cell patches `[cells·P·3] f32` in working space, OR index the flat gridW×gridH×3 image with a cell offset. Per-cell stats (`ST,STT,minT,maxT,eacScale`) computed in a pre-pass kernel or on CPU (cheap) and uploaded.
- Output: `[cells]` → `{glyphIdx:u32, F:vec3<u8>, B:vec3<u8>, gated flag}`; readback → assemble `GridCell[]`.
- Dispatch: one workgroup per cell; threads cooperatively reduce the P-length inner products across G glyphs. Keep the glyph loop sequential for the argmin (first-wins ties), parallelize the P reduction. cols=100,rows≈53,G≈270,P≈66 ⇒ ~300M MACs — trivial on Blackwell.

## 5. Integration & timings

`pipeline.run`: render (WebGL2, main thread) → readback ImageData → if GPU-eligible,
run `gpuMatch` (async, non-blocking — GPU compute + `mapAsync`; main thread stays live
for e2e check 7) → assemble Grid → rasterize (reuse the existing CPU rasterizer for
round 1) → SSIM (non-interactive only, as today). Report `timings.match` = GPU
dispatch→readback wall-clock so check 7 stays meaningful. Atlas re-upload only on
charset change (mirror the pool's `setAtlas` cadence).

## 6. Parity contract (THE correctness gate — non-negotiable)

GPU f32 vs CPU f64 will differ slightly, so parity is defined on OUTCOMES, tested by a
new headless harness comparing `gpuMatch` vs `matchGrid` (Q3, gamma) on the demo scene
+ a few bench images, cols ∈ {80,100,140}, both charsets:
1. **Glyph agreement ≥ 99.5%** of non-gated cells pick the identical glyph. Every
   disagreement must be a genuine near-tie: `|score_gpu_winner − score_cpu_winner| <
   1e-4 · eacScale` (i.e. the two glyphs are indistinguishable, not a real error).
2. **Gate agreement 100%** (gated set identical — it's a threshold on the same scalar).
3. **Color parity:** emitted sRGB u8 F/B differ by ≤ 1 level per channel for agreed cells.
4. **SSIM parity:** |SSIM_gpu − SSIM_cpu| < 5e-4 on every tested image.
A failure on any of these is a blocker — the GPU path must not ship diverging from the
closed-form CPU truth. (The gate is what makes this safe to enable by default.)

## 7. Predictions (on record — falsifiable)

1. GPU `match` wall-clock (dispatch→readback, warm) at cols=100/Q3/blocks is **< 15ms**
   on the local Blackwell — a >10× cut vs the ~118ms 8-worker CPU pool. (Interactive
   cadence then bounded by render+readback, not match.)
2. Parity §6 holds at the stated thresholds with NO code change to `src/core/match.ts`.
   If glyph agreement < 99.5% with non-tie disagreements, the WGSL port of
   `channelSse`/`channelFB` is wrong — fix the port, not the thresholds.
3. On a browser without WebGPU (or non-secure origin) the demo is byte-identical to
   today (CPU pool). e2e stays 9/9 (the Playwright headless-shell exposed no
   `navigator.gpu` in my probe, so e2e likely exercises the CPU path — confirm which
   path e2e takes and record it; do NOT weaken any e2e assertion to force a path).
4. Readback (gridW·gridH·4 bytes) is < 2ms and not the bottleneck.

## 8. Verification

- New parity harness (headless, node+playwright, secure-context page): the §6 numbers, printed, with a no-flag repro command.
- New vitest unit: the WGSL-ported `channelSse`/`channelFB` (run on CPU via a tiny JS mirror OR structural test) agree with `src/core/fit.ts` on random inputs — OR fold this into the parity harness if WGSL can't be unit-run in node.
- `npx vitest run` unchanged-green (no existing test touched); `npm run e2e` 9/9.
- Perf number from the harness, warm, median of N.

## 9. Non-goals / follow-ups (record, do not silently skip)

Round 2+: GPU Q1/Q2/Q4, families/contour on GPU, GPU rasterizer, running the matcher
in a worker via OffscreenCanvas, and a native CUDA matcher for the CLI/bench path
(the 8 GPUs make that independently attractive). None are in round 1.
