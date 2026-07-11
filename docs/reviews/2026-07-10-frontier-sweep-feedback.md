<!-- jahns-workflow feedback: the body below is the reviewer reply VERBATIM (byte-exact copy via `jw review ingest`) — do not edit it; a triage skeleton is appended beneath it. -->
round: 2026-07-10-frontier-sweep
reviewer: gpt-5.5-pro
ingested: 2026-07-11
source: /tmp/review.md

---

## 검토 판정

패킷의 Reviewed HEAD는 `721e241c91a552ba57895bd584af0f72c6780f16`, base는 `09447b1733ed296992d572ab13cd2abb455ad520`입니다. 현재 `main`의 `f168a274fe81e89acfc9657a9fecfd11aa0ebf62`는 이 HEAD 위에 리뷰 요청 파일만 추가한 1커밋이므로 검토 대상은 일치합니다.

확인된 **Critical은 없고, Major 6건**입니다. 직전 재리뷰의 `F1R-1` coalescer 직렬화와 `F2R-1`의 `targetHost`/`cstatHost` 독립 재할당은 소스 구조상 닫힌 것으로 보입니다. coalescer는 한 번에 하나의 run만 실행하고, prep scratch도 두 배열을 각각의 필요 길이로 검사합니다.

---

## 확인된 findings

### F1. `bake --identity`가 실제 shading AOV를 shape-color coupling에 연결하지 않습니다

**심각도: Major**

`applyIdentity()`는 `opts.coupling = {}`를 설정해 coupling을 활성화합니다.  그러나 `bakeCmd()`는 `aov.shadingLuma`를 오직 `--split > 0`일 때만 읽으며, `opts.aov` 역시 `split/antibleed/styleAlbedo/orient` 중 하나가 켜져 있을 때만 연결합니다. `--identity` 또는 `opts.coupling`은 이 조건에 포함되지 않습니다.

따라서 일반적인 다음 명령은:

```bash
npx tsx src/cli.ts bake <model-or-aov-dir> --identity
```

3D renderer가 제공한 `shading.png`를 사용하지 않고, `matchGrid()`의 2D fallback인 `ℓ = Ȳ`를 사용합니다. `matchGrid()`는 `opts.aov?.shadingLuma`가 없으면 명시적으로 그 fallback을 택합니다.

이는 ADR의 계약과 다릅니다. ADR-0003은 bake 경로에서 `ℓ`이 셀 평균 `shadingLuma`이고, AOV가 없을 때만 `Ȳ` fallback이라고 정의합니다. identity 평가 하네스 역시 AOV 장면에서 `shadingLuma`를 직접 주입해 그 경로를 검증합니다.

**실패 메커니즘**

* 실제 CLI `--identity` 출력과 identity-report의 AOV contestant가 서로 다른 coupling 입력을 사용합니다.
* 무관한 `--split`을 함께 켰을 때만 우연히 true-illumination 경로가 활성화됩니다.
* 따라서 AOV 결과를 근거로 shipping `bake --identity` 경로가 검증됐다고 할 수 없습니다.

**개선 방향**

```ts
const needShadingLuma = eta > 0 || opts.coupling !== undefined;
if (needShadingLuma) {
  aov.shadingLuma = await shadingLumaOf(req('shading.png'), space);
}

if (
  eta > 0 || kappa > 0 || styleAlbedo || orientKappa > 0 ||
  opts.coupling !== undefined
) {
  opts.aov = aov;
}
```

기존 AOV directory에 `shading.png`가 없을 때 fallback을 허용할 것인지도 명시해야 합니다. 3D bake에서 true-illumination을 계약으로 삼는다면 조용한 fallback보다 hard error가 안전합니다.

---

### F2. `palette + contrastFloor` 조합을 허용하면서 floor를 조용히 무시합니다

**심각도: Major**

`MatchOptions`는 `contrastFloor`와 `palette`를 독립적인 공개 옵션으로 노출합니다. palette의 비호환 목록에는 families, contour, split, collapse 등이 있지만 `contrastFloor`는 없습니다.

`matchGrid()`의 palette guard도 `contrastFloor`를 거부하지 않습니다.  그러나 palette winner는 palette 색을 emit한 뒤 즉시 `continue`하므로, 뒤쪽의 `contrastFloorFit()` 블록에 절대로 도달하지 않습니다.

따라서 다음은 오류 없이 실행되지만 floor가 완전히 무시됩니다.

```ts
matchGrid(img, atlas, {
  ...defaultOptions(3),
  palette: 'theme16',
  contrastFloor: 0.1,
});
```

