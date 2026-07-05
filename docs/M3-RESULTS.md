# M3 결과 — gate 재설계 · synthesized families · contour null (DESIGN §3.4/§3.6/§4.3, §12 M3, docs/M3-SPEC.md)

> 상태: 2026-07-05. M3 ablation(§4) + 8-defect 적대적 리뷰(출판 수치 무결성 실패 포함) 완료.
> 이 문서는 M3의 4개 verify 기준 판정과, 세 개의 반증된 예측, 그리고 그 판정을
> "교정된 측정기" 위에 다시 세우기까지의 리뷰 사이클을 기록한다. chafa-gate 수치는
> `bench/chafa-gate.ts`(무플래그 / `--families` / `--families --strict`)를 production
> default(gateTau 2e-5, space gamma)로 재실행해 재생성했고, gate·collapse sweep은
> `bench/out/gate-sweep.md`, ablation은 `bench/out/ablate-m3.md`에서 그대로 옮겼다.

---

## 1. 결론 요약

M3 verify 4개 기준 (M3-SPEC §4):

| 기준 | 내용 | 판정 |
|---|---|---|
| 1 | **GATE**: synth object-cell Δ ≥ +0.002 · washout proxy ≤ +1%p · zoo overall 비퇴행 · chafa 마진 비축소 | **PARTIAL** — 품질 성분 전부 PASS, washout-proxy 성분만 FAIL |
| 2 | **FAMILIES**: overall SSIM이 synth 3/3 AND zoo ≥4/6 개선 | **PASS** (결정적: synth 3/3, zoo 6/6) |
| 3 | **CONTOUR**: edgeSSIM이 zoo ≥4/6 개선 (overall guard 준수) | **FAIL** (orient 1/6, contour 0/6 — 철회 확정) |
| 4 | **SUITE**: 66+ green, 기존 gate/harness 전부 PASS | **PASS** (100 green, e2e 8/8) |

- **기준 1 (PARTIAL).** 품질 성분은 모두 통과한다: synthetic object-cell Δ **+0.0056**
  (≥ +0.002), zoo overall 비퇴행, 그리고 chafa 6이미지 마진은 **축소가 아니라 확대**됐다
  (+0.0015 → **+0.0035**). FAIL은 단 하나 — washout-proxy 성분이다: invisible-ink이
  τ=2e-4 대비 +1%p 이내로 유지되어야 하는데 **+99.35%p까지 폭발**하고 MDL이 이를 잡지
  못한다(§2.1). literal 기준으로는 "MDL이 washout을 방어한다"는 §1 예측이 반증된 것이므로
  FAIL이지만, 그 proxy 폭발은 측정 가능한 품질 손상과 **분리(decoupled)**되어 있다(§2.2).
  미학적 통제가 필요한 입력을 위한 **collapseThreshold 옵트인 노브**로 대체했다(§5.2).
- **기준 2 (PASS, 결정적).** families는 overall SSIM을 synth 3/3, zoo 6/6 전부에서 올린다.
  M3의 유일한 무조건적 품질 승리이자 milestone의 최대 단일 이득이다.
- **기준 3 (FAIL, 철회 확정).** cross-cell contour 기제(orientation prior + contour DP)는
  edgeSSIM을 개선하지 못한다(orient 1/6, contour 0/6). M1 truecolor null에 이은 **두 번째
  3D-native null**로 기록하고 DESIGN §4.3을 철회한다(§2.3).
- **기준 4 (PASS).** vitest 100 green, Playwright e2e 8/8.

**요약: 품질 목표는 달성(gate 재설계 + families), cross-cell 테제는 철회.**

---

## 2. 세 개의 반증된 예측

M3-SPEC는 각 기제에 falsifiable prediction을 걸었다. 세 개가 반증됐고, 각각의 root
cause가 확정됐다.

### 2.1 Washout 방어는 MDL이 아니다 — E_AC 비례로 소멸

§1 예측: gateTau를 2e-4 → 2e-5로 낮춰도 invisible-ink은 `λ·ink·E_AC` MDL 페널티가
잡아준다. **반증.** invisible-ink proxy(E_AC/(3P) < 2e-4인 셀 중 non-space glyph를
`|F−B|<24 u8`로 내는 비율)는 τ=2e-5에서 washout-stress 99.35%, sphere 22.00%로
폭발한다(§5.1). 그리고 λ_mdl을 0.02→0.05로 올려도 washout-stress ink는 **+0.00%p**만
변하고, λ=0.8까지 escalation해도 80.75%에서 멈춘다. **root cause: MDL 페널티가
`λ·ink·E_AC`로 E_AC에 비례하므로, 정확히 저에너지 washout regime에서 leverage가 0으로
소멸한다.** MDL은 방어 장치가 아니다.

