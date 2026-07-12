# ADR-0003: ASCII-identity 미학 모드와 contrast floor를 도입한다 — 고정-bg 미학 목적 함수, selection-prior 정리 불변

- Status: accepted
- Date: 2026-07-10
- Round: 2026-07-10-ascii-identity
- SSOT sections affected: §3.4 (washout 방지 / gate·collapse 의미론) — 개정; §6 (색상 모델과 품질 사다리) — 개정; §3.2 (닫힌 형태 피팅), §3.3 (DC/AC 따름정리·selection-prior 일반화), §10 (평가 프로토콜, ADR-0002) — 참조
- Tasks: docs/contrast-floor-design-amendment (본 ADR), feat/contrast-floor-fill, feat/ascii-identity-selection, feat/shape-color-coupling, fix/contrast-floor-linear-space, spike/identity-guardrail-retune (등록), fix/contrast-floor-linear-exactness (등록)

## Context

사용자(2026-07-06)가 미학 피벗을 확립했다. ADR-0002 §5가 그 **평가 프로토콜**을 SSOT에
이관했고, 본 ADR은 그 피벗을 실제로 구현한 **메커니즘 일체(이번 라운드에 shipped)**를
정식 등재한다.

**미학 피벗의 근거.** 무제약 free-bg 재구성(Q3+)은 셀마다 두 색을 자유로 잡아 서브셀
그라디언트를 최대한 재현하므로 **구조적으로 pixel art로 수렴**한다 — 문자의 정체성이
사라지고 밝기 필드의 디더가 남는다. 사용자의 미학 목표는 **ASCII-identity**(문자가 문자로
읽히는 고정-bg 계열, Q2 최근접)다. 이는 재구성 최적화와 **명시적으로 다른 목적 함수**이며,
selection-prior 정리(무제약 truecolor에서 어떤 prior도 per-cell 재구성 메트릭을 개선 불가 —
§3.3, 2회 실증: docs/M1-RESULTS.md·M3-RESULTS.md)를 **건드리지 않는다**. 정리는 *재구성
메트릭 한정*이고, ASCII-identity는 그 정리가 다루지 않는 **별도 목적 함수**다. 따라서 두
축은 분리해 측정·판정한다(ADR-0002 §5). 본 ADR이 도입하는 어떤 것도 무제약 재구성 경로의
기본 동작을 바꾸지 않는다 — 전부 **default OFF**이고 무플래그 경로에서 byte-identical이다.

이 피벗을 실현하는 이번 라운드 산출물은 세 가지다: (1) contrast floor(어두운 영역의
검은-구멍/보이지 않는 잉크를 가시화하는 대비 하한 제약, feat/contrast-floor-fill), (2)
구조 인지 선택 prior(feat/ascii-identity-selection), (3) shape-color coupling(feat/shape-
color-coupling). (2)+(3)+(1)을 묶은 것이 `--identity` preset이다.

## Decision

### 1. contrastFloor — collapseThreshold 옆 두 번째 opt-in 미학 knob

§3.4의 M3 교정은 **전역 대비 하한이 재구성에 해롭다**고 못박았다: `|F−B|<24 u8`의 희미한
glyph는 실제 서브셀 그라디언트를 인코딩하는 재구성-양성 피처이며, 이를 제거하면 chafa gate가
반전한다. `contrastFloor`는 그 경고의 **명시적-제약 답**이다 — 재구성을 위해서가 아니라
미학(가시 glyph)을 위해, **옵트인으로만** 대비를 끌어올린다.

- **위치와 기본값**: `MatchOptions.contrastFloor`(src/core/types.ts), `collapseThreshold`
  바로 옆의 두 번째 opt-in 미학 knob. **모든 재구성 경로(bench/gate/parity)에서 기본 0 =
  OFF = byte-identical**. 데모 기본 0.06, `--identity` preset은 24/255≈0.0941 working luma
  (u8-24 가시성 임계). collapse와의 방향: `collapseThreshold`는 희미한 glyph를 **demote**
  (지움), `contrastFloor`는 어두운 영역 glyph를 **가시화**(끌어올림) — 반대 처방이다.
