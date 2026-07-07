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

// ─── chore/parity-adversarial-fixtures (O1) ─────────────────────────────────────────────────
// The byte-exact parity claim above rests on the random pixel-consistent sweep + the 14-config
// GPU harness, both of which only sample what the demo scenes / bench images happen to produce.
// These fixtures instead CRAFT the worst-case numeric regimes directly — high-DC/low-AC cells,
// the gateTau AC boundary, minT/maxT clamp/box corners, and near-degenerate Saa_c glyphs — and
// pin the centered mirror to the f64 fit.ts closed form in each. Both sides are f64 JS, so a
// tight equality here isolates the CENTERED-ALGEBRA port (branch selection, box candidates,
// clampf) from f32 effects, which the GPU harness covers separately.
//
// Every fixture is built to be PHYSICALLY REALIZABLE (STTc ≥ 0, Saac ≥ 0, and
// SaTc² = ρ²·Saac·STTc ≤ Saac·STTc by construction — Cauchy–Schwarz-tight only at |ρ|=1) and,
// for the glyph, α-realizable (Sa1²/P ≤ Saa ≤ Sa1). This matters: an UNphysical stat set
// (|SaTc| > √(Saac·STTc), i.e. |ρ|>1) drives a* past √(STTc/Saac) and makes the box devSse
// expansion cancel two large terms — a divergence that cannot occur for real glyphs. The
// fixtures therefore stay inside the realizable cone the pipeline actually feeds the kernel.

// Raw stats from physically-meaningful knobs: DC mean = S1T/P, per-channel AC energy
// sttc = STT − S1T²/P, glyph (Sa1, Saa) with Saac = Saa − Sa1²/P, and the α·T correlation
// ρ ∈ [−1,1] setting SaTc = ρ·√(Saac·sttc). Returns exactly what the harness uploads.
function rawFrom(mean: number, sttc: number, Sa1: number, Saa: number, rho: number): {
  g: FitStatsG; SaT: number; S1T: number; STT: number;
} {
  const g: FitStatsG = { Saa, Sa1, S11: P };
  const Saac = Saa - (Sa1 * Sa1) / P;
  const SaTc = rho * Math.sqrt(Math.max(0, Saac) * Math.max(0, sttc));
  const S1T = P * mean;
  const SaT = SaTc + Sa1 * mean;
  const STT = sttc + (S1T * S1T) / P;
  return { g, SaT, S1T, STT };
}

// Run the centered mirror the way matcher-wgsl.ts feeds it (centered stats derived from the raw
// ones exactly as parity-page uploads them) beside the f64 fit.ts reference on the SAME raw.
function mirror(g: FitStatsG, SaT: number, S1T: number, STT: number, minTc: number, maxTc: number): ReturnType<typeof fitChannelQ3> {
  const SaTc = SaT - g.Sa1 * (S1T / g.S11);
  const Saac = g.Saa - (g.Sa1 * g.Sa1) / g.S11;
  const STTc = STT - (S1T * S1T) / g.S11;
  return fitChannelQ3(g.Saa, g.Sa1, g.S11, SaT, S1T, SaTc, Saac, STTc, minTc, maxTc);
}

// Assert the mirror's SSE + fitted (F,B) equal fit.ts to f64 rounding; return both for extra
// path assertions at the call site.
function expectFit(g: FitStatsG, SaT: number, S1T: number, STT: number, minTc: number, maxTc: number, tol = 1e-9): {
  got: ReturnType<typeof fitChannelQ3>; ref: number; rF: number; rB: number;
} {
  const got = mirror(g, SaT, S1T, STT, minTc, maxTc);
  const ref = refSse(g, SaT, S1T, STT, minTc, maxTc);
  const [rF, rB] = refFB(g, SaT, S1T, STT, minTc, maxTc);
  expect(Math.abs(got.sse - ref)).toBeLessThanOrEqual(tol * (1 + Math.abs(ref)));
  expect(Math.abs(got.F - rF)).toBeLessThanOrEqual(tol * (1 + Math.abs(rF)));
  expect(Math.abs(got.B - rB)).toBeLessThanOrEqual(tol * (1 + Math.abs(rB)));
  return { got, ref, rF, rB };
}

