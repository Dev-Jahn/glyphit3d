import { describe, it, expect } from 'vitest';
import { rhoStar, uWeight, identityPenalty, precomputeIdentity } from '../src/core/identity.js';
import type { Atlas, Glyph } from '../src/core/types.js';

// V2 (spec §3.2) — the selection-prior math derivations, tested in isolation.

describe('rhoStar (spec §3.2 density ramp)', () => {
  it('maps Ȳ=L_B→0 and Ȳ=L_F→1 (ramp endpoints)', () => {
    expect(rhoStar(0, 0, 1)).toBe(0);
    expect(rhoStar(1, 0, 1)).toBe(1);
    // general (L_B,L_F)
    expect(rhoStar(0.1, 0.1, 0.9)).toBeCloseTo(0, 12);
    expect(rhoStar(0.9, 0.1, 0.9)).toBeCloseTo(1, 12);
    expect(rhoStar(0.5, 0.1, 0.9)).toBeCloseTo(0.5, 12);
  });
  it('is linear inside and clamps outside [L_B,L_F]', () => {
    expect(rhoStar(0.3, 0, 1)).toBeCloseTo(0.3, 12);
    expect(rhoStar(-0.5, 0, 1)).toBe(0);   // Ȳ < L_B
    expect(rhoStar(1.5, 0, 1)).toBe(1);    // Ȳ > L_F
  });
});

describe('uWeight (spec §3.1 uniformity weight)', () => {
  it('u(0)=1, u(τ)=0.5, →0 as s→∞', () => {
    const tau = 2.5e-4;
    expect(uWeight(0, tau)).toBe(1);
    expect(uWeight(tau, tau)).toBeCloseTo(0.5, 12);
    expect(uWeight(1e6, tau)).toBeLessThan(1e-6);
  });
  it('is monotone decreasing in s', () => {
    const tau = 2.5e-4;
    let prev = Infinity;
    for (const s of [0, 5e-5, 1e-4, 2.5e-4, 5e-4, 1e-3, 4e-3]) {
      const u = uWeight(s, tau);
      expect(u).toBeLessThan(prev);
      prev = u;
    }
  });
});

describe('identityPenalty', () => {
  it('is exactly 0 when λ=0 (byte-identical off) or D=0', () => {
    expect(identityPenalty(0.9, 0.3, 1, 1, 100, 0)).toBe(0);
    expect(identityPenalty(0.9, 0.3, 1, 0, 100, 5)).toBe(0);
  });
  it('equals λ·u·D·P·(ρ_g−ρ*)²', () => {
    expect(identityPenalty(0.7, 0.4, 0.5, 2, 100, 5)).toBeCloseTo(5 * 0.5 * 2 * 100 * 0.09, 9);
  });
});

// Synthetic binary coverage-ladder: J(ρ) = D·P·(1−ρ) + penalty (spec §3.2 flat-cell objective,
// SSE_flat(binary glyph)=D·P·(1−ρ_g)). The discrete argmin must sit within one ladder step of
// ρ†=min(1, ρ*+1/(2λu)), and full block (ρ=1) must lose whenever ρ*<1−1/(2λu).
describe('flat-cell argmin tracks ρ*+1/(2λu) (spec §3.2 closed form)', () => {
  const ladder = Array.from({ length: 11 }, (_, i) => i / 10); // 0,0.1,…,1.0
  const argminRho = (rs: number, lambda: number, u: number, D: number, P: number): number => {
    let best = Infinity, bestRho = 0;
    for (const rho of ladder) {
      const J = D * P * (1 - rho) + identityPenalty(rho, rs, u, D, P, lambda);
      if (J < best) { best = J; bestRho = rho; }
    }
    return bestRho;
  };
  it('argmin ≈ ρ† within one 0.1 step; full block loses below the crossover', () => {
    const D = 1, P = 100, u = 1;
    // ρ*=0.3, λ=5, u=1 → ρ†=0.4; 0.3<0.9 ⇒ full block loses
    const dagger1 = Math.min(1, 0.3 + 1 / (2 * 5 * u));
    const a1 = argminRho(0.3, 5, u, D, P);
    expect(Math.abs(a1 - dagger1)).toBeLessThanOrEqual(0.1 + 1e-9);
    expect(a1).toBeLessThan(1); // full block not selected
    // ρ*=0.95, λ=5 → ρ†=min(1,1.05)=1; 0.95>0.9 ⇒ full block wins
    const a2 = argminRho(0.95, 5, u, D, P);
    expect(a2).toBe(1);
  });
});

describe('precomputeIdentity', () => {
  const mkGlyph = (ch: string, sumA: number): Glyph => ({
    ch, cp: ch.codePointAt(0)!, alpha: new Float32Array(4), dxA: new Float32Array(4), dyA: new Float32Array(4),
    sumA, sumAA: sumA, gradAA: 0, ink: 0,
  });
  const atlas: Atlas = {
    cellW: 2, cellH: 2, P: 4, fontPath: 'x', fontSize: 16, ascent: 12, inkMin: 0, inkMax: 1,
    glyphs: [mkGlyph(' ', 0), mkGlyph('a', 3), mkGlyph('b', 1), mkGlyph('c', 4)],
  };
  it('computes ρ_g=sumA/P index-aligned and a coverage-sorted diagnostic order', () => {
    const id = precomputeIdentity(atlas);
    expect(Array.from(id.rho)).toEqual([0, 0.75, 0.25, 1]);
    expect(Array.from(id.coverageOrder)).toEqual([0, 2, 1, 3]); // ρ ascending: 0,0.25,0.75,1
  });
});
