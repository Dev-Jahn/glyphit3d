# PROGRESS — glyphit3d

작업 로그. 상태의 단일 소재는 [`tasks.yaml`](tasks.yaml)(읽기·수정은 `jw task` CLI),
계획 뷰는 생성물 [`ROADMAP.md`](ROADMAP.md)이다. 라운드는 `/jahns-workflow:round`로 닫는다.

하네스 채택(2026-07-07) 이전의 이력 — M0~M3, Round P — 은 소급 기록하지 않는다:
git 히스토리와 `docs/M0~M3-SPEC·RESULTS.md`, `docs/ROUND-P-SPEC.md`가 그 소재다.

## 2026-07-10-frontier-sweep

- **Goal**: 사용자 지시 "남은 작업 전부 병렬로 완료까지" — registry 잔여 태스크 전면 소진. wave-1 6 lanes(격리 worktree ∥ opus 구현 → clean 적대 리뷰(fable=수학/코어) → 수정) + wave-2 chains(GPU 래스터→temporal ∥ 미학 피벗) → main 직렬 통합(작업 단위 커밋, 매 통합 전 게이트 green). 15 commits (9a20027..f8d033d).
- **Shipped** (18 done):
  - fix/rematch-single-flight-gpu-race — 모든 rematch 진입점을 coalescer 단일 큐로(F1R-1); fix/gpu-matcher-cstat-host-realloc — cstatHost 독립 재할당+충돌쌍 회귀(F2R-1)
  - docs/metric-redesign — CAS 셀-AC 구조 headline(ADR-0002, DESIGN §10): SSIM이 천장 포화로 압축하는 ours−chafa 구조 마진을 CAS가 해상(척도 불변 효과크기 d = 이미지별 마진 mean/std: wmean 3.29 vs SSIM 1.14; 종전 cross-metric 배수 표현은 척도 의존이라 fix/cas-multiplier-claim에서 철회), 물체 마스크 극성 blocker 리뷰 발견→수정
  - feat/palette-constrained-color — theme16 전수 정확해 + palette-256 project-then-refine(리뷰 major 2 수정)
  - feat/contrast-floor-fill — 제약 refit(gamut-constrained DC re-solve) + GPU per-cell post-pass(CPU와 cell 동일 증명); 데모 642→0 invisible cells, 재구성 비용 −0.0033 정직 공표
  - perf/gpu-rasterizer — 래스터→WebGPU + prep→worker(스펙 프로브가 OQ1 전제 반증: main-thread 블록 2개); maxGap 93→11-20ms, 드래그 4.5→12.9-14.3 updates/s; raster parity 13/13
  - feat/temporal-animation — delta frames+hysteresis 엔진: 불변식 byte-identity 122/122, hysteresis 위반 0, speedup 1.31×, npm run temporal EXIT 0. H-T 가설은 UNTESTED(계측 부재 정직 기록)
  - feat/ascii-identity-selection + feat/shape-color-coupling — ASCII-identity opt-in preset(ADR-0003): readability 0.067→0.810, full-block 0.920→0.177; **사전등록 재구성 가드레일 blocks에서 파괴(SSIM 0.079<0.758) — 정직 공표, spike/identity-guardrail-retune 등록**; 기본값 OFF byte-identity 이중 증명
  - fix/rematch-promise-completion · fix/torn-runparams-snapshot · fix/contrast-floor-linear-space · fix/palette-q0-guard · chore/vitest-worktree-exclude · chore/compose-hero-canvas-types(tsc 완전 clean) · docs/profile-payload-external-contract · docs/contrast-floor-design-amendment(ADR-0003, DESIGN §3.4/§6)
  - decision/public-repo-toggle — 룰링: public 전환+Pages (클로즈 직후 실행)
- **Gates**: vitest 330/330 · parity 28/28+raster 13/13 · e2e 9/9(check-7 강화: maxGap<50, matcher='gpu' 단언) · npm run temporal EXIT 0(전 계약 MET) · tsc 0 errors · chafa-gate 0.9835/0.9812 PASS 불변 · build OK. 근거: 커밋 메시지 + docs/TEMPORAL-RESULTS.md + bench/out/identity-report.md(재현: npx tsx bench/identity-report.ts).
- **SSOT**: changed §10(CAS headline), §3.4(contrastFloor), §6(ASCII-identity); ADR-0002·ADR-0003 ratified.
- **Decisions pending**: none.
- **Review**: requested (docs/reviews/2026-07-10-frontier-sweep-request.md)
- **Next**: (2026-07-11 사용자 판정으로 방향 확정 — 블라인드 A/B 장치 폐기, ADR-0003 §3 참조) ① feat/identity-ascii-charset-coherence(charset 산만함 해소, ascii-first — 최우선) ② feat/color-dither-toggle ③ 리뷰 major 수정(bake-identity-aov-wiring, palette-floor-guard, model-drop-latest-wins, cas-multiplier-claim) ④ feat/temporal-interactive-wiring + churn-sweep-instrument.
- **특기(프로세스)**: 세션 리밋 3회 중단→resumeFromRunId 캐시 재개로 전량 복구; tmp 정리 사고로 스펙 3종 소실→wave-1 journal에서 바이트 동일 복원(에이전트들이 스펙 부재 시 작업 거부 — golden rule 준수 실증); 매 lane 리뷰가 blocker 1·major 9+ 발견(gate green ≠ correct 재확인).

