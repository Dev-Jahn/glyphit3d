# Review Request — 2026-07-10-frontier-sweep

The reviewer has the repository via git. This is a domain/code review, not a workflow audit —
keep the jahns-workflow harness out of scope unless asked.

- Project / Branch: glyphit3d / main
- Reviewing: 721e241c91a552ba57895bd584af0f72c6780f16   (diff against 09447b1733ed296992d572ab13cd2abb455ad520)

## What changed and why

레지스트리의 잔여 태스크를 전면 소진한 대형 라운드 (15 feature/fix/docs commits + closeout).
네 갈래가 한 라운드에 들어왔다:

1. **정합성**: 직전 재리뷰의 major 2건 — rematch 전 진입점을 coalescer 단일 큐로 직렬화(F1R-1),
   gpu-matcher `cstatHost` 독립 재할당(F2R-1). 이후 coalescer promise 완료 의미론과 run-snapshot
   (pre-await 원자 스냅샷)로 심화.
2. **측정 체계 교체**: SSIM 포화 → CAS(셀 스케일 AC 구조) headline + 물체 마스크 + 하위 percentile
   분포 (ADR-0002, DESIGN §10). 이후 모든 품질 주장이 이 위에 선다.
3. **성능**: 인터랙티브 경로의 main-thread 블록 2개(prep ~90ms + raster ~90ms)를 각각 worker와
   WebGPU로 이전 — 스펙 단계의 실측 프로브가 "래스터만 옮기면 된다"는 기존 가정(OQ1)을 반증했기
   때문에 scope가 둘이 됐다. e2e check-7을 실제 프레임 예산(maxGap<50ms)으로 조임.
4. **미학 피벗 + temporal**: ASCII-identity opt-in 모드(구조 인지 선택 + 형태-색 coupling +
   contrast floor, ADR-0003)와 temporal 엔진(delta frames + hysteresis, 계약 검증). 두 갈래 모두
   **정직 공표가 핵심**: identity preset은 미학 지표를 크게 개선하지만 사전등록 재구성 가드레일을
   blocks에서 파괴(등록된 재조율 spike로 이관); temporal의 H-T 가설(안정성-비용 tradeoff)은 계측
   부재로 UNTESTED — MET로 포장하지 않았다.

## Read these first

1. `docs/adr/ADR-0002-cell-ac-structure-metric.md` — 새 측정 체계의 수학·마스크·anti-gaming 논증
2. `docs/adr/ADR-0003-ascii-identity-contrast-floor.md` — 미학 피벗의 목적 함수 분리 논증 + 가드레일 실패 공표
3. `web/src/webgpu/prep.ts` + `gpu-matcher.ts`(matchPrepped 분리) — byte-exact 이전 주장의 본체
4. `web/src/webgpu/gpu-temporal.ts` + `web/src/temporal-logic.ts` — temporal 계약과 oracle
5. `web/src/webgpu/contrast-floor-post.ts` + `src/core/fit.ts` contrastFloorFit — 제약 LS의 gamut 처리
6. `docs/TEMPORAL-RESULTS.md`, `bench/out/identity-report.md`(재현: `npx tsx bench/identity-report.ts`)

## Claims to attack

1. **동시성**: coalescer 경유가 유일한 rematch 진입 경로이며 공유 GpuMatcher에 동시 `match()`가
   도달할 수 있는 interleaving이 존재하지 않는다 (seq 가드는 이중 안전장치일 뿐).
2. **prep 이전의 byte-exactness**: worker 이전 + 융합 2D LUT(65,536 전수 테스트)가 CPU 원본과
   비트 동일하고, parity 28/28의 의미가 이전 후에도 그대로다.
3. **GPU 래스터 parity 기준의 건전성**: gamma |Δ|≤1 u8·mismatch≤1e-4(실측 0), linear 한도 2e-3
   (실측 2.88e-6)이 결함을 숨기지 않는다. 반례: 반올림 의미론(floor(x+0.5) vs half-even) 결함은
   이 게이트가 구조적으로 못 본다 — 소스 감사로만 방어됨.