**실패 메커니즘**

호출자는 “palette 제약과 표시 대비 하한을 모두 만족하는 출력”을 요청하지만 실제 결과는 palette-only입니다. 특히 floor는 legibility constraint이므로 조용한 무시는 단순 품질 차이가 아니라 옵션 계약 위반입니다.

**개선 방향**

둘 중 하나를 택해야 합니다.

1. 구현 전까지 명시적으로 거부:

```ts
if (pal && contrastFloor > 0) {
  throw new Error('palette mode is incompatible with contrastFloor');
}
```

2. discrete palette floor 구현:

   * palette pair의 **표시-space luma separation**을 계산
   * floor 미만 pair를 후보에서 제외하거나 제약 위반으로 처리
   * 유효 pair가 없으면 palette 내 flat representation과 비교
   * `theme16`에서는 전체 `16×16` argmin으로 정확히 해결 가능
   * `palette256`에서는 refine candidate 집합에 floor 제약 적용

패킷의 domain lens가 명시적으로 `palette×floor` 조합을 요청했으므로, 이 조합은 unsupported라면 반드시 loud failure여야 합니다.

---

### F3. 연속 model drop은 latest-wins가 아니며 오래된 모델이 최종 상태를 덮어쓸 수 있습니다

**심각도: Major**

모든 **rematch**는 coalescer를 통하지만, model loading과 `scene.setModel()`은 그 밖에서 비동기로 수행됩니다. drop handler는 즉시 `scene.loadGLB(url)`을 시작하고 완료 후에만 coalescer에 rematch를 요청합니다.

`Scene.loadGLB()`는 load가 끝난 즉시 `this.setModel(gltf.scene)`을 호출합니다. generation 확인이나 cancellation은 없습니다.

**실패 메커니즘**

1. 사용자가 A 모델을 drop합니다.
2. 곧바로 B 모델을 drop합니다.
3. B가 먼저 로드되어 화면에 반영됩니다.
4. 뒤늦게 A load가 완료되면 `setModel(A)`를 호출합니다.
5. coalescer는 두 rematch를 직렬화하지만 최종 모델은 오래된 A가 됩니다.

즉 F1 계열의 stale-state 문제가 GPU run에서는 해결됐지만, async model mutation 경계에는 그대로 남아 있습니다.

**개선 방향**

`loadGLB()`를 “load와 commit”으로 분리하십시오.

```ts
let modelLoadSeq = 0;

async function loadDroppedModel(url: string): Promise<void> {
  const mySeq = ++modelLoadSeq;
  const model = await scene.parseGLB(url); // 아직 setModel하지 않음

  if (mySeq !== modelLoadSeq) return;
  scene.setModel(model);

  forceKeyframe = true;
  await coalescer.request(false);
}
```

가능하면 `AbortController` 또는 GLTF loader request cancellation도 추가하고, `URL.revokeObjectURL()`을 완료·폐기 양쪽에서 처리해야 합니다.

---

### F4. `identity-report`의 no-flag 평가 집합이 로컬 파일 존재 여부에 따라 바뀝니다

**심각도: Major — 측정 재현성**

보고서는 “6개 bench 이미지 + 2개 AOV bake”를 평가 대상으로 설명하지만, `buildAovCtx()`는 `shaded.png`나 `coverage.png`가 없으면 `null`을 반환하고, `buildCtxs()`는 해당 장면을 그냥 생략합니다.

그 후 guardrail의 SSIM/CAS 평균과 `ctxs.every(...)` per-image 판정은 이 동적으로 구성된 `ctxs`를 그대로 사용합니다. 즉 AOV가 있으면 8장면, 없으면 6장면으로 같은 contestant의 평균과 PASS/FAIL 조건이 달라집니다.

실행기는 누락을 note로 쓰고 계속 진행하며, 헤더에도 “현재 존재하는 AOV 개수”를 기록합니다.  동시에 `bench/aov/`와 결과물 `bench/out/`은 모두 gitignore 대상입니다.

**실패 메커니즘**

* 구현자 머신: 6 + 2 AOV, 보고된 ADR 수치와 guardrail verdict 생성
* clean checkout: AOV 없음, 같은 `npx tsx bench/identity-report.ts`가 6장면 verdict 생성
* packet에서 참조하는 `bench/out/identity-report.md`도 저장소에 없어 정확히 어떤 입력으로 수치가 생성됐는지 감사할 수 없음

특히 AOV 두 장면은 shape-color coupling의 true-illumination 경로를 검증하는 유일한 표본이므로, 이를 조용히 생략하는 것은 단순 표본 축소가 아닙니다.

