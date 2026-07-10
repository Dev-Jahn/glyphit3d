# DESIGN — glyph-constrained 3D renderer (가칭 `ascii-3d`)

> 3D 모델을 고품질 reference로 렌더링한 뒤, 각 터미널 셀의 픽셀 패치를
> **실제 폰트 glyph의 연속(anti-aliased) coverage + per-cell fg/bg 색상**으로
> 최적 근사하여 ANSI/HTML/JSON sprite로 굽는 렌더러.
> "터미널에 이미지를 띄우는 것"(sixel/kitty graphics)이 아니라,
> **문자만으로 이미지를 근사하는 것** — glyph-constrained rendering.

---

## 0. 문서 상태

- 2026-07-04 브레인스토밍 산출물. 코드 없음. 구현 전 founding design doc.
- 근거: Chafa/notcurses/libcaca 등 **소스 코드 레벨 검증**, 학술 문헌,
  WebGPU/폰트 스택 현황 조사 (2026 기준).
- 본 문서의 수학적 주장은 독립적인 적대적 재유도 검증을 통과했으며, 검증에서
  발견된 오류(제약 하 SSE 항등식, block family "exact" 해, WASM int8 dot 등)는
  반영 완료. 성능 최적화는 "프로파일링이 병목을 증명한 뒤에만"이라는 원칙으로
  본문에서 부록 A로 강등됨.

---

## 1. 정직한 선행기술 지형 — "무엇이 이미 존재하는가"

설계의 출발점은 **"per-cell glyph shape matching + 2색 최적화"는 새로운 아이디어가
아니라는 사실**이다. 소스 코드로 검증된 내용:

| 도구 | 실제 알고리즘 (검증됨) | 한계 |
|---|---|---|
| **Chafa** | glyph당 **8×8 1-bit** coverage bitmap(u64). 셀을 2색으로 thresholding → Hamming distance(popcount, AVX2)로 후보 1–8개 → 후보별로 fg/bg = 마스크 그룹별 **평균색**(고정 이진 마스크에 대한 LS 최적해) → 정확한 squared-RGB 오차로 최종 선택. `-w 9`면 **전수 탐색**. `--font`로 실제 폰트 로드 가능하나 8×8 1-bit로 다운샘플됨 | 8×8 1-bit이 품질 상한. 셀 독립 최적화. 3D 정보 없음. 프레임 간 일관성 없음 |
| notcurses | half/quadrant/sextant/octant/braille 블리터 — 서브셀 점유 thresholding으로 glyph **직접 결정**(탐색 없음), 셀당 2색 | 블록 계열 전용, shape 탐색 없음 |
| libcaca | 밝기 ramp + ordered dithering | 톤 매핑 |
| timg/viu/catimg | 반블록(▀▄) 트릭: 셀당 세로 2픽셀 | shape 탐색 없음 |
| kciter/ascii-3d-renderer.js | 소프트웨어 래스터라이저 + Lambertian 밝기 → **고정 7문자 ramp** | 우리가 이기려는 baseline 그 자체 |
| adamsky/globe | 손으로 그린 ASCII 텍스처를 UV 매핑 | 텍스처 샘플링 |
| PETSCII/ZX Spectrum/teletext 변환기 | "글리프 1개 + 2색/셀, RGB 오차 최소화" 전수 탐색 — **40년 된 아이디어** | 레트로 고정 charset |
| Acerola(AcerolaFX) 계열 GPU ASCII 셰이더 | DoG+Sobel edge 방향을 소수의 방향 문자에 lookup | 고정 lookup, LS 매칭 아님, 진짜 터미널 셀 아님 |
| 학술: Xu/Zhang/Wong SIGGRAPH 2010 | alignment-insensitive shape similarity로 **선화** ASCII (단색, 변형 허용) | 톤/색 없음 |
| 학술: Nakano et al. 2014 (IEEE) | GPU에서 per-cell 전수 glyph 탐색 (~57× CPU 대비) | 2D 이미지 입력, 구형 GPU, 단색 |

인접 경쟁자 실물 확인 완료 (2026-07-05): **GlyphCSS** = OBJ/glTF/GLB 폴리곤
메시를 monospace `<pre>` 그리드에 투영하는 **폴리곤 rasterizer** (per-cell
glyph shape 매칭·색 최적화 없음). **mayz/ascii-renderer** = **2D 이미지 전용**,
문자당 6-D shape vector의 nearest 매칭 (joint LS 아님, 3D 아님). 즉 GlyphCSS는
"3D→글자 그리드"를, mayz는 "shape 매칭"을 각각 갖지만 **교차점(3D + per-cell
glyph+색 LS 최적화)은 비어 있다** — 이것이 포지셔닝 한 줄이다.

### 1.1 그래서 진짜 novelty는 무엇인가 (방어 가능성 순)

1. **3D G-buffer 구동 매칭** — 조사한 범위에서, depth/normal/object-id/albedo
   **분리 버퍼가 glyph 선택에 개입**하는 변환기는 발견되지 않았다 (GlyphCSS/
   mayz 실물 확인 완료 — 위 참조, 주장 유지 확정). 실루엣과 텍스처 에지를
   구분할 수 있는 것은 3D 파이프라인뿐. **가장 강한 novelty 후보.**
2. **연속 coverage 폰트 프로파일 atlas + 진짜 alpha-composite LS** — Chafa의
   "1-bit 마스크 + 그룹 평균"을 "연속 α + 닫힌 형태 회귀"로 상향. 품질 상한을
   측정 가능하게 올리는 지점. 프레이밍은 반드시 *"continuous-coverage LS vs
   Chafa's 1-bit-coverage mean"* — "2색 피팅을 발명했다"가 아니라.
3. **시간적 일관성** — 조사한 변환기 중 프레임 간 glyph flicker를 다루는 것은
   없었다 (전수 조사는 아니므로 "세계 최초" 주장은 금지).
4. **GPU 실시간 (WebGPU GEMM 정식화)** — 개념이 아닌 엔지니어링 novelty.
   Nakano 2014가 GPU 전수 탐색의 선례이므로 "GPU화 최초"도 금지.

README 포지셔닝 문장:

> Chafa's symbol mode, but driven by real 3D G-buffers instead of a flat image,
> using a continuous grayscale font-profiled glyph atlas with true
> alpha-composite two-color least squares — made temporally stable and
> GPU-real-time.

**금지된 주장**: "glyph shape 매칭은 우리가 처음" / "per-cell 색상 최적화는
우리가 처음" / "2색 LS 피팅은 우리가 처음" / "GPU 전수 탐색은 우리가 처음".
전부 출하된 선행 코드/논문이 있다.

---

## 2. 아키텍처 개요 — 렌더러와 최적화기의 분리

```text
[Renderer A: 3D → buffers]              [Renderer B: buffers → glyph grid]
 glTF/OBJ/STL 로드                        glyph atlas (폰트 프로파일)
 카메라/조명/머티리얼 프리셋          →    per-cell 닫힌 형태 최적화 (GEMM)
 RGB + depth + normal + albedo            전역 보정 패스 (contour/dither)
 + object-id + alpha (+AO)                temporal 패스 (애니메이션)
        │                                        │
        └── cell-grid 정렬, aspect pre-warp      └──> JSON sprite grid (canonical)
                                                       ├─ ANSI (.ans)
                                                       ├─ HTML / SVG / PNG
                                                       ├─ asciinema / delta frames
                                                       └─ TUI adapters (Ratatui 등)
```

원칙:
- **Renderer A와 B는 완전히 분리** — B는 이미지+AOV만 받으므로 어떤 렌더러든
  (raster, path tracer, 외부 렌더 결과물) 앞단에 붙을 수 있다.
- **JSON sprite grid(v1, §8)가 유일한 canonical 산출물** — 모든 export와
  adapter는 이 그리드의 순수 함수. v1 스키마가 표현하지 못하는 기능(SGR
  attribute 등)은 v1 스코프 밖이다 — 스키마가 못 담는 기능을 export가 몰래
  만들지 않는다.
- ray tracing은 glyph 단계가 아니라 **Renderer A의 품질 옵션** (+ §4.7의
  glyph-aware 적응 샘플링은 post-1.0 tech demo).

---

## 3. 핵심 알고리즘 — 셀 모델과 닫힌 형태 최적화

### 3.1 Appearance model

셀 = P픽셀 패치 (예: 8×16=128). glyph g의 anti-aliased coverage
α ∈ [0,1]^P (target 폰트를 4–8× supersample 후 box-downsample). 터미널 셀 렌더링 모델:

```text
pred_i = F·α_i + B·(1−α_i)          (F=fg, B=bg, 채널별)
```

**두 개의 합성 방정식이 존재한다** — 다른 문제이므로 output target별로 명시 선택:
- **bake 모드** (PNG/HTML로 직접 래스터): 물리적으로 올바른 **linear-light** 합성.
  sRGB→linear 디코딩 후 피팅/합성, 마지막에 재인코딩.
