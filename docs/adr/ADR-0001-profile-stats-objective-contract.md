# ADR-0001: 프로파일 스칼라 stats를 objective truth로 확정하고 프로파일 hash를 canonical payload 전체로 확장한다 (Contract B)

- Status: accepted
- Date: 2026-07-07
- Round: 2026-07-07-gpu-reality (외부 리뷰 ingest)
- SSOT sections affected: §5.4 (폰트 프로파일) — 개정, §5.2 (atlas 전처리) — 참조
- Tasks: decision/profile-stats-objective-contract (ruled), fix/profile-hash-canonical

## Context

외부 리뷰(gpt-5.5-pro, F3)가 프로파일 무결성 공백을 지적했다. 브라우저 프로파일은 glyph별
스칼라 통계(sumA, sumAA, gradAA, ink)를 별도 필드로 싣고, `decodeProfile()`은 이를 그대로
atlas glyph stats로 신뢰한다. CPU/GPU 매처의 점수 함수(argmin objective, MDL 페널티,
degenerate 분기, 색 피팅)가 모두 이 스칼라를 직접 소비하며, GPU 매처 코드는 "stored sumAA가
objective"라고 명시한다. 그러나 `verifyProfileHash()`와 exporter는 glyph `cp` + `alphaB64`
coverage 바이트만 해싱한다 — 스칼라 stats, cellW/cellH, 폰트 메타데이터는 hash 범위 밖이다.

즉 코드는 **스칼라를 저장·신뢰(Contract B 데이터 모델)**하면서 hash 범위는 **coverage만
(Contract A 범위)**을 덮는 혼종이고, 이 엇갈림 자체가 공백이다. sumAA/ink가 손상·구식화되면
hash 검증은 통과하지만 매칭이 조용히 틀어진다.

현 시점 잠재적 결함이다: 내장 exporter는 coverage와 스칼라를 같은 atlas 객체에서 한 번에
생성하므로 자동 경로에서는 둘이 어긋날 수 없다. 노출은 (a) 손편집·제3자 프로파일, (b) 스칼라
공식 변경으로 인한 버전 skew에서 열리며, §5.4가 "내 TTF로 프로파일 생성 / 공유 생태계"를
명시하므로 실제 미래 노출 경로다.

또한 프로파일의 저장 coverage(`alphaB64`)는 양자화(저해상도)본인 반면 스칼라는 생성 시점의
고해상도 atlas에서 계산된 값이라, 파일 안에서 이미 두 해상도가 섞여 있다(리뷰 O2가 짚은 hybrid).

## Decision

**Contract B를 채택한다.** glyph별 사전계산 스칼라(sumA/sumAA/gradAA/ink)를 프로파일의 1급
objective truth로 확정한다. 프로파일 hash를 coverage 단독이 아니라 **전체 canonical payload**
로 확장한다: `version`, `font`, `cellW`, `cellH`, `ascent`, glyph 순서, `ch`, `cp`, `alphaB64`,
`sumA`, `sumAA`, `gradAA`, `ink`. `verifyProfileHash()`와 exporter가 동일한 canonical payload를
해싱해야 한다.

**근거**: 이 프로젝트의 핵심 가치는 충실도(직전 라운드가 byte-exact parity에 집중)다. 실시간
경로는 고해상도 스칼라로 매칭한다. 프로파일이 공유·재사용되려면 **불러온 프로파일이 실시간
프로파일과 동일한 매칭 결과**를 내야 하며, 이는 고해상도 스칼라를 보존·보호하는 B가 지킨다.
코드가 이미 B 철학으로 짜여 있어(고해상도 스칼라를 기준으로 선언) 변경면이 hash 범위 한 곳으로
작다.

## Consequences

- `verifyProfileHash()`(web/src/profile.ts)와 exporter(scripts/export-atlas.ts)가 canonical
  payload 전체를 해싱하도록 개정 — 스칼라/메타 변조가 이제 거부된다. → `fix/profile-hash-canonical`.
- `decodeProfile()`는 저장 스칼라를 계속 신뢰한다(재계산하지 않음). 단, decodeProfile이 현재
  gradient 배열(dxA/dyA)은 decoded α에서 재계산하면서 그 집계 gradAA는 저장값을 신뢰하는 내부
  비일관은 스칼라=objective 확정하에 gradAA도 저장값 신뢰로 정합시킨다.
- 스칼라 변조 거부 테스트를 추가한다(현재 test/profile.test.ts는 coverage 바이트 변조만 거부).
- DESIGN §5.4를 개정(프로파일이 스칼라를 1급 objective로 싣고, hash가 전체 payload를 덮음).

## Alternatives considered

- **Contract A** (coverage = truth, decode 시 스칼라를 decoded 양자화 coverage에서 재계산, hash
  불변). 기각: 양자화 coverage에서 재계산하면 objective가 "양자화 기준"으로 재정의되어, 불러온
  프로파일이 실시간 고해상도 경로와 **미세하게 다른 매칭**을 낸다 — 프로젝트 충실도 명제에
  반하는 재현성 틈. DESIGN §5.4/§5.2 서술이 A쪽으로 기울었으나, 이는 양자화 coverage와 live
  고해상도 스칼라가 섞인 hybrid 구조를 인지하기 전의 문구다(본 ADR로 개정).
