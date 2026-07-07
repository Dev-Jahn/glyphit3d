# PROGRESS — glyphit3d

작업 로그. 상태의 단일 소재는 [`tasks.yaml`](tasks.yaml)(읽기·수정은 `jw task` CLI),
계획 뷰는 생성물 [`ROADMAP.md`](ROADMAP.md)이다. 라운드는 `/jahns-workflow:round`로 닫는다.

하네스 채택(2026-07-07) 이전의 이력 — M0~M3, Round P — 은 소급 기록하지 않는다:
git 히스토리와 `docs/M0~M3-SPEC·RESULTS.md`, `docs/ROUND-P-SPEC.md`가 그 소재다.

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
