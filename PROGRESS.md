# PROGRESS — glyphit3d

작업 로그. 상태의 단일 소재는 [`tasks.yaml`](tasks.yaml)(읽기·수정은 `jw task` CLI),
계획 뷰는 생성물 [`ROADMAP.md`](ROADMAP.md)이다. 라운드는 `/jahns-workflow:round`로 닫는다.

하네스 채택(2026-07-07) 이전의 이력 — M0~M3, Round P — 은 소급 기록하지 않는다:
git 히스토리와 `docs/M0~M3-SPEC·RESULTS.md`, `docs/ROUND-P-SPEC.md`가 그 소재다.

## 2026-07-07-adopt-harness

- **Goal**: jahns-workflow 하네스 도입(비파괴 retrofit) — SSOT=DESIGN.md, tasks 레지스트리, packet 리뷰.
- **Shipped**: chore/adopt-jahns-workflow — 하네스 파일·디렉토리·생성 뷰 구축 (done)
- **Gates**: jw validate tasks.yaml 통과
- **SSOT**: 불변 (ADR-0000 비준 — 프로세스 도입, DESIGN 내용 변화 없음)
- **Decisions pending**: decision/public-repo-toggle — private→public 전환은 사용자 지시 대기
- **Review**: none (도입 라운드)
- **Next**: Round A(ASCII-identity 미학 재정의 + 지표 재설계) 착수. tasks.yaml/ROADMAP 참조.