### 2.2 Collapse의 "SSIM-neutral by construction" 전제 반증 — faint ink는 재구성-양성

MDL을 대체할 후보로 post-selection invisibility-collapse(승자가 `|F−B|<T`면 셀을 space +
평탄 평균으로 치환)를 실측했다. 아키텍트의 전제는 "faint glyph는 구조가 없으니 평탄
치환이 SSIM-중립"이었다. **반증.** collapse는 테스트한 모든 threshold에서 모든 이미지의
overall AND object SSIM을 0.0005 허용치 이상으로 **비용화**한다(§5.2). 결정적 발견:
`|F−B|<24 u8`의 "invisible ink"는 실제 서브셀 그라디언트를 인코딩하는 **재구성-양성
피처**다 — 제거하면 sphere/torus/spheres·helmet 전 이미지에서 SSIM이 하락하고, T=24에서
chafa gate가 **−0.0064로 반전**한다. washout은 결함이 아니었다. collapse는 faint glyph가
진짜 노이즈인 washout-지배 입력을 위한 **옵트인 purity 노브**로만 출하하고 기본 OFF(0)다.

### 2.3 Braille의 그라디언트 우위 반증 — quadrant 우세, sextant가 주력

§3.6 예측: 미세 텍스처/그라디언트는 braille(2×4 dot)이 이긴다. **반증.** family usage
(§5.5)를 보면 매끈한 그라디언트는 **quadrant/sextant가 이기고**, braille은 dot-lattice와
정합하는 구조에서만 승리한다(sphere braille 5셀 vs sextant 870셀; torus 3 vs 428).
실전 주력은 **sextant**다(전 이미지에서 braille 대비 3–290×). §3.6의 "매끈한 그라디언트는
블록이 이긴다"는 문장이 맞고, "braille이 이긴다"는 문장이 틀렸다. (families의 실제 이득은
repertoire가 아니라 **exact region solver**임을 재확인 — §3에서 검증.)

---

## 3. 적대적 리뷰 — 교정된 측정기 (8 defect)

리뷰는 8개 결함을 probe로 확정했고 모두 수정됐다(commit 84ce090). 그중 셋은 **출판
수치 무결성 실패**로, 이것이 M3의 "corrected-instruments" 서사의 핵심이다 — 측정기를
고치기 전의 수치는 신뢰할 수 없었다.

| # | 결함 | 종류 | 수정 |
|---|---|---|---|
| D1 | family/collapse 승자가 `grid.cands`에 미등록 → contour 패스가 되돌림, `+all`이 `+families`의 상위집합이 아님 | 기제 | cands 등록; `+all`이 전 이미지에서 families의 깨끗한 superset |
| D2 | family ink가 atlas scale로 정규화되지 않음 → 같은 mask가 다른 MDL, request-set 변동 | 기제 | atlas scale로 정규화(같은 mask = 같은 MDL; request-set invariant) |
| D3 | orientation/split/antibleed prior가 family pattern에 미적용 | 기제 | summed-mask region dots로 세 prior 적용(1e-5 parity 테스트) |
| D4 | `contourPostPass`가 `fg:null`(gate된 space 셀)을 보존하지 않음 | 기제 | fg:null 보존 |
| D5 | **chafa-gate harness가 stale `gateTau 2e-4`를 하드코딩** (production은 2e-5) | **수치 무결성** | `defaultOptions()`를 소스 → 무플래그 재현 명령이 production default 측정 |
| D6 | **sextant grant이 chafa에게 no-op** — chafa 1.18.2는 U+1FB00 대역/class/codepoint 전부에서 glyph를 **0개** 방출 | **수치 무결성** | verified no-op; `--strict` 변형 추가(양 엔진 공유 repertoire) |
| D7 | **출판 마진 +0.0058이 재현 불가** | **수치 무결성** | 실측 결과 fix 이전 **+0.0033**; fix 이후 **+0.0058 full-capability / +0.0034 strictly-fair**로 정정 |
| D8 | `augmentAtlas` 중복 미제거 + block-mask override 부재(§5.6 mixed raster) | 기제 | dedup + `--override-blocks` |