- **predict-terminal 모드** (실제 터미널 출력 예측): 대부분의 터미널은 glyph AA를
  **gamma 공간에서 (잘못) 블렌딩**한다. 실제 보일 모습을 예측하려면 터미널의
  틀린 블렌딩을 복제해야 한다. 또한 현대 터미널은 box/block/braille 범위를
  폰트 무시하고 자체 합성하므로(§5.6), 이 모드의 atlas는 "합성 범위 = 이상
  마스크, text 범위 = 폰트 래스터"의 혼합이 맞다.

이하의 닫힌 형태 수식은 T가 어느 공간에 살든 무관하다 — 피팅과 채점이 같은
공간을 쓰기만 하면 된다.

### 3.2 닫힌 형태 fg/bg 피팅과 잔차

a = F−B, b = B로 치환하면 `pred = b + a·α` — 기저 {α, 1}에 대한 채널별 OLS.

```text
P  = 픽셀 수,  S_α = Σα_i,  S_αα = Σα_i²   ← glyph에만 의존 (atlas 빌드 시 사전계산)
S_T = ΣT_i,  S_TT = ΣT_i²                   ← 셀에만 의존 (프레임당 1회)
S_αT = Σα_i·T_i                              ← 유일한 (glyph, cell) 교차항 = dot product 1개

a = (P·S_αT − S_α·S_T) / (P·S_αα − S_α²)
b = (S_T − a·S_α) / P
```

잔차는 두 형태를 구분해서 쓴다 (**적대적 검증에서 잡힌 함정**):

```text
(1) 무제약 OLS 최적해에서만:   SSE = S_TT − b·S_T − a·S_αT      (회귀 항등식)
(2) 임의의 (a,b)에서 (ridge/clamp/box-constraint 이후 등):
    SSE = S_TT − 2(b·S_T + a·S_αT) + (P·b² + 2ab·S_α + a²·S_αα)
```

(1)은 잔차가 span{1, α}에 직교할 때만 성립한다. §3.4의 제약 피팅, gamut clamp,
ridge ε를 거친 (a,b)에 (1)을 쓰면 **SSE가 조용히 틀려 glyph 순위가 오염된다** —
반드시 (2)를 쓴다. (2)도 같은 6개 통계량만 필요하므로 여전히 O(1) epilogue다.
M0 단위 테스트에 "제약 경로의 SSE = brute-force와 일치" 케이스를 반드시 포함.

**따라서 "모든 셀 × 모든 glyph" 전수 탐색은 GEMM 하나다:**

```text
S_αT 행렬 = Masks(G×P) × Patches(P × 3N)    + O(1) epilogue per pair

N=4,800 (120×40), P=128, G=3,000, 3ch  →  ≈ 5.5 GMAC
  → GPU: sub-ms급.  CPU SIMD(naive full scan, 최적화 없음): ~1s
N=19,200 (240×80), G=2,000            →  ≈ 14.7 GMAC
```

**전수 정확 탐색이 그냥 가능한 문제다.** prefilter/shortlist는 필수가 아니라,
프로파일링이 병목을 증명했을 때의 옵션이다 (→ 부록 A). GPT류 설계가 성능
문제로 본 것은 사실 문제가 아니다.

퇴화 케이스: α가 상수에 가까우면(space, full block — Cauchy-Schwarz에 의해
분모=0은 정확히 α=상수일 때) ridge ε 정규화 + (2)로 채점. 피팅된 F/B가 gamut
밖이면 §3.4의 제약 피팅으로 재해결. palette 모드(256색)는 연속해 top-K를
팔레트에 스냅 후 (2)로 exact 재채점.

### 3.3 DC/AC 분해 관점 — glyph 선택은 구조 상관이다

α + (1−α) = 1이므로 상수(DC) 벡터가 피팅의 column space에 있다 → **무제약**
2색 피팅은 패치 평균을 항상 정확히 재현하고 잔차는 DC에 직교한다. 결과
(채널별): 평균 제거한 벡터를 T̃, α̃라 하면

```text
SSE_c = ‖T̃_c‖²·(1 − ρ_c²),   ρ_c = corr(α̃, T̃_c)
```

즉 glyph 선택은 **Σ_c ‖T̃_c‖²·ρ_c² 최대화** (AC 에너지 가중 상관 제곱 합)다.
주의 세 가지 (검증에서 정밀화됨):
- 최대화 대상은 ρ²(= |ρ|)다. 음의 상관도 좋다 — F/B가 스왑되며 (a<0) 흡수된다.
- 3채널에서는 "하나의 정규화 상관"이 아니라 위의 가중 합이다.
- 이 동치는 **무제약 피팅에서만** 성립한다. box-constraint/palette/mono 모드에서는
  깨지므로, 그 모드들에서 밝기·대비 불변성을 주장하지 말 것.

따름정리: 무제약 truecolor 모드에서 **DC 오차는 모든 glyph에 대해 항등적으로
0**이다. 따라서 "DC/AC 가중치로 구조를 우대한다" 같은 손잡이는 이 모드에서
아무것도 하지 않는 죽은 손잡이다 — DC/AC 재가중이 의미를 갖는 곳은 평균 재현이
깨지는 **제약 모드**(fg-only, palette-256, theme-16, clamp된 셀)뿐이다 (§6).

**Selection-prior 일반화.** 위 따름정리는 DC/AC 재가중이라는 특정 손잡이를 넘어
임의의 selection prior로 확장된다: 무제약 truecolor에서 전수 LS argmin은 이미 셀별
재구성 SSE를 정확히 최소화하므로, 선택 점수에 최적해와 무관한 항을 더하거나 후보를
게이팅하는 **어떤 prior도 per-cell 재구성 메트릭을 개선할 수 없다** — 최선이 tie,
그 외엔 argmin을 최적에서 밀어낼 뿐이다. Prior가 실제로 활동할 여지는 평균 재현이
깨지는 제약 모드, 그리고 per-cell 재구성이 못 재는 축(cross-cell 윤곽 §4.3, temporal
§4.9)에만 있다.[^m1-sel]

[^m1-sel]: M1 실증(docs/M1-RESULTS.md): shading-유도 선택(split)은 argmin을 실제로
바꾸나(FlightHelmet 148/1123 object cell) SSIM은 하락; object-id anti-bleed는 비경계
flip 0으로 정확히 작동하나 truecolor에서 tie. 둘 다 이 일반화의 예측과 일치한다.

### 3.4 Washout(퇴화 피팅) 방지

제곱오차는 잔차를 티끌만큼 줄이는 아무 구조나 보상하므로, 매끈한 영역이 "거의
안 보이는 희미한 문자들의 안개"가 되는 것이 ASCII 변환의 고전적 실패다. 방어:

1. **Contrast gate (주 방어)**: 패치 AC 에너지 `E_AC = S_TT − S_T²/P`가 임계
   이하면 그 셀은 정직하게 평탄하다 — space(=bg only) / full block으로 폴백.
   이미 계산된 통계량으로 비교 1회. 배경이 많은 장면에서 셀의 30–70%가 GEMM
   이전에 게이트아웃되는 부수 효과.
2. **Box-constrained fit**: F, B를 패치의 채널별 [min,max] 범위로 제약해 LS의
   외삽(범위 밖 색으로 희미한 고주파 glyph를 만드는 것)을 방지. **주의: 무제약
   해를 박스에 사영(clamp)하는 것은 최적이 아니다** — 한 변수가 경계에 붙으면
   다른 변수를 재해결해야 한다. 정확한 해는 변수별 {하한/상한/내부} 9-case
   active-set 열거 (각 case 닫힌 형태, 채널별). 채점은 반드시 §3.2 (2)식으로.
3. **MDL식 복잡도 페널티**: `λ·(glyph ink 복잡도)` — 같은 잔차면 깨끗한 평탄
   채움이 희미한 복잡 glyph를 항상 이기게.

> **교정 (2026-07-05, M3 실측):** 위 3-방어 서사를 실측으로 교체한다. (1) contrast
> gate는 품질 장치가 아니라 순수 **compute saver**다 — space glyph의 무제약 fit이
> 정확히 flat-fill 후보(b=mean, SSE=E_AC)라 전수 탐색이 이미 평탄 후보를 포함한다.
> 기본 τ=2e-5로 near-flat 셀만 skip. (2) MDL 페널티 `λ·ink·E_AC`는 E_AC에 비례하므로
> **저에너지 washout regime에서 정확히 소멸** — washout 방어로서 반증됨(λ escalation
> 0.02→0.8도 못 잡음). (3) 결정적 발견: `|F−B|<24 u8`의 "invisible ink"는 실제 서브셀
> 그라디언트를 인코딩하는 **재구성-양성 피처**다 — 제거하면 chafa gate가 **−0.0064로
> 반전**한다. washout은 결함이 아니었다. 미학적 통제가 필요한 입력은 `collapseThreshold`
> 옵트인 노브로(기본 off). 근거: docs/M3-RESULTS.md.

