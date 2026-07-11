# ADR-0002: 재구성 헤드라인 지표를 mean SSIM에서 셀 스케일 AC 구조 지표(CAS)로 교체하고, 미학(ASCII-identity) 태스크의 평가 프로토콜을 확정한다

- Status: accepted
- Date: 2026-07-07
- Round: 2026-07-07-metric-redesign
- SSOT sections affected: §10 (검증과 벤치마크) — 개정; §3.3 (DC/AC 분해), §3.4 (invisible-ink), §6 (Q 사다리) — 참조
- Tasks: docs/metric-redesign (본 ADR), feat/ascii-identity-selection (평가 프로토콜 확정), feat/shape-color-coupling (평가 프로토콜 확정)

## Context

사용자(2026-07-06)가 두 가지를 확립했다. 이 ADR은 둘을 SSOT에 정식 이관한다.

**(1) mean SSIM은 포화된 부적절 headline이다.** 무제약 truecolor 2색 피팅은 셀 DC(평균색)를
**항등적으로 정확히** 재현한다(§3.3 따름정리). 따라서 SSIM의 휘도(luminance)항
`l=(2μxμy+C1)/(μx²+μy²+C1)`은 셀마다 ≈1로 붕괴한다. 게다가 프레임 대부분이 매끈한
배경/평탄 영역이라, 11×11 창의 대비·구조항까지 배경 창에서 ≈1로 포화된다. 전 창 평균을
내면 지표가 0.98대에 고정되고 **glyph의 서브셀 구조 기여가 소수점 3–4자리로 압축**된다 —
이것이 Q3와 Q4가 지표상 구분 불가였던 이유다(bench/README §"Full experiment matrix": E1/E2/E3
전부 0.9812). "색 채우기가 지표를 먹어치운다."

**(2) 재구성 최적화는 더 이상 프로젝트의 단일 목표가 아니다.** free-bg(Q3+)는 pixel art로
수렴하는 구조적 필연이고, 사용자의 미학 목표는 **ASCII-identity**(고정 bg 계열, Q2 최근접)다.
이는 selection-prior 정리(무제약 truecolor에서 어떤 prior도 재구성 메트릭을 개선 불가, 2회
실증 — §3.3, docs/M1·M3-RESULTS)와 **모순되지 않는다**: 정리는 *재구성 메트릭 한정*이고,
ASCII-identity는 **명시적으로 다른 목적 함수**다. 따라서 두 축은 분리해 측정·판정해야 한다.

두 제약(과학 원장)을 위반하면 이 ADR은 무효다: (a) **invisible-ink** — |F−B|<24 u8의 희미한
glyph는 실제 서브셀 그라디언트를 인코딩하는 **재구성-양성** 피처다(T=24 제거 시 chafa gate가
−0.0064로 반전); 새 지표가 이를 체계적으로 벌하면 안 된다. (b) **측정 무결성** — 지표는 채점
표현에 직접 피팅해 게임할 수 없어야 하고(M0 하네스 편향: 마진의 77%가 허수였음), loss-공간과
metric-공간은 페어링돼야 한다(gamma).

## Decision

### 1. 새 headline: CAS (Cell-AC Structure)

셀 하나를 창으로 삼아, **DC(평균)를 제거한 대비·구조 상관**을 채점한다. 이는 SSIM의 세
인수 `l·c·s` 중 포화 주범인 휘도항 `l`을 떼어낸 **`cs = c·s` 인수를 셀 스케일로** 평가하는
것과 정확히 같다.

셀 k(픽셀 수 P=cellW·cellH, **균일 가중**, 이웃 셀을 읽지 않는 정확히 그 셀):

```text
채널 = gamma-encoded u8 luma  Y = round(linearToSrgb(luma(r,g,b)))   (src/metric/ssim.ts와 동일 추출)
μx,μy = 셀 평균;  σx²,σy² = 셀 분산;  σxy = 셀 공분산    (P 픽셀에 대한 모집단 적률)
cs_k  = (2·σxy + C2) / (σx² + σy² + C2),     C2 = (0.03·255)² = 58.5225   (ssim.ts와 동일 상수)
```

- **창 = 셀**(11×11 가우시안 아님): "cell-scale"의 문자 그대로. 가우시안 창은 셀 경계를 넘어
  이웃 glyph 선택을 끌어들이고(§3.5 경계 규약 위반) 배경 매끈함을 다시 섞어 포화를 되살린다.
