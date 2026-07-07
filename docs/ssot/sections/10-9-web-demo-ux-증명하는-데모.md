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

