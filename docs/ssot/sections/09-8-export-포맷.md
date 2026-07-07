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