**개선 방향**

평가 suite를 고정하십시오.

```text
--suite bench6
--suite bench6-aov2
```

`bench6-aov2`는 필수 파일 하나라도 없으면 exit 2로 실패해야 합니다. 결과에는 최소한 다음 manifest를 남겨야 합니다.

```json
{
  "suite": "bench6-aov2-v1",
  "scenes": [...],
  "inputSha256": {...},
  "aovGeneratorCommit": "...",
  "rendererInfo": "...",
  "atlasProfileHash": "..."
}
```

최종 수용 verdict는 특정 suite ID에만 연결해야 하며, “존재하는 장면만 평균”내면 안 됩니다.

---

### F5. blind A/B answer key는 봉인되지 않았습니다

**심각도: Major — 측정 무결성**

`scripts/identity-ab.ts`는 key를 “SEALED”라고 부르지만, 실제로는 전체 left/right mapping을 JSON으로 만든 뒤 **base64로 인코딩**하여 `key.json`에 저장합니다. 파일 안에는 base64 decode 방법까지 적혀 있습니다.

또한 L/R 순서는 공개된 deterministic PRNG와 공개 default seed `3735928559`로 만들어집니다. key 파일을 보지 않더라도 같은 소스를 실행하면 mapping을 재현할 수 있습니다.

ADR은 이를 “평문이 아닌 sha256 commitment로 봉인됐고 판정 후 디코드 가능”하다고 기술합니다.  그러나:

* SHA-256 commitment는 **사후 mapping 변경 방지**만 제공합니다.
* base64는 암호화나 봉인이 아닙니다.
* judge가 접근 가능한 같은 디렉터리에 mapping이 있으므로 blinding은 기술적으로 보장되지 않습니다.

**실패 메커니즘**

판정 전에 `key.json`을 열거나 seed로 mapping을 재생성하면 어느 쪽이 feature인지 알 수 있습니다. 이후 forced-choice 결과는 blind evidence가 아닙니다.

**개선 방향**

판정자와 key custodian을 분리해야 합니다.

* generator는 pair 이미지와 commitment만 judge-visible 디렉터리에 저장
* mapping은 외부 공개키로 암호화하거나 독립 custodian이 보관
* seed는 CSPRNG로 생성하고 판정 전 공개하지 않음
* `ab-verdicts.json`의 hash가 먼저 커밋된 후 mapping 공개
* 단독 로컬 workflow라면 최소한 key 파일을 별도 위치로 이동하고 OS-level access separation 적용

현재 방식은 “commitment가 있는 obfuscated A/B”이지 sealed blind A/B가 아닙니다.

---

### F6. CAS의 “SSIM보다 5.3–5.9× 높은 해상도” 주장은 척도 단위의 비율일 뿐입니다

**심각도: Major — 핵심 과학 주장**

`structure-report.ts`는 다음과 같이 계산합니다.

```ts
ratio = CAS_mean_margin / SSIM_mean_margin
```

즉 ours-Q3 − chafa의 CAS raw delta를 SSIM raw delta로 나눈 값을 그대로 `× vs SSIM`으로 출력합니다.  ADR도 `+0.0191 / +0.0036 = 5.3×`, `+0.0211 / +0.0036 = 5.9×`를 “5–6× 크게 해상”한다고 해석합니다.

이 비율은 통계적 해상도나 discriminability를 측정하지 않습니다. CAS와 SSIM은 다른 비선형 척도입니다. CAS의 범위는 `[-1,1]`입니다.  예를 들어 자연스러운 affine 표기인:

```text
CAS' = (CAS + 1) / 2
```

로 바꾸면 순위, 정보량, 유의성, 판별력은 전혀 변하지 않지만 모든 CAS delta가 절반이 되어 “5.3×”가 즉시 “2.65×”가 됩니다. 따라서 현재 배수는 지표의 단위 선택에 종속된 숫자입니다.

**영향**

CAS 자체의 셀 단위 DC 제거 설계가 틀렸다는 뜻은 아닙니다. 잘못된 것은 이를 “SSIM보다 몇 배 더 해상한다”는 정량 증명으로 사용하는 부분입니다. 패킷은 이후 모든 품질 주장이 CAS 위에 선다고 명시하므로, 이 과장은 load-bearing합니다.

**개선 방향**

배수 표현을 제거하고 다음 중 하나로 평가해야 합니다.

