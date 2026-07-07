<!-- jahns-workflow feedback: the body below is the reviewer reply VERBATIM (byte-exact copy via `jw review ingest`) — do not edit it; a triage skeleton is appended beneath it. -->
round: 2026-07-07-gpu-reality
reviewer: gpt-5.5-pro
ingested: 2026-07-07
source: /tmp/review.md

---

문제 중심으로만 정리합니다.

## 검토 기준

* GitHub Connector 기준 현재 최신 커밋은 `c2d6afbbb29f00726da710cc316eaf9a148011a9`이고, 리뷰 패킷의 Reviewed HEAD는 `78e478941ebb43f4da64b9d8120c11c3e4fef99b`입니다. 패킷 자체가 “closeout commit은 registry/PROGRESS metadata만 추가”라고 설명하므로, `c2d6afb`가 `78e4789` 위 1커밋인 상태는 패킷과 부합합니다.
* 초기 커밋은 `2fe1e6c1613cad0c097ef2c3e7a6ccf84f175f6d`로 확인했고, 최근 GPU 라운드의 핵심 커밋은 `4a8f78f...` e2e GPU 전환, `f93d324...` WebGPU matcher, `78e4789...` stale docs 정정입니다.
* `docs/review-profile.md`는 Connector fetch 기준 존재하지 않았습니다. 패킷의 “CPU raster cost out of scope”는 그대로 숨기지 않았습니다. 현재 “GPU real-time” claim과 직접 상호작용하므로 이 리뷰에서는 포함했습니다. 패킷도 GPU path가 아직 main-thread CPU raster `~96ms`를 가진다고 명시합니다.

---

## 확인된 주요 findings

### F1. UI rematch 결과가 stale write 될 수 있습니다

**심각도: High**

`main.ts`의 `rematch()`는 비동기 `pipeline.run(...)`이 끝난 뒤 무조건 `last`, canvas, `#ssim`, perf를 갱신합니다. run generation, cancellation token, “latest request only commit” 검사가 없습니다.

반면 coalescing/stale 방지는 `requestRematch()`에만 있으며, 이 경로는 orbit drag 전용입니다.  UI controls와 quality ladder는 `app().setParams(...)` 후 `void app().rematch()`를 직접 호출합니다. charset/cols/space 변경도 직접 호출이고, Q ladder도 직접 호출입니다.

**실패 메커니즘**

사용자가 빠르게 `Q3 → Q1 → Q3`, `blocks → ascii → blocks`, `cols` 변경 등을 수행하면 여러 `rematch()`가 병렬로 살아 있을 수 있습니다. 느린 이전 run이 빠른 최신 run 뒤에 resolve되면, 현재 `params`와 다른 grid/raster/SSIM/perf가 화면과 export에 commit됩니다. 특히 현재는 GPU Q3, CPU pool Q0/Q1/Q2가 섞여 있어 run latency가 품질별로 달라질 수 있으므로 순서 역전 가능성이 현실적입니다.

**개선 방향**

* `rematch()` 내부에 `runSeq` 또는 `AbortController`를 둬서, 최신 request id가 아닌 결과는 commit하지 마십시오.
* `window.__app.rematch` 자체를 `requestRematch(false)`로 래핑하고, controls/ladder/drop 모두 동일한 single-flight queue를 타게 하십시오.
* `pipeline.run` 시작 시 `params`와 `atlas`를 immutable snapshot으로 캡처하고, commit 직전 `seq === latestSeq`를 확인하십시오.
* stale 결과를 버릴 때는 perf/SSIM mutation도 발생시키지 말아야 합니다. 현재 UI는 `#ssim` mutation을 “new output” signal로 쓰므로 stale mutation 자체가 잘못된 refresh trigger가 됩니다.

---

### F2. WebGPU matcher의 buffer/shader가 `P` 변화와 `P > 256`을 방어하지 않습니다

**심각도: High, font-profile 확장 시 Critical**

`GpuMatcher.ensureCellBuffers(numCells, P)`는 `numCells`만 같으면 기존 buffer를 재사용합니다. `P`, `cellW`, `cellH`, atlas profile 변화는 cache key에 포함되지 않습니다.  `match()`도 footprint 일치만 확인하고 `P` 상한이나 이전 buffer의 `P`와의 일치를 확인하지 않습니다.