> **추가 (2026-07-10, ASCII-identity 라운드):** `collapseThreshold` 옆에 **두 번째 opt-in
> 미학 노브 `contrastFloor`**를 둔다(기본 0 = off, 무플래그 재구성 경로 전부 byte-identical).
> collapseThreshold가 희미한 glyph를 **지운다면(demote)** contrastFloor는 어두운 영역 glyph를
> **가시화한다(boost)** — 반대 처방이다. fitted 승자의 대비 ΔL=|luma(F−B)|가 floor 미만이면
> fit 자신의 chromatic 축을 따라(hue 보존) 대비를 floor에 pin하고 DC를 gamut box 안에서
> 재해결하며, gamut이 floor를 못 담으면 flat 셀로 demote한다(잔차는 §3.2 (2)식 재채점). 위 M3
> 경고(전역 대비 하한은 재구성-양성 희미 잉크를 벌해 해롭다)는 **그대로 유효**하고, 이 노브는
> 그 경고에 대한 **명시적-제약 답**이다: 재구성이 아니라 미학을 위해, 옵트인일 때만 켠다. 측정
> 재구성 비용(ON): chafa-gate mean **−0.0033**(0.9835→0.9802, 게이트 PASS→FAIL) — M3
> invisible-ink 발견과 정합. 의미론·space-invariance·GPU 등가·평가 프로토콜은 ADR-0003.

### 3.5 Perceptual loss가 닫힌 형태를 깨지 않는다 — 선형 필터 접기

Sobel/gradient/Gaussian pyramid 등 **선형 필터 L 기반의 어떤 loss도** 같은
구조에 접힌다: `L(pred) = b·L(1) + a·L(α)` — 여전히 (a,b)에 선형. √w_f 스케일한
필터 채널들을 패치와 마스크 양쪽에 쌓으면 joint fit은 그대로 채널별 2×2
정규방정식이고, 교차항은 **연결된 feature 벡터에 대한 dot product 1개**로 유지.
미분 필터는 L(1)=0이라 a만 제약하므로, b의 식별을 위해 plain 채널은 항상 유지.

단, 두 가지를 명시해야 구현 가능하다 (검증에서 잡힘):
- **셀 경계 규약**: 셀 가장자리에서 필터 서포트가 이웃 셀을 읽는다 — 이웃의
  glyph 선택에 의존하면 per-cell 닫힌 형태가 깨진다. **규약: target은 full
  support로 필터링, prediction은 셀 내부 support로 필터링(경계 바이어스 수용).
  셀 경계를 넘는 진짜 연속성은 §3.7 contour 패스가 담당한다.**
- **비용**: 필터 채널을 쌓으면 유효 P가 2–5× 커진다. §7 예산은 plain-L2 기준
  이며, edge-aware 모드(Q4)는 그만큼 비싸다 — 그래도 전수 탐색 가능 범위.

색공간: 합성은 linear RGB(물리). 지각적 색 오차는 **top-K 후보에 대한 진짜
Oklab 재채점**으로 처리한다 — 단순하고 정확하다. (Oklab을 Jacobian 선형화로
GEMM 안에 넣는 변형은 가능하지만 top-K 재채점과 중복이라 부록 A로 강등.)

### 3.6 블록/브라유 계열은 탐색이 아니라 열거

quadrant(2×2)/sextant(2×3)/octant(2×4)/braille(2×4 점)는 이상화하면 마스크가
이진 서브그리드다 → (fg, bg, pattern)의 joint 최적화가 **서브셀 평균색들의
가중 2-클러스터링**으로 환원된다(서브셀 내부 분산은 glyph 무관 상수).

- **Exact 해 = 2^k 이분할 전수 열거.** k ≤ 8이므로 보색 대칭 제하면 ≤128
  케이스 — 자명하게 싸다. 이것이 기본 경로.
- PCA 축 사영 + Otsu 임계값은 **근사 fast path일 뿐이다.** (3D 색공간 2-means의
  최적 분할면 방향은 PC1이 아닐 수 있음 — "exact"로 표기 금지. 적대적 검증에서
  교정된 사항.)
- **주의**: 실제 폰트의 braille/sextant glyph는 이상적 이진 서브그리드가 아니다
  (둥근 점, AA, 갭). 위 열거는 *모델*의 exact 해이므로, family 간 비교는 반드시
  **진짜 atlas coverage로, text glyph와 같은 loss 공간에서 재채점**한 잔차로 한다.

**Per-cell family meta-selection**: 각 셀에 대해 {text glyph(상관 탐색),
half-block, quadrant, sextant, octant/braille} 각 계열의 최적해와 재채점 잔차를
모두 계산(각각 저렴) → 최저 잔차 계열 선택 + 계열 전환 깜빡임 방지용 소량의
일관성 prior. 매끈한 그라디언트는 블록이, 실루엣은 방향 text glyph가, 미세
텍스처는 braille이 이긴다 — 단일 알파벳 고정보다 엄밀히 우월.

> **구현 교정 (2026-07-05, M3):** "disjoint ⇒ 교차항 0" 가정은 홀수 셀 분할(2×3
> sextant 등)에서 깨지는 idealization다 — 출하된 solver는 region Gram의 교차항을
> 정확히 반영한다(2^k brute-force 대비 **0.0 오차**, `test/families.test.ts`). braille의
> 그라디언트 우위 예측은 **반증**: 매끈한 그라디언트는 **quadrant**가 이기고 braille은
> dot-lattice 정합 구조에서만 승리한다; 실전 주력은 **sextant**(전 이미지에서 braille
> 대비 3–290×, docs/M3-RESULTS.md). families의 이득은 repertoire가 아니라 exact region
> solver다.

### 3.7 전역 최적화 — greedy per-cell이 실패하는 곳만 표적 수리

greedy의 실패는 두 곳: (a) 윤곽선이 셀 경계에서 끊기고 흔들림, (b) 평탄 영역
색상 shimmer. 전면 MRF 대신 표적 패스:

- **Contour DP**: G-buffer에서 실루엣 polyline 추출(§4.3) → polyline이 지나는
  셀들에 대해 Viterbi/DP로 (fit + 이웃 경계 coverage 연속성) 최대화.
  O(cells·glyphs) per contour. 눈이 "모델처럼 보이는가"를 판정하는 곳이
  정확히 윤곽선이다. §3.5의 셀 경계 바이어스를 구조적으로 보완하는 패스.
- **Color-smoothness ICM**: 소스가 매끈한 곳의 인접 셀 fg/bg 불연속에 페널티,
  ICM 1–2 스윕. top-K 리스트만 재평가하므로 저렴. (ICM은 국소해 — greedy
  폴백 유지.)

전각(2셀) glyph 타일링은 행별 DP로 정확히 풀리지만 터미널 호환성 리스크가 커서
post-1.0 (부록 A.5).

### 3.8 구조 보존 디더링 — DC만, 제약 모드에서만

셀 잔차를 DC(평균색 오차)와 AC(구조 오차 — glyph의 몫)로 분해해 **DC 잔차만**
error-diffusion (serpentine, linear light). AC까지 확산하면 고주파 노이즈가
shape 매처와 싸우는 고전적 "지글거림"이 된다.

**모드 조건부다** (§3.3 따름정리): 무제약 truecolor에서 DC 잔차는 항등적으로
0이므로 이 패스는 아무것도 확산하지 않는다. 실질적으로 load-bearing한 곳은
palette-256/theme-16/fg-only/clamp된 셀 — truecolor 파이프라인에 배선하고
"효과가 없다"고 당황하지 말 것.

추가 규칙: **depth/object-id 불연속을 넘는 확산 금지** — 실루엣 보존. 이것은
3D-aware 변환기만 가능한 규칙이다. 애니메이션에서는 error diffusion 대신
blue-noise ordered dithering (시간적 크롤링 방지).

---

## 4. 3D-native 확장 — 이미지 변환기가 원리적으로 못 하는 것들

프로젝트의 가장 방어 가능한 novelty. **4.1–4.3이 코어** (M1/M3에 배정),
4.4–4.6은 코어가 출하된 뒤의 폴리시(polish), 4.7–4.8은 post-1.0.

### 4.1 Albedo/shading 분리 [M1 코어]
단일 합성 이미지에서는 "어두운 albedo × 밝은 조명"과 "밝은 albedo × 어두운
조명"이 같은 회색으로 붕괴한다. 버퍼가 분리돼 있으면: **glyph(형태/밀도)는
shading 버퍼에서, fg/bg 색은 albedo 버퍼에서** — 색은 머티리얼을, 문자는 빛을
인코딩. 셀의 supersampled albedo에 2-클러스터링(§3.6과 같은 열거)으로 대비
최대의 2색 선택.

> **상태 (2026-07-04, M1 ablation):** **충실도 변형**(shading 채널로 glyph 선택을
> 유도, `splitSelection`)은 무제약 Q3과 제약 Q2 **양 regime에서 null/부정**(argmin은
> 실제로 바뀌나 재구성 SSIM은 하락) → **충실도 주장 철회**. **스타일화 변형**(색=albedo,
> `styleAlbedoColors`)은 유지 — 시각 전용, SSIM 무주장. 근거: docs/M1-RESULTS.md.

