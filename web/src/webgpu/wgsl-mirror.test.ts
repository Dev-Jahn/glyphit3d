import { describe, it, expect } from 'vitest';
import type { FitStatsG } from '../../../src/core/types.js';
import { fitFree, fitBox } from '../../../src/core/fit.js';
import { fitChannelQ3 } from './wgsl-mirror.js';

// The WGSL matcher (matcher-wgsl.ts) reproduces matchGrid's Q3 channelSse/channelFB objective
// (which uses the atlas's STORED sumAA) via a centered/deviation reformulation that survives
// f32. wgsl-mirror.ts is a faithful JS transcription of that WGSL. This suite proves the
// centered algebra is identical to the src/core/fit.ts closed forms on PIXEL-CONSISTENT stats
// (Saa from the same coverage the residual would see, so a residual-vs-algebraic mismatch
// cannot hide here). A wrong centered-coordinate term, clamp, or box candidate diverges.

// Reference: exactly match.ts's channelSse/channelFB, quality===3 branch, from fit.ts.
function refSse(g: FitStatsG, SaT: number, S1T: number, STT: number, minTc: number, maxTc: number): number {
  const free = fitFree(g, SaT, S1T, STT);
  const F = free.a + free.b, B = free.b;
  if (F >= minTc && F <= maxTc && B >= minTc && B <= maxTc) return free.sse;
  return fitBox(g, SaT, S1T, STT, minTc, maxTc, minTc, maxTc).sse;
}
function refFB(g: FitStatsG, SaT: number, S1T: number, STT: number, minTc: number, maxTc: number): [number, number] {
  const free = fitFree(g, SaT, S1T, STT);
  const F = free.a + free.b, B = free.b;
  if (F >= minTc && F <= maxTc && B >= minTc && B <= maxTc) return [F, B];
  const box = fitBox(g, SaT, S1T, STT, minTc, maxTc, minTc, maxTc);
  return [box.F, box.B];
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
}

const P = 190;

// Build a physically consistent cell + glyph (actual pixel arrays), then derive the exact
// stats the matcher sees. `Saa` (stored sumAA) is Σα² of THESE pixels — the residual and the
// algebraic form agree here, so this isolates the centered-algebra port.
function randCase(rng: () => number): { g: FitStatsG; Saac: number; SaT: number; S1T: number; STT: number; STTc: number; minTc: number; maxTc: number } {
  // T_i = base + slope·α_i + noise. A large |slope| makes the free (F,B) extrapolate past
  // [minT,maxT] ⇒ box-constrained; small slope ⇒ in-box. Mixing both exercises both branches.
  const base = rng() * 0.5;
  const slope = (rng() * 4 - 2);          // [-2, 2]
  const noise = rng() * 0.15;
  let sumA = 0, sumAA = 0, saT = 0, ST = 0, STT = 0, mn = Infinity, mx = -Infinity;
  for (let i = 0; i < P; i++) {
    const a = rng();
    const t = base + slope * a + noise * (rng() - 0.5);
    sumA += a; sumAA += a * a; saT += a * t; ST += t; STT += t * t;
    if (t < mn) mn = t; if (t > mx) mx = t;
  }
  const Saac = sumAA - (sumA * sumA) / P;
  const STTc = STT - (ST * ST) / P;
  return { g: { Saa: sumAA, Sa1: sumA, S11: P }, Saac, SaT: saT, S1T: ST, STT, STTc, minTc: mn, maxTc: mx };
}

describe('wgsl-mirror centered Q3 fit (matcher-wgsl.ts port) == src/core/match.ts objective', () => {
  it('fitChannelQ3 SSE matches fit.ts channelSse over 40000 pixel-consistent cases', () => {
    const rng = makeRng(0xC0FFEE);
    let maxRel = 0, freeN = 0, boxN = 0;
    for (let t = 0; t < 40000; t++) {
      const c = randCase(rng);
      const SaTc = c.SaT - c.g.Sa1 * (c.S1T / c.g.S11);
      const got = fitChannelQ3(c.g.Saa, c.g.Sa1, c.g.S11, c.SaT, c.S1T, SaTc, c.Saac, c.STTc, c.minTc, c.maxTc);
      const ref = refSse(c.g, c.SaT, c.S1T, c.STT, c.minTc, c.maxTc);
      const [rF, rB] = refFB(c.g, c.SaT, c.S1T, c.STT, c.minTc, c.maxTc);
      const inBox = got.F === rF && got.B === rB ? 'x' : 'y'; void inBox;
      const rel = Math.abs(got.sse - ref) / (1 + Math.abs(ref));
      if (rel > maxRel) maxRel = rel;
      expect(rel).toBeLessThan(1e-9);
      expect(Math.abs(got.F - rF)).toBeLessThanOrEqual(1e-9 * (1 + Math.abs(rF)));
      expect(Math.abs(got.B - rB)).toBeLessThanOrEqual(1e-9 * (1 + Math.abs(rB)));
      // branch bookkeeping
      const free = fitFree(c.g, c.SaT, c.S1T, c.STT);
      const F = free.a + free.b, B = free.b;
      if (F >= c.minTc && F <= c.maxTc && B >= c.minTc && B <= c.maxTc) freeN++; else boxN++;
    }
    expect(freeN).toBeGreaterThan(0);
    expect(boxN).toBeGreaterThan(0);
    expect(maxRel).toBeLessThan(1e-9);
  });

  it('handles space (Saa=0) and a solid block (Saa=Sa1=P, denom=0)', () => {
    for (const kind of ['space', 'solid'] as const) {
      const rng = makeRng(kind === 'space' ? 11 : 22);
      for (let t = 0; t < 3000; t++) {
        // consistent cell pixels
        const base = rng() * 0.7, span = rng() * 0.3;
        let ST = 0, STT = 0, saT = 0, mn = Infinity, mx = -Infinity;
        for (let i = 0; i < P; i++) {
          const tt = base + span * rng();
          const a = kind === 'space' ? 0 : 1; // space: α≡0, solid: α≡1
          ST += tt; STT += tt * tt; saT += a * tt;
          if (tt < mn) mn = tt; if (tt > mx) mx = tt;
        }
        const Sa1 = kind === 'space' ? 0 : P;
        const Saa = kind === 'space' ? 0 : P;
        const g: FitStatsG = { Saa, Sa1, S11: P };
        const Saac = Saa - (Sa1 * Sa1) / P;
        const STTc = STT - (ST * ST) / P;
        const SaTc = saT - Sa1 * (ST / P);
        const got = fitChannelQ3(Saa, Sa1, P, saT, ST, SaTc, Saac, STTc, mn, mx);
        const ref = refSse(g, saT, ST, STT, mn, mx);
        expect(Math.abs(got.sse - ref)).toBeLessThanOrEqual(1e-9 * (1 + Math.abs(ref)));
      }
    }
  });
});
