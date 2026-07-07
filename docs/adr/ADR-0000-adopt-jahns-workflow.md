# ADR-0000: jahns-workflow 하네스를 채택한다

- Status: accepted
- Date: 2026-07-07
- Round: 2026-07-07-adopt-harness
- SSOT sections affected: 없음 (프로세스 도입, DESIGN 내용 불변)
- Tasks: chore/adopt-jahns-workflow

## Context

프로젝트가 M0~M3 + Round P를 거치며 스펙/결과 문서(docs/M*-SPEC·RESULTS, ROUND-P-SPEC)와
에이전트 메모리에 상태가 흩어져 있었다. 작업 식별자도 `P0`, `Q1`, `Round P`처럼 프로젝트마다
충돌하고 시간이 지나면 의미가 흐려지는 letter-number 코드네임을 써 왔다. 여러 프로젝트를
동시에 다루는 워크플로에서 상태의 단일 소재(single home)와 전역적으로 모호하지 않은 작업
문법이 필요해졌다.

## Decision

jahns-workflow 규약을 **채택 시점부터** 적용한다(과거 문서·커밋·코드네임은 소급 재작성하지
않는다). DESIGN.md를 SSOT로 지정하고, 작업은 `<type>/<slug>` ID로 tasks.yaml에 등록하며,
`jw task` CLI로만 읽고 쓴다. 라운드 리뷰는 packet 모드(라운드 종료→push→review-request.md를
외부 웹 리뷰어에게 전달). 규약 전문은 docs/CONVENTIONS.md.

## Consequences

- 이후 모든 작업은 등록된 `<type>/<slug>` ID를 갖고, 상태는 tasks.yaml + PROGRESS 한 곳에만
  산다. CLAUDE.md·메모리는 복사하지 않고 링크한다.
- DESIGN.md 변경은 ADR로 승인한다(binding but falsifiable: 증거가 스펙과 충돌하면 멈추고
  `decision/...` 태스크 등록 → 판정 → ADR로 SSOT 개정).
- 생성 뷰(docs/ssot/, ROADMAP.md)는 스크립트가 만들며 손으로 편집하지 않는다.
- 과거 M0~M3·Round P 산출물은 그대로 두되 새 규약의 대상이 아니다.

## Alternatives considered

- 메모리/애드혹 문서 유지 — 상태가 계속 흩어지고 코드네임 충돌이 남아 기각.
- pr 모드 — private·main 직커밋·외부 웹 리뷰어 방식과 맞지 않아 기각(packet 채택).