### 4.2 Object-id anti-bleed + depth-peeling 투명도 [M1 코어]
- 경계 셀에서 두 물체 색을 **평균 내지 않는다**(뭉갬의 주범). id 경계 방향에
  맞는 half/quarter block을 골라 fg=물체A 색, bg=물체B 색 — 셀 하나가 두 표면을
  깨끗하게 렌더.
- 투명/얇은 지오메트리는 depth-peel 2층 → **fg=근층, bg=원층**. 터미널 셀의
  2색 채널이 두 depth layer를 인코딩하는 데 정확히 대응된다. (depth-peel은
  M3 이후 옵션.)

> **상태 (2026-07-04, M1 ablation):** 기계 구현·검증 완료 — boundary cell에서만
> id-partition mask에 보너스, **비경계 flip 정확히 0**(κ=0.02/0.05/0.1에서 4/13/25 flip).
> 무제약 truecolor에서 boundary-cell SSIM은 **tie**, 제약 Q2에서 **미미한 양수**
> (+0.0006~0.0007, sweep 전 구간 악화 없음). 잔여 기대 역할: 디더 배리어(제약 모드,
> §3.8)·temporal(§4.9)·유사색 실루엣. 기본 off. 근거: docs/M1-RESULTS.md.

### 4.3 해석적 실루엣/크리즈 → 방향 prior [M3 코어]
depth 점프=가림 실루엣, id 점프=물체 경계, normal 각도 점프=크리즈로 **타입이
붙은** 에지를 서브셀 정밀도로 추출(이미지 Sobel은 AA에 뭉개지고 실루엣과 텍스처
에지를 구분 못함). 에지 셀에서는 stroke 방향이 에지 방향과 일치하는 glyph
(│ ─ ╱ ╲ ( ) 및 box-drawing)에 상관 점수 배율 prior. 내부 셀에서는 normal
derivative의 지배적 표면 흐름 방향으로 후보군 게이팅 — 구가 위도/경도 흐름의
stroke를 얻는다. "쉐이딩된 3D 형태로 읽히는가 vs 디더링된 밝기 필드인가"를
가르는 최대 단일 요인.

> **철회 (2026-07-05, M3 ablation — 교정된 측정기):** orientation prior는 zoo **1/6**,
> contour DP는 **0/6**에서만 edgeSSIM을 개선하고, `+all`은 전 6이미지에서 `+families`
> 단독보다 낮다. cross-cell 3D-native 주장은 **M1 truecolor null에 이은 두 번째 null**로
> 기록한다. edgeSSIM을 올린 유일한 기제는 **families**(새 기저 원소) — §3.3 selection-prior
> 일반화와 정합(prior는 argmin을 최적에서 밀어낼 뿐). 잔여 가설(temporal §4.9 / 지각 /
> 애니메이션 맥락)은 M4에서만 재검토. 근거: docs/M3-RESULTS.md.

### 4.4 Curvature/AO 해칭 [폴리시]
고곡률 능선 → 능선 방향 해칭 glyph, 저AO 공동 → 밀한/어두운 glyph. 펜화 NPR
해칭을 luma가 아닌 진짜 기하로 구동.

### 4.5 카메라와 그리드의 공모 [aspect pre-warp만 M1, 나머지 폴리시]
- 셀 종횡비를 **projection matrix에 pre-warp** — 원이 터미널에서 원으로.
  이것은 M1 필수 (없으면 모든 결과물이 눌린다). 비율은 하드코딩 0.5가 아니라
  폰트 프로파일 값(실측 0.40–0.50 분산, §5.6) 또는 런타임 질의.
- auto-framing(실루엣의 그리드 충전 최대화, 대칭축 스냅), 히어로 샷 뷰 선택
  (가시 실루엣 길이 채점)은 폴리시.

### 4.6 Glyph 표현력에 맞춘 셰이딩 프리셋 [폴리시]
toon 밴드 수 = glyph 밀도 레벨의 판별 가능 개수로 설정, 실루엣 셀에 rim light
보장, view-stable matcap. ASCII에는 `clay + strong rim + AO`가 잘 맞을 것으로 예상.

### 4.7 Glyph-aware 적응 ray tracing [post-1.0 tech demo]
샘플 예산을 **glyph 결정의 모호성**으로 배분: top-1/top-2 후보 점수 마진이 큰
셀은 이미 결정 완료 — 동결. 마진이 작은 셀에만 추가 레이. 수렴 판정도 픽셀
분산이 아니라 **선택된 glyph+색의 안정화**. 출력이 ~수천 개의 이산 결정뿐이라는
사실을 이용하는, 출력 도메인을 아는 렌더러만 정의할 수 있는 기준. "ASCII에
ray tracing을 얹었다"가 아니라 "glyph space가 요구하는 곳에만 광선을 쓴다".

### 4.8 Lighting-for-legibility [someday/maybe]
bake는 오프라인이므로 조명 파라미터를 최종 text-space 잔차에 대해 최적화하는
것이 원리적으로 가능하다. 비미분 파이프라인에 대한 black-box 최적화 = 연구
프로젝트 — 한 줄로만 기록해 둔다.

### 4.9 Temporal coherence [M4]
- 3D 파이프라인의 공짜 **motion vector로 이전 프레임 선택을 재투영**한 뒤
  hysteresis: 새 후보가 마진 δ 이상 이길 때만 glyph 교체. 회전 중 ghosting 없이
  sparkle 제거. (과도하면 끈적임, 부족하면 sparkle — 튜닝 창이 좁다는 리스크.)
- 멀티프레임 sprite는 프레임 간 **변경 셀만 delta 인코딩** (터미널 비디오 코덱).

---

## 5. Glyph atlas와 프로파일링

### 5.1 Renderable Glyph Set
"모든 문자"는 컨셉이고 구현은 **"target 폰트/렌더러에서 monospace 셀에 안정적으로
그려지는 glyph"**다. 필터: 실제 ink 존재, advance가 셀 폭과 일치, 셀 밖 과도
돌출 없음, tofu/fallback 아님, zero-width/combining 제외, wide 여부 태깅.
시작 세트: ASCII printable + Latin-1 기호 + box drawing + block elements +
geometric shapes + braille + shade. "aggressive Unicode" 모드는 후순위.

코드포인트 주의 (검증에서 교정): sextant는 **U+1FB00~ (Symbols for Legacy
Computing, Unicode 13)**, 2×4 **octant는 Unicode 16의 Symbols for Legacy
Computing Supplement (~U+1CD00 대역)** — 별개 블록이다. octant/supplement는
2026 현재 폰트·터미널 지원이 희박하므로 기본 세트에서 제외, capability 태그로만.

### 5.2 Atlas 전처리 (M0 최소 버전)
- 4–8× supersample 래스터 → 셀 해상도 box-downsample → 연속 coverage α.
- glyph별 사전계산: **α, S_α, S_αα, 정규방정식용 상수 — 이게 전부다.**
- dedup 클러스터링, DCT/PCA 사영, ink 복잡도 등은 그것을 소비하는 최적화
  (부록 A, §3.4의 MDL 페널티)가 실제로 들어올 때 추가. M0에 선행 구축 금지.

### 5.3 SGR attribute 확장 [post-1.0]
bold/italic/underline/strikethrough(+colored underline SGR 58 = 셀의 세 번째
색)는 atlas를 싸게 배가할 *가능성*이 있으나, 이득이 미검증(오픈 질문 §15)이고
터미널 capability 게이팅과 조합 폭발 관리가 따라온다. **JSON grid v1 스키마에
없다 = v1 기능이 아니다.** post-1.0에 실험.

### 5.4 폰트 프로파일
프로파일 = {폰트, 크기, 셀 종횡비, glyph coverage 집합, hash}. bake 산출물에
프로파일 hash를 임베드("Best viewed with JetBrains Mono 14px, truecolor").
JetBrains Mono/Cascadia/Iosevka 등 3–4개 번들 + 브라우저에서 "내 TTF로 프로파일
생성" 도구. (프로파일 공유 생태계 같은 이야기는 사용자가 생긴 뒤에.)

> **[ADR-0001, 2026-07-07 개정 — Contract B]** 프로파일은 coverage 집합뿐 아니라
> glyph별 사전계산 스칼라(S_α, S_αα, gradAA, ink)를 **1급 objective 데이터**로 싣는다:
> 매처의 점수 함수가 이 값을 직접 신뢰하며, 실시간 고해상도 계산 기준을 보존해 공유
> 프로파일이 실시간 프로파일과 **동일한 매칭을 재현**하도록 한다. 따라서 프로파일 hash는
> coverage만이 아니라 **전체 canonical payload**(coverage + 위 스칼라 + 폰트/셀 메타데이터)를
> 덮어야 한다 — coverage만 해싱하면 스칼라 변조가 봉인을 통과해 매칭이 조용히 틀어진다
> (외부 리뷰 F3). 기각된 대안(Contract A: coverage=truth, decode 시 스칼라 재계산)과 근거는
> ADR-0001.

