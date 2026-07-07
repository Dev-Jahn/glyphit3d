# Review Request — 2026-07-07-gpu-reality

The reviewer has the repository via git. This is a domain/code review, not a workflow audit —
keep the jahns-workflow harness out of scope.

- Project / Branch: glyphit3d / main
- Reviewing: `78e478941ebb43f4da64b9d8120c11c3e4fef99b` (diff against `6f649029b43ca7049d5bad4c8743c4d580270b0e` — the pre-round tip; the closeout commit that carries this file adds only registry/PROGRESS metadata on top)

## What changed and why

A long-standing "this machine has no GPU / WebGPU deferred" assumption was a **misdiagnosis**:
the box has 8× RTX PRO 6000 Blackwell, and WebGPU works headless on a **secure context**
(`navigator.gpu` was only ever probed on a non-secure origin). Two things shipped off that:

1. **e2e off SwiftShader** — the harness forced `--use-angle=swiftshader` (software), so the
   ~300ms render "floor" was self-imposed. Switched to `--use-angle=vulkan`; render ~300→33ms,
   with a check-1 guard asserting the WebGL2 renderer is the NVIDIA GPU (a silent software
   fallback now fails the suite).
2. **WebGPU Q3 compute matcher** — a WGSL kernel reproduces `matchGrid`'s EXACT Q3 objective
   (one workgroup per cell, per-glyph two-color LS, first-wins-on-tie argmin). It runs in
   *centered / AC-scale coordinates* (STT_c/Saa_c precomputed f64 on CPU) so it survives f32
   with no `f64`. `pipeline.ts` routes the Q3 default web path to the GPU on a WebGPU-capable
   secure context and everything else (Q0/Q1/Q2, WebGPU-absent, device-lost) to the unchanged
   CPU worker pool — a capability/availability boundary, never a masking fallback. `src/core/*`
   is untouched: the GPU must MATCH the CPU truth, not change it.

## Read these first

1. `web/src/webgpu/matcher-wgsl.ts` — the WGSL kernel + the numerics (centered reformulation, 8-way-blocked cross, tie rule). Load-bearing correctness.
2. `web/src/webgpu/gpu-matcher.ts` — device lifecycle, CPU per-cell stats + gate prep (must be byte-identical to `src/core/match.ts`), dispatch, readback, cell assembly.
3. `src/core/match.ts` (Q3 scan ≈ 260–540) + `src/core/fit.ts` (channelSse/channelFB) — the CPU truth being matched.
4. `web/src/pipeline.ts` — the GPU/pool routing + fallback.
5. `web/src/webgpu/wgsl-mirror.ts` + `test-e2e/webgpu-parity.spec.ts` — the parity proof harness.

## Claims to attack

1. The WGSL Q3 matcher is **byte-exact** with the CPU closed-form: glyph 100.0% agreement, colorΔ 0, |ΔSSIM|=0 across 14 configs. Break it — find a scene/config/glyph where the GPU picks a different glyph or a >1-u8 color than `matchGrid`, that is NOT a genuine score-tie.
2. The `saTc = saT − Sa1·mean` centered cross survives f32 without changing selection. Find a low-contrast / high-DC cell where the f32 cancellation flips the argmin vs the f64 CPU.
3. First-wins-on-tie is preserved through the workgroup argmin reduction. Find a tie where the parallel reduction keeps a higher `gi` than the sequential CPU scan.
4. The contrast gate is byte-identical (CPU-side `Math.fround` f32 accumulation). Find a borderline cell gated on one side only.
5. Routing is sound: ONLY Q3-web-default goes to GPU; Q0/Q1/Q2, WebGPU-absent, non-secure origin, and device-lost fall back to the pool with identical output. Find a mis-route or a diverging fallback.
6. The e2e GPU switch doesn't mask a software fallback (check 1 asserts NVIDIA renderer). Find a config that passes on llvmpipe/SwiftShader.

## Evidence already produced (mine — inspect, don't trust)

| Claim | Command / artifact | My reading | Where it lives |
|---|---|---|---|
| Parity byte-exact | `npm run parity` | 14/14, glyph 100%, ΔSSIM 0 | `test-e2e/webgpu-parity.spec.ts`; PROGRESS gpu-reality |
| WGSL fit == fit.ts | `npx vitest run` | mirror < 1e-9 over 40k cases | `web/src/webgpu/wgsl-mirror.test.ts` |
| GPU path + 9/9 | `npm run e2e` | GPU renderer, match ~55ms | `test-e2e/demo.spec.ts` check 1/7 |
| Predictions→outcomes | — | §7.1 met (1.25ms), §7.3 falsified | `docs/WEBGPU-MATCHER-SPEC.md` Outcome |

## Known weak spots

- The f32 cross cancellation (claim 2) is empirically clean on the harness sweep but not *proven* for all inputs — the sweep is finite.
- The interactive perf claim rests on GPU **compute** (1.25ms). The headless dispatch→readback wall-clock is ~25ms (Dawn queue-completion callback latency) — I assert this collapses in a real browser but did not measure a real (non-headless) browser.
- The GPU path still rasterizes on the main-thread CPU (~96ms). Out of this round's scope (`perf/gpu-rasterizer`), but flag if it interacts with correctness.

## Domain lens

Numerical parity of a GPU port of a closed-form per-cell optimizer, and the correctness of the
capability/availability routing between the GPU matcher and the CPU pool.

## Out of scope

The jahns-workflow harness; the aesthetic/metric redesign (Round A, `docs/metric-redesign`);
Q1/Q2/Q4 + families on GPU; the CPU rasterize cost.

## Response wanted

Major / critical issues only. For each: a concrete failure mechanism and where you confirmed it.
Separate confirmed findings, open domain questions, and residual risks.