WGSL은 workgroup scratch를 `array<f32, 768>`으로 고정하고, 주석상 `P ≤ 256`을 가정합니다. 하지만 shader는 runtime `P`를 uniform으로 받고 `idx < 3*P`까지 `sT[idx]`에 씁니다. 즉 `P > 256`이면 workgroup array out-of-bounds가 됩니다.

**실패 메커니즘**

현재 bundled DejaVu profiles가 같은 `P`라면 바로 드러나지 않습니다. 그러나 설계 문서는 여러 font profile과 브라우저-side TTF profiling을 명시하고 있습니다.  향후 다른 폰트/크기에서 같은 `cols*rows`이지만 다른 `P`가 들어오면:

1. `targetBuf`, `cstatBuf`, staging buffers가 이전 `P` 크기로 남습니다.
2. `writeBuffer`가 GPUBuffer 크기를 초과하거나, 작은 쪽이면 데이터가 truncate/validation error를 냅니다.
3. shader shared memory는 `P > 256`에서 구조적으로 불가능합니다.
4. fallback도 “capability fallback”이 아니라 runtime exception catch 후 CPU pool로 빠질 수 있는데, 그 전에 validation/device-lost가 발생할 수 있습니다.

**개선 방향**

* cell buffer cache key를 최소한 `{ numCells, P }`로 바꾸십시오. 가능하면 `{ cols, rows, P, cellW, cellH }`까지 포함하는 편이 안전합니다.
* `GpuMatcher.match()` 시작 시 `if (P > 256) throw new Error('gpu-matcher: unsupported P ...')`처럼 명시적으로 CPU fallback 가능한 error를 내십시오.
* 더 나은 방향은 WGSL `override P_MAX`/shader specialization 또는 tiled load로 `P` 상한을 제거하는 것입니다.
* 테스트는 fake atlas 2개를 만들어 같은 `numCells`·다른 `P`로 연속 `gpu.match()`를 호출하는 케이스를 추가하십시오. 현재 parity harness는 `ascii/blocks`와 고정 profiles만 다뤄 이 결함을 노출하지 못합니다.

---

### F3. `profileHash`가 matcher objective에 실제로 쓰이는 scalar stats를 보호하지 않습니다

**심각도: High**

browser profile에는 `sumA`, `sumAA`, `gradAA`, `ink`가 별도 scalar로 들어 있고, `decodeProfile()`은 이를 그대로 atlas glyph stats로 신뢰합니다.   그러나 `verifyProfileHash()`는 glyph `cp`와 `alphaB64` coverage bytes만 hash합니다. scalar stats, `cellW/cellH`, font metadata, `ch`, `ink` 등은 hash 범위 밖입니다.  exporter도 hash를 `cp + coverage bytes`로만 만들고, stats는 hash 이후 JSON에 별도 필드로 싣습니다.

**실패 메커니즘**

`sumAA`나 `ink`가 손상되거나 stale regeneration되면 `profileHash` 검증은 통과하지만 CPU/GPU matcher의 점수 함수가 바뀝니다. 특히 GPU matcher는 atlas upload 시 저장된 `sumA`, `sumAA`, `ink`, `Saa_c`를 그대로 사용합니다.  즉 coverage artifact는 정상처럼 보이는데 argmin, MDL penalty, degenerate branch, color fit이 모두 틀어질 수 있습니다.

현재 test도 coverage tamper는 reject하지만, scalar tamper reject는 없습니다.  live atlas와 decoded atlas 비교 테스트는 exporter가 정상 생성한 profile에 대한 consistency만 확인합니다.

**개선 방향**

둘 중 하나로 계약을 명확히 해야 합니다.

1. **canonical profile hash 확대**
   `profileHash`를 `profileHash` 필드 제외 전체 canonical payload의 hash로 바꾸십시오. `version`, `font`, `cellW`, `cellH`, `ascent`, glyph order, `ch`, `cp`, `alphaB64`, `sumA`, `sumAA`, `gradAA`, `ink`를 모두 포함해야 합니다.