### 5.5 Terminal calibration card [post-1.0 연구 아이디어]
터미널이 실제로 그리는 방식(AA/hinting/행간 갭/감마/테마 팔레트)을 테스트 패턴
스크린샷에서 역산하는 아이디어. 스크린샷 스케일링/모아레와 싸우는 독립된 CV
역문제라서 founding scope가 아니다. fidelity 증명은 bake/HTML/PNG 경로 +
프로파일 hash로 충분히 시작할 수 있다.

### 5.6 터미널 렌더링 현실 (조사 반영 — 2026 기준, 소스/스펙 검증)

**셀 지오메트리** (폰트 바이너리 실측):
- 셀 종횡비는 폰트별로 0.40–0.50+로 흩어진다: JetBrains Mono 0.455,
  Cascadia Code 0.504, Iosevka 0.400. 반블록(▀) 서브픽셀이 정사각형인 것은
  일부 폰트뿐(Cascadia ≈1.01, JetBrains 0.91, Iosevka 0.80) — **aspect
  pre-warp(§4.5)는 하드코딩 0.5가 아니라 프로파일/런타임 질의**
  (`TIOCGWINSZ` 픽셀 필드, `CSI 14/16 t`)로.
- 같은 폰트·같은 포인트라도 터미널마다 셀 높이가 다르다 (hhea/typo/win 중
  어떤 메트릭을 쓰는지가 다름). 행간 조정 옵션(kitty `modify_font`, VTE
  `cell-height-scale`, VS Code `lineHeight` 등)은 폰트 렌더 블록 glyph에
  갭 줄무늬를 만든다.

**터미널이 glyph를 자체 합성한다 (핵심 발견)**: WezTerm/kitty/alacritty/
Windows Terminal/xterm.js(VS Code)/foot/VTE/Ghostty는 box drawing(U+2500),
block elements(U+2580), 상당수의 Legacy Computing(U+1FB00, 일부 U+1CC00
supplement), braille(kitty/WezTerm), Powerline을 **폰트를 무시하고 직접
그리며 실제 셀 크기에 맞게 늘린다**. 설계 결론:
1. 블록/quadrant/sextant 기반 아트는 형상이 **결정론적이고 행간 갭에 면역** —
   §3.6 family의 이상적 이진 서브그리드 모델이 오히려 실물에 더 정확하다.
2. 반대로 text glyph(문자·기호)는 래스터라이저 스택(FreeType/CoreText/
   DirectWrite)마다 실제로 다르게 그려진다 — predict-terminal 모드의 atlas는
   "합성 범위 = 이상 마스크, text 범위 = 폰트 래스터"의 **혼합 atlas**가 맞다.
3. 음영 문자 ░▒▓는 합성하는 터미널과 폰트로 그리는 터미널이 갈린다 — 시각
   편차 예상 지점.
- JetBrains Mono는 braille/Legacy Computing glyph가 **0개**지만 합성 터미널
  에서는 문제없이 나온다 — "폰트 커버리지"와 "터미널에서 보임"은 별개 축.
- sextant(U+1FB00–1FB3B)는 현대 터미널에서 안전, **octant(U+1CD00–1CDE5,
  Unicode 16)는 아직 부분 지원** — sextant/half-block 폴백 필수 (§5.1과 일치).

**wcwidth/폭 함정**:
- box drawing U+2500–254B와 block U+2580–258F 다수는 East Asian Width
  **Ambiguous** — "ambiguous=wide"로 설정된 CJK 레거시 환경에서는 2셀이 되어
  그리드가 파괴된다 (기본값은 narrow; 설계 대상이 아니라 문서화 대상).
- 이모지/ZWJ 시퀀스는 터미널별 폭 판정이 실제로 갈린다(누적 오프셋 붕괴) —
  baked ANSI에서 사용 금지. 전각 CJK(EAW W/F)는 2셀로 신뢰 가능(시각적
  폰트 폴백 편차는 별개). grapheme 문제의 표준 해법은 mode 2027 (WT/WezTerm/
  Ghostty/foot 기본 on).

**truecolor/SGR**:
- truecolor(38;2/48;2)는 현대 터미널 전반 지원; 예외 macOS Terminal.app
  (256색). `COLORTERM=truecolor`가 최선의 감지지만 ssh/sudo로 전달 안 됨 —
  **256색(38;5) 폴백 파일을 항상 함께 생성** (비지원 터미널은 38;2를
  깨진 채로 파싱할 수 있어 터미널 측 degradation을 신뢰하면 안 됨).
  세미콜론 형식만 사용 (콜론 형식은 호환성 낮음).
- colored underline(SGR 58)은 kitty/VTE/foot/WezTerm/VS Code 등이 지원하나
  **Windows conpty가 시퀀스를 제거** — baked sprite에는 부적합, §5.3의
  post-1.0 판단을 재확인해 주는 사실.
- bold(합성 굵기/bright 시프트), faint(구현별 제각각)는 truecolor 아트에서
  휘도 인코딩 수단으로 쓰지 말 것 — RGB를 직접 계산한다.

**HTML export 규칙**:
- `line-height`를 셀 높이 px로 명시(브라우저의 `normal`은 폰트 메트릭 유래,
  1.2 아님), `letter-spacing: 0; white-space: pre; font-kerning: none;
  font-variant-ligatures: none; font-synthesis: none;`.
- **inline `<span>` 배경은 콘텐츠 영역만 칠한다** — 행간이 있으면 배경 줄무늬
  발생. 행 단위 블록 요소 또는 셀 크기 inline-block으로 해결.
- canvas `measureText`/래스터는 브라우저·OS 간 비결정적(핑거프린팅의 원리
  그 자체) — **브라우저 내 폰트 프로파일링은 per-browser 캘리브레이션이거나,
  reference rasterizer(FreeType)의 사전 계산 LUT를 배포**하는 쪽이 맞다.

**.ansi 크기와 규약**:
- 최악 ~40B/셀 (fg+bg 풀 SGR + astral glyph). 80×24 ≈ 75KB, 200×50 ≈ 390KB.
  SGR 상태 재사용(델타만 방출)으로 40–70% 절감 — 안정적인 색을 bg 쪽에
  배치하면 절감 증가. `REP`는 지원이 갈려 baked 파일에 사용 금지, 배포
  압축은 gzip(~10:1)에 맡긴다. 행 끝은 `ESC[0m` + `\r\n`(auto-wrap 의존 금지).
- SAUCE(128B 레코드, 폭/행수/iCE/aspect 플래그)는 ANSI-art 씬 도구 호환용 —
  post-1.0 (§8).

**투명성 규약** (§6/§8의 `bg: null`·skip과 1:1 대응 확인):
- 터미널에서 유일한 "투명 페인트"는 **기본 배경**(SGR 49/bg 미지정)이다.
  chafa(`--bg`/`-t`/`--probe`), notcurses(default color), ratatui
  (`Cell::skip`)가 전부 같은 모델.
- ANSI export 2모드: **overlay 모드** = 투명 런을 커서 전진(`CSI n C`)으로
  건너뛰어 기존 화면 보존(TUI 삽입용), **opaque 모드** = SGR 49 + space
  (cat/단독 뷰용).

---

## 6. 색상 모델과 품질 사다리 (Q0–Q5)

| 단 | 내용 | 용도 |
|---|---|---|
| Q0 | 고정 밝기 ramp (baseline strawman) | **데모 비교 전용** — CLI 미노출 |
| Q1 | shape 매칭, 단색 | 고전 ASCII 미학 |
| Q2 | + fg 색 피팅 (bg 고정) | TUI 삽입 기본 |
| Q3 | + fg/bg 2색 피팅 | 최고 fidelity |
| Q4 | + edge/multi-scale loss (§3.5) | 윤곽 보존 |
| Q5 | + 3D-aware (§4: 실루엣 prior, id 디더 배리어, family 선택) | 풀 파이프라인 |

- **CLI 매핑 고정: `--quality 1..5` = Q1..Q5.** Q0는 데모의 사다리 시연에만 존재.
- 각 단은 데모에서 SSIM 숫자와 함께 시연 — **데모가 곧 ablation study** (§9).
- 직교 축 두 개 (Q와 독립):
  - `charset`: ascii → +blocks → +braille → full-profile (purity 슬라이더)
  - `color`: `mono | fg | fg-bg` (채널) × `truecolor | ansi256 | theme16` (깊이)
- 제약 색 모드(ansi256/theme16, fg-only)에서는: 연속해 top-K → 팔레트 스냅 →
  §3.2 (2)식 exact 재채점. §3.3의 DC/AC 재가중과 §3.8의 DC 디더링이 실질
  작동하는 곳이 바로 여기다.
