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