2. **decode-time 재계산 + assertion**
   `alphaB64`에서 `sumA/sumAA/gradAA`를 재계산하고, JSON stats와 epsilon 비교하십시오. 단, 현재 설계는 quantized `alpha`와 live high-resolution stats를 혼합해 쓰는 구조이므로, “objective stats는 quantized alpha 기준인가, live atlas 기준인가”를 먼저 결정해야 합니다.

개인적으로는 1번이 현재 의도와 덜 충돌합니다. “stored `sumAA`가 objective truth”라는 WebGPU matcher 계약과도 맞습니다.

---

### F4. e2e liveness/perf check가 현재 GPU path의 main-thread stall을 충분히 잡지 못합니다

**심각도: Medium-High**

GPU path는 match 이후 `rasterizeGrid(grid, atlas, params.space)`를 main thread에서 동기 실행합니다.  패킷과 WebGPU spec outcome 모두 이 CPU raster가 남은 병목이라고 인정합니다.

그런데 e2e check 7은 “heavy match/raster/ssim run off-thread”라는 전제의 주석을 유지하고, heartbeat가 `ticks >= 3`이고 `maxGap < dur`이면 통과합니다.  이 조건은 긴 main-thread raster stall을 놓칠 수 있습니다. 예컨대 전체 rematch가 async GPU/readback 때문에 200ms이고, 그중 90ms가 main-thread raster stall이어도 `maxGap < dur`는 참입니다.

**실패 메커니즘**

“main thread stays live”라는 claim이 실제 frame budget 관점에서는 거짓 양성으로 통과할 수 있습니다. 현 check는 “전체 compute가 완전히 main thread에서 돈 것은 아니다”만 증명하고, interactive smoothness를 증명하지 않습니다.

**개선 방향**

* e2e check 7을 `maxGap < 50ms` 또는 더 엄격하게 `maxGap < 32ms` 같은 long-task budget으로 바꾸십시오.
* `PerformanceObserver({ type: 'longtask' })`를 사용해 rematch 중 long task 수와 최대 duration을 기록하십시오.
* `PipelineOutput.timings`에 `raster`가 이미 있으므로, GPU path에서는 “main-thread raster”임을 UI/e2e detail에 명시하십시오.
* `perf/gpu-rasterizer` 전까지 README/Status의 “GPU real-time” 표현은 “WebGPU Q3 matcher shipped”로 좁히는 편이 안전합니다. README는 GPU matcher shipped를 명시하지만, 사용자에게는 전체 pipeline GPU-real-time으로 읽힐 여지가 있습니다.

---

### F5. `wgsl-mirror.ts`에 수치 경로에 대한 stale/false comment가 남아 있습니다

**심각도: Medium, 수치 유지보수상 위험**

`web/src/webgpu/wgsl-mirror.ts`는 `SaTc` 설명에서 “kernel accumulates it directly with Kahan so it never cancels `SaT−Sa1·mean` in f32”라고 적고 있습니다.  실제 WGSL은 raw cross `saT = Σ α·T`를 8-way blocked accumulation으로 계산한 뒤 `saTc = saT - Sa1 * mean`을 수행합니다.

이 문제는 runtime code defect라기보다는, 이번 라운드의 핵심 위험인 f32 cancellation을 설명하는 문서/테스트 mirror가 실제 구현과 다르게 말하는 문제입니다. WebGPU spec outcome은 “Kahan compensation / never cancels”류의 잘못된 header comment를 고쳤다고 기록하지만, mirror 파일에는 같은 성격의 문장이 남았습니다.

**개선 방향**

* `wgsl-mirror.ts` comment를 `matcher-wgsl.ts` header와 동일한 표현으로 맞추십시오: “8-way blocked raw cross, then `saT − Sa1·mean`; cancellation-free는 아니지만 centered SSE formulation이 AC-scale cancellation을 피한다.”
* 가능하면 mirror test에 “comment와 코드” 문제가 아니라 실제 수치 경로를 강제하는 adversarial fixture를 추가하십시오. 현재 mirror는 WGSL 실행이 아니라 JS hand-transcription이므로, comment drift가 다시 생기기 쉽습니다.

---

## Open domain questions / decision points

### O1. WebGPU parity claim은 “현 harness에서 byte-exact”로 한정하는 편이 맞습니다

