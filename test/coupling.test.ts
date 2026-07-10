import { describe, it, expect } from 'vitest';
import { coupleCell, coupleFg, resolveCoupling, COUPLING_DEFAULTS } from '../src/core/coupling.js';
import { luma } from '../src/core/color.js';

// V4 (spec §4.2) — the shape-color coupling transform derivations, tested in isolation.

const P = COUPLING_DEFAULTS;
const dc = (F: [number, number, number], rhoBar: number, LB: number): number =>
  rhoBar * luma(F[0], F[1], F[2]) + (1 - rhoBar) * LB;

describe('exact DC-luma preservation in gamut (spec §4.2)', () => {
  it('luma(ρ̄·F″+(1−ρ̄)·B) = Ȳ when no clamp binds, hue preserved, desaturation applied', () => {
    // chromatic F, dim ℓ (exercises desaturation), unclamped k, in-gamut.
    const F: [number, number, number] = [0.6, 0.4, 0.2];
    const rhoBar = 0.5, Ybar = 0.2, LB = 0, ell = 0.05;
    const r = coupleCell(F, rhoBar, Ybar, LB, ell, P);
    expect(r.guarded).toBe(false);
    expect(r.kClamped).toBe(false);
    expect(r.gamutCapped).toBe(false);
    expect(Math.abs(dc(r.F, rhoBar, LB) - Ybar)).toBeLessThan(1e-6);
  });
});

describe('luma gain direction (spec §4.2)', () => {
  it('k>1 for sparse+bright (uncapped)', () => {
    // rhoBar·v < Ȳ < rhoBar keeps k>1 below the gamut cap.
    const r = coupleCell([0.4, 0.4, 0.4], 0.5, 0.3, 0, 1, P);
    expect(r.k).toBeGreaterThan(1);
    expect(r.kClamped).toBe(false);
    expect(r.gamutCapped).toBe(false);
  });
  it('k<1 for dense+dim', () => {
    const r = coupleCell([0.5, 0.5, 0.5], 0.9, 0.2, 0, 1, P);
    expect(r.k).toBeLessThan(1);
    expect(r.k).toBeGreaterThan(P.kMin);
  });
});

describe('desaturation is luma-invariant (spec §4.1)', () => {
  it('luma(F_out) = k·luma(F) to 1e-9 (in gamut, strength=1)', () => {
    const F: [number, number, number] = [0.6, 0.4, 0.2];
    const r = coupleCell(F, 0.5, 0.2, 0, 0.05, P);
    expect(Math.abs(luma(r.F[0], r.F[1], r.F[2]) - r.k * luma(F[0], F[1], F[2]))).toBeLessThan(1e-9);
  });
});

describe('range + gamut caps honored (spec §4.1)', () => {
  it('kMax clamp (below the gamut cap)', () => {
    // maxF=0.1 ⇒ cap=10 > kMax=8; raw k=20 ⇒ clamped to kMax.
    const r = coupleCell([0.1, 0.1, 0.1], 0.05, 0.1, 0, 1, P);
    expect(r.k).toBe(P.kMax);
    expect(r.kClamped).toBe(true);
    expect(r.gamutCapped).toBe(false);
  });
  it('kMin clamp', () => {
    // raw k=0.1/(0.9·0.9)=0.1235 < kMin.
    const r = coupleCell([0.9, 0.9, 0.9], 0.9, 0.1, 0, 1, P);
    expect(r.k).toBe(P.kMin);
    expect(r.kClamped).toBe(true);
  });
  it('hue-preserving gamut cap 1/max_c(F_c)', () => {
    // raw k=2.5, kMax=8 (no k-clamp), cap=1/0.8=1.25 binds.
    const r = coupleCell([0.8, 0.8, 0.8], 0.3, 0.6, 0, 1, P);
    expect(r.k).toBeCloseTo(1.25, 12);
    expect(r.gamutCapped).toBe(true);
    expect(r.kClamped).toBe(false);
    // hue preserved: F_out ∝ F before desaturation; here ℓ/knee≥1 ⇒ σ=1 (no desat) ⇒ F_out=k·F.
    expect(r.F[0]).toBeCloseTo(1, 12);
  });
});

describe('guards return F unchanged (spec §4.2)', () => {
  it('luma(F)<1e-4, ρ̄<1e-4, Ȳ<L_B all bypass the transform', () => {
    for (const args of [
      [[0, 0, 0], 0.5, 0.5, 0, 0.5] as const,       // luma(F) too small
      [[0.5, 0.5, 0.5], 0, 0.5, 0, 0.5] as const,   // ρ̄ too small
      [[0.5, 0.5, 0.5], 0.5, 0.1, 0.2, 0.5] as const, // Ȳ < L_B
    ]) {
      const [F, rhoBar, Ybar, LB, ell] = args;
      const r = coupleCell([...F] as [number, number, number], rhoBar, Ybar, LB, ell, P);
      expect(r.guarded).toBe(true);
      expect(r.F).toEqual([...F]);
    }
  });
});

describe('strength lerp endpoints (spec §4.1)', () => {
  it('strength=0 → F unchanged; strength=1 → full transform', () => {
    const F: [number, number, number] = [0.6, 0.4, 0.2];
    const p0 = resolveCoupling({ strength: 0 });
    expect(coupleFg(F, 0.5, 0.2, 0, 0.05, p0)).toEqual(F);
    const r1 = coupleCell(F, 0.5, 0.2, 0, 0.05, resolveCoupling({ strength: 1 }));
    expect(r1.F).not.toEqual(F);
  });
});

describe('resolveCoupling', () => {
  it('fills preset defaults and applies partial overrides', () => {
    expect(resolveCoupling(undefined)).toEqual(COUPLING_DEFAULTS);
    expect(resolveCoupling({ kMax: 16 })).toEqual({ ...COUPLING_DEFAULTS, kMax: 16 });
  });
});