- **DC 제거 = 휘도항 폐기**: cs는 셀 평균색에 불변 → SSIM을 포화시킨 색 채우기가 사라진다.
- **경계·엣지 케이스**(단위 테스트 `test/cell-ac.test.ts`로 고정):
  - 동일(x≡y): cs=1. `cs=1 ⇔ Var(x−y)=0 ⇔ 출력=참조 (셀별 DC offset 무시하고 AC 정확 일치)`.
  - 양쪽 평탄(σx=σy=σxy=0): cs=C2/C2=1 — 평탄 셀은 구조가 자명히 재현됨.
  - **참조 평탄·출력 구조(σy=0, σx>0)**: cs=C2/(σx²+C2)<1 — 평탄 영역에 구조를 **날조**하면
    벌점(정확히 washout 미학 결함). 단 σx²≪C2인 *진짜 안 보이는* 희미함은 cs≈1(불벌).
  - **출력 평탄·참조 구조(σx=0, σy>0)**: cs=C2/(σy²+C2)<1 — 실제 구조를 **재현 실패**하면 벌점
    (예: Q1이 그라디언트 셀을 단색으로 채움).
  - cs∈[−1,1](Cauchy–Schwarz). 분모 ≥ C2>0이라 0-나눗셈 없음. 음의 분산은 float 잡음이므로 0 클램프.

### 2. Object mask (구조를 물체 위에서 채점)

- **AOV 경로(원칙)**: 렌더러가 AOV를 주면(§4.2 `coverage`/`objectId`) 셀 마스크 = `coverage>0`
  또는 `objectId≠0`, 1-셀 dilation(실루엣 셀 포함). 기하학적 진실. `bench/cell-ac.ts:aovCellMask`.
- **2D 이미지 fallback(문서화)**: AOV가 없는 평면 입력(chafa gate 벤치 세트 등)은 gate가 이미
  쓰는 통계 재사용 — 셀 평균 gamma-luma의 per-image **Otsu 분할**로 두 클래스를 나눈 뒤,
  **극성(polarity)은 경계에서 자기보정**한다: 이미지 테두리(edge 셀 링)에서 **다수인 클래스를
  배경, 소수인 클래스를 물체**로 잡고 **1-셀 dilation**(실루엣 셀 포함)
  (`bench/masked-ssim.ts:cellMeanLuma01`+`otsuThreshold`, 극성 결정은 `bench/cell-ac.ts:cellObjectMask`).
  이로써 밝은-피사체/어두운-배경(합성 렌더 sphere/torus/spheres·DamagedHelmet)**과** 어두운-
  피사체/밝은-배경(FlightHelmet·BoomBox) **양쪽 모두** 물체를 올바로 지역화한다 — 고정 "물체=더
  밝음" 규칙이 뒤집혀 배경을 채점하던 오라벨을 제거했다. **한계 명시**: 피사체가 테두리 링을
  가득 채우면 경계 투표가 흐려진다(벤치 6-이미지 세트엔 해당 없음). AOV 경로가 이를 대체한다.

### 3. 집계 = 분포(하위 percentile) + AC-에너지 가중 평균

object 셀에 대해 cs_k를 **분포로** 보고한다:

- **percentile p05 / p10 / p25 / p50** — headline은 **하위 percentile**. 매끈한 object 셀은 cs≈1로
  분포 상단에 몰리므로, 하위 percentile이 곧 구조가 있는 어려운 셀 = SSIM 평균이 희석한 신호다.
- **wmean = Σ_k w_k·cs_k / Σ_k w_k, w_k = 참조 AC 에너지 σy²(k)** — 구조 지배 스칼라. 가중치가
  **참조에서만** 나오므로(출력 독립) 게임 불가. 평탄 셀에 포화되지 않는 단일 수.
- **plain mean**과 **nStructured**(σy²>C2인 object 셀 수)는 부차 보고.

### 4. mean SSIM은 가드레일로 강등

기존 `src/metric/ssim.ts`, `bench/chafa-gate.ts`(그 게이트 계약·출력·기존 chafa 기록 전부)는
**그대로 둔다** — "그 지표 하에서의 유효 기록"이며 회귀 가드레일이다. mean SSIM은 이제 품질
주장의 **단일 기준이 아니라** "재구성을 무너뜨리지 않았다"의 하한 감시자다.

### 5. 미학(ASCII-identity) 태스크 평가 프로토콜 — 재구성이 아닌 목적 함수

feat/ascii-identity-selection(균일/밝은 영역 큰-면적 glyph, 미묘한 그라디언트에 조절된 작은
glyph)과 feat/shape-color-coupling(셀 광량으로 glyph 색 명도·채도 변조)은 **미학 목표**다.
selection-prior 정리상 이들은 무제약 truecolor 재구성을 이길 수 없고, **이기려 해서도 안 된다.**
평가는 다음으로 확정한다.

