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

