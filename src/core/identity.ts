// feat/ascii-identity-selection (spec §3) — structure-aware glyph selection prior.
//
// The prior adds  λ_id·u·D·P·(ρ_g − ρ*)²  to the Q2 selection score, pulling the chosen glyph's
// ink coverage ρ_g toward the appearance model's own luminance ramp ρ* on uniform cells and
// reverting to LS shape matching on structured cells. All quantities are O(1) from the per-cell
// stats already computed in match.ts (ST, eacScale) and the per-glyph coverage precomputed here —
// zero new pixel loops. Math lives here so it is unit-testable in isolation (test/identity.test.ts)
// and shared verbatim between the full scan and the gated flat path.

import type { Atlas } from './types.js';

export interface IdentityAtlas {
  rho: Float64Array;          // per-glyph ink coverage ρ_g = sumA/P, index-aligned to atlas.glyphs
  coverageOrder: Int32Array;  // glyph indices sorted by ρ_g ascending — DIAGNOSTICS ONLY (bench coverage histograms); the prior itself is soft over the full atlas (no hard subsetting, spec §3.2)
}

// Per-atlas coverage precompute (spec §3.1: ρ_g = sumA/P). O(G), once per atlas.
export function precomputeIdentity(atlas: Atlas): IdentityAtlas {
  const G = atlas.glyphs.length;
  const rho = new Float64Array(G);
  for (let i = 0; i < G; i++) rho[i] = atlas.glyphs[i]!.sumA / atlas.P;
  const coverageOrder = Int32Array.from({ length: G }, (_, i) => i).sort((a, b) => rho[a]! - rho[b]!);
  return { rho, coverageOrder };
}

// Target ink coverage ρ* (spec §3.2) — the appearance model's own density ramp: under
// pred = F·α + B·(1−α), a cell of mean luma Ȳ is DC-reproduced by full-lightness ink (L_F) over
// the fixed bg (L_B) at exactly coverage (Ȳ−L_B)/(L_F−L_B). Clamped to [0,1]. The caller guards
// L_F − L_B ≥ 0.5 (working luma) so the denominator is well-conditioned and bright-fg-on-dark-bg.
export function rhoStar(Ybar: number, LB: number, LF: number): number {
  const r = (Ybar - LB) / (LF - LB);
  return r < 0 ? 0 : r > 1 ? 1 : r;
}

// Uniformity weight u(s) = τ/(τ+s) (spec §3.1): 1 on flat cells, 0.5 at s=τ, →0 on structured
// cells. s = eacScale/(3P) is the mean per-pixel-channel AC energy — the SAME statistic the
// contrast gate thresholds. τ > 0. Monotone decreasing in s.
export function uWeight(s: number, tau: number): number {
  return tau / (tau + s);
}

// Selection-prior penalty for one glyph (spec §3.1 last term): λ·u·D·P·(ρ_g − ρ*)². D is the
// flat-cell contrast scale Σ_c(m_c − fbg_c)² (matches the scale of the Q2 SSE it competes with,
// spec §3.2). ≡ 0 whenever λ = 0 (byte-identical off) or D = 0 (cell equals the fixed bg). match.ts
// inlines this with the per-cell prefactor W = λ·u·D·P precomputed once; this form is the contract.
export function identityPenalty(rhoG: number, rhoStarVal: number, u: number, D: number, P: number, lambda: number): number {
  const d = rhoG - rhoStarVal;
  return lambda * u * D * P * d * d;
}
