export interface LinearImage { w: number; h: number; data: Float32Array } // w*h*3, linear RGB, row-major

export interface FitStatsG { Saa: number; Sa1: number; S11: number } // glyph-side Gram entries (generalized)

export interface Glyph {
  ch: string; cp: number;
  alpha: Float32Array;                    // P = cellW*cellH, coverage [0,1]
  dxA: Float32Array; dyA: Float32Array;   // central-difference gradients of alpha, zero-padded at cell borders
  sumA: number;                            // Σα
  sumAA: number;                           // Σα²
  gradAA: number;                          // Σ(dxA²) + Σ(dyA²)
  ink: number;                             // Σ(|dxA|+|dyA|), then min-max normalized to [0,1] across atlas
}

export interface Atlas {
  cellW: number; cellH: number; P: number;
  fontPath: string; fontSize: number; ascent: number; // px at fontSize, from canvas TextMetrics
  glyphs: Glyph[];                          // glyphs[0] MUST be space (ch=' ')
  inkMin: number; inkMax: number;          // raw ink (Σ|dxA|+|dyA|) min/max across atlas — the scale glyph.ink was min-max normalized on. Families normalize their raw ink onto THIS scale so text/family MDL is comparable (DESIGN §3.6).
}

export interface GridCell { ch: string; fg: [number, number, number] | null; bg: [number, number, number] | null } // sRGB 0..255 ints

// §3.4 topK candidate emitted per cell when MatchOptions.topK>0. glyphIdx indexes
// atlas.glyphs (text scan only — families/gated cells emit their own single-entry
// list); score is the SAME selection score that picked the cell winner (so cand[0]
// == emitted glyph); F/B are the ALREADY-ENCODED sRGB u8 fg/bg for that glyph in the
// current quality mode, so the contour post-pass can write a GridCell directly. This
// interface is structurally identical to core/contour.ts's Candidate (kept separate
// so contour.ts stays a standalone phase-1 module).
//
// `ch` and `fgNull` carry the emitted-cell identity for the non-text winners (family
// wins, invisibility-collapse, gated flat cells) whose candidate is a single forced
// entry: `ch` names the emitted glyph directly (family/sextant/braille codepoints are
// NOT in atlas.glyphs, so glyphIdx cannot resolve them), and `fgNull` records that the
// emitted cell had fg=null (space/gated Q3/Q4). The contour post-pass reconstructs the
// cell as { ch: cand.ch ?? atlas.glyphs[glyphIdx].ch, fg: fgNull ? null : F, bg: B }, so
// contourPostPass(kappaC=0) reproduces the greedy emit byte-for-byte for every winner
// kind. Both default undefined → plain text candidates are unchanged.
export interface Candidate { glyphIdx: number; score: number; F: [number, number, number]; B: [number, number, number]; ch?: string; fgNull?: boolean }

export interface Grid { cols: number; rows: number; cells: GridCell[]; cellW: number; cellH: number; font: string;
  cands?: Candidate[][] } // per-cell topK (cols*rows), only when opts.topK>0 — consumed by the contour post-pass

export type ColorMode = 'mono' | 'fg' | 'fg-bg'
export interface MatchOptions {
  quality: 0 | 1 | 2 | 3 | 4;   // Q0..Q4 (DESIGN §6). quality implies colorMode: Q1=mono, Q2=fg, Q3/Q4=fg-bg
  space?: 'linear' | 'gamma';  // working space for fit/selection (DESIGN §3.1). default 'gamma' (predict-terminal); 'linear' = bake (opt-in)
  edgeLambda: number;          // λ_e, only used at Q4. default 0.35
  gateTau: number;             // contrast gate threshold on full per-channel E_AC = Σ_c(STT_c−ST_c²/P), per pixel-channel (÷3P). The gate statistic lives in the WORKING space (tau calibrated for gamma), NOT linear luma. default 2e-5 (options.ts is the SSOT)
  mdlLambda: number;           // ink complexity penalty weight. default 0.02
  fixedBg: [number, number, number]; // linear RGB, for mono/fg modes and Q0. default [0,0,0]
  fixedFg: [number, number, number]; // linear RGB, for mono mode. default [1,1,1]