4. **contrastFloor**: OFF가 전 경로 bit-identical(그리드 해시 증명), ON일 때 GPU post-pass가 CPU
   경로와 cell 단위 동일, 데모 기본(0.06)에서도 matcher='gpu' 유지.
5. **temporal 불변식**: ε=0/δ=0 출력이 same-frame 전체 rematch와 byte-identical (122/122, 중간
   charset/cols/space 전환 포함), 리셋 매트릭스가 ε/δ/floor 변화를 keyframe으로 강제.
6. **identity 기본값 무해성**: 기본값 OFF에서 golden hash + 독립 structure-report diff 이중 증명 —
   기존 모든 재구성 수치가 불변.
7. **가드레일 실패의 성격**: blocks에서의 SSIM 0.808→0.079는 배선 버그가 아니라 목적 함수 상충의
   구조적 결과다 (ascii에서 Q2+A가 PASS하는 비대칭이 방증). — 이 주장 자체를 공격해달라: 버그라면
   spike/identity-guardrail-retune의 방향이 달라진다.

## Evidence already produced (mine — inspect, don't trust)

| Claim | Command / artifact | My reading | Where it lives |
|---|---|---|---|
| 1,2 | `npm run parity` | 28/28 byte-exact + raster 13/13 | 커밋 2d96094 메시지 |
| 3 | `npm run e2e` | 9/9, check-7 maxGap 11–20ms, matcher='gpu' | 커밋 2d96094 |
| 4 | `npx vitest run test/contrast-floor.test.ts` + `npx tsx bench/floor-invisible.ts` | 동일성+disabled-proof, 642→0 | 커밋 3bdefbc·af8377d |
| 5 | `npm run temporal` | EXIT 0, 전 계약 MET, 1.31× | `docs/TEMPORAL-RESULTS.md` |
| 6,7 | `npx tsx bench/identity-report.ts`, `npx tsx bench/structure-report.ts` | 기본값 불변 / preset 가드레일 FAIL 공표 | 커밋 c3a962f·a981f1d, PROGRESS |

## Known weak spots

- **linear-space floor는 1차 근사** (scalar-slope rescale): dark/sparse 극단에서 표시 대비가 최대
  ~14% 미달 (등록: fix/contrast-floor-linear-exactness).
- **temporal 인터랙티브 배선 부재**: 엔진은 하네스 구동 전용, production 경로는 temporal:'full'.
  파이프라인 배선은 등록된 별도 기능 (feat/temporal-interactive-wiring).
- **hysteresis 경계**: GPU 결정(f32) vs oracle(f64) near-tie 창 — verdict flake 가능 (등록:
  fix/temporal-oracle-f32-boundary). 스펙 §4.1의 equality 경계는 하네스 정의(replace-at-tie)를
  따랐다 — measure-zero지만 스펙과 어긋난 선택.
- **compacted ranged-upload 경로**: 하네스 구조상 same-frame runFull이 선행해 마스킹됨 — 비마스킹
  프로브는 PASS했지만 게이트가 상시 강제하지 않음.
- **P7(worker prep wall)**: 직접 게이트 부재 — maxGap<50으로 간접 확인만.

## Domain lens

동시성/GPU 호스트 상태(이번 라운드 계보의 결함 클래스), 측정 무결성(사전등록 vs 실측, 가드레일
집계 정의), 제약 최소자승의 경계 케이스(gamut, isoluminant, palette×floor 조합). 표준 우선순위는
`docs/review-profile.md`.

## Out of scope

jahns-workflow 하네스 자체; 미학적 취향 판단(블라인드 A/B가 별도 판정 — sealed key 커밋먼트
ccfb2c125327515e30fd0a1e5923837cd4aa5dabed12b626e87969034804c265); Pages 배포 인프라.

## Response wanted

Major / critical issues only. For each: a concrete failure mechanism and where you confirmed it.
Separate confirmed findings, open domain questions, and residual risks from unavailable
GPU / data / environment.
