// feat/shape-color-coupling (spec §4) — shape-color coupling transform (pure functions).
//
// Applied per Q2 cell AFTER glyph selection + the fg fit, to the fitted fg F of the chosen glyph.
// A hue-preserving luma gain k rescales F so the emitted cell DC-luma tracks the cell mean Ȳ,
// coupled with the glyph's ink coverage ρ̄ (sparse glyph on a bright cell → k>1 brightens; dense
// glyph on a dim cell → k<1 dims). A luma-invariant desaturation then greys dim cells. Because
// luma() is linear in RGB, uniform scaling preserves hue and desaturation preserves luma, so the
// DC-luma guarantee luma(ρ̄·F_out + (1−ρ̄)·B) = Ȳ is EXACT whenever no clamp binds (spec §4.2).

import { luma } from './color.js';

type Vec3 = [number, number, number];

export interface CouplingParams { strength: number; satKnee: number; satMin: number; kMin: number; kMax: number }

// Preset defaults (spec §4.1). kMax=8 from the ramp identity k≈1/ρ̄ on flat cells: admits the
// full-lightness ramp down to Ȳ≈0.125.
export const COUPLING_DEFAULTS: CouplingParams = { strength: 1, satKnee: 0.20, satMin: 0.15, kMin: 0.25, kMax: 8 };

export function resolveCoupling(o: { strength?: number; satKnee?: number; satMin?: number; kMin?: number; kMax?: number } | undefined): CouplingParams {
  return { ...COUPLING_DEFAULTS, ...(o ?? {}) };
}

export interface CoupleResult {
  F: Vec3;              // coupled fg (working space), clamp01 per channel
  k: number;            // applied luma gain (after kMin/kMax + gamut caps)
  guarded: boolean;     // true = a guard fired and F was returned unchanged (spec §4.2)
  kClamped: boolean;    // true = k hit kMin or kMax
  gamutCapped: boolean; // true = k hit the hue-preserving gamut cap 1/max_c F_c
}

// Shape-color coupling of a single fitted fg (spec §4.1). ρ̄ = glyph ink coverage sumA/P, Ȳ = cell
// mean luma, LB = luma(fixed bg), ℓ = cell illumination (shadingLuma cell mean on the bake path,
// else Ȳ — spec §4.1). All working-space luma. Guards (return F unchanged): luma(F)<1e-4, ρ̄<1e-4,
// Ȳ<LB (cell darker than bg — impossible at the default black bg).
export function coupleCell(F: Vec3, rhoBar: number, Ybar: number, LB: number, ell: number, p: CouplingParams): CoupleResult {
  const lumaF = luma(F[0], F[1], F[2]);
  if (lumaF < 1e-4 || rhoBar < 1e-4 || Ybar < LB) {
    return { F: [F[0], F[1], F[2]], k: 1, guarded: true, kClamped: false, gamutCapped: false };
  }
  // luma gain: makes ρ̄·luma(k·F) + (1−ρ̄)·LB = Ȳ exactly (spec §4.2), i.e. k·ρ̄·luma(F) = Ȳ−(1−ρ̄)LB.
  let k = (Ybar - (1 - rhoBar) * LB) / (rhoBar * lumaF);
  let kClamped = false, gamutCapped = false;
  if (k < p.kMin) { k = p.kMin; kClamped = true; }
  else if (k > p.kMax) { k = p.kMax; kClamped = true; }
  // hue-preserving gamut cap: keep k·F_c ≤ 1 on every channel (scalar scale preserves hue).
  const maxF = Math.max(F[0], F[1], F[2]); // > 0 here (luma(F) ≥ 1e-4)
  const cap = 1 / maxF;
  if (k > cap) { k = cap; gamutCapped = true; }
  const Fp: Vec3 = [k * F[0], k * F[1], k * F[2]];
  const lp = luma(Fp[0], Fp[1], Fp[2]); // = k·lumaF exactly
  // saturation transfer (spec §4.1): dim cells → greyer ink. luma(1,1,1)=1 ⇒ luma-invariant.
  const sigma = p.satMin + (1 - p.satMin) * Math.min(1, ell / p.satKnee);
  const Fpp: Vec3 = [
    lp + sigma * (Fp[0] - lp),
    lp + sigma * (Fp[1] - lp),
    lp + sigma * (Fp[2] - lp),
  ];
  const Fout: Vec3 = [
    clamp01(F[0] + p.strength * (Fpp[0] - F[0])),
    clamp01(F[1] + p.strength * (Fpp[1] - F[1])),
    clamp01(F[2] + p.strength * (Fpp[2] - F[2])),
  ];
  return { F: Fout, k, guarded: false, kClamped, gamutCapped };
}

// Thin wrapper for the match.ts emit path (discards the diagnostic flags).
export function coupleFg(F: Vec3, rhoBar: number, Ybar: number, LB: number, ell: number, p: CouplingParams): Vec3 {
  return coupleCell(F, rhoBar, Ybar, LB, ell, p).F;
}

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
