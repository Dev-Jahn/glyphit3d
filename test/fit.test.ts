import { describe, it, expect } from 'vitest';
import { sseAt, fitFree, fitFgOnly, fitBox } from '../src/core/fit.js';
import type { FitStatsG } from '../src/core/types.js';

// deterministic PRNG (mulberry32)
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const P = 16;

// SSE of pred = a·m + b·1ext against target vectors, computed directly.
function directSSE(m: number[], one: number[], T: number[], a: number, b: number): number {
  let s = 0;
  for (let i = 0; i < m.length; i++) {
    const pred = a * m[i]! + b * one[i]!;
    const d = T[i]! - pred;
    s += d * d;
  }
  return s;
}

function plainStats(alpha: number[]): FitStatsG {
  let Saa = 0, Sa1 = 0;
  for (const a of alpha) { Saa += a * a; Sa1 += a; }
  return { Saa, Sa1, S11: alpha.length };
}

function cellStats(alpha: number[], T: number[]): { SaT: number; S1T: number; STT: number } {
  let SaT = 0, S1T = 0, STT = 0;
  for (let i = 0; i < alpha.length; i++) { SaT += alpha[i]! * T[i]!; S1T += T[i]!; STT += T[i]! * T[i]!; }
  return { SaT, S1T, STT };
}

// build one random mask: mix of continuous, binary, constant
function makeMask(rng: () => number): number[] {
  const kind = rng();
  const m: number[] = [];
  if (kind < 0.15) { const c = rng(); for (let i = 0; i < P; i++) m.push(c); }        // constant
  else if (kind < 0.4) { for (let i = 0; i < P; i++) m.push(rng() < 0.5 ? 0 : 1); }    // binary
  else { for (let i = 0; i < P; i++) m.push(rng()); }                                   // continuous
  return m;
}

describe('fit — fitFree vs brute-force grid', () => {
  it('closed-form OLS beats grid best and identity matches quadratic form', () => {
    const rng = mulberry32(12345);
    const step = 1 / 128;
    const lo = -0.5, hi = 1.5;
    for (let trial = 0; trial < 220; trial++) {
      const alpha = makeMask(rng);
      const one = new Array(P).fill(1);
      const T: number[] = [];
      for (let i = 0; i < P; i++) T.push(rng());

      const g = plainStats(alpha);
      const cs = cellStats(alpha, T);
      const res = fitFree(g, cs.SaT, cs.S1T, cs.STT);

      // brute force over (F,B) grid, a=F-B, b=B
      let gridBest = Infinity;
      for (let F = lo; F <= hi + 1e-12; F += step) {
        for (let B = lo; B <= hi + 1e-12; B += step) {
          const s = directSSE(alpha, one, T, F - B, B);
          if (s < gridBest) gridBest = s;
        }
      }
      expect(res.sse).toBeLessThanOrEqual(gridBest + 1e-6);

      // identity SSE must equal the full quadratic form at the optimum
      const quad = sseAt(g, res.a, res.b, cs.SaT, cs.S1T, cs.STT);
      expect(Math.abs(res.sse - quad)).toBeLessThan(1e-9);
    }
  });
});