## 2026-07-07-review-fixes

- **Goal**: gpu-reality 외부 리뷰(gpt-5.5-pro) 지적 7건 근본 수정. F3는 ADR-0001(Contract B) 룰링 반영.
- **Shipped** (workflow 병렬 구현 + 건별 clean 적대적 verify, 전부 PASS):
  - fix/rematch-single-flight (F1) — rematch() seq 가드로 최신 run만 commit(화면·export json/ans/png 오염 차단) (done)
  - fix/gpu-matcher-p-guard (F2) — ensureCellBuffers 캐시 키에 P + 3P≤768 상한(catchable→CPU pool fallback), 순수함수 단위테스트 10 (done)
  - fix/profile-hash-canonical (F3, ADR-0001) — profileHash를 전체 canonical payload(coverage+스칼라+폰트/셀 메타)로 확장, 스칼라 변조 거부 테스트, 번들 dejavu-16 프로파일 재생성 (done)
  - fix/e2e-liveness-frame-budget (F4) — check-7 정직화(raster=메인스레드 명시, liveWindow>20 + maxGap<250, perf/gpu-rasterizer TODO) (done)
  - docs/wgsl-mirror-kahan-comment (F5) — stale Kahan 주석 정정(수치 무영향) (done)
  - docs/gpu-realtime-wording (O3) — README 'GPU-real-time' 헤드라인 축소(WebGPU Q3 matcher shipped로) (done)
  - chore/parity-adversarial-fixtures (O1) — parity 14→28 config(high-DC/checker/grazing/steep + first-wins-on-tie property) (done)
- **Gates**: tsc 클린(기존 compose-hero.ts 2건 제외 — 라운드 무관); vitest 143/143; web build 클린; parity 28/28 (glyph 100.0%, ΔSSIM 0, colorΔ≤1); e2e 9/9 (NVIDIA RTX PRO 6000 Blackwell). 근거 `npm run parity`, `npm run e2e`.
- **SSOT**: ADR-0001로 §5.4 개정(스칼라 stats=objective truth, hash=full canonical payload).
- **Discovered (out-of-scope → chore 등록)**: compose-hero.ts 기존 tsc 실패(chore/compose-hero-canvas-types), braille 문자셋이 blocks와 동일 출력 = 사실상 no-op(chore/braille-charset-noop).
- **Decisions pending**: decision/public-repo-toggle (변동 없음).
- **Review**: requested (docs/reviews/2026-07-07-review-fixes-request.md) — 재리뷰(지적 해소 확인).
- **Next**: perf/gpu-rasterizer(메인스레드 raster를 GPU로), 또는 Round A(ASCII-identity 미학 + docs/metric-redesign).

## 2026-07-07-gpu-reality

- **Goal**: "이 머신엔 GPU 없음" 오진을 정정하고 render·match를 실 GPU로 내린다 (사용자 지적: RTX PRO 6000 Blackwell 8장 존재).
- **Shipped**:
  - chore/e2e-gpu-rendering — e2e Chromium을 SwiftShader→`--use-angle=vulkan` (render ~300→33ms), NVIDIA renderer 가드 추가 (done)
  - perf/webgpu-matcher — WebGPU Q3 컴퓨트 매처, CPU 닫힌 형태와 byte-exact parity (done)
- **Gates**: vitest 126 green; e2e 9/9 (GPU 경로 활성); parity 14/14 (glyph 100.0%, ΔSSIM 0); tsc 클린. 근거는 `npm run parity`, `npm run e2e`.
- **SSOT**: DESIGN 불변 (WebGPU 언급은 이미 정확 — ADR 불요). 오진은 역사적 스펙(M2-SPEC/ROUND-P-SPEC)에 날짜 정정 노트로 표기, README·WEBGPU-MATCHER-SPEC Outcome 갱신.
- **Decisions pending**: decision/public-repo-toggle (변동 없음 — 사용자 지시 대기).
- **Review**: requested (docs/reviews/2026-07-07-gpu-reality-request.md).
- **Next**: perf/gpu-rasterizer (GPU 경로 남은 병목 = 메인스레드 CPU raster ~96ms), 또는 Round A(ASCII-identity 미학 + 지표 재설계).

## 2026-07-07-adopt-harness

- **Goal**: jahns-workflow 하네스 도입(비파괴 retrofit) — SSOT=DESIGN.md, tasks 레지스트리, packet 리뷰.
- **Shipped**: chore/adopt-jahns-workflow — 하네스 파일·디렉토리·생성 뷰 구축 (done)
- **Gates**: jw validate tasks.yaml 통과
- **SSOT**: 불변 (ADR-0000 비준 — 프로세스 도입, DESIGN 내용 변화 없음)
- **Decisions pending**: decision/public-repo-toggle — private→public 전환은 사용자 지시 대기
- **Review**: none (도입 라운드)
- **Next**: Round A(ASCII-identity 미학 재정의 + 지표 재설계) 착수. tasks.yaml/ROADMAP 참조.