패킷도 f32 cross cancellation은 finite sweep으로만 clean하다고 인정합니다.  현재 parity harness는 14개 구성의 scene/image sweep이고, 주요 configs는 `ascii/blocks`, `cols 80/100/140`, 일부 pose/image, linear 1건입니다.  이 harness에서의 outcome은 매우 강하지만, 모든 cell/glyph/profile에 대한 증명은 아닙니다.

**권장 추가 검증**

* synthetic high-DC/low-AC cells, `gateTau` 바로 위 cell, `minT/maxT` clamp가 걸리는 box cases.
* degenerate `Saa_c` 근처 glyphs.
* exact tie와 near-tie에서 lower `gi` 보존 property test.
* random profile/P sweep, 특히 `P` 증가와 `G` 증가.
* CPU f64로 adversarial target을 만든 뒤 GPU 결과와 score margin을 비교하는 seed-repro harness.

---

### O2. Browser profile의 objective contract를 결정해야 합니다

현재 browser atlas는 quantized `alphaB64`를 사용해 `saT`를 계산하지만, `sumA/sumAA/gradAA/ink`는 profile에 저장된 scalar를 그대로 사용합니다. `decodeProfile()`은 quantized alpha를 만들고 scalar는 복사합니다.  이 구조는 의도적일 수 있습니다. WebGPU matcher도 “stored `sumAA`가 objective”라고 못박고 있습니다.

다만 장기적으로는 둘 중 하나를 명문화해야 합니다.

* **Live-atlas objective**: high-resolution atlas stats가 truth이고 quantized alpha는 dot-product approximation이다. 그러면 stats를 hash해야 합니다.
* **Serialized-profile objective**: quantized alpha가 truth이고 stats는 decode-time 재계산한다. 그러면 browser artifact가 self-consistent하지만 live node atlas와 약간 달라질 수 있습니다.

현재 상태는 전자에 가깝습니다. 그러면 F3의 hash 범위 확대가 필수입니다.

---

### O3. “GPU real-time” milestone semantics를 좁힐 필요가 있습니다

README thesis는 temporal stability와 GPU-real-time을 목표 문장으로 제시하고, 곧바로 temporal은 roadmap이고 GPU Q3 matcher만 shipped라고 일부 정정합니다.  DESIGN에서도 temporal coherence는 M4로 남아 있습니다.

현재 shipped claim은 “WebGPU Q3 matcher”에는 맞지만, full interactive pipeline에는 아직 render readback, main-thread raster, SSIM, UI commit race가 남아 있습니다. 문구를 다음처럼 분리하는 편이 방어 가능합니다.

> WebGPU Q3 matcher shipped; full GPU raster/temporal coherence remain follow-ups.

---

## Residual risks

* 이 환경에서는 GitHub Connector로 파일과 커밋을 확인했지만, container에서 private repo를 직접 `git clone`해 `git rev-parse HEAD`, `git diff`, `npm run test`, `npm run e2e`, `npm run parity`를 실행하지는 못했습니다. 따라서 위 findings는 current file inspection 기반입니다.
* 실제 Blackwell GPU/WebGPU runtime에서 validation error나 timing을 재현하지는 못했습니다. 특히 F2는 코드 구조상 확인되는 latent defect이며, 현재 bundled DejaVu profiles만 쓰는 기본 demo에서는 숨어 있을 가능성이 큽니다.
* `initial..HEAD` 전체 변경 범위는 커밋 목록과 current-state 핵심 파일 위주로 검토했습니다. 가장 load-bearing한 runtime 경로는 `src/core/match.ts`, `src/core/fit.ts`, `web/src/webgpu/*`, `web/src/pipeline.ts`, `web/src/main.ts`, profile/export/e2e harness입니다.


---

## Findings (triage skeleton — verify each before registering)

Triaged 2026-07-07 by opus (main) via 4 clean adversarial verifiers (F1 / F2+F5 / F3+O2 / F4+O3),
each reading only the cited files and instructed to confirm **and** refute. Verdicts below;
REAL/NEEDS-RULING registered as tracked tasks (origin `review-2026-07-07-gpu-reality`).