- 투명 sprite: alpha-weighted LS — 가중 회귀도 닫힌 형태이나 S_wα=⟨w,α⟩,
  S_wαα=⟨w,α²⟩가 셀 의존이 되어 **GEMM 3개** 필요 (α² 마스크 행렬을 별도
  저장; ⟨wT_c,α⟩는 3N열). 실루엣 걸침 셀은 커버된 픽셀만 피팅하고
  bg = 터미널 기본색(`bg: null`, §8) → 어떤 TUI 배경 위에도 합성 가능.
- **ASCII-identity 미학 모드**(opt-in preset, Q 사다리와 직교): 고정-bg Q2 위에 구조 인지
  선택 prior + shape-color coupling + `contrastFloor`(§3.4)를 얹은 `--identity` preset.
  **재구성이 아닌 미학 목적 함수**다 — 자유-bg는 pixel art로 수렴하므로 문자 정체성을 위해
  고정-bg 계열을 택하며, selection-prior 정리(§3.3)를 건드리지 않고 무제약 재구성을 이기려
  하지 않는다. 기본 OFF(byte-identical). 평가는 ADR-0002 §5 프로토콜(고정-bg regime + 양면
  정량 가드레일)에 **사전등록 블라인드 A/B**가 1차 판정. **가드레일 상태(정직)**: preset은
  미학 프록시를 크게 올리나(readability 0.067→0.810) blocks에서 재구성 가드레일을 깬다
  (SSIM 0.808→0.079 < 0.758; CAS p10 0.152→0.012 < 0.092); ascii는 선택 prior 단독은 PASS.
  spec §6.4 새-라운드 트리거로 재조율 대기(spike/identity-guardrail-retune). 상세: ADR-0003.

---

## 7. 성능 — "빠른 커널"이 아니라 "느린 곳을 피하는 배관"

### 7.1 매처는 병목이 아니다 — 기본 경로는 naive f32 전수 탐색
§3.2의 수치가 결론이다: MVP 워크로드(M2 목표 N≈8k, G≈500 ≈ 1.5 GMAC)에서
**tile된 f32 GEMM + 셀별 argmin 융합(또는 2-pass materialize-then-reduce:
8k×500 score 행렬은 채널당 ~16MB로 문제없음)**이면 끝난다. int8 양자화, DCT
shortlist, flash-attention식 fused kernel, temporal 캐시는 전부 **프로파일링이
매처를 병목으로 증명한 뒤에만** — 부록 A로 이동. (참고: N=19,200·G=5,000
전 채널을 통째로 materialize하면 채널당 384MB, 3채널 ~1.15GB — 그 규모에
가면 융합이 필요해진다는 것이지 MVP의 문제가 아니다.)

### 7.2 진짜 병목 후보와 대응
1. **Canvas 2D fillText로 20k 셀 그리기 (10–30ms+)** — naive ASCII 렌더러의
   숨은 지배 비용. → **instanced textured quad 1 draw call** (<0.5ms),
   matcher가 instance buffer를 GPU 상에서 직접 씀 (readback 자체를 생략).
2. **동기 readback stall** → 결과는 셀당 8B(glyph u16 + fg/bg RGB) ≈ 150KB만
   async double-buffered map (1프레임 지연 허용).
3. **escape 문자열 CPU 조립** → 색상 불변 시 SGR 생략(RLE), 실시간 터미널은
   프레임 diff + 커서 점프로 변경 셀만.
4. 파이프라인 전체 GPU 상주: 모델을 cell-grid×patch 해상도(예: 1280×1920,
   ~2.5Mpx)로 직접 렌더 → matcher가 텍스처로 샘플 → instance buffer 기록.

### 7.3 예산 (M2 목표 규모, naive f32 전수)
```text
reference render     ~0.4ms
matcher (f32 전수)    ~1–3ms       (Q4 edge 채널 스택 시 P′ 배율만큼 증가)
display (quads)      ~0.4ms
합계                  60fps 여유
```
CPU 폴백(WASM): §3.2의 ~1s는 naive 전수 기준 — bake에는 충분, 인터랙티브가
필요하면 부록 A의 가속을 그때 켠다.

---

## 8. Export 포맷

**JSON sprite grid v1이 canonical** — 모든 export는 이것의 순수 함수:

```json
{
  "version": 1,
  "cols": 120, "rows": 40,
  "cell": { "width": 8, "height": 16, "aspect": 0.5 },
  "font": { "family": "JetBrains Mono", "size": 14, "profileHash": "…" },
  "color": { "channels": "fg-bg", "depth": "truecolor" },
  "cells": [ { "ch": "▓", "fg": [220,210,180], "bg": [12,13,16] } ],
  "frames": [ { "camera": { "yaw": 0 }, "delta": [[137, { "ch": "▒", "fg": [200,190,170], "bg": null }]] } ]
}
```

- `bg: null` = 터미널 기본 배경(투명 셀 규약, §6). `cells` 배열의 `null` 원소 =
  **skip 셀**(칠하지 않음 — ratatui `Cell::skip`/ANSI 커서 전진과 1:1, §5.6).
- ANSI export는 투명 처리 2모드: **overlay**(skip 런을 `CSI n C`로 건너뜀,
  TUI 삽입용) / **opaque**(SGR 49+space, `cat` 단독 뷰용). truecolor 파일에는
  항상 256색(38;5) 폴백 파일 동반 (§5.6).
- `color.channels`(mono/fg/fg-bg)와 `color.depth`(truecolor/ansi256/theme16)는
  직교 축으로 분리 (§6과 일치).
- SGR attribute는 **v1에 없다** — v1 기능이 아니라는 뜻이다 (§5.3). 스키마가
  버전드이므로 v2에서 `attrs` 비트마스크 확장 가능.

| 포맷 | 용도 | 단계 |
|---|---|---|
| ANSI .ans (truecolor + 256 폴백, RLE) | `cat`으로 터미널에, TUI 삽입 | **MVP** |
| HTML (인라인 스타일, 폰트 명시) | 블로그 임베드, 픽셀 diff 측정 | **MVP** |
| PNG (bake 모드 래스터) | 소셜 공유 — ANSI는 붙여넣기에서 죽는다 | M2 |
| SVG (`<text>`) | README/문서 — 줌에도 crisp | 수요 시 |
| asciinema .cast / delta frames | 턴테이블 애니메이션 | M4 |
| Ratatui adapter (`Sprite::from_grid`) | 첫 TUI adapter — Rust 코어·크레이트 배포·타깃 사용자 정렬. Ink/Textual/Bubble Tea는 수요(PR)가 당기게 | M5 |
| SAUCE 메타데이터 | ANSI-art 씬 호환 | post-1.0 |

CLI: `ascii3d bake model.glb` 무인자 호출이 아름다운 결과를 stdout으로
(`| less -R`이 첫 사랑의 순간). `--cols --charset --color --view
--quality 1..5`(=Q1..Q5), `--format ansi,html` fan-out, `--watch`.

---

## 9. Web demo UX — "증명하는 데모"

- **Un-blur reveal scrubber**: 같은 프레임버퍼 위 와이프 슬라이더, 좌=native /
  우=glyph, 셀 그리드에 실루엣 정렬. 첫 로드에 2초 자동 스윕. **"squint" 토글**
  (양쪽 Gaussian blur)에서 둘이 구분 불가능해지는 것이 진짜 증명.
  공유되는 순간은 "오 ASCII 멋지다"가 아니라 "잠깐, 오른쪽이 텍스트라고?"
- **Quality ladder** (Q0→Q5): 클릭마다 crossfade + **실시간 SSIM 숫자**가
  단마다 오른다. 이 시퀀스 자체를 README 히어로 GIF로 pre-bake.
- **Diff heatmap**: per-cell perceptual delta를 적→녹 틴트, 헤드라인 수치
  ("97.3% perceptual match"). 엔진이 약한 곳(에지, 얇은 피처)을 숨기지 않고
  보여준다 — 그리고 이 코드가 곧 dev-time 품질 게이트.
- 슬라이더가 곧 문서: charset purity를 드래그하면 glyph 수와 fidelity 숫자가
  실시간 trade — 메커니즘이 스스로를 설명.
- URL fragment에 {모델 ref/hash, 카메라, 설정} 인코딩한 permalink. 백엔드 없음.
- 갤러리 = 정적 manifest에 PR로 추가 (CC0 모델 존: teapot, Suzanne, dragon,
  DamagedHelmet…). GitHub Pages로 무료·불멸.

---

## 10. 검증과 벤치마크

