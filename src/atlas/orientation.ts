// Atlas orientation precompute (M3-SPEC §3.1). Structure-tensor dominant angle +
// anisotropy per glyph, and per-side border ink profiles. Pure math over the
// existing Glyph fields (α, dxA, dyA); no font/canvas access. Consumed by the
// in-scan orientation prior (§3.3, phase 2) and the contour DP pairwise cost
// (§3.4, src/core/contour.ts).

import type { Atlas, Glyph } from '../core/types.js';

// Dominant gradient orientation of a scalar field, from its structure tensor
// J = Σ[gx² gxgy; gxgy gy²]. θ is the dominant-eigenvector angle, π-periodic in
// (−π/2, π/2]; anisotropy = (λ1−λ2)/(λ1+λ2) ∈ [0,1]; energy = λ1+λ2 = Σ|∇|².
export interface Orientation {
  theta: number;
  anisotropy: number;
  energy: number;
}

// Both glyph precompute (§3.1) and the per-cell edge field (§3.2) call this on
// their respective gradient fields so θ_g and θ_e live in the SAME convention —
// the §3.3 cos 2(θ_g−θ_e) term is only meaningful because of that shared frame.
export function structureTensor(gx: ArrayLike<number>, gy: ArrayLike<number>, n: number): Orientation {
  let Jxx = 0, Jyy = 0, Jxy = 0;
  for (let i = 0; i < n; i++) {
    const x = gx[i]!, y = gy[i]!;
    Jxx += x * x;
    Jyy += y * y;
    Jxy += x * y;
  }
  const trace = Jxx + Jyy;
  // eigenvalues of the symmetric 2×2: (trace ± sqrt((Jxx−Jyy)² + 4Jxy²)) / 2.
  const diff = Jxx - Jyy;
  const disc = Math.sqrt(diff * diff + 4 * Jxy * Jxy);
  const l1 = (trace + disc) / 2;
  const l2 = (trace - disc) / 2;
  const anisotropy = trace > 0 ? (l1 - l2) / trace : 0;
  // dominant eigenvector angle: tan 2θ = 2Jxy / (Jxx−Jyy).
  const theta = 0.5 * Math.atan2(2 * Jxy, diff);
  return { theta, anisotropy, energy: trace };
}

export function glyphOrientation(g: Glyph): Orientation {
  return structureTensor(g.dxA, g.dyA, g.alpha.length);
}

export function glyphOrientations(atlas: Atlas): Orientation[] {
  return atlas.glyphs.map(glyphOrientation);
}

// §3.3 orientation prior, evaluated for one glyph against a cell's edge field.
// Returns the (non-negative) amount to SUBTRACT from the selection score:
//   κ · w_e · a_g · max(0, cos 2(θ_g − θ_e)) · eacScale.
// π-periodic via cos 2Δ. Phase 2 (match.ts) applies this in-scan; kept here so
// the atlas-side math and the prior form live together and are testable alone.
export function orientationBonus(
  ori: Orientation, thetaE: number, wE: number, eacScale: number, kappa: number,
): number {
  const c = Math.cos(2 * (ori.theta - thetaE));
  return kappa * wE * ori.anisotropy * (c > 0 ? c : 0) * eacScale;
}

// One border strip's ink profile (§3.1). mass = fraction of the side length that
// is inked (Σα over the strip / sideLen ∈ [0,1]); pos = ink centroid along the
// side ∈ [0,1] (0.5 when the strip is empty — a neutral, no-bias default so the
// contour pairwise cost adds nothing where there is no ink to continue).
export interface SideProfile { mass: number; pos: number }
export interface BorderProfile { top: SideProfile; bottom: SideProfile; left: SideProfile; right: SideProfile }

// centroid/mass of a 1px strip sampled by an index fn along `len` positions.
function strip(len: number, at: (k: number) => number): SideProfile {
  let m = 0, wsum = 0;
  for (let k = 0; k < len; k++) {
    const v = at(k);
    m += v;
    wsum += k * v;
  }
  const pos = m > 0 ? wsum / (m * (len - 1)) : 0.5;
  return { mass: m / len, pos };
}

export function borderProfile(g: Glyph, cellW: number, cellH: number): BorderProfile {
  const a = g.alpha;
  return {
    top: strip(cellW, (x) => a[x]!),                          // row 0, along x
    bottom: strip(cellW, (x) => a[(cellH - 1) * cellW + x]!), // last row, along x
    left: strip(cellH, (y) => a[y * cellW]!),                 // col 0, along y
    right: strip(cellH, (y) => a[y * cellW + (cellW - 1)]!),  // last col, along y
  };
}

export function borderProfiles(atlas: Atlas): BorderProfile[] {
  return atlas.glyphs.map((g) => borderProfile(g, atlas.cellW, atlas.cellH));
}