**출판 수치 무결성 삼각(D5·D6·D7)의 결론:** 정정 전에 인용되던 +0.0058 families 마진은
(a) harness가 production이 아닌 stale τ를 쓰고 있었고, (b) chafa가 실제로 낼 수 없는
sextant 대역의 공을 ours에게 돌린 값이었다. 측정기를 고친 뒤의 정직한 수치는 **무플래그
+0.0035**(품질 전부 production default), **full-capability +0.0058**(sextant no-op 주의
포함), **strictly-fair +0.0034**(atlas + braille만, 양 엔진)다. 헤드라인은 strictly-fair
+0.0034를 대표값으로, full-capability +0.0058은 각주로 취급한다(§4).

리뷰의 마지막 확인: contour edgeSSIM null이 **교정된 측정기 위에서도 확정**됐다 —
`+all < +families`가 zoo 6이미지 전부에서 성립(§5.4). DESIGN §4.3 철회는 유지된다.

---

## 4. 교정된 헤드라인 (corrected headline)

> Production default(Q3, gamma, gateTau 2e-5)에서, 무플래그 6이미지 chafa gate는
> **+0.0035 SSIM**으로 통과한다(ours **0.9533** vs chafa **0.9498**) — 이제 문서화된
> 명령으로 재현 가능하다. Synthesized families를 켜면 ours는 **0.9556**에 도달해
> **+0.0058** 마진이 되지만, 이는 chafa 1.18.2가 glyph를 하나도 내지 않는 U+1FB00
> sextant 대역에 대한 공을 ours에게 돌린 값이다; strictly-fair 공유 repertoire(atlas +
> braille만, 양 엔진)에서 정직한 마진은 **+0.0034**다. Families는 견고한 승리로 남는다
> (overall이 synthetic 3/3과 zoo 6/6에서 상승; object-cell은 textured zoo에서
> **+0.015–0.020**); `+all`은 cands fix 이후 families의 깨끗한 상위집합이다. Cross-cell
> contour 기제는 null이다: orientation prior와 contour DP는 edgeSSIM을 개선하지 못하고
> (1/6, 0/6) families 단독 대비 오히려 엄격히 감소시킨다 — DESIGN §4.3 철회는 교정된
> 측정기 위에서 성립한다.

---

## 5. 전체 수치 표

### 5.1 Gate τ × λ_mdl sweep + 결정 (`bench/out/gate-sweep.md`, §1)

atlas: DejaVu Sans Mono @16, blocks(270 glyphs), cell 10×19, gamma. 이미지: 3 synthetics +
washout-stress + DamagedHelmet.

| τ | λ_mdl | synth overall | synth object | washout ink | DH overall | DH object | wall (ms, 5 img) |
|---|---|---|---|---|---|---|---|
| 0 | 0.02 | 0.9840 | 0.9457 | 100.00% | 0.9392 | 0.6143 | 9357 |
| **2e-5** | **0.02** | **0.9835** | **0.9448** | **99.35%** | **0.9388** | **0.6141** | **3284** |
| 2e-4 | 0.02 | 0.9814 | 0.9392 | 0.00% | 0.9385 | 0.6121 | 1423 |

**결정 (chosen: gateTau=2e-5, mdlLambda=0.02).**
- synthetic object-cell Δ(2e-5 vs 2e-4): **+0.0056** (기준 ≥ +0.002 → PASS).
- washout-proxy: 2e-5에서 +99.35%p 폭발, λ escalation(0.02→0.8)로도 못 잡음
  (MDL이 E_AC에 비례해 저에너지에서 소멸, §2.1) → **washout 성분 FAIL**.
- ink 폭발은 SSIM과 분리: λ=0.8로 ink 20%p를 걷어내도 washout SSIM은 0.9855→0.9852만 변함
  (faint glyph가 진짜 서브셀 그라디언트를 실음, §2.2).

### 5.2 Invisibility-collapse sweep + 결정 (`bench/out/gate-sweep.md`, MDL 대체)

production default 고정(2e-5, 0.02), `collapseThreshold`(u8)만 변화. SSIM cost = SSIM@0 − SSIM@T (양수 = collapse가 잃은 품질):

| collapseT | overall cost (max) | object cost (max) | invisible-ink (washout-stress) |
|---|---|---|---|
| 0 (OFF) | — | — | 99.35% |
| 8 | +0.0030 | +0.0066 | 0.00% |
| 12 | +0.0046 | +0.0120 | 0.00% |
| 24 | +0.0053 | +0.0321 | 0.00% |

