# DESIGN — glyph-constrained 3D renderer (가칭 `ascii-3d`)

> 3D 모델을 고품질 reference로 렌더링한 뒤, 각 터미널 셀의 픽셀 패치를
> **실제 폰트 glyph의 연속(anti-aliased) coverage + per-cell fg/bg 색상**으로
> 최적 근사하여 ANSI/HTML/JSON sprite로 굽는 렌더러.
> "터미널에 이미지를 띄우는 것"(sixel/kitty graphics)이 아니라,
> **문자만으로 이미지를 근사하는 것** — glyph-constrained rendering.

---