  // Post-selection invisibility collapse (u8 units; default in options.ts, 0 = off). After the
  // winner (text glyph OR family pattern) is chosen, if its fitted fg/bg are visually
  // indistinguishable in the OUTPUT encoding — max-channel |F−B| (u8) < collapseThreshold — the
  // cell is replaced with space + the winner's coverage-weighted flat mean (sumA·F+(P−sumA)·B)/P
  // per channel (the exact flat fill matching the chosen prediction's DC). Applied in matchGrid
  // AFTER selection, before emit; Q1 (mono, fixed colors) exempt. SSIM-neutral by construction
  // (the replaced prediction was already near-flat) and it zeroes the invisible-ink proxy
  // deterministically. This REPLACES M3's soft MDL washout defense (λ·ink·E_AC), which was
  // FALSIFIED (bench/out/gate-sweep.md): that penalty scales WITH E_AC and so vanishes exactly in
  // the low-energy washout regime; this exact rule has full leverage there.
  collapseThreshold?: number;

  // Perceptual contrast floor (Round A ASCII-identity, feat/contrast-floor-fill). WORKING-space
  // luma units; default 0 = OFF = byte-identical output. In the fitted (non-gated) TEXT path,
  // when the winner's fg/bg luma separation ΔL=|luma(F−B)| falls below `contrastFloor`, the fit
  // is re-solved as a constrained LS: the fg/bg separation is pinned to ΔL=floor along the fit's
  // own chromatic axis and the DC term is re-solved (contrast lifted, cell mean preserved). If
  // that constrained residual exceeds a flat solid cell's, the glyph is demoted to space + bg
  // fill instead (fit.ts contrastFloorFit derives the rule). This is the OPPOSITE remedy to
  // collapseThreshold (which demotes faint glyphs); it makes dark-region glyphs legible rather
  // than removing them. A GLOBAL floor is known-harmful to reconstruction (DESIGN §3.4 M3
  // correction: faint |F−B|<24 glyphs encode real sub-cell gradients), so this is an explicit
  // aesthetic opt-in — keep 0 in every reconstruction bench/gate. Q1 (mono, fixed colors) exempt;
  // not applied to family/gated winners.
  contrastFloor?: number;

  // M1 AOV score-priors (all optional, all default off → M0 behavior unchanged; M1-SPEC §3).
  aov?: {
    shadingLuma?: Float32Array;  // gridW*gridH, WORKING-space luma of the albedo-free shading render (§4.1)
    objectId?: Uint16Array;      // gridW*gridH, per-mesh id, 0 = background (§4.2)
    albedo?: LinearImage;        // linear RGB, for the stylization variant only
    coverage?: Float32Array;     // gridW*gridH, silhouette coverage [0,1] — drives the §3.2 edge field / boundary gate
  };
  splitSelection?: number;     // η ≥ 0, default 0 (off). §4.1 fidelity variant: extra shading-luma scoring channel.
  antibleedKappa?: number;     // κ ≥ 0, default 0 (off). §4.2 boundary-cell object-id correlation bonus.
  styleAlbedoColors?: boolean; // default false. §4.1 stylization variant: refit selected glyph colors on albedo.

  // M3 synthesized families (M3-SPEC §2). default [] / absent → off, M0/M1 output
  // byte-identical. When non-empty, each listed family's exact region solve competes
  // with the text scan per cell in the same (SSE + λ_mdl·ink·scale) score space.
  families?: ('quadrant' | 'sextant' | 'braille')[];

  // M3 contour mechanisms (M3-SPEC §3). Both default off → output byte-identical.
  orientKappa?: number;  // κ ≥ 0, §3.3 in-scan orientation prior on boundary cells (uses aov.coverage/objectId, else 2D luma fallback).
  topK?: number;         // K ≥ 0, §3.4: also emit the top-K text candidates per cell into grid.cands (for the contour post-pass).