**결정 (chosen: collapseThreshold=0 = OFF).** 규칙(모든 이미지에서 overall+object cost ≤
0.0005인 최대 threshold)을 만족하는 값이 없다 — 어느 threshold에서도 실제 그라디언트 내부의
faint glyph를 지우는 비용이 허용치를 넘는다("SSIM-neutral" 전제 반증, §2.2). 기제는 작동한다
(T=24에서 invisible-ink → 0.00% on all 6); washout-지배 입력을 위한 **옵트인**으로 유지.

### 5.3 Fairness 변형 3종 (`bench/chafa-gate.ts`, production default)

세 변형 모두 gateTau 2e-5, space gamma, 6이미지(3 synth + 3 Khronos zoo). chafa reference =
per-image `max(builtin, DejaVu) × best raster` = **0.9498** (세 변형 공통).

**(a) 무플래그 (production default 재현 명령):**

| image | ours Q3 | chafa builtin (best) | chafa DejaVu (best) |
|---|---|---|---|
| sphere | 0.9834 | 0.9832 (linear) | 0.9830 (linear) |
| torus | 0.9824 | 0.9821 (gamma) | 0.9820 (gamma) |
| spheres | 0.9846 | 0.9783 (linear) | 0.9779 (linear) |
| DamagedHelmet | 0.8677 | 0.8603 (gamma) | 0.8568 (gamma) |
| FlightHelmet | 0.9718 | 0.9697 (gamma) | 0.9691 (gamma) |
| BoomBox | 0.9301 | 0.9251 (gamma) | 0.9218 (gamma) |
| **mean** | **0.9533** | **0.9498** | **0.9484** |

**PASS +0.0035.** gate 재설계(τ 2e-4→2e-5)로 ours가 이제 **6/6 전부** 승리 — 이전에 지던
sphere(+0.0002)/torus(+0.0003)도 역전. Khronos 리드: DamagedHelmet +0.0074, FlightHelmet
+0.0021, BoomBox +0.0050.

**(b) full-capability families** (`--families`; ours = quadrant+sextant+braille, chafa granted
braille+sextant): ours **0.9556** vs chafa 0.9498 → **PASS +0.0058**. sextant는 chafa
no-op(§3 D6)이므로 이 마진은 ours에 대한 full-capability 값 — 각주로만 사용.

**(c) strictly-fair families** (`--families --strict`; 양 엔진 atlas + braille만, sextant를
양쪽에서 제거): ours **0.9532** vs chafa 0.9498 → **PASS +0.0034**. **정직한 대표값.**

### 5.4 Ablation — overall / object / edge (`bench/out/ablate-m3.md`, §4)

atlas: blocks(270) + synth families → augmented 585 raster; cell 10×19; gamma, Q3;
orientKappa=0.05, κ_c=0.15 (sweep midpoints).

**Overall SSIM**

| image | base | +families | +orient | +contour | +all |
|---|---|---|---|---|---|
| DamagedHelmet | 0.9388 | 0.9418 | 0.9385 | 0.9387 | 0.9413 |
| FlightHelmet | 0.9539 | 0.9562 | 0.9535 | 0.9539 | 0.9557 |
| BoomBox | 0.9570 | 0.9598 | 0.9564 | 0.9570 | 0.9592 |
| SciFiHelmet | 0.9567 | 0.9591 | 0.9566 | 0.9567 | 0.9590 |
| Fox | 0.9854 | 0.9863 | 0.9852 | 0.9854 | 0.9861 |
| Sponza | 0.9434 | 0.9448 | 0.9434 | 0.9434 | 0.9447 |
| sphere *(synth)* | 0.9834 | 0.9841 | 0.9834 | 0.9833 | 0.9841 |
| torus *(synth)* | 0.9824 | 0.9834 | 0.9824 | 0.9824 | 0.9834 |
| spheres *(synth)* | 0.9846 | 0.9858 | 0.9846 | 0.9846 | 0.9858 |

**Object-cell SSIM** (families의 이득이 집중되는 곳; textured zoo +0.015–0.020)