describe('fit — fitBox vs box-restricted brute-force grid', () => {
  it('exact box QP beats grid best within the box', () => {
    const rng = mulberry32(777);
    const step = 1 / 128;
    for (let trial = 0; trial < 220; trial++) {
      const alpha = makeMask(rng);
      const one = new Array(P).fill(1);
      const T: number[] = [];
      for (let i = 0; i < P; i++) T.push(rng());

      // random sub-box of [0,1]^2
      let loF = rng(), hiF = rng(); if (loF > hiF) [loF, hiF] = [hiF, loF];
      let loB = rng(), hiB = rng(); if (loB > hiB) [loB, hiB] = [hiB, loB];

      const g = plainStats(alpha);
      const cs = cellStats(alpha, T);
      const box = fitBox(g, cs.SaT, cs.S1T, cs.STT, loF, hiF, loB, hiB);

      // solution stays inside the box
      expect(box.F).toBeGreaterThanOrEqual(loF - 1e-9);
      expect(box.F).toBeLessThanOrEqual(hiF + 1e-9);
      expect(box.B).toBeGreaterThanOrEqual(loB - 1e-9);
      expect(box.B).toBeLessThanOrEqual(hiB + 1e-9);

      // reported sse matches the quadratic form
      const quad = sseAt(g, box.F - box.B, box.B, cs.SaT, cs.S1T, cs.STT);
      expect(Math.abs(box.sse - quad)).toBeLessThan(1e-9);

      // brute force restricted to the box
      let gridBest = Infinity;
      for (let F = loF; F <= hiF + 1e-12; F += step) {
        for (let B = loB; B <= hiB + 1e-12; B += step) {
          const s = directSSE(alpha, one, T, F - B, B);
          if (s < gridBest) gridBest = s;
        }
      }
      // also include exact bounds (grid may miss the hiF/hiB edge)
      {
        const s = directSSE(alpha, one, T, hiF - hiB, hiB);
        if (s < gridBest) gridBest = s;
      }
      expect(box.sse).toBeLessThanOrEqual(gridBest + 1e-6);
    }
  });
});

describe('fit — fitFgOnly matches 1-D brute force with B fixed', () => {
  it('optimal a with B fixed', () => {
    const rng = mulberry32(2024);
    const step = 1 / 256;
    for (let trial = 0; trial < 120; trial++) {
      const alpha = makeMask(rng);
      const one = new Array(P).fill(1);
      const T: number[] = [];
      for (let i = 0; i < P; i++) T.push(rng());
      const B = rng() * 2 - 0.5;

      const g = plainStats(alpha);
      const cs = cellStats(alpha, T);
      const r = fitFgOnly(g, cs.SaT, cs.S1T, cs.STT, B);
      expect(r.b).toBe(B);

      let gridBest = Infinity;
      for (let a = -2; a <= 2 + 1e-12; a += step) {
        const s = directSSE(alpha, one, T, a, B);
        if (s < gridBest) gridBest = s;
      }
      expect(r.sse).toBeLessThanOrEqual(gridBest + 1e-6);
      const quad = sseAt(g, r.a, B, cs.SaT, cs.S1T, cs.STT);
      expect(Math.abs(r.sse - quad)).toBeLessThan(1e-9);
    }
  });
});