- **평가 regime = 고정-bg 계열(Q1/Q2)**. 자유-bg Q3에서 판정하면 범주 오류다(정리의 활동
  여지는 평균 재현이 깨지는 **제약 모드** = 고정-bg에만 존재).
- **1차 판정 = 사용자 직접 시각 판정**(목표가 미학이므로): 고정 씬 세트(6 벤치 이미지
  + 데모 포즈)에 baseline(현 Q2) vs feature-on. 예측을 **관측 전 등록**(라운드 spec 관례). 강제선택
  기준 = "문자 아이덴티티가 살아 캐릭터 아트로 읽히는가 vs 디더링된 밝기 필드/washout 안개인가".
  보고 = feature-on 선호 씬 비율 + 실패 모드 열거. **수용 = 사용자가 feature 쪽을 다수 씬에서 선호
  ∧ 명시 회귀(가독성 붕괴·색 밴딩) 씬 0.** (봉인·블라인드 A/B 형식주의는 오버엔지니어링으로 폐기 —
  사용자 지시 2026-07-11; 육안 판정으로 충분.)
- **정량 가드레일(회귀 금지, 무플래그 재현)**:
  - **SSIM 하한**: Q2 baseline 대비 사전 등록 floor 아래로 떨어지지 않는다(미학은 재구성 파괴
    면허가 아니다). *개선은 불요*(정리).
  - **CAS 하한(object p10/wmean)**: object 셀 구조를 사전 등록 floor 아래로 **떨어뜨리지 않는다**.
    개선 불요(정리) — 허용. 이것이 "구조 셀을 평탄 채움으로 뭉개는" 게임을 잡는다.
- **ASCII-identity 정량 프록시**(feature 고유 목적, 병기): object 셀에서 출력 기준
  **glyph 가독률** = {space 아님 ∧ |F−B|≥τ_vis(24 u8) ∧ full-block 아님}인 셀 비율. shape-color-coupling은
  추가로 **셀 참조 휘도 ↔ 선택 fg 명도/채도 상관**. 이 프록시는 CAS와 **의도적으로 다른 목적**이며
  invisible-ink와 **명시적 trade-off**다(재구성은 invisible-ink를 원하고, ASCII-identity는 가시 glyph를
  원한다). 그 교환을 가드레일 floor 안에서 하는 것이 곧 feature.
- **수용 판정(논리곱)**: (a) 사용자 시각 판정 다수승 ∧ (b) ASCII-identity 프록시가 사전 등록 마진만큼
  개선 ∧ (c) SSIM·CAS floor 유지. 프록시는 올랐는데 floor를 깨면 **기각**(구조를 과다 교환 = washout,
  아이덴티티 아님). 이 양면 조건이 프록시 게임(어디에나 밀한 glyph를 찍어 가독률만 올리기)을 CAS
  floor로, 재구성 회귀를 SSIM floor로 동시에 차단한다.

## Consequences

- **DESIGN §10 개정**: "Golden metric: SSIM/LPIPS … 단일 기준" → CAS(object mask·분포)를 headline
  으로, mean SSIM을 가드레일로 강등하고, 미학 태스크 평가 프로토콜을 §10에 명시(본 ADR 상호참조).
- **참조 구현(순수 TS, bench/)**:
  - `bench/cell-ac.ts` — CAS 지표(`cellCsMap`), object mask(`cellObjectMask` 2D fallback / `aovCellMask`),
    percentile, 집계(`aggregateCas`), 편의 `casReport`. SSIM은 기존 `src/metric/ssim.ts`를 가드레일로 재사용.
  - `bench/structure-report.ts` — chafa-gate의 **형제 진입점**(gate 미변경): Q1/Q2/Q3/Q4 + chafa를 동일
    predict-terminal(gamma) 공간·동일 grid-footprint 참조로 재래스터해 CAS 분포 + SSIM 가드레일을 표로
    방출. `bench/out/structure-report.md`로 저장.
  - `test/cell-ac.test.ts` — CAS 수학 계약(동일→1, DC 불변, 날조 벌점, 재현 실패 벌점, faint-but-correct
    불벌, wmean 구조 지배, percentile, 마스크 — 밝은-피사체·어두운-피사체 양극성 포함) 13 케이스로 고정.
- **anti-gaming 분석**: (i) CAS는 **재래스터된 predict-terminal 합성물**을 채점(피팅 잔차 아님) → gate의
  하네스-공정 프로토콜 상속, 채점 배열 직접 피팅 불가. (ii) fit-공간=합성-공간=metric-공간 모두 gamma
  (predict-terminal, §3.1) → loss/metric 페어링 유지. (iii) cs는 **대비 민감**(진폭 일치를 요구, cs=1은
  Var(x−y)=0 필요) → 대비-정규화 NCC와 달리 임의의 미세 구조 주입으로 ρ→1을 살 수 없다. (iv) wmean의
  가중치는 참조 AC 에너지(출력 독립).