| # | 심각도 | Verdict | 근거 (검증 결과) | Task |
|---|---|---|---|---|
| F1 stale rematch write | major | **REAL** | `main.ts` rematch() commit 경로에 seq/generation/Abort 가드 없음(`main.ts:55-78`); coalescing은 requestRematch()=orbit 전용, controls/ladder는 bare `rematch()` 직접 호출(`ladder.ts:39`, `controls.ts:25/35/45`); GPU Q3 vs CPU pool 지연차로 순서 역전 현실적; export(json/ans/png)도 stale `last` 읽어 오염; #ssim mutation이 refresh 신호라 stale mutation이 잘못된 refresh trigger. 리뷰어 정확(params는 torn-read 아님 — resolve-order 문제) | `fix/rematch-single-flight` |
| F2 GPU P-guard | major (latent) | **REAL** | `ensureCellBuffers`가 `numCells`만 키(`gpu-matcher.ts:133`), P 미포함; P 증가 시 `targetBuf`(유일 P-크기)에 writeBuffer validation error→silent 오출력; 별개로 WGSL `array<f32,768>`=3·256 고정(`matcher-wgsl.ts:145`)이라 P>256은 첫 run부터 구조적 OOB; match() try/catch 없어 capability fallback이 못 잡음. 현재 번들 프로파일 전부 P=190이라 **미발현**, DESIGN §5.4 브라우저 TTF 프로파일에서 발현. 리뷰어 과장: cstat/staging은 P-무관, P 감소는 안전 | `fix/gpu-matcher-p-guard` |
| F3 profileHash scope | major (latent) | **NEEDS-RULING** | hash는 `cp`+coverage 바이트만(verify `profile.ts:110-122`, produce `scripts/export-atlas.ts:31-47` 양측 일치); scalar stats는 `decodeProfile`가 그대로 신뢰(`profile.ts:83-86`), GPU matcher가 "STORED sumAA=objective"로 업로드(`gpu-matcher.ts:116-119`). 자동 exporter는 stats·coverage를 한 atlas에서 동시 생성 → 실경로 divergence 불가(**latent**); 노출은 hand-edit/third-party/버전 skew(DESIGN §5.4이 계획). 수정이 계약에 의존: A(coverage=truth, decode 재계산, hash 불변, DESIGN §5.4/§5.2) vs B(stats=truth, hash 확대). 현재 B 데이터모델+A hash 범위 혼종 → SSOT 모순, decision 필요 | `decision/profile-stats-objective-contract` |
| F4 e2e liveness | minor | **REAL** | check-7 주석은 "raster off-thread"(`demo.spec.ts:345`)이나 GPU 경로는 `rasterizeGrid` 메인스레드 동기(`pipeline.ts:154`, ~96ms); `maxGap<dur`(`demo.spec.ts:370`)는 dur=전체 rematch(~200ms, 비동기 match ~55ms가 tick 공급)라 96ms stall도 통과 → 사실상 vacuous. 근본원인(메인스레드 raster)은 `perf/gpu-rasterizer`로 기추적 → net-new는 테스트 조임 + O3 문구뿐. headless에서 async 슬라이스가 부풀어 CI에서 가장 취약 | `fix/e2e-liveness-frame-budget` |
| F5 wgsl-mirror 주석 | minor | **REAL** | `wgsl-mirror.ts:24-25` "Kahan so it never cancels SaT−Sa1·mean" — 실제 커널은 8-way-blocked raw cross 후 `saT-Sa1*mean`(`matcher-wgsl.ts:122-131`)으로 방법·주장 둘 다 반대. matcher-wgsl.ts 헤더는 이번 라운드에 정정됐으나 mirror 미반영. mirror는 SaTc를 인자로 받아 수치 무영향 — 순수 doc drift | `docs/wgsl-mirror-kahan-comment` |

**Open questions:** O1(parity 유한 sweep 한정) → `chore/parity-adversarial-fixtures`(적대적 fixture 보강). O2 → F3 decision에 흡수. O3(“GPU real-time” 문구) → `docs/gpu-realtime-wording`(README 헤드라인만; WEBGPU-MATCHER-SPEC Outcome은 이미 정직).

**Blockers: 0.** major 3(F1 race, F2 latent GPU guard, F3 decision), minor 4. 다음 라운드가 downstream을 소비하기 전 major 우선.