| image | base | +families | +orient | +contour | +all |
|---|---|---|---|---|---|
| DamagedHelmet | 0.6141 | 0.6333 | 0.6125 | 0.6139 | 0.6307 |
| FlightHelmet | 0.7219 | 0.7354 | 0.7197 | 0.7216 | 0.7331 |
| BoomBox | 0.7558 | 0.7720 | 0.7535 | 0.7557 | 0.7698 |
| SciFiHelmet | 0.7190 | 0.7346 | 0.7183 | 0.7188 | 0.7338 |
| Fox | 0.8400 | 0.8514 | 0.8386 | 0.8395 | 0.8486 |
| Sponza | 0.7686 | 0.7736 | 0.7684 | 0.7683 | 0.7733 |
| sphere *(synth)* | 0.9729 | 0.9745 | 0.9730 | 0.9729 | 0.9745 |
| torus *(synth)* | 0.8949 | 0.9008 | 0.8949 | 0.8950 | 0.9007 |
| spheres *(synth)* | 0.9667 | 0.9696 | 0.9667 | 0.9666 | 0.9696 |

**edgeSSIM** (§3.5 boundary band — contour 기제의 primary metric)

| image | base | +families | +orient | +contour | +all |
|---|---|---|---|---|---|
| DamagedHelmet | 0.4592 | 0.4686 | 0.4550 | 0.4573 | 0.4618 |
| FlightHelmet | 0.4731 | 0.4906 | 0.4682 | 0.4722 | 0.4833 |
| BoomBox | 0.5287 | 0.5533 | 0.5198 | 0.5275 | 0.5410 |
| SciFiHelmet | 0.4909 | 0.5062 | 0.4870 | 0.4893 | 0.4998 |
| Fox | 0.5428 | 0.5628 | 0.5418 | 0.5390 | 0.5594 |
| Sponza | 0.4634 | 0.4810 | 0.4635 | 0.4623 | 0.4798 |
| sphere *(synth)* | 0.5844 | 0.6005 | 0.5847 | 0.5840 | 0.6001 |
| torus *(synth)* | 0.3872 | 0.4049 | 0.3873 | 0.3867 | 0.4047 |
| spheres *(synth)* | 0.5607 | 0.5814 | 0.5607 | 0.5608 | 0.5816 |

**판독:**
- **families만 edgeSSIM을 올린다** (새 basis element). 전 이미지에서 `+families` >
  `+orient`, `+contour`, 그리고 `+all` < `+families`. cross-cell 기제는 새 기저를
  더하는 게 아니라 argmin을 최적에서 밀어내므로 edgeSSIM까지 깎는다 — §3.3
  selection-prior 정리의 두 번째 실증.
- **orient (κ=0.05):** edgeSSIM 개선 **1/6** (Sponza만 +0.0000; 나머지 −0.001~−0.009).
- **contour (κ_c=0.15):** edgeSSIM 개선 **0/6** (전부 −0.0009~−0.0038).
- overall-guard(base−0.002)는 두 기제 모두 준수하나, edgeSSIM 기준 자체를 못 넘음 → **FAIL, 철회**.

### 5.5 Synthesized-family usage (`+families` run, cells)

| image | grid cells | braille | sextant | braille+sextant % |
|---|---|---|---|---|
| DamagedHelmet | 7560 | 144 | 381 | 6.94% |
| FlightHelmet | 7560 | 105 | 436 | 7.16% |
| BoomBox | 7560 | 76 | 303 | 5.01% |
| SciFiHelmet | 7560 | 90 | 448 | 7.12% |
| Fox | 7560 | 11 | 138 | 1.97% |
| Sponza | 7560 | 356 | 381 | 9.75% |
| sphere | 7560 | 5 | 870 | 11.57% |
| torus | 7560 | 3 | 428 | 5.70% |
| spheres | 7560 | 3 | 709 | 9.42% |

sextant가 전 이미지에서 주력(braille 대비 3–290×). braille은 dot-lattice 텍스처(Sponza
356셀)에서만 두각 — §2.3의 반증 근거.

### 5.6 Side-by-side renders (reference | base | +all)

`bench/out/ablate-m3.md`의 패널 참조: `m3-{DamagedHelmet,FlightHelmet,BoomBox,SciFiHelmet,Fox,Sponza}.png`.

---

## 6. DESIGN 갱신

관련 DESIGN 교정은 §3.4(washout 서사 교체 — collapse 옵트인), §3.6(region-Gram 교차항 +
braille 예측 반증), §4.3(dated RETRACTION — 두 번째 3D-native null), §15.7(오픈 질문 종결),
§12 M3(verify 상태 한 줄)에 2026-07-05자로 반영했다.
