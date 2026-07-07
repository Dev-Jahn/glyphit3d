<!-- jahns-workflow feedback: the body below is the reviewer reply VERBATIM (byte-exact copy via `jw review ingest`) — do not edit it; a triage skeleton is appended beneath it. -->
round: 2026-07-07-review-fixes
reviewer: gpt-5.5-pro
ingested: 2026-07-07
source: /tmp/review.md

---

## 검토 범위

현재 default branch 최신은 `a6c5f48aadfbb11f3b079bd5cd041f5897aa4b0f`로 보이며, 패킷의 Reviewed HEAD는 `09447b1733ed296992d572ab13cd2abb455ad520`입니다. `a6c5f48`는 `09447b1`을 watermark로 하는 review-fixes closeout commit이고, 패킷도 이 파일을 싣는 closeout commit은 registry/PROGRESS metadata라고 설명하므로, HEAD 불일치로 중단할 상황은 아닙니다.

아래는 문제 중심입니다.

---

## 확인된 findings

### F1R-1. `rematchSeq`는 stale commit만 막고, 실제 single-flight는 보장하지 않아 WebGPU matcher가 재진입될 수 있습니다

**심각도: High**

이번 F1 fix는 `rematch()`가 `mySeq = ++rematchSeq`를 잡고, `pipeline.run(...)`이 끝난 뒤 `mySeq !== rematchSeq`이면 `last`, canvas, `#ssim`, perf를 commit하지 않는 구조입니다. 즉 guard는 `pipeline.run` **이후의 commit**만 막습니다. `pipeline.run` 자체는 계속 동시에 실행될 수 있습니다.

실제 UI 호출부도 여전히 `void app().rematch()`를 직접 여러 곳에서 호출합니다. charset, cols, space 변경은 모두 직접 rematch를 fire-and-forget으로 호출하고, quality ladder도 동일합니다.

문제는 `Pipeline`이 하나의 `GpuMatcher` 인스턴스를 재사용한다는 점입니다. `Pipeline`은 `gpuReady: Promise<GpuMatcher | null>` 하나를 들고, Q3이면 그 matcher로 `runGpu(...)`를 호출합니다.   그런데 `GpuMatcher`는 `targetBuf`, `cstatBuf`, `outGlyphBuf`, `outFBBuf`, `stagingGlyph`, `stagingFB`, timestamp query staging, CPU scratch를 instance field로 공유합니다.  `match()`는 이 공유 buffer들에 write/dispatch/copy/map을 걸고, `onSubmittedWorkDone()` 및 `mapAsync()`에서 await합니다.

**실패 메커니즘**

1. 사용자가 Q3 상태에서 빠르게 space/cols/charset/quality를 조작하거나 테스트가 `app().rematch()`를 연속 호출합니다.
2. `rematchSeq` 때문에 오래된 run의 최종 commit은 drop될 수 있지만, 오래된 run의 `gpu.match()`는 이미 공유 GPU buffer/staging buffer를 사용해 실행 중입니다.
3. 최신 run도 같은 `GpuMatcher` instance에 들어와 같은 `stagingGlyph`, `stagingFB`, `queryStaging`, output buffer를 재사용합니다.
4. 첫 번째 run이 map 대기 중일 때 두 번째 run이 같은 buffer에 copy/map을 걸거나, 두 번째 run이 output/staging buffer를 overwrite합니다.
5. 결과는 WebGPU validation error, device-lost, fallback storm, 또는 latest run의 readback 오염입니다. seq guard는 `last` commit 시점만 보므로 이 공유-resource race를 막지 못합니다.

**개선 방향**

`rematchSeq`만으로는 “latest-wins”가 안전하지 않습니다. 둘 중 하나가 필요합니다.

* **UI/API 레벨 single-flight**: exported `window.__app.rematch`도 직접 `rematch()`가 아니라 기존 `requestRematch(false)` 계열 queue를 타게 만들고, 내부 실제 실행 함수를 `runRematchOnce`로 분리하십시오. 그러면 Q3 GPU matcher가 동시에 두 번 들어가지 않습니다.
* **GpuMatcher 레벨 serialization**: `GpuMatcher.match()` 내부에 `this.inFlight = this.inFlight.then(...)` 형태의 mutex를 두십시오.
* **또는 per-run GPU resources**: staging/output/query buffers를 match-local로 만들고 atlas buffers만 공유하십시오. 이 경우에도 `ensureCellBuffers()`의 destroy/reallocate가 in-flight buffer를 파괴하지 않도록 분리해야 합니다.

현재 패킷의 “latest-wins, not cancellation; superseded GPU run still completes then is discarded”는 shared WebGPU resource 구조에서는 충분한 안전 조건이 아닙니다.

---

### F2R-1. GPU device buffer key는 고쳤지만, CPU host scratch 재할당 조건이 아직 불완전합니다

**심각도: High, latent**

