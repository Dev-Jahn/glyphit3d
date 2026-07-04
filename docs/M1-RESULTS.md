# M1 결과 — 3D static bake + 첫 3D-native 검증 (DESIGN §4.1/§4.2, §12 M1, docs/M1-SPEC.md)

> 상태: 2026-07-04. M1 ablation(§4) + 적대적 리뷰 + null-validity 감사 완료.
> 이 문서는 M1의 4개 verify 기준 판정과, 그 판정을 과학적으로 수용하기까지의 3중 검증을
> 기록한다. 수치는 `bench/out/ablate.md`(Q3 기본)와 `bench/out/ablate-q2-k0.02.md`(Q2 제약),
> 그리고 null-audit 프로브(아래 §4)에서 그대로 옮겼다.

---

## 1. 결론 요약

M1 verify 4개 기준 (M1-SPEC §4):

| 기준 | 내용 | 판정 |
|---|---|---|
| 1 | regression guard: 모든 feature-on run이 overall SSIM ≥ base−0.002 | **PASS** (worst −0.0007 @ DamagedHelmet/+split) |
| 2 | §4.2 anti-bleed: boundary-cell SSIM이 ≥4/6 모델에서 개선 | **FAIL** (1/6) |
| 3 | §4.1 split: object-cell SSIM이 ≥2/3 textured 모델에서 개선 (guard 준수) | **FAIL** (0/3) |
| 4 | zoo bake가 ≥5/6 모델에서 완주 + re-rasterize SSIM 기록 | **PASS** (6/6) |

기준 2·3의 FAIL은 버그가 아니라 **무제약 truecolor(Q3)에서 3D selection prior가 재구성
메트릭을 개선할 수 없다**는 원리적 사실의 실증이다. 이 truecolor null은 3중 검증을 거쳐
과학적으로 수용된다:

1. **단위 테스트(기계 작동 확인)** — `test/aov-match.test.ts`: split은 shading 구조로
   glyph 선택을 실제로 뒤집고(η>0에서 vertical stripe→horizontal half-block), anti-bleed는
   boundary cell을 vertical half-block 계열로 flip시켜 두 물체색을 복원하며, styleAlbedoColors는
   선택된 glyph의 색만 albedo로 refit한다. **메커니즘은 의도대로 동작한다.**
2. **null-audit(측정기 건전성 4체크)** — §4. AOV가 유효한 신호이고(shading은 shaded RGB와
   구별되며, 버퍼 분산 구조가 기대대로), prior가 실제로 argmin을 바꾸고(no-op 아님),
   anti-bleed가 정확히 boundary cell에서만 발화(비경계 flip 0)함을 확인. **null은 "아무것도
   안 일어나서"가 아니라 "작동하지만 개선하지 못해서"다.**
3. **Q2 제약 모드 대조** — §3. 무제약이 아닌 제약 색 모드(fg-only)에서 anti-bleed의 부호가
   양수로 바뀌는지 확인. 방향성은 확인되나 크기가 미미.

---

## 2. Selection-prior 정리 (M1의 핵심 학습)

> **정리.** 무제약 truecolor 2색 피팅에서, 각 셀의 전수 최소제곱(LS) glyph 선택은 이미
> per-cell 재구성 오차를 최소화한다. 따라서 어떤 selection prior(선택 점수에 항을 더하거나
> 후보를 게이팅하는 방식)도 per-cell 재구성 메트릭을 **개선할 수 없다** — 기껏해야 argmin을
> 유지하거나(tie), 최적에서 멀어지게 만들 뿐이다.