- **boost-or-demote 의미론**(src/core/fit.ts `contrastFloorFit`): 승자 glyph의 fg/bg 대비
  ΔL=|luma(F−B)|이 floor 미만이면, fit의 **자신의 chromatic 축을 따라**(hue 보존) AC를
  s=floor/ΔL로 스케일해 대비를 floor에 **pin**한다. pin은 feature가 건 등식 제약이므로 남는
  자유도는 DC(b) 하나뿐 — 이 b를 emit gamut box [0,1] **안에서 재해결**한다(§3.2가 out-of-
  gamut fit을 §3.4 제약 피팅으로 보내고, §3.4가 "clamp 대신 자유변수 재해결"을 요구하는 그
  규약을 그대로 따른다; near-black regime에서 사후 clamp는 luma(a')=floor와 평균을 조용히
  깨뜨린다). gamut이 허용하면 DC는 **평균 보존**(b*=mean−a'·ρ)이고, box가 비면(|a'|>1:
  Q3/Q4에서 floor 분리가 전 gamut 초과, 또는 Q2에서 고정 bg로 F'가 이탈) floor를 gamut 안에서
  못 맞추므로 **flat 셀(space+mean)로 demote**한다. keep vs demote는 제약 잔차 대 flat-fill
  잔차 비교로 결정(§3.2 (2)식 sseAt로 실제 emit되는 in-gamut b에서 채점) — 재구성을 flat
  셀보다 나쁘게 만들지 않을 때만 keep.
- **space-invariant**: floor는 **표시(sRGB) 공간의** luma 분리이므로 gamma·linear 두 working
  모드에서 **같은 지각 대비**를 뜻한다. contrastFloorFit이 floor를 채널별 sRGB slope로 working
  공간에 rescale한다(floorW = floor/scale). gamma 모드에서는 slope=1이라 raw working-space
  pin과 bit-identical. **주의(정직)**: linear 모드 rescale은 채널 평균에서의 slope를 쓰는
  **1차 근사**라 dark/sparse 극단에서 표시 대비가 floor를 최대 ~3.4 u8(14%) 미달할 수 있다 —
  필요 시 display-side 정확 평가로 개선(follow-up **fix/contrast-floor-linear-exactness**,
  minor). fit-space/raster-space 페어링 결함은 이미 수정됨(fix/contrast-floor-linear-space).
- **GPU 등가**: WebGPU Q3 경로는 GPU가 비싼 per-cell 선택을 하고, contrast floor는
  `matchPrepped`(web/src/webgpu/gpu-matcher.ts) 안의 **host per-cell post-pass**
  (web/src/webgpu/contrast-floor-post.ts, `applyContrastFloor`)로 적용된다. 이 post-pass는
  GPU가 올린 **동일 working-space target**에서 동일 closed form(fitFree/fitBox)과 동일
  contrastFloorFit을 재유도해 CPU 경로(src/core/match.ts)와 **셀 단위로 동일**한 emit을
  낸다(decision은 host f64 F/B에서 취해 ±1 u8 GPU/CPU 색 허용오차와 무관). floor=0이면 no-op
  → parity 경로 불변.
- **측정된 재구성 비용(ON일 때)**: chafa-gate mean **−0.0033**(0.9835→0.9802, 게이트가 chafa
  0.9812 아래로 떨어져 **PASS→FAIL로 반전**). 이는 §3.4 M3 invisible-ink 발견과 **정합**한다
  (floor가 재구성-양성 희미 glyph를 끌어올려 재구성을 미세하게 해친다 — 정확히 예측된 교환).
  gamut-fix 이전 측정은 −0.0054였다. **재현: `npx tsx bench/chafa-gate.ts --floor 0.06`**.
- **invisible-cell 효과(feature 목적)**: DamagedHelmet의 검은-구멍(보이지 않는 잉크) 셀
  **642 → 0** at floor 0.06. **재현: `npx tsx bench/floor-invisible.ts`**.

### 2. ASCII-identity 선택 prior + shape-color coupling + `--identity` preset

두 미학 feature는 **defaults OFF, byte-identity 실증**(λ=0 또는 강도=0이면 항등)이며, ADR-0002
§5가 확정한 대로 무제약 재구성을 **이기려 하지 않는다**. Q 사다리에서의 위치: 둘 다 **고정-bg
Q2를 대상으로 하는 미학 변조**로, §6 사다리와 직교한 opt-in preset(§6 개정 참조).

- **구조 인지 선택 prior**(src/core/identity.ts): Q2 선택 점수에
  `λ_id·u·D·P·(ρ_g − ρ*)²`를 더해, 선택 glyph의 잉크 coverage ρ_g를 appearance model 자신의
  밀도 램프 **ρ\* = (Ȳ−L_B)/(L_F−L_B)** (평균 luma Ȳ를 DC-재현하는 coverage, [0,1] clamp)로
  당긴다. 균일 가중 **u(s)=τ/(τ+s)** (평탄 셀 1, 구조 셀 0)로 **균일/밝은 셀엔 면적 큰 문자,
  미묘한 그라디언트엔 조절된 작은 문자**를 선택하고, 구조 셀에서는 LS shape 매칭으로 복귀
  한다. 새 pixel loop 없음(match.ts의 per-cell stats + per-glyph coverage precompute만 소비).
  이것이 coverage prior와 **ρ\* crossover**의 정확한 규칙이다.
- **shape-color coupling**(src/core/coupling.ts): glyph 선택+fg fit **후에** 적용하는 hue-보존
  변환. 셀 광량 ℓ(bake 경로는 셀 평균 shadingLuma, 아니면 Ȳ)로 fg의 **명도**(luma gain k:
  희소 glyph·밝은 셀 → k>1 밝힘, 밀한 glyph·어두운 셀 → k<1 어둡힘)와 **채도**(dim 셀 →
  greyer)를 변조한다. luma가 RGB에 선형이라 균일 스케일은 hue를, 채도 변환은 luma를 보존
  → clamp 미발동 시 **DC-luma 보장 luma(ρ̄·F_out+(1−ρ̄)·B)=Ȳ가 정확**. 실측: raster **DC-luma
  오차 1.02 → 0.29 u8**(coupling이 셀 평균색 재현을 오히려 개선).
- **`--identity` preset**(src/cli.ts): 세 멤버를 동시에 켠다 — 선택 prior(λ=5, τ=2.5e-4),
  coupling(defaults), contrastFloor=24/255. `--quality 2`를 **함의**(다른 명시 quality는 hard
  error). override 플래그(`--identity-lambda/-tau/--couple-*/--floor` 등)는 진단 sweep용이며
  수용은 defaults로만 판정(spec §6.4).
- **기본 coherence = pure-ramp**(2026-07-12 사용자 판정, feat/color-dither-toggle): charset
  일관성 노브(none/ramp-bias/pure-ramp/smooth, feat/identity-ascii-charset-coherence)의 4모드
  육안 비교에서 **pure-ramp만 글리프 램프가 일관**(나머지는 glyph 수프) → identity **CLI 기본
  coherence로 확정**(`--identity-coherence`로 override; matchGrid 명시-opts 기본은 'none' 유지라
  기존 재구성 경로는 불변). 색 dither는 `--identity-color-dither on|off`로 노출 —
  off=monochrome(fg=encode(fixedFg), coupling 미설정, 밝기는 pure-ramp 밀도가 나름).

### 3. 사전등록 결과와 수용 판정 (정직, verbatim — 완화 금지)

ADR-0002 §5 프로토콜(고정-bg regime + 사전등록 블라인드 A/B + 양면 정량 가드레일)에 따라
`npx tsx bench/identity-report.ts`로 관측 전 예측을 등록하고 실측했다. **결과를 그대로 싣는다:**

- **미학 목적은 달성**: readability **0.067 → 0.810**, full-block rate **0.920 → 0.177**,
  coverage-luma corr **0.112 → 0.516**(blocks charset). 문자 아이덴티티 프록시가 사전등록
  마진만큼 상승.
- **그러나 blocks에서 ADR-0002 §5 / spec §6.2 재구성 가드레일을 깬다**: SSIM **0.808 → 0.079**
  (하한 0.758); CAS p10 **0.152 → 0.012**(하한 0.092). charset별로는 **ascii는 Q2+A(선택
  prior 단독)가 PASS이나 preset(A+B+floor)은 FAIL**. blocks가 크레이터, ascii가 상대적으로
  안정 — 이 비대칭이 재조율의 단서다.
- **해석**: 이 결과는 spec 자신의 리스크 레지스터, 그리고 typography-vs-reconstruction 긴장과
  **정합**한다(가시 glyph를 강제할수록 서브셀 재구성을 교환한다 — invisible-ink와의 명시적
  trade-off, ADR-0002 §5). spec §6.4는 가드레일 파괴를 **새 라운드 트리거**로 지정한다:
  λ/τ/coupling 재조율 또는 ADR로 하한 개정. **register: spike/identity-guardrail-retune**
  (major). 지금 하한을 완화(soften)하지 않는다 — 그것이야말로 프록시 게이밍을 막는 가드레일의
  존재 이유다.
- **최종 수용은 사용자 직접 판정으로 확정**(목적이 미학이므로). **2026-07-11 사용자 판정**:
  pair-00(sphere)에서 feature 쪽을 선호 — 미학 방향은 옳음. 단 **charset 비일관성(블록·선문자·
  산발 glyph 혼재로 산만)이 blocker** → **ascii-first 일관성**이 우선(web demo ascii 모드가 최우선
  타겟, block은 옵션 유지), coupling의 색 dithering은 별도 on/off toggle로 노출. 후속 등록:
  `feat/identity-ascii-charset-coherence`, `feat/color-dither-toggle`.
- **봉인/블라인드 A/B 장치는 오버엔지니어링으로 폐기**(scripts/identity-ab.ts 삭제 — 사용자 지시
  2026-07-11). sha256 commitment·blind seed 형식주의는 솔로 프로젝트에 불요이며, 외부 리뷰(F5)도
  그 봉인이 base64+공개 seed라 실질 blinding이 아님을 지적했다. 미학 판정은 사용자 육안으로 충분.

**재현 명령**:

```bash
npx tsx bench/identity-report.ts                # 프록시 + 가드레일 표(Q2/Q2+A/Q2+B/Q2+A+B/preset)
npx tsx bench/floor-invisible.ts                # invisible-cell 카운트(DamagedHelmet 642→0 @0.06)
npx tsx bench/chafa-gate.ts --floor 0.06        # floor ON 재구성 비용(mean −0.0033, PASS→FAIL)
```

## Consequences

- **DESIGN §3.4 개정**: `contrastFloor`를 `collapseThreshold` 옆 **두 번째 opt-in 미학 knob**
  으로 등재(boost-or-demote 의미론 1문단 + 측정 비용 −0.0033 + 본 ADR 상호참조). §3.4의 M3
  전역-floor 경고는 그대로 유지 — 이 knob이 그 경고의 명시적-제약 답임을 명시.
- **DESIGN §6 개정**: **ASCII-identity 모드** 항목을 Q 사다리 옆에 추가(opt-in preset, 미학
  목적 함수, ADR-0002 §5 프록시/가드레일 + 사용자 직접 판정으로 평가, 가드레일 상태 정직 기재) + 본 ADR
  상호참조.
- **§3.2/§3.3 불변**: 닫힌 형태 피팅과 DC/AC 따름정리·selection-prior 일반화 서술은 개정하지
  않는다. contrastFloor는 자유 fit에 **명시 제약을 추가**해 optimum에서 의도적으로 벗어나는
  것이고(잔차는 §3.2 (2)식으로 재채점), 재구성 정리를 부정하지 않는다.
- **Follow-ups 등록**:
  - **spike/identity-guardrail-retune**(major): preset이 blocks에서 사전등록 가드레일 파괴 —
    spec §6.4 새 라운드 트리거. 다음 라운드에서 λ/τ/coupling 재조율 또는 하한 ADR 개정.
  - **fix/contrast-floor-linear-exactness**(minor): linear-space floor의 1차 근사가 dark/sparse
    극단에서 표시 대비를 최대 ~3.4 u8 미달 — 필요 시 display-side 정확 평가로.
- **테스트/타입 불변**: docs-only 변경. `npx tsc --noEmit` 0 errors, `npm run test` green 유지.

## Alternatives considered

- **전역(무조건) 대비 floor** — §3.4 M3 실측에서 재구성-해로움으로 반증됨(희미 glyph =
  재구성-양성). 기각하고 **opt-in 명시 제약**으로 채택(기본 0, 무플래그 경로 불변).
- **사후 clamp로 floor 적용**(pin된 a' 후 색을 gamut에 사영) — near-black regime에서
  luma(a')=floor와 평균을 조용히 깨뜨림(§3.4 규약 위반). 기각하고 **gamut box 안 DC 재해결**로.
- **미학을 CAS/재구성 지표로 판정** — selection-prior 정리 정면 위배(prior는 재구성을 못
  이김). 기각. 미학은 별도 목적 함수 + 블라인드 A/B + 양면 가드레일(ADR-0002 §5)로.
- **지금 가드레일 하한을 완화해 preset을 PASS로** — 프록시 게이밍(밀한 glyph 남발로 readability만
  올리기)을 잡는 가드레일의 존재 이유를 무력화. 기각하고 **새 라운드 재조율(spike)**로 이관.
- **hue-보존 pin 대신 6-DOF box-constrained floored LS 최소화** — fg/bg hue를 회전해 더 작은
  잔차를 살 수 있으나 문자색의 정체성(hue)을 바꿔 미학 목적과 상충. hue-보존 축 pin으로 확정
  (contrastFloorFit NOTE 참조).