- **Headline metric — CAS (Cell-AC Structure, ADR-0002)**: 텍스트 출력을 같은
  atlas로 재래스터한 뒤, **셀을 창으로** DC(평균)를 제거한 대비·구조상관
  `cs=(2σxy+C2)/(σx²+σy²+C2)`(gamma-luma, C2=(0.03·255)²)를 **object mask**(렌더러
  AOV `coverage`/`objectId`, 없으면 2D 이미지 fallback = 셀 평균 luma Otsu +
  경계-소수 극성(테두리 다수 클래스=배경) + 1-셀 dilation) 위에서 **분포로** 보고한다 — headline은 하위 percentile(p05/p10)과
  AC-에너지(σy²) 가중 평균(wmean). 무제약 truecolor 2색 피팅은 셀 DC를 항등적으로
  재현하므로(§3.3) mean SSIM의 휘도항이 셀마다 ≈1로 포화하고, 매끈한 배경이 전-창
  평균을 0.98대에 고정해 glyph 서브셀 구조를 소수점 3–4자리로 압축한다(Q3↔Q4 구분
  불가의 원인). 따라서 **mean SSIM은 가드레일로 강등**한다 — 품질 주장의 단일 기준이
  아니라 "재구성을 무너뜨리지 않았다"의 하한 감시자. 참조 구현 `bench/cell-ac.ts`
  (지표·마스크·집계) + `bench/structure-report.ts`(Q1–Q4·chafa 재baseline, chafa-gate
  형제 진입점 — 게이트 출력 불변); 계약·anti-gaming·invisible-ink 준수는 ADR-0002.
- **Chafa 게이트 (M0 통과 조건, hard gate)**: 같은 reference 이미지를 Chafa
  `-w 9 --symbols <동일 세트>` + 동일 색상 제약으로 변환해 같은 metric으로
  비교. **벤치 세트 전체 평균 SSIM에서 Chafa를 넘지 못하면 M1로 진행하지
  않는다** — 원인 규명이 우선이다. 이기지 못하면 "ultra-fidelity"는 마케팅이다.
- **이 벤치마크가 증명하는 것의 정직한 범위**: 입력이 평면 이미지이므로 이
  비교는 **novelty #2(연속 coverage LS)와 Q4(edge loss)만** 검증한다. 3D-native
  이득(novelty #1, §4)은 Chafa와 비교 불가능하며 **내부 ablation**(Q5 vs Q4,
  §4 기능 on/off)으로 별도 증명한다. "Chafa를 이겼다"를 "3D라서 좋다"의
  증거로 쓰지 말 것.
- **Model zoo CI**: Khronos glTF-Sample-Assets에서 DamagedHelmet(표준 스모크),
  FlightHelmet(멀티파트), BoomBox(고밀도 노멀), Sponza(대형 씬), SciFiHelmet
  (고폴리), Fox(스킨/애니) — bake 후 metric 회귀 테스트.
- **닫힌 형태 피팅 단위 테스트**: 무작위 패치에 대해 brute-force 색상 그리드
  탐색과 일치 확인 — **무제약 경로와 제약 경로(§3.2 (2)식, 9-case box fit)
  모두**.
- **미학(ASCII-identity) 태스크 평가**(feat/ascii-identity-selection,
  feat/shape-color-coupling): 재구성이 아닌 **별도 목적 함수** — selection-prior
  정리(§3.3)상 미학 feature는 무제약 truecolor 재구성을 이길 수 없고 이기려 하지도
  않는다. **고정-bg(Q1/Q2) regime**에서 사전 등록 블라인드 A/B 시각 판정을 1차 기준으로,
  SSIM·CAS floor(회귀 금지)와 ASCII-identity 프록시(object 셀 glyph 가독률 = space·invisible
  |F−B|<24·full-block 아닌 셀 비율)를 **논리곱 수용 조건**으로 판정한다. 상세 프로토콜·근거
  ADR-0002.
- 애니메이션(M4): glyph 전환율(flicker metric)을 동일 SSIM에서 임계 이하로 — 단
  이제 "동일 SSIM"은 CAS 가드레일과 함께 읽는다(SSIM은 headline이 아니라 가드레일).

---

## 11. 구현 스택

**권고: 2-트랙, TS-first — 단 M0는 GPU도 3D도 없이.**

- **M0**: 순수 TypeScript CPU 구현 (three.js/WebGPU 불필요 — PNG 입력 이미지
  처리일 뿐이고, naive 전수도 bake에는 ~1s면 충분하다). 무거운 인프라를 가장
  덜 필요한 마일스톤에 앞당겨 얹지 않는다.