  // Palette-constrained color depth (DESIGN §6, CPU path only; core/palette.ts). Default absent
  // → truecolor, output byte-identical. Requires quality 3/4 (fg-bg). Per candidate glyph the fit
  // argmins over a DISCRETE palette (fg,bg) pair grid instead of the continuous optimum, scored by
  // the same sseAt (§3.2 (2)): 'theme16' = EXACT over 16×16 pairs; 'palette256' = APPROXIMATE
  // project-then-refine over xterm-256 (top-k nearest to the unconstrained optimum, k×k exact).
  // Not compatible with families/contour/topK/split/antibleed/style-albedo/collapse/orient (a
  // clean hook point for selection priors in the constrained activity space — none implemented).
  palette?: 'theme16' | 'palette256';
  paletteRefineK?: number; // palette256 refine width k (≥1); default 8 (options.ts).

  // feat/ascii-identity-selection (spec §3) — structure-aware glyph selection prior. 0 = off =
  // byte-identical output (SSOT default in options.ts). Requires quality 2 (fixed-bg fg fit) and
  // throws otherwise (no fallback), throws with families in v1 (the penalty is not yet forwarded
  // into solveFamily, which would rig the meta-selection), and throws when L_F−L_B < 0.5 working
  // luma (ρ* degenerates). Adds λ_id·u·D·P·(ρ_g−ρ*)² to the Q2 selection score in BOTH the full
  // scan and the gated flat path, pulling glyph ink coverage ρ_g toward the appearance model's own
  // luminance ramp ρ*=(Ȳ−L_B)/(L_F−L_B) on uniform cells (u≈1) and reverting to LS shape matching
  // on structured cells (u→0). O(1) per glyph on top of the existing dot product (core/identity.ts).
  identityLambda?: number;   // λ_id ≥ 0, preset 5
  identityTau?: number;      // τ_id > 0, uniformity knee (working per-pixel-channel AC energy), default 2.5e-4 (read only when identityLambda>0)

  // feat/identity-ascii-charset-coherence (spec) — selectable charset-coherence mode for the ASCII
  // identity aesthetic. Default 'none' (or absent) → BYTE-IDENTICAL to the plain identity prior path
  // (top invariant). Any non-'none' mode requires identityLambda>0 AND quality 2 (throws otherwise, no
  // fallback). Operates on OBJECT cells only (the gate/flat/background contract is unchanged). The ramp
  // set R (core/identity.ts rampSet) is the clean coverage-ordered ASCII glyph ramp:
  //   'ramp-bias'  — object-cell scan candidates restricted to R + normal LS shape score, with the ramp
  //                  pull widened (uniformity weight floored, u' = max(u, 0.5)); shape tie-breaks in R.
  //   'pure-ramp'  — object cell = argmin_{g∈R}(ρ_g−ρ*)²; no LS shape term. fg/bg via the Q2 color path.
  //   'smooth'     — full ASCII scan + neighbor-consistency penalty μ·[(ρ_g−ρ_left)²+(ρ_g−ρ_top)²] over
  //                  the already-decided raster-order left/top neighbors (μ = the cell's own λ·u·D·P).
  identityCoherence?: 'none' | 'ramp-bias' | 'pure-ramp' | 'smooth';

  // feat/shape-color-coupling (spec §4) — absent = off = byte-identical. Requires quality 2; throws
  // otherwise and throws with styleAlbedoColors (two competing color-rewrite passes). Rescales the
  // fitted fg by a hue-preserving luma gain k so the emitted cell DC-luma tracks the cell mean Ȳ
  // (coupled with the glyph's ink coverage ρ̄), then desaturates dim cells (luma-invariant, so the
  // DC guarantee survives). Applied per Q2 cell AFTER the fg fit and BEFORE the contrast floor
  // (spec §4.3 order: prior→fit→coupling→floor→collapse), to fitted-text winners, gated Q2 emits
  // and — for the cand[0]==emit invariant — every topK candidate (core/coupling.ts).
  coupling?: { strength?: number; satKnee?: number; satMin?: number; kMin?: number; kMax?: number };
}