이번 F2 fix는 GPU cell buffer 재사용 key에 `P`를 넣었습니다. `needsCellBufferRealloc(prev, numCells, P)`도 `numCells` 또는 `P`가 바뀌면 true를 반환합니다.  실제 GPU buffers도 `numCells`와 `P` 기준으로 recreate합니다.

하지만 host scratch는 별도입니다. `targetHost`와 `cstatHost` 재할당이 `targetHost.length !== numCells * 3 * P` 하나에 묶여 있습니다. 즉 `targetHost` 길이가 우연히 같으면 `cstatHost`는 재할당되지 않습니다.  이후 code는 `cstatHost[cell * 16 + ...]`에 per-cell stats를 쓰고, 그대로 GPU `cstatBuf`에 업로드합니다.

**실패 메커니즘**

프로파일/격자 전환에서 `numCells * P`는 같지만 `numCells`는 증가할 수 있습니다. 예를 들어 이전 run이 `{ numCells: 4750, P: 200 }`, 다음 run이 `{ numCells: 5000, P: 190 }`이면 `targetHost.length = numCells * 3 * P`는 둘 다 같습니다. 그러면 `targetHost` 조건 때문에 `cstatHost`가 이전 길이 `4750 * 16`으로 남습니다. 그러나 새 run은 `5000 * 16` stats가 필요합니다.

그 결과:

* 마지막 250개 cell의 `cstatHost` write는 typed-array OOB로 무시됩니다.
* 새 GPU `cstatBuf`는 `5000 * 16` 크기로 만들어졌지만, `queue.writeBuffer(..., cstatHost)`는 짧은 host array만 업로드합니다.
* tail cell의 `ST`, `STT_c`, `min/max`, `eacScale`가 zero/stale 상태가 되어 gate/score가 틀어집니다.
* `P <= 256`이면 `assertPWithinScratch`도 통과하므로 CPU fallback으로 빠지지 않고 GPU path가 잘못된 결과를 낼 수 있습니다.

현재 unit test는 `needsCellBufferRealloc`라는 GPU buffer reuse decision만 검증합니다. host scratch의 `targetHost.length`/`cstatHost.length` 분리 재할당 조건은 테스트하지 않습니다.

**개선 방향**

아래처럼 host scratch를 별도 조건으로 재할당하십시오.

```ts
const targetLen = numCells * 3 * P;
const cstatLen = numCells * 16;

if (!this.targetHost || this.targetHost.length !== targetLen) {
  this.targetHost = new Float32Array(targetLen);
}
if (!this.cstatHost || this.cstatHost.length !== cstatLen) {
  this.cstatHost = new Float32Array(cstatLen);
}
```

그리고 `gpu-matcher-pguard.test.ts`에 pure helper를 추가해 `{ numCells: 4750, P: 200 } → { numCells: 5000, P: 190 }` 같은 `numCells*P` 동률 case를 고정하십시오.

---

## Open questions / decision points

### OQ1. F4 check는 개선됐지만, 아직 “frame-budget liveness”가 아니라 “완전 main-thread block은 아니다” 수준입니다

check 7은 이제 GPU match/worker SSIM window가 yield한다는 `liveWindow > 20`과, longest stall이 `250ms` 미만이라는 loose ceiling을 둡니다. 주석도 CPU raster가 main-thread synchronous pass라는 사실을 명시합니다.

이건 이전의 `maxGap < dur`보다 낫지만, 여전히 interactive frame-budget 보증은 아닙니다. `maxGap=180ms`, `liveWindow=30ms`인 run도 통과할 수 있습니다. 패킷도 `250ms` ceiling이 느슨하다고 인정합니다.

따라서 현재 check의 의미는 다음으로 제한해야 합니다.

> rematch 전체가 한 덩어리 main-thread compute는 아니다. 그러나 frame-smoothness는 아직 보증하지 않는다.

`perf/gpu-rasterizer` 전에는 blocker로 보지 않지만, README/Status/bench copy가 “interactive smooth”를 말하려면 별도 long-task budget이 필요합니다.

---

### OQ2. F3 Contract B는 코드상 일관되지만, 외부 profile generator에는 강한 계약입니다

ADR-0001은 stored scalar stats를 objective truth로 확정하고, hash가 full canonical payload를 덮도록 결정했습니다.  구현도 verifier/exporter가 같은 `computeProfileHash()`/`buildCanonicalPayload()`를 공유하므로 produce/verify byte-layout drift 위험은 낮습니다.

다만 이것은 “profile JSON은 단순 schema가 아니라 canonical binary payload contract까지 맞춰야 한다”는 뜻입니다. 향후 “내 TTF로 profile 생성”을 외부/브라우저 도구로 열 때는 `buildCanonicalPayload`를 공유 library로 노출하거나, profile version bump 없이 독립 구현을 허용하지 않는 쪽이 안전합니다.

---

## 닫힌 것으로 보이는 항목