* scene bootstrap을 통한 effect-size confidence interval
* 반복 render/test-retest로 metric noise floor 산정
* standardized effect size: `Δ / σ`
* known-quality ordering 또는 human pairwise label에 대한 판별 정확도/AUC
* Q ladder pair의 sign consistency와 rank correlation
* metric perturbation sensitivity: 작은 구조 결함을 주입한 controlled sweep

현재 근거로 가능한 정직한 표현은 다음 정도입니다.

> “이 6장면 suite에서 CAS raw margin은 SSIM raw margin보다 수치상 크게 나타났다.”

“5.3–5.9× resolution”은 철회하는 편이 맞습니다.

---

## Open domain questions / decision points

### O1. readability proxy의 “가시성” 정의가 contrast floor의 가시성 계약과 다릅니다

readability는 `max(|ΔR|, |ΔG|, |ΔB|) ≥ 24`를 사용합니다.  반면 contrast floor는 표시 sRGB 공간의 Rec.709 luma separation을 legibility 축으로 사용합니다.

프로젝트 자체의 transfer/luma 식으로 계산하면 검정 배경에서:

```text
fg = [24,24,24]  → 표시 luma 차이 ≈ 24 u8
fg = [0,24,0]    → ≈ 19.0 u8
fg = [24,0,0]    → ≈ 6.4 u8
fg = [0,0,24]    → ≈ 2.2 u8
```

네 경우 모두 현재 readability proxy에서는 동일하게 “readable”입니다. coupling이 색상과 채도를 직접 변조하므로 이 hue dependency는 headline `0.067 → 0.810`에 영향을 줄 수 있습니다.

결정이 필요합니다.

* ASCII glyph legibility를 lightness mark로 정의한다면 floor와 같은 display-luma threshold를 써야 합니다.
* chromatic contrast도 identity로 인정한다면 별도 color-difference 모델과 calibration이 필요합니다.
* 현 max-channel proxy를 유지한다면 “readability”보다 “not-max-channel-collapsible rate”처럼 좁게 명명해야 합니다.

---

### O2. production SSIM badge가 실제 GPU 표시 raster가 아니라 CPU canonical 재래스터를 채점합니다

GPU path는 `GpuRaster.render()`의 `rr.data`를 화면에 표시합니다. 그러나 non-interactive SSIM은 worker가 같은 `GridCell[]`를 받아 CPU `rasterizeGrid()`로 다시 만든 raster를 채점합니다.

이는 canonical grid 품질을 재는 계약으로는 타당하지만, GPU shader/device-specific 표시 회귀는 badge에 반영되지 않습니다. 현재 별도 parity gate가 그 위험을 맡지만, production badge의 의미를 명확히 해야 합니다.

* “grid reconstruction SSIM”이면 현재 방식 유지 후 UI에 그렇게 표기
* “displayed output SSIM”이면 실제 `rr.data`를 linear reference와 비교
* 또는 낮은 빈도로 actual-GPU-raster sampling 검증 추가

---

## Residual risks

* 이번 검토는 GitHub Connector로 Reviewed HEAD의 실제 파일과 diff를 확인한 정적 검토입니다. 이 환경에서는 private repository를 fresh local clone하여 `npm run test`, `npm run parity`, `npm run e2e`, `npm run temporal`을 직접 재실행하지 못했습니다.
* `bench/aov/`와 `bench/out/identity-report.md`가 저장소에 없으므로, 패킷의 exact AOV 수치와 identity guardrail 표를 독립 재현하지 못했습니다.
* GPU가 필요한 worker-prep wall, shader parity, compacted ranged upload, temporal f32 boundary는 직접 실행 검증하지 못했습니다.
* temporal engine이 production pipeline에 연결되지 않은 상태는 코드와 패킷 모두 명시하고 있습니다. 현재 `setTemporal()`은 router state만 설정하며 pipeline은 항상 `temporal: 'full'`을 반환합니다. 이는 숨겨진 결함은 아니지만, 현 시점의 temporal 성능 수치는 shipping interactive path의 성능으로 해석하면 안 됩니다.


---

## Findings (triage skeleton — verify each before registering)

_No `JW-GPT-NNN` finding blocks parsed — triage the verbatim reply directly._

### Triage (2026-07-11, 5개 독립 검증 에이전트 코드 대조 후 판정)