이는 DESIGN §3.3 따름정리("무제약 truecolor에서 DC 오차는 항등적으로 0, DC/AC 재가중은
죽은 손잡이")의 일반화다. §3.3은 DC/AC 재가중이라는 특정 손잡이를 다뤘고, 여기서는 임의의
선택 prior로 확장한다: 근거는 동일하다 — 무제약 2색 피팅의 잔차 SSE가 이미 셀별로 최소화된
목적함수이고, 전수 argmin이 그것을 정확히 푸는데, prior는 그 목적함수에 최적해와 무관한 항을
더하므로 argmin을 최적에서만 밀어낼 수 있다.

**실증 증거:**

- **split(§4.1 fidelity)**: shading-luma 채널을 η로 가중해 선택 점수에 추가하면 argmin이
  실제로 바뀐다 — FlightHelmet에서 전체 7560셀 중 **159셀**, 그중 object cell 1123개 중
  **148셀**에서 선택 glyph가 달라진다. 그런데도 SSIM은 하락한다(Q3 object-cell −0.0034,
  overall −0.0005). 선택이 "빛의 구조"로 끌려가면 그만큼 셀의 실제 픽셀(albedo×조명이 이미
  섞인 shaded RGB) 재구성에서 멀어지기 때문이다.
- **anti-bleed(§4.2)**: boundary cell에서만 id-partition에 맞는 mask에 보너스를 준다.
  FlightHelmet에서 flip 수는 κ=0.02/0.05/0.1에 대해 **4 / 13 / 25**개이며, **비경계 셀 flip은
  정확히 0**이다 — 기계는 명세대로 정확히 작동한다. 그러나 Q3에서 boundary-cell SSIM 변화는
  tie(+0.0001 수준)에 그친다: 무제약 2색 피팅은 이미 두 물체가 만나는 셀에서도 최적 2색을
  뽑으므로, "물체 경계에 맞춘 half-block"이 재구성상 더 낫다는 보장이 없다.

즉 **재구성 충실도(SSIM)의 관점에서 selection prior는 무제약 truecolor에서 구조적으로
무력하다.** 이것이 M1의 가장 중요한 학습이다.

---

## 3. Q2 제약 모드 결과 (`bench/out/ablate-q2-k0.02.md`)

§3.3의 논리대로, prior가 활동할 여지는 평균 재현이 깨지는 **제약 색 모드**에만 있다. Q2
(fg-only, bg 고정 [0,0,0])는 그 가장 가벼운 사례다. Q2 boundary-cell SSIM(κ=0.02):

| 모델 | base | +anti-bleed | Δ |
|---|---|---|---|
| FlightHelmet | 0.3868 | 0.3874 | **+0.0006** (κ=0.1에서 +0.0007) |
| Sponza | 0.3793 | 0.3793 | +0.0000 (tie) |
| mean (boundary 모델) | — | — | +0.0003 (κ sweep 전 구간 양수) |

- **anti-bleed는 제약 모드에서 부호가 양수로 확인된다** — Q3의 tie가 Q2에서 +0.0006~0.0007로
  전환되고, κ sweep {0.02, 0.05, 0.1} 전 구간에서 mean Δ는 +0.0003으로 **어디서도 악화되지
  않는다**. 방향은 옳다. 다만 크기가 미미해 "충실도 기능"으로서의 주장은 성립하지 않는다.
- **split은 제약 모드에서 오히려 더 악화된다** — Q2에서 object-cell SSIM은 전 모델 하락하고
  (DamagedHelmet −0.0134, FlightHelmet −0.0068), regression guard를 DamagedHelmet·FlightHelmet
  에서 위반(overall Δ −0.0026 / −0.0021 < −0.002)한다. 무제약보다 제약에서 더 나빠지므로
  **split은 충실도 메커니즘으로서 폐기**한다. (기계 코드는 유지 — §6.)

---

## 4. 전체 수치 표

### 4.1 Q3 무제약 ablation (기본, `bench/out/ablate.md`, κ=0.02)

atlas: DejaVu Sans Mono @16, blocks(270 glyphs), cell 10×19, working space gamma, split η=0.5.

Overall SSIM:

| 모델 | base | +split | +antibleed | +both |
|---|---|---|---|---|
| DamagedHelmet | 0.9385 | 0.9377 | 0.9385 | 0.9377 |
| FlightHelmet | 0.9536 | 0.9532 | 0.9536 | 0.9531 |
| BoomBox | 0.9568 | 0.9566 | 0.9568 | 0.9566 |
| SciFiHelmet | 0.9565 | 0.9560 | 0.9565 | 0.9560 |
| Fox | 0.9853 | 0.9853 | 0.9853 | 0.9853 |
| Sponza | 0.9427 | 0.9426 | 0.9427 | 0.9426 |

Object-cell SSIM (coverage>0.3):

| 모델 | base | +split | +antibleed | +both |
|---|---|---|---|---|
| DamagedHelmet | 0.6121 | 0.6073 | 0.6121 | 0.6073 |
| FlightHelmet | 0.7200 | 0.7166 | 0.7200 | 0.7164 |
| BoomBox | 0.7548 | 0.7531 | 0.7548 | 0.7531 |
| SciFiHelmet | 0.7172 | 0.7137 | 0.7172 | 0.7137 |
| Fox | 0.8387 | 0.8382 | 0.8387 | 0.8382 |
| Sponza | 0.7654 | 0.7649 | 0.7654 | 0.7649 |

Boundary-cell SSIM (§4.2; multi-mesh 모델만 — gate-fired 셀 제외):

| 모델 | boundary cells | base | +split | +antibleed | +both |
|---|---|---|---|---|---|
| FlightHelmet | 185 | 0.5599 | 0.5544 | 0.5600 | 0.5535 |
| Sponza | 97 | 0.5578 | 0.5534 | 0.5578 | 0.5534 |

(DamagedHelmet/BoomBox/SciFiHelmet/Fox는 단일 mesh → boundary cell 0 → n/a.)

### 4.2 Q2 제약 대조 (`bench/out/ablate-q2-k0.02.md`, κ=0.02)

| 지표 | FlightHelmet base→+antibleed | Sponza base→+antibleed |
|---|---|---|
| Boundary-cell SSIM | 0.3868 → 0.3874 (+0.0006) | 0.3793 → 0.3793 (+0.0000) |
| Object-cell SSIM (+split) | 0.3941 → 0.3873 (−0.0068) | 0.3931 → 0.3908 (−0.0023) |

Q2에서 criterion 1(guard)은 split 때문에 FAIL(worst −0.0026 @ DamagedHelmet/+split).

### 4.3 null-audit 프로브 (측정기 건전성 4체크)

측정 도구와 AOV가 건전함을, 그리고 null이 "메커니즘 미작동"이 아님을 입증한다:

| # | 체크 | 수치 | 의미 |
|---|---|---|---|
| 1 | shading 채널의 독립성 | corr(shading, shaded) = **0.6046** | shading은 shaded RGB와 구별되는 신호(≈1이 아님) — split이 무력한 건 채널이 중복이라서가 아니다 |
| 2 | AOV 분산 구조 | textured-cell std: albedo **0.1828** / shading **0.0773** / shaded **0.1027** | albedo가 texture 분산 최대, shading이 최소(매끈한 빛), shaded가 중간 — 버퍼가 기대대로 내용을 담는다 |
| 3 | split이 실제로 argmin을 바꿈 | flips **159/7560** (object **148/1123**) | prior는 no-op이 아니다 — 선택을 바꾸고도 SSIM이 하락 = 진짜 null |
| 4 | anti-bleed가 정확히 boundary에서만 발화 | flips **4 / 13 / 25** @ κ=0.02/0.05/0.1, **비경계 flip 0** | 기계가 명세대로 정확히 작동, 누수 없음 |

이 4체크로 "기계는 유효한 신호 위에서 정확히 작동한다"가 증명되고, 그럼에도 SSIM이 개선되지
않으므로 truecolor null은 과학적으로 확정된다.

---

## 5. 3D-native 가치의 재배치

무제약 truecolor 재구성에서 selection prior가 무력하다는 결론은 **3D-native 테제 자체를
반증하지 않는다.** prior가 실제로 활동하는 공간을 다음으로 재배치한다:

- **(a) 제약 색 모드 (palette-256 / theme-16 / fg-only)** — 미구현. §3.3·§3.8의 논리대로
  평균 재현이 깨지는 이 영역이 prior의 진짜 활동 공간이다. Q2에서 anti-bleed의 부호가 이미
  양수로 확인됐다 — palette/theme의 더 강한 제약에서 크기가 커질지가 다음 실측 대상.
- **(b) cross-cell 윤곽 연속성 (M3, DESIGN §4.3)** — per-cell 재구성이 아니라 셀 경계를
  가로지르는 실루엣 연속성. per-cell SSIM이 못 재는 축.
- **(c) temporal (M4, §4.9)** — 프레임 간 flicker. 단일 프레임 SSIM과 직교.
- **(d) 스타일화 (styleAlbedoColors, §4.1)** — 색=material albedo, 문자=빛. 시각 전용,
  SSIM을 주장하지 않는다.

**M2 진행에는 영향 없음** — M2는 인터랙티브 데모 + 품질 사다리(Q-ladder)이고, M1의 null은
"Q5의 3D selection prior가 Q3 재구성 SSIM을 못 올린다"만 말한다. M2의 무제약 fidelity 경로는
이미 Q3에서 검증됐다.

---

## 6. 기계 유지 결정

- **`splitSelection`(η) / `antibleedKappa`(κ) 코드는 유지한다** (기본 off). 이유: M3의
  orientation prior(§4.3)가 동일한 "extra scoring channel / boundary correlation bonus" 채널
  구조를 재사용한다. 검증된 기계를 지우고 M3에서 다시 만드는 것은 낭비다.
- **철회하는 것은 "충실도 주장"뿐이다** — "split/anti-bleed가 재구성 SSIM을 개선한다"는
  주장. 이 주장은 무제약 truecolor에서 원리적으로 성립하지 않는다.
- **styleAlbedoColors는 유지**하되 시각 전용으로 명시 (SSIM 표에 진입 금지).

관련 DESIGN 갱신은 §4.1/§4.2 상태 노트, §3.3 selection-prior 일반화 단락, §15 오픈 질문 7번
후속 줄에 반영했다.
