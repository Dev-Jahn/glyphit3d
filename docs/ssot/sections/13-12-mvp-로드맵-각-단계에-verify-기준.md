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