// SSE-only parity — the SELECTION quantity (the argmin runs on SSE, not on the fitted colours).
// Used for rank-deficient glyphs (near-solid: α≈const ⇒ B unidentified, or near-degenerate
// Saa_c) where (F,B) is JOINTLY non-unique: symmetric box candidates tie in SSE, so devSse vs
// sseAt rounding can pick a different (F,B) LABEL by O(box) while the SSE stays byte-equal — and
// fit.ts's own det-form free (a,b) loses ~1e-8 to cancellation there, below its own precision.
// Such glyphs never win the scan (huge ink ⇒ MDL, poor structured fit), so the colour label is
// never emitted; the byte-exact claim that matters is the SSE. Well-conditioned (F,B) parity is
// pinned by the high-DC/low-AC, gate-boundary and box-corner fixtures above.
function expectSse(g: FitStatsG, SaT: number, S1T: number, STT: number, minTc: number, maxTc: number, tol = 1e-9): number {
  const got = mirror(g, SaT, S1T, STT, minTc, maxTc);
  const ref = refSse(g, SaT, S1T, STT, minTc, maxTc);
  expect(Math.abs(got.sse - ref)).toBeLessThanOrEqual(tol * (1 + Math.abs(ref)));
  return got.sse;
}

describe('adversarial fixtures: centered Q3 fit vs f64 fit.ts on crafted numeric corners', () => {
  it('high-DC / low-AC cells: the fit is not lost to the DC even at AC → 1e-14 (free branch)', () => {
    // Bright near-constant cells: S1T²/P is O(P·mean²) ≈ 186 while the AC energy the fit must
    // recover is sttc ≈ 0. In f32 the STT−a·SaT−b·S1T cancellation flips glyphs here (why the
    // kernel centres); in f64 both forms agree — this pins that the centred algebra keeps the
    // tiny sseFree = sttc·(1−ρ²). Box is wide so F*,B* ≈ mean stay in-box → free branch.
    const g: FitStatsG = { Saa: 63, Sa1: 95, S11: P }; // Saac = 63 − 95²/190 = 15.5 (mid-ink)
    for (const mean of [0.5, 0.9, 0.99]) {
      for (const sttc of [1e-3, 1e-5, 1e-8, 1e-11, 1e-14]) {
        for (const rho of [-0.95, -0.3, 0, 0.3, 0.95]) {
          const { SaT, S1T, STT } = rawFrom(mean, sttc, g.Sa1, g.Saa, rho);
          const { got } = expectFit(g, SaT, S1T, STT, -1, 2);
          // sanity: this really is the free branch (fitted colours interpolate near the DC).
          expect(got.F).toBeGreaterThanOrEqual(-1);
          expect(got.F).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it('gateTau-boundary cells: per-channel AC straddling gateTau·P stays byte-exact', () => {
    // The gate skips cells with eacScale/(3P) < gateTau (default 2e-5); the lowest-AC cells that
    // still get SCANNED sit right above per-channel STTc = gateTau·P. Those are exactly the
    // near-cancellation cells, so the fit must be exact there. (The gate itself is a whole-cell
    // decision proven in the GPU harness; here we pin the per-channel fit at that AC level.)
    const thresh = 2e-5 * P; // per-channel STTc at the gate ≈ 3.8e-3
    for (const sttc of [thresh * 0.5, thresh * 0.999, thresh, thresh * 1.001, thresh * 4]) {
      for (const [Sa1, Saa] of [[40, 20], [95, 63], [150, 130]] as const) {
        for (const rho of [-1, -0.5, 0.5, 1]) {
          const { g, SaT, S1T, STT } = rawFrom(0.4, sttc, Sa1, Saa, rho);
          expectFit(g, SaT, S1T, STT, -0.5, 1.5);
        }
      }
    }
  });

  it('minT/maxT box: free optimum pushed outside a tight box exercises every clamp corner', () => {
    // A small Saac inflates a* = ρ·√(sttc/Saac); a tight [minT,maxT] then rejects F*=a*+b* and/or
    // B*=b*, forcing the 4-candidate box path (both fg-only edges and both F-fixed edges) with
    // clampf active. matchGrid scores these with sseAt; the mirror with the devSse expansion —
    // the fixture asserts they pick the SAME edge to f64 rounding, and that the box really fired.
    const g: FitStatsG = { Saa: 52, Sa1: 95, S11: P }; // Saac = 52 − 47.5 = 4.5
    const cases: Array<{ mean: number; sttc: number; rho: number; lo: number; hi: number }> = [
      { mean: 0.5, sttc: 0.40, rho: 1, lo: 0.40, hi: 0.60 },   // B* below lo, F* above hi
      { mean: 0.5, sttc: 0.40, rho: -1, lo: 0.40, hi: 0.60 },  // mirror image (F* below lo, B* above hi)
      { mean: 0.2, sttc: 0.50, rho: 1, lo: 0.10, hi: 0.30 },   // F* far above hi (F-fixed edge + clamp b)
      { mean: 0.8, sttc: 0.50, rho: -1, lo: 0.70, hi: 0.90 },  // symmetric high-DC corner
      { mean: 0.5, sttc: 0.30, rho: 0.6, lo: 0.30, hi: 0.55 }, // asymmetric partial box
    ];
    for (const c of cases) {
      const { SaT, S1T, STT } = rawFrom(c.mean, c.sttc, g.Sa1, g.Saa, c.rho);
      // confirm the fixture genuinely leaves the box (else it would silently degrade to a free test).
      const free = fitFree(g, SaT, S1T, STT);
      const Ffree = free.a + free.b, Bfree = free.b;
      const outside = Ffree < c.lo || Ffree > c.hi || Bfree < c.lo || Bfree > c.hi;
      expect(outside).toBe(true);
      const { got } = expectFit(g, SaT, S1T, STT, c.lo, c.hi);
      // the winning candidate lies on the box boundary (a clamp/edge actually fired).
      const onEdge = [c.lo, c.hi].some((v) => Math.abs(got.F - v) < 1e-9 || Math.abs(got.B - v) < 1e-9);
      expect(onEdge).toBe(true);
    }
  });

  it('degenerate & near-degenerate Saa_c glyphs take the same branch as fit.ts', () => {
    // Solid (Saa=Sa1=P) and space (Saa=Sa1=0) both give Saac=0 → the degenerate branch (a*=0,
    // b*=mean). The mirror gates on Saac ≤ 1e-9·Saa; fit.ts on det = S11·Saac ≤ 1e-9·Saa·S11 —
    // the SAME predicate. In a WIDE box the degenerate free (F*,B*)=(mean,mean) is unique, so full
    // (F,B) parity holds and proves both take the degenerate branch (a wrong branch → wild F,B).
    for (const [Sa1, Saa] of [[P, P], [0, 0]] as const) {
      const { g, SaT, S1T, STT } = rawFrom(0.5, 0.2, Sa1, Saa, 0);
      expectFit(g, SaT, S1T, STT, -1, 2);         // wide box → degenerate free, (F,B)=(mean,mean)
      expectSse(g, SaT, S1T, STT, 0.60, 0.90);    // mean=0.5 < lo → degenerate box (rank-deficient F,B)
    }
    // Near-degenerate but strictly NON-degenerate (clearly above the 1e-9·Saa threshold): a
    // near-solid glyph with a small physical Saac, driven into the box. a* stays O(1) because sttc
    // is scaled with Saac (physical). SSE (the selection quantity) is byte-exact; (F,B) is
    // rank-deficient here (see expectSse) so it is not asserted — it is covered where identified.
    for (const Saac of [1e-1, 1e-3, 1e-6]) {
      const Sa1 = 180, Saa = Sa1 * Sa1 / P + Saac;   // ∈ [Sa1²/P, Sa1] ⇒ α-realizable
      expect(Saac).toBeGreaterThan(1e-9 * Saa);       // strictly non-degenerate on both predicates
      const g: FitStatsG = { Saa, Sa1, S11: P };
      for (const rho of [-1, -0.4, 0.4, 1]) {
        const { SaT, S1T, STT } = rawFrom(0.5, Saac, g.Sa1, g.Saa, rho);
        expectSse(g, SaT, S1T, STT, 0.45, 0.55);
      }
    }
    // Just BELOW the threshold ⇒ both must take the degenerate branch. Kept a factor ~17 under
    // 1e-9·Saa so the 1-ULP difference between Saac and det/S11 cannot flip the predicate; the
    // wide box keeps (F,B)=(mean,mean) unique, so full parity here is a branch-agreement assertion.
    {
      const Sa1 = 180, Saa = Sa1 * Sa1 / P + 1e-8;
      expect(1e-8).toBeLessThan(1e-9 * Saa / 17);
      const g: FitStatsG = { Saa, Sa1, S11: P };
      const { SaT, S1T, STT } = rawFrom(0.5, 0.3, g.Sa1, g.Saa, 0.7);
      expectFit(g, SaT, S1T, STT, -1, 2);
    }
  });
});

describe('adversarial fixtures: first-wins-on-tie (lowest gi survives an exact score tie)', () => {
  // matchGrid and matcher-wgsl.ts main() both scan glyphs with a STRICT `<` and ascending gi, so
  // on an EXACT score tie the LOWER gi is kept. wgsl-mirror.ts only exposes the per-channel fit,
  // so we replicate that exact argmin over per-glyph totals built FROM the mirror — pinning both
  // the tie rule and the mirror's determinism (identical stats ⇒ bit-identical totals) in f64.
  function argminFirstWins(scores: number[]): number {
    let best = Infinity, bi = 0;
    for (let gi = 0; gi < scores.length; gi++) if (scores[gi]! < best) { best = scores[gi]!; bi = gi; }
    return bi;
  }

  it('identical-stat glyphs tie to the bit and the lower gi wins', () => {
    const g: FitStatsG = { Saa: 70, Sa1: 100, S11: P };
    const { SaT, S1T, STT } = rawFrom(0.55, 0.25, g.Sa1, g.Saa, 0.6);
    // full per-glyph total: 3 identical channels + a constant MDL term (λ·ink·eac).
    const total = (): number => {
      let s = 0;
      for (let c = 0; c < 3; c++) s += mirror(g, SaT, S1T, STT, 0, 1).sse;
      return s + 0.01 * 3.0;
    };
    const tied = total();
    expect(total()).toBe(tied);         // determinism: equal inputs ⇒ a bit-exact tie exists
    const worse = tied + 1e-6;
    // wherever the tied pair sits, the lower index survives the strict-< scan.
    expect(argminFirstWins([worse, tied, worse, tied, worse])).toBe(1);
    expect(argminFirstWins([tied, worse, tied, worse])).toBe(0);
    expect(argminFirstWins([worse, worse, tied, tied])).toBe(2);
    expect(argminFirstWins([tied, tied, tied, tied])).toBe(0);
  });

  it('a strictly-smaller higher-gi glyph still wins — the rule is EXACT equality, not a tolerance', () => {
    const base = 4.0;
    // one ULP smaller at gi=2 ⇒ it is NOT a tie, so gi=2 (the true min) must win.
    expect(argminFirstWins([base, base, base - Number.EPSILON * base, base])).toBe(2);
    // add that ULP back ⇒ a genuine tie ⇒ the lowest gi wins.
    expect(argminFirstWins([base, base, base, base])).toBe(0);
  });
});