- **M1부터**: three.js **WebGPURenderer**(MRT로 G-buffer, TSL). 주의: WebGPU
  경로의 `readRenderTargetPixelsAsync`에 2025년 시점 버그 이력 있음(blank
  RenderTarget #31658, sRGB 생성자 #31654 — 착수 시점에 상태 재확인) → 버전
  고정 + readback 명시 테스트. path-traced reference는
  three-gpu-pathtracer(WebGL 기반이지만 성숙)를 전처리로.
- **M2부터**: WGSL compute matcher + instanced quad 디스플레이.
- **Track 2 (native CLI, M5)**: Rust + wgpu — **같은 WGSL 커널이 native와
  브라우저에서 실행**되는 검증된 패턴. 폰트 래스터는 fontdue로 충분(단일
  glyph에는 shaping/HarfBuzz 불필요). wasm 번들 ~5MB → wasm-opt 필요.
  알고리즘이 TS에서 확정된 뒤에만 착수 (조기 Rust화는 실험 속도를 죽인다).
- WebGPU 지원 현황(2026): Chrome/Edge/Safari 26 기본, **Firefox Linux 미지원**
  — `navigator.gpu` feature-detect + CPU 폴백 고지 필수.

---

## 12. MVP 로드맵 (각 단계에 verify 기준)

### M0 — image→glyph 최적화기 코어 (순수 TS/CPU, 3D 없음)
PNG 입력 → 최소 atlas(§5.2) → 닫힌 형태 피팅(무제약+제약) → contrast gate →
HTML/ANSI export + diff heatmap.
- verify (전부 통과해야 M1 진행):
  - (a) 피팅 단위 테스트: 무제약/제약 경로 모두 brute-force와 일치.
  - (b) 3D 렌더 스크린샷 256×256 → 120×40 변환, **Q0–Q4 사다리 나란히 비교** —
    Q3/Q4가 육안+SSIM으로 명확히 우월.
  - (c) **Chafa hard gate (§10)**: 동일 charset/색 제약, 벤치 세트 평균 SSIM 우위.

### M1 — 3D static bake + 첫 3D-native 증명
glb drag&drop → three.js G-buffer → 최적화기 → sprite export. **aspect
pre-warp(§4.5) + albedo/shading 분리(§4.1) + object-id anti-bleed(§4.2) 포함** —
차별화 테제를 가장 싼 값에 최전선에서 검증한다.
- verify: model zoo 6종 bake; §4.1/§4.2 **on/off ablation에서 SSIM 및 육안
  개선 확인** (개선 없으면 3D-native 테제 재검토); re-rasterize SSIM 기록.

### M2 — 인터랙티브 데모 + 품질 사다리
WebGPU matcher(naive f32 전수), un-blur scrubber, Q-ladder + live SSIM, permalink,
PNG export.
- verify: 중급 dGPU에서 N≈8k/G≈500 60fps (naive 커널로); Playwright 스모크.

### M3 — 3D-aware 품질 완성 (Q5)
실루엣/크리즈 방향 prior(§4.3), id 디더 배리어(§3.8), family meta-selection
(§3.6), contour DP(§3.7).
- verify: zoo에서 Q4 대비 SSIM/edge 보존 ablation 개선 수치 기록.
- **verify 상태 (2026-07-05):** 기준 1 **PARTIAL**(품질 성분 PASS, washout-proxy FAIL →
  collapse 옵트인 대체) / 2 **PASS**(families, 결정적) / 3 **FAIL**(contour edgeSSIM null →
  §4.3 철회) / 4 **PASS**(100 green, e2e 8/8). **품질 목표 달성, cross-cell 테제 철회.**
  근거: docs/M3-RESULTS.md.

### M4 — temporal + 애니메이션 export
motion-vector hysteresis, delta frames, asciinema.
- verify: 동일 SSIM에서 flicker metric 임계 이하.

### M5 — native CLI + Ratatui adapter
`ascii3d bake` (crates.io), `ascii3d-ratatui`.
- verify: 동일 입력 → 웹/native 동일 JSON grid. **주의: 부록 A의 int8 경로를
  쓰는 경우 WASM/GPU 간 byte-exact가 불가능하므로(A.2) 양자화 공차 기반 비교로
  정의.** naive f32 경로끼리는 golden file 교차 검증.

### Post-1.0 (명시적 스코프 아웃)
glyph-aware 적응 path tracing(§4.7), lighting 최적화(§4.8), SGR attribute
채널(§5.3), terminal calibration card(§5.5), wide-glyph 타일링(부록 A.5),
부록 A의 가속 일체(프로파일이 요구하기 전까지), GPU 바이트스트림 생성,
나머지 TUI adapter들(커뮤니티 PR로), SVG/SAUCE, 이미지/비디오 입력
(**정체성 훼손 — 3D 입력이 유일한 진짜 차별화다**).

---

## 13. 리스크 레지스터

| 리스크 | 대응 |
|---|---|
| 셀당 2색 병목은 근본적 (3색+ 영역은 표현 불가) | 블록/braille 서브셀 계열 + 기대치 명시 |
| "native처럼 보임"은 bake 모드에서만 완전 통제 가능 (터미널 AA/감마/행간 드리프트) | bake/predict-terminal 모드 분리(§3.1) + HTML/PNG를 증명 매체로 |
| atlas가 폰트+크기에 결합 | 프로파일 hash 임베드(§5.4) |
| Firefox Linux WebGPU 부재 | feature-detect + CPU 폴백 |
| **분해 불가능한 전역 perceptual loss를 도입하면 닫힌 형태/GEMM 구조가 무너진다** (제곱오차가 GEMM 그 자체다 — 위험은 그걸 버리는 쪽) | perceptual은 (a) 선형 필터 접기(§3.5) 또는 (b) top-K 재채점으로만 |
| Chafa 게이트 실패 가능성 — 연속 coverage의 마진이 작을 수 있음 | M0에서 즉시 실측; 지면 원인 규명이 최우선 (그래서 hard gate) |
| 하이엔드 Unicode 결과물이 "ASCII art"가 아니라 "블록 모자이크"로 보임 | charset purity 슬라이더를 1급 UX로 — 미학 선택권을 사용자에게 |
| 솔로 취미 프로젝트 스코프 폭발 | 백엔드 없음(정적 호스팅), adapter 1개, 부록 A는 프로파일 증명 후에만, post-1.0 목록 준수 |
| GlyphCSS / mayz ascii-renderer 등 미검증 경쟁자 | **착수 전 실물 확인**, novelty #1 문구 조건부 유지 |
| octant 등 최신 Unicode 블록의 폰트/터미널 지원 희박 | capability 태그 + 기본 세트 제외 (§5.1) |

---

## 14. 이름

`ascii-3d`는 설명적이지만 몰개성 + SEO 침수. 후보: **Polyglyph** (poly+glyph,
3D 함의), **Glyphtrace** (ray tracing 변형에 조응), Glyphsmith, Chromoglyph.
`Glyphcast`는 동명 ASCII 스튜디오가 존재한다고 조사됨 — 이 제외 사유 자체도
착수 전 crates.io/npm/GitHub 가용성 확인과 함께 재검증할 것. 바이너리 이름은
발견성 위해 `ascii3d` 유지 가능.

결정 (2026-07-05): **Glyphit3D** (패키지/repo `glyphit3d`, CLI `glyphit`) — 전 채널 가용성 확인 완료.

---

## 15. 오픈 질문

1. Chafa 대비 연속 coverage LS의 실제 SSIM 마진 — M0의 첫 실측이 프로젝트의
   운명을 결정한다.
2. §3.5 경계 규약(내부 support prediction)의 바이어스가 실제 품질에 미치는 영향.
3. contour DP의 이득이 greedy+방향 prior 대비 얼마나 큰가 — M3 ablation.
4. text glyph 마스크 집합의 실제 rank — 부록 A.1을 켤 일이 생기면 그때 실측.
5. SGR attribute 채널의 실질 이득 vs 조합 폭발 (post-1.0 실험).
6. coverage 중심 기반의 싼 admissible prune이 존재하는가 — 검증에서 기존
   주장은 기각됨(엄밀한 형태는 S_αT 자체를 요구). 새 유도가 없으면 휴리스틱
   이상을 주장하지 말 것.
7. object/lit 셀 피팅 갭 vs chafa (~0.004 SSIM, masked-SSIM으로 국소화됨) —
   후보 원인: 셀당 2색 제약이 specular highlight에서 포화, 실루엣 셀의
   gate/MDL 상호작용; M1의 3D-aware 기능(albedo/shading 분리 §4.1)이 자연히
   개선하는지 먼저 관찰 후 별도 대응 결정.
   - M1 실측: **3D selection prior로는 닫히지 않음**이 확인됨(§3.3 일반화, docs/M1-RESULTS.md).
     남은 후보는 fit/atlas 측 — charset 확대(braille), multi-scale loss, atlas AA 정합.
   - M2 병행 실측: **charset 확대도 무효** — DejaVu는 braille glyph가 0개(preset이 blocks와
     동일)이고, full(+Latin-1 94자)은 전 이미지 SSIM이 4자리까지 동결된 채 비용만 1.25×.
     추가 국소화: Khronos 텍스처 렌더에선 우리가 object 셀 +0.0063 리드 — 잔여 갭은
     **매끈한 합성 렌더의 물체 내부**에 산다. 차기 가설: contrast gate가 저대비 내부
     그라디언트 셀을 평탄화하는 비용 (M0의 gateTau=0 +0.0030과 정합) → gate를 "AC 임계
     prefilter"에서 "flat-fill SSE vs best-glyph SSE 직접 비교"로 교체 검토(M3), washout
     방어는 MDL이 담당. 별개: braille은 폰트 커버리지와 무관하게 터미널 자체 합성(§5.6)
     이상 마스크로 predict-terminal 모드에 도입 가능.
   - **M3에서 종결**: gate 재설계(synth object-cell **+0.0056**)와 synthesized families로
     합성 물체 내부 갭을 폐쇄 — 6이미지 chafa 마진 strictly-fair **+0.0034** / full-capability
     +0.0058 (무플래그 +0.0035, ours 6/6 승리). washout 방어는 MDL이 아니라 §3.4 교정대로
     처리. 오픈 질문 종결. 근거: docs/M3-RESULTS.md.

---

## 부록 A — 가속 옵션 (프로파일링이 매처를 병목으로 증명한 뒤에만)

> §3.2/§7의 결론: MVP 규모에서 naive f32 전수가 이미 프레임 예산 안이다.
> 아래는 G를 수천 이상으로 키우거나(aggressive Unicode), CPU 폴백을
> 인터랙티브하게 만들거나, N을 4배 이상 키울 때를 위한 선반 위의 부품이다.

### A.1 DCT/PCA admissible shortlist
dot product는 정규직교 변환에 보존된다. truncated 기저(r≈16–32)에서
`true_dot = approx_dot + ⟨tail(α̃), tail(T̃)⟩`이고 Cauchy-Schwarz로
`|오차| ≤ ‖tail(α̃)‖·‖tail(T̃)‖` — **glyph별 tail norm은 정확히 사전계산
가능**하므로(집계 특이값 에너지가 아니라 per-glyph tail norm이 bound다)
`근사점수 + bound ≥ 현재 최적`인 glyph만 남기는 shortlist는 진짜 최적해를
보장 포함한다. 이후 top-K만 full-P exact 재채점. 비용 3·N·G·P →
3·N·G·r + 3·N·P·r + 3·N·K·P. 전제(글리프 집합의 낮은 rank)는 실측 후 신뢰.

### A.2 int8 양자화 (GPU dot4U8Packed / WASM relaxed-SIMD)
~4× 처리량 + 대역폭 절반. 단: (a) linear-light 패치의 암부 정밀도를 깎는다 —
그림자 영역 품질 검증 필수. (b) **WASM `i32x4.relaxed_dot_i8x16_i7x16_add_s`의
두 번째 피연산자는 7-bit** — 0–255 coverage를 그대로 넣으면 구현 정의 결과
(플랫폼별 상이). WASM 경로는 coverage를 0–127로 양자화해야 하고, 따라서
GPU(dot4U8Packed, 8-bit)와 **byte-exact 일치가 불가능** — 교차 검증은 공차
기반으로 (§12 M5).

### A.3 Fused streaming kernel (규모가 커지면)
[N,G]를 materialize하지 않고 GEMM과 argmin을 융합: workgroup이 셀 타일을
shared memory에 상주시키고 glyph 타일을 스트리밍, 레지스터에서
(best_sse, best_glyph) running reduction (flash-attention 패턴). WebGPU 보장
workgroup storage 16KB에 맞춰 타일 조정. N=19,200·G=5,000·3ch(채널당 384MB,
합 ~1.15GB) 규모에서 필요해진다.

### A.4 Temporal shortlist 캐시
궤도 카메라에서 셀 signature(S_T, S_TT, 저차 계수)가 안 움직이면 이전 top-K만
재채점, N프레임마다 강제 full scan으로 드리프트 바운드. popping 리스크 관리 필요.

### A.5 Wide-glyph(전각 2셀) 타일링 DP
행별 exact 타일링: `DP[0]=0, DP[1]=best_single(1),
DP[i]=max(DP[i−1]+best_single(i), DP[i−2]+best_wide(i−1,i))` — 행 분리 가능·
셀 국소 점수라는 조건 하에 정확. 터미널 wcwidth 비호환 리스크 → HTML export 전용.

### A.6 Oklab Jacobian 닫힌 형태 (top-K 재채점의 대안)
검증 결과 구조가 예상보다 강하다: 지각 메트릭 M=JᵀJ는 기저 {1,α}가 채널 공유라
정규방정식에서 **소거**되어 피팅 색은 RGB 피팅과 동일하고, SSE만 tr(M·R)로
바뀐다 (R = 잔차 교차 공분산, 셀별 6개 교차 모멘트 S_{T_c T_c'} 추가 필요).
즉 GEMM 구조 유지 가능. 다만 top-K 진짜 Oklab 재채점이 더 단순하므로 기본
경로는 그쪽이다.