- **invisible-ink 준수(실증)**: cs는 참조가 실제 구조를 가진 곳의 faint-but-correct glyph를 벌하지
  않는다(그곳은 σy²>0, 출력이 대비를 맞추면 cs≈1). 오직 *평탄 참조에 날조된 가시 구조*만 벌한다. 실측
  가드(structure-report "Invisible-ink guard"): Q3 ink-keep(collapse=0) vs strip(collapse=24)에서
  **CAS(keep) ≥ CAS(strip) 전 이미지 통과**(Δp10 평균 +0.1746, Δwmean +0.0200) — CAS가 stripping을
  더 나쁘다고 **동의**한다.

### 재baseline @ HEAD (무플래그 재현)

```bash
npx tsx bench/structure-report.ts     # 6-image 표준 세트(3 synthetic + 3 Khronos) → bench/out/structure-report.md
npx tsx bench/chafa-gate.ts           # 기존 게이트(불변, PASS ours 0.9835 vs chafa 0.9812)
npx vitest run test/cell-ac.test.ts   # CAS 계약 13/13
```

핵심 결과(6-image 평균):

| 비교 | mean SSIM(가드레일) | CAS wmean | CAS p05 | 해석 |
|---|---|---|---|---|
| ours Q2 → Q3 (고정→자유 bg) | 0.7752 → 0.9533 | 0.3904 → 0.8371 | 0.0820 → 0.7705 | 미학 피벗의 분기점 |
| ours Q3 − chafa (재구성 리드) | **+0.0036** | **+0.0191 (5.3×)** | **+0.0211 (5.9×)** | CAS가 SSIM이 압축한 구조 마진을 해상 |
| Q4 − Q3 (SSIM이 구분 못 한 쌍) | +0.0001 (잡음) | −0.0008 | −0.0008 | 아래 정직 주석 |

- **de-saturation 입증**: 동일한 ours-Q3의 chafa 대비 재구성 리드를 CAS는 SSIM보다 **5–6× 크게** 해상한다
  (wmean +0.0191 vs SSIM +0.0036; p05 +0.0211 = 5.9×). CAS median(p50) 마진은 0.6×로 SSIM처럼 포화 — 그래서
  headline은 중앙값이 아니라 **하위 percentile + 에너지 가중**이다(설계와 정합).
- **Q3 vs Q4 정직 주석**: 이 매끈한 렌더에선 Q3와 Q4가 **진짜로 근접**하다(Q4 edge loss가 물 곳이 거의
  없음 — §4.3 철회·edge-prior null과 정합). CAS는 이를 *마법처럼 벌리지 않는다*. 다만 SSIM의 +0.0001(잡음,
  부호 뒤집힘)과 달리 CAS는 **일관 부호의 −0.0008**(약 8× 민감, Q4가 내부 AC를 미세 교환) — 신호를 해상하되
  결론은 "포화가 전부는 아니었고, 실제 near-equivalence였다". 이 정직한 구분이 새 지표의 값이다.

## Alternatives considered

- **mean SSIM 유지(현상)** — 포화가 사용자 비판의 핵심. 기각(단, 가드레일로 강등해 보존).
- **대비-정규화 NCC(순수 ρ, 진폭 무시)** — invisible-ink에 더 관대하나 **게임 가능**(임의 미세 구조로
  ρ→1). anti-gaming(측정 무결성)에 반해 기각. cs는 진폭 일치를 요구해 이 구멍을 막는다.
- **채널별(RGB) cs** — isoluminant 색 구조까지 잡지만 가드레일 SSIM(luma)과 비교 축이 어긋나고 범위가
  커진다. 현 비판은 *구조* 포화이지 색 구조가 아니므로 luma로 확정(gate의 per-channel E_AC는 게이팅 통계로
  유지, 지표와 별개). 색 구조가 문제로 승격되면 재검토.
- **LPIPS/딥 지표** — 순수 TS·의존성 금지 제약 위반, 재현·감사 곤란, 블랙박스라 anti-gaming 감사 불가. 기각.
- **미학 태스크를 CAS/재구성으로 판정** — selection-prior 정리에 정면 위배(prior는 재구성을 못 이김).
  미학은 별도 목적 함수 + 사용자 직접 시각 판정 + 양면 가드레일로 판정하도록 확정.