* **F3 canonical hash**: 기존 coverage-only hash 문제는 구조적으로 닫힌 것으로 보입니다. `profileHash`는 이제 version/font/cell geometry/ascent/glyph ch/cp/coverage/scalars를 포함하고, scalar tamper test도 추가됐습니다.
* **F5 stale Kahan comment**: `wgsl-mirror.ts`의 설명은 실제 8-way blocked raw cross 후 `saT − Sa1·mean`을 형성한다고 정정되어 있습니다.
* **O1 parity fixtures**: synthetic high-DC, washout/checker, full/braille G sweep, alternate poses가 parity harness에 추가됐습니다. 단, 이는 `P=190` bundled profiles 범위입니다.
* **O3 wording**: README는 WebGPU Q3 matcher만 shipped이고 full GPU raster/end-to-end GPU real-time은 follow-up이라고 좁혀 썼습니다.

---

## Residual risks

* 이 검토는 GitHub Connector의 current files/commit metadata inspection 기반입니다. 로컬 fresh clone에서 `git rev-parse HEAD`, `npm run test`, `npm run parity`, `npm run e2e`를 직접 실행하지는 못했습니다.
* 패킷은 `npm run test`, `npm run parity`, `npm run e2e`, `npm run build` green을 주장하지만, 위 findings는 그 gate들이 포착하지 않는 동시성/latent profile-shape 경로입니다.
* 특히 F1R-1은 “빠른 연속 Q3 rematch” e2e가 없으면 재현성이 환경 의존적일 수 있습니다. 하지만 shared WebGPU buffers를 instance field로 두고 `match()`를 async 재진입 가능하게 둔 구조 자체는 코드상 확인됩니다.


---

## Findings (triage skeleton — verify each before registering)

Triaged 2026-07-07 by opus (main) via 2 clean adversarial verifiers (F1R-1, F2R-1), each reading
only the cited files (confirm + refute). OQ1/OQ2 triaged directly. **Blockers: 0.**

| # | 심각도 | Verdict | 근거 | Task |
|---|---|---|---|---|
| F1R-1 shared-GPU-buffer 재진입 | major | **REAL** | 공유 `GpuMatcher` 1인스턴스(`pipeline.ts:60`), `match()`가 mutex 없이 재진입 가능 — 공유 staging buffer의 **host map-state**에서 경합(`gpu-matcher.ts:311-325`의 mapAsync/getMappedRange). device-queue write/copy는 FIFO라 안전. controls/ladder의 bare `void app().rematch()`(`controls.ts:25/35/46`, `ladder.ts:39`)가 직렬화된 requestRematch 우회. seq 가드는 commit만 막음(`main.ts:75`, await 이후). 실패: mapAsync-reject→CPU fallback(복구·noisy) 또는 submit-into-mapped→async ValidationError→copy 드롭→최신 run wrong-frame. **pre-existing**(F1이 완결 못 함). 리뷰어 과장: device-lost/fallback storm/CPU scratch 오염은 미발생 | `fix/rematch-single-flight-gpu-race` |
| F2R-1 host scratch 재할당 | major (latent) | **REAL** | `gpu-matcher.ts:213-216`가 `targetHost.length !== numCells*3*P` **단일 조건**으로 targetHost·cstatHost 동시 재할당; cstatHost(`numCells*16`) 독립 체크 없음. `{4750,200}→{5000,190}`이면 곱 2,850,000 동률→미재할당→cstatHost가 76000 stale(필요 80000). tail 250셀 write OOB(JS silent)→writeBuffer가 짧은 배열만 업로드→tail stats 0→P=190라 `assertPWithinScratch` 통과→fallback 없이 silent 오출력. numCells 증가 방향만 silent(감소는 throw→fallback). 단위테스트는 host-scratch 조건 미커버 | `fix/gpu-matcher-cstat-host-realloc` |
| OQ1 F4 frame-budget | — | ACK | check-7은 개선됐으나 여전히 frame-budget 보증 아님(maxGap=180·liveWindow=30도 통과). 리뷰어도 "perf/gpu-rasterizer 전엔 blocker 아님". 근본은 이미 `perf/gpu-rasterizer` + F4 check의 TODO. 새 태스크 대신 gpu-rasterizer 노트에 "raster GPU 이전 시 check-7을 real frame-budget으로 조이고 'interactive smooth' 문구 검증" 추가 | (note on perf/gpu-rasterizer) |
| OQ2 external profile 계약 | minor | ACK/forward | Contract B가 외부 profile generator에 강한 계약. 지금 코드는 일관(verify/exporter가 buildCanonicalPayload 공유). 브라우저 TTF 도구 착수 시 대비 | `docs/profile-payload-external-contract` |

**닫힘 확인(리뷰어)**: F3 canonical hash(coverage+scalars+meta+tamper test), F5 Kahan 주석, O1 parity fixture(P=190 범위), O3 README 문구 — 전부 구조적으로 해소.

**Blockers 0.** major 2(F1R-1, F2R-1 — 둘 다 done 태스크의 완결분), minor 1 + OQ1 note. 규약상 blocker만 다음 라운드를 막으므로 진행은 자유지만 major 우선 권장.