describe('fit — edge-extended composition vs explicit extended-vector OLS', () => {
  it('composed six-statistic form equals OLS on explicit concatenated vectors', () => {
    const rng = mulberry32(90210);
    for (let trial = 0; trial < 220; trial++) {
      const lambda = rng() < 0.5 ? 0.35 : 1;

      // glyph plain + gradient channels
      const alpha: number[] = [], dxA: number[] = [], dyA: number[] = [];
      const T: number[] = [], dxT: number[] = [], dyT: number[] = [];
      for (let i = 0; i < P; i++) {
        alpha.push(rng());
        dxA.push(rng() * 2 - 1); dyA.push(rng() * 2 - 1);
        T.push(rng());
        dxT.push(rng() * 2 - 1); dyT.push(rng() * 2 - 1);
      }

      // explicit extended vectors (length 3P): m=[α, λdxA, λdyA], T̂=[T, λdxT, λdyT], 1ext=[1..1,0..0]
      const m: number[] = [], That: number[] = [], one: number[] = [];
      for (let i = 0; i < P; i++) { m.push(alpha[i]!); That.push(T[i]!); one.push(1); }
      for (let i = 0; i < P; i++) { m.push(lambda * dxA[i]!); That.push(lambda * dxT[i]!); one.push(0); }
      for (let i = 0; i < P; i++) { m.push(lambda * dyA[i]!); That.push(lambda * dyT[i]!); one.push(0); }

      // reference stats summed directly over extended vectors
      let Saa = 0, Sa1 = 0, S11 = 0, SaT = 0, S1T = 0, STT = 0;
      for (let i = 0; i < 3 * P; i++) {
        Saa += m[i]! * m[i]!;
        Sa1 += m[i]! * one[i]!;
        S11 += one[i]! * one[i]!;
        SaT += m[i]! * That[i]!;
        S1T += one[i]! * That[i]!;
        STT += That[i]! * That[i]!;
      }

      // composed stats from the six-statistic identities (spec §3)
      let sumA = 0, sumAA = 0, gradAA = 0, gST = 0, gSTT = 0, dotGrad = 0;
      for (let i = 0; i < P; i++) {
        sumA += alpha[i]!;
        sumAA += alpha[i]! * alpha[i]!;
        gradAA += dxA[i]! * dxA[i]! + dyA[i]! * dyA[i]!;
        gST += T[i]!;
        gSTT += T[i]! * T[i]!;
        dotGrad += dxA[i]! * dxT[i]! + dyA[i]! * dyT[i]!;
      }
      let plainAT = 0;
      for (let i = 0; i < P; i++) plainAT += alpha[i]! * T[i]!;
      const gradTT = (() => { let s = 0; for (let i = 0; i < P; i++) s += dxT[i]! * dxT[i]! + dyT[i]! * dyT[i]!; return s; })();

      const gComposed: FitStatsG = { Saa: sumAA + lambda * lambda * gradAA, Sa1: sumA, S11: P };
      const SaTc = plainAT + lambda * lambda * dotGrad;
      const S1Tc = gST;
      const STTc = gSTT + lambda * lambda * gradTT;

      // the composed stats must equal the directly-summed extended stats
      expect(Math.abs(gComposed.Saa - Saa)).toBeLessThan(1e-9);
      expect(Math.abs(gComposed.Sa1 - Sa1)).toBeLessThan(1e-9);
      expect(gComposed.S11).toBe(S11);
      expect(Math.abs(SaTc - SaT)).toBeLessThan(1e-9);
      expect(Math.abs(S1Tc - S1T)).toBeLessThan(1e-9);
      expect(Math.abs(STTc - STT)).toBeLessThan(1e-9);

      // fits must agree
      const refFit = fitFree({ Saa, Sa1, S11 }, SaT, S1T, STT);
      const compFit = fitFree(gComposed, SaTc, S1Tc, STTc);
      expect(Math.abs(refFit.a - compFit.a)).toBeLessThan(1e-9);
      expect(Math.abs(refFit.b - compFit.b)).toBeLessThan(1e-9);
      expect(Math.abs(refFit.sse - compFit.sse)).toBeLessThan(1e-9);

      // and the composed sse matches direct SSE on the extended vectors at that (a,b)
      const direct = directSSE(m, one, That, compFit.a, compFit.b);
      expect(Math.abs(compFit.sse - direct)).toBeLessThan(1e-6);
    }
  });
});

describe('fit — degenerate constant masks', () => {
  it('no NaN/Inf; b = mean(T), sse = variance·P', () => {
    const rng = mulberry32(555);
    for (const c of [0, 1, 0.5]) {
      for (let trial = 0; trial < 40; trial++) {
        const alpha = new Array(P).fill(c);
        const T: number[] = [];
        for (let i = 0; i < P; i++) T.push(rng());
        const g = plainStats(alpha);
        const cs = cellStats(alpha, T);
        const r = fitFree(g, cs.SaT, cs.S1T, cs.STT);

        const mean = T.reduce((x, y) => x + y, 0) / P;
        let variance = 0;
        for (const t of T) variance += (t - mean) * (t - mean);

        expect(Number.isFinite(r.a)).toBe(true);
        expect(Number.isFinite(r.b)).toBe(true);
        expect(Number.isFinite(r.sse)).toBe(true);
        expect(r.a).toBe(0);
        expect(Math.abs(r.b - mean)).toBeLessThan(1e-9);
        expect(Math.abs(r.sse - variance)).toBeLessThan(1e-9);
      }
    }
  });
});