| finding | verdict | evidence (핵심) | task |
|---|---|---|---|
| F1 bake --identity AOV 미배선 | **REAL** (major) | `src/cli.ts:115` shadingLuma 로드가 `eta>0`에만, `:131` opts.aov 부착 조건에 coupling 부재 → `src/core/match.ts:129-134`가 ℓ=Ȳ fallback. ADR-0003 §2 ℓ 계약("bake 경로는 셀 평균 shadingLuma") 위반. 하네스(`bench/identity-report.ts:167`)와 유일한 AOV 테스트(V4)는 shadingLuma 직접 주입이라 CLI 배선 무검증 | `fix/bake-identity-aov-wiring` |
| F2 palette×floor silent 무시 | **REAL** (major) | `src/core/match.ts:151-158` 가드에 contrastFloor 부재(형제 collapse는 거부됨), palette winner `:617`/`:439` continue가 floor 블록(`:761`) 도달 차단. CLI에선 조합 불가(`--floor`는 `--identity` 필수 → quality 2 vs palette quality 3) — 라이브러리 API 한정이나 공개 표면 계약 위반. 수정은 명시 throw(코드 자체 주석 `:147-148`의 의도와 일치) | `fix/palette-floor-guard` |
| F3 model drop latest-wins 아님 | **REAL** (major) | `web/src/scene.ts:76-79` loadGLB가 load 즉시 무조건 setModel(세대 가드 없음), drop 핸들러(`web/src/main.ts:188`)는 load를 coalescer 밖에서 실행. 기존 rematchSeq는 render-commit만 보호. revokeObjectURL 미처리 누수 부수 확인. 기존 등록 task와 중복 아님 | `fix/model-drop-latest-wins` |
| F4 identity-report suite 동적 | **PARTIALLY-REAL → 기존 task 병합** | 기계적 주장 전부 TRUE(`bench/identity-report.ts:123` null, `:153-154` 무경고 skip, `:241-247` 동적 ctxs 풀링; `.gitignore:2,6,7,8`). 근본 원인(풀링 미고정)은 `chore/identity-prediction-instruments`에 기등록 → severity minor→**major** 승격 + suite 고정/manifest/감사 각도 notes 병합. 부수 발견: header aovPresent가 shaded.png만 검사(평가는 coverage.png도 요구) | `chore/identity-prediction-instruments` (병합) |
| F5 A/B key 봉인 아님 | **REAL** (major) | `scripts/identity-ab.ts:122-129` key.json은 base64 인코딩+파일 내 디코드 안내, `:85` 공개 default seed 3735928559(0xDEADBEEF)+`:40-48` 공개 mulberry32 → key 없이도 mapping 재현 가능. commitment는 사후 변조 방지만. ADR-0003:118-121 "봉인" 표현 과장. 기존 실행분은 blind-by-honor(검증 불가) — verdict-before-reveal 커밋으로 부분 구제 가능하나 "sealed blind"로 인용 불가 | `fix/identity-ab-blinding-protocol` |
| F6 CAS 5.3–5.9× 해상 주장 | **REAL** (major) | `bench/structure-report.ts:192-196` raw-delta 비율을 "× vs SSIM"으로 출력; ADR-0002:156,159-160이 "5–6× 크게 해상"으로 해석. affine 재표기 CAS'=(CAS+1)/2는 순위·정보량 불변인데 배수를 절반으로 — 배수는 척도 선택 종속, 수학 논증 airtight. 추가 confound: SSIM 마진은 full-frame mean, CAS 마진은 object-masked percentile(모집단도 다름). 철회 대상: ADR-0002 표·prose, PROGRESS.md:14, structure-report 생성기·산출물. DESIGN §10은 정성 표현만이라 무사. 정성적 SSIM-포화 주장은 독립 근거(Q-ladder spread)로 성립 유지 | `fix/cas-multiplier-claim` |
| O1 readability 가시성 정의 불일치 | **REAL → decision** | `bench/identity-proxies.ts:32-47` max-channel sRGB-u8 무가중 ≥24 vs `src/core/fit.ts:34,110-112` Rec.709 luma 가중. 리뷰어 4개 예시 수치 독립 재유도로 전부 재현(24.0/19.04/6.40/2.17) — 사실 확정. 세 옵션 중 ruling 필요 | `decision/readability-proxy-luma` |
| O2 SSIM badge 채점 대상 | **확인 → decision** | `web/src/pipeline.ts:224,246` 표시= GPU rr.data, `:230-241`+`web/src/worker.ts:115-123` badge= CPU rasterizeGrid 재래스터. GPU 픽셀 검사는 오프라인 parity 하네스(`parity-page.ts:99-134`)뿐 | `decision/ssim-badge-semantics` |

**요약**: Critical 0 · Major 6 전원 REAL(1건은 기존 task 병합) · decision 2 등록 · REJECTED 0.
