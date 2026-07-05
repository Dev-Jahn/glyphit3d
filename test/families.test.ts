import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildAtlas } from '../src/atlas/atlas.js';
import { buildFamily, buildFamilies, solveFamily, type CellFitCtx, type FamilyName } from '../src/atlas/families.js';
import { matchGrid } from '../src/core/match.js';
import { sseAt, fitFree, fitFgOnly, fitBox } from '../src/core/fit.js';
import { structureTensor, orientationBonus } from '../src/atlas/orientation.js';
import type { Atlas, MatchOptions, LinearImage, Grid } from '../src/core/types.js';

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
const CELL_W = 10, CELL_H = 19, P = CELL_W * CELL_H;

function defaults(overrides: Partial<MatchOptions>): MatchOptions {
  return {
    quality: 3,
    edgeLambda: 0.35,
    gateTau: 2e-4,
    mdlLambda: 0.02,
    fixedBg: [0, 0, 0],
    fixedFg: [1, 1, 1],
    ...overrides,
  };
}

// ---- helpers to drive the standalone solver from a grayscale target patch ----
function ctxFor(T: Float32Array, quality = 3, isQ4 = false): CellFitCtx {
  const ST = new Float32Array(3), STT = new Float32Array(3);
  const minT = new Float32Array(3), maxT = new Float32Array(3);
  for (let c = 0; c < 3; c++) { minT[c] = Infinity; maxT[c] = -Infinity; }
  for (let c = 0; c < 3; c++) {
    const b = c * P;
    for (let p = 0; p < P; p++) {
      const v = T[b + p]!;
      ST[c] = ST[c]! + v; STT[c] = STT[c]! + v * v;
      if (v < minT[c]!) minT[c] = v;
      if (v > maxT[c]!) maxT[c] = v;
    }
  }
  return {
    P, T, ST, STT, minT, maxT,
    dxT: new Float32Array(3 * P), dyT: new Float32Array(3 * P), gradTT: new Float32Array(3),
    quality, isQ4, lam2: 0, ffg: [1, 1, 1], fbg: [0, 0, 0], mdlLambda: 0.02, eacScale: 1,
  };
}

function grayTarget(fn: (lx: number, ly: number) => number): Float32Array {
  const T = new Float32Array(3 * P);
  for (let ly = 0; ly < CELL_H; ly++)
    for (let lx = 0; lx < CELL_W; lx++) {
      const v = fn(lx, ly);
      for (let c = 0; c < 3; c++) T[c * P + ly * CELL_W + lx] = v;
    }
  return T;
}

// mulberry32 (must match test/fixtures/regression-grid.json generator EXACTLY)
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('families: region geometry (M3-SPEC §2.4)', () => {
  const NAMES: FamilyName[] = ['quadrant', 'sextant', 'braille'];

  // Partition: Σα_i + α_bg == 1 pointwise. Coverage never exceeds 1 (the meaningful
  // cell-resolution disjointness invariant). NOTE: quadrant/sextant tile the cell so
  // their regions share the one pixel row/col straddling an odd split → Σα_i·α_j is
  // NOT identically zero (measured up to ~1.25); even the braille disks pick up a small
  // (~0.05) boundary cross term. Those cross terms are carried EXACTLY by the
  // precomputed per-pattern sumAA/gradAA, proven by the brute-force exactness test
  // below — so the spec's "no cross terms" shortcut is an idealization the solver does
  // not rely on. We therefore assert the true invariants, not Σα_i·α_j == 0.
  it('partition sums to 1 and coverage is bounded by 1 (supersample partition)', () => {
    for (const name of NAMES) {
      const f = buildFamily(name, CELL_W, CELL_H);
      for (let p = 0; p < P; p++) {
        let cov = 0;
        for (let i = 0; i < f.k; i++) {
          const a = f.regions[i]![p]!;
          expect(a).toBeGreaterThanOrEqual(-1e-9);
          expect(a).toBeLessThanOrEqual(1 + 1e-9);
          cov += a;
        }
        expect(cov + f.bg[p]!).toBeCloseTo(1, 6);   // partition
        expect(cov).toBeLessThanOrEqual(1 + 1e-6);  // disjoint ⇒ total coverage ≤ 1
      }
    }
  });

  it('emits the documented codepoints (all quadrants exist; sextant/braille ranges)', () => {
    const q = buildFamily('quadrant', CELL_W, CELL_H);
    expect(q.ch.join('')).toBe(' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█'); // §2.1 quadrant map
    const s = buildFamily('sextant', CELL_W, CELL_H);
    expect(s.ch[0]).toBe(' ');
    expect(s.ch[63]).toBe('█');
    expect(s.ch[21]).toBe('▌');           // left column → left half block
    expect(s.ch[42]).toBe('▐');           // right column → right half block
    expect(s.ch[1]!.codePointAt(0)).toBe(0x1fb00);
    expect(s.ch[62]!.codePointAt(0)).toBe(0x1fb3b);
    const b = buildFamily('braille', CELL_W, CELL_H);
    expect(b.ch[0]).toBe(' ');
    expect(b.ch[1]!.codePointAt(0)).toBe(0x2801); // dot 1
    expect(b.ch[255]!.codePointAt(0)).toBe(0x28ff); // all 8 dots
  });
});

describe('families: exact region solver == brute force (M3-SPEC §2.4)', () => {
  const NAMES: FamilyName[] = ['quadrant', 'sextant', 'braille'];

  // Replicates match.ts channelSse for the brute-force reference (must stay in sync).
  function chSse(Saa: number, Sa1: number, S11: number, SaT: number, S1T: number, STT: number,
                 q: number, mn: number, mx: number, ffg: number, fbg: number): number {
    const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
    const g = { Saa, Sa1, S11 };
    if (q === 1) return sseAt(g, ffg - fbg, fbg, SaT, S1T, STT);
    if (q === 2) { const r = fitFgOnly(g, SaT, S1T, STT, fbg); const F = clamp01(r.a + fbg); return sseAt(g, F - fbg, fbg, SaT, S1T, STT); }
    const free = fitFree(g, SaT, S1T, STT); const F = free.a + free.b, B = free.b;
    if (F >= mn && F <= mx && B >= mn && B <= mx) return free.sse;
    return fitBox(g, SaT, S1T, STT, mn, mx, mn, mx).sse;
  }

  // For each pattern S: build the ACTUAL summed coverage mask α_S = Σ_{i∈S} α_i and its
  // gradient, compute the six stats directly from those masks (the honest reference,
  // cross terms and all), score with the shared fit machinery, and take the argmin over
  // all 2^k patterns. The O(k)-per-pattern solver must match this to 1e-6.
  it('solver best pattern + SSE match a full 2^k brute force over the true masks (Q2/Q3/Q4)', () => {
    const lam2 = 0.35 * 0.35;
    for (const q of [2, 3, 4]) {
      const isQ4 = q === 4;
      for (const name of NAMES) {
        const f = buildFamily(name, CELL_W, CELL_H);
        for (let trial = 0; trial < 4; trial++) {
          const rnd = mulberry32(9001 + trial * 13 + q * 101);
          const T = new Float32Array(3 * P), dxT = new Float32Array(3 * P), dyT = new Float32Array(3 * P);
          const ST = new Float32Array(3), STT = new Float32Array(3);
          const minT = new Float32Array(3), maxT = new Float32Array(3), gradTT = new Float32Array(3);
          for (let c = 0; c < 3; c++) { minT[c] = Infinity; maxT[c] = -Infinity; }
          for (let c = 0; c < 3; c++) {
            const b = c * P;
            for (let p = 0; p < P; p++) {
              const v = rnd(); T[b + p] = v; ST[c] = ST[c]! + v; STT[c] = STT[c]! + v * v;
              if (v < minT[c]!) minT[c] = v; if (v > maxT[c]!) maxT[c] = v;
              const gx = rnd() - 0.5, gy = rnd() - 0.5; dxT[b + p] = gx; dyT[b + p] = gy;
              gradTT[c] = gradTT[c]! + gx * gx + gy * gy;
            }
          }
          const ctx: CellFitCtx = { P, T, ST, STT, minT, maxT, dxT, dyT, gradTT, quality: q, isQ4, lam2, ffg: [1, 1, 1], fbg: [0, 0, 0], mdlLambda: 0.02, eacScale: 1 };
          const sol = solveFamily(f, ctx);

          let bestScore = Infinity, bestPat = 0, bestSse = 0;
          for (let S = 0; S < (1 << f.k); S++) {
            const mask = new Float32Array(P), dxM = new Float32Array(P), dyM = new Float32Array(P);
            for (let i = 0; i < f.k; i++) if ((S >> i) & 1) {
              const a = f.regions[i]!, dx = f.dxR[i]!, dy = f.dyR[i]!;
              for (let p = 0; p < P; p++) { mask[p] = mask[p]! + a[p]!; dxM[p] = dxM[p]! + dx[p]!; dyM[p] = dyM[p]! + dy[p]!; }
            }
            let sumA = 0, sumAA = 0, gAA = 0;
            for (let p = 0; p < P; p++) { sumA += mask[p]!; sumAA += mask[p]! * mask[p]!; gAA += dxM[p]! * dxM[p]! + dyM[p]! * dyM[p]!; }
            let sse = 0;
            for (let c = 0; c < 3; c++) {
              const b = c * P;
              let saT = 0; for (let p = 0; p < P; p++) saT += mask[p]! * T[b + p]!;
              let stt = STT[c]!, Saa = sumAA;
              if (isQ4) { let gd = 0; for (let p = 0; p < P; p++) gd += dxM[p]! * dxT[b + p]! + dyM[p]! * dyT[b + p]!; saT += lam2 * gd; stt += lam2 * gradTT[c]!; Saa = sumAA + lam2 * gAA; }
              sse += chSse(Saa, sumA, P, saT, ST[c]!, stt, q, minT[c]!, maxT[c]!, 1, 0);
            }
            const score = sse + 0.02 * f.ink[S]! * 1;
            if (score < bestScore) { bestScore = score; bestPat = S; bestSse = sse; }
          }
          expect(sol.pattern).toBe(bestPat);
          expect(sol.score).toBeCloseTo(bestScore, 6);
          expect(sol.sse).toBeCloseTo(bestSse, 6);
        }
      }
    }
  });
});

describe('families: meta-selection regression (M3-SPEC §2.4)', () => {
  let atlas: Atlas;
  beforeAll(async () => { atlas = await buildAtlas(FONT, 16, 'blocks'); }, 60000);

  // families:[] (and absent) must be byte-identical to the pre-M3 M0 grid. Reuses the
  // frozen M0 golden fixture: reproduce its exact input, run matchGrid with families off,
  // and require every cell to match byte-for-byte.
  it('families:[] reproduces the M0 golden grid byte-for-byte', () => {
    const golden = JSON.parse(
      readFileSync(new URL('./fixtures/regression-grid.json', import.meta.url), 'utf8'),
    ) as { cols: number; rows: number; cellW: number; cellH: number; cells: Grid['cells'] };

    const { cellW, cellH } = atlas;
    const cols = 6, rows = 3;
    const w = cols * cellW, h = rows * cellH;
    const data = new Float32Array(w * h * 3);
    const rnd = mulberry32(12345);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const cx = x / w, cy = y / h;
        const r = 0.2 + 0.6 * cx + 0.15 * Math.sin(cy * 6.28) + 0.05 * (rnd() - 0.5);
        const g = 0.2 + 0.6 * cy + 0.15 * Math.cos(cx * 6.28) + 0.05 * (rnd() - 0.5);
        const b = 0.5 + 0.3 * Math.sin((cx + cy) * 6.28) + 0.05 * (rnd() - 0.5);
        const i = (y * w + x) * 3;
        data[i] = Math.max(0, Math.min(1, r));
        data[i + 1] = Math.max(0, Math.min(1, g));
        data[i + 2] = Math.max(0, Math.min(1, b));
      }
    }
    const img: LinearImage = { w, h, data };

    expect(matchGrid(img, atlas, defaults({})).cells).toEqual(golden.cells);            // absent
    expect(matchGrid(img, atlas, defaults({ families: [] })).cells).toEqual(golden.cells); // []
  });
});

describe('families: MDL ink basis == atlas raw-ink scale (M3-fix §2)', () => {
  let atlas: Atlas;
  beforeAll(async () => { atlas = await buildAtlas(FONT, 16, 'blocks'); }, 60000);

  // Post-fix, a family pattern's normalized ink is the SAME affine map atlas.ts applies to
  // a text glyph: clamp01((rawInk − inkMin)/(inkMax − inkMin)). So an identical mask pays an
  // identical MDL penalty whether it enters selection as a text glyph or a family pattern.
  it('each pattern is normalized onto the atlas affine ink map (identical mask ⇒ identical MDL as text)', () => {
    const { cellW, cellH, inkMin, inkMax } = atlas;
    const span = inkMax - inkMin;
    const [quad] = buildFamilies(['quadrant', 'braille'], cellW, cellH, inkMin, inkMax);
    for (let S = 0; S < quad!.ink.length; S++) {
      const expected = Math.max(0, Math.min(1, (quad!.rawInk[S]! - inkMin) / span));
      expect(quad!.ink[S]).toBeCloseTo(expected, 6); // 6 dp: ink is Float32-stored; the bug's error is ~0.05+
    }
    // upper-half (quadrant pattern 3 == '▀'): MDL normalized ink == what the atlas would
    // assign a text glyph carrying the same raw ink. The two MDL bases coincide.
    expect(quad!.ink[3]).toBeCloseTo(Math.max(0, Math.min(1, (quad!.rawInk[3]! - inkMin) / span)), 6);
  });

  // The bug: family ink used to be normalized by the requested-family-set max, so adding
  // braille to the request rescaled quadrant's MDL (and thus the whole score space). Fixed:
  // the basis is the atlas scale, independent of which families are requested.
  it('quadrant ink + solver winner are invariant to adding braille to the request set', () => {
    const { cellW, cellH, inkMin, inkMax } = atlas;
    const qAlone = buildFamilies(['quadrant'], cellW, cellH, inkMin, inkMax)[0]!;
    const qWith = buildFamilies(['quadrant', 'braille'], cellW, cellH, inkMin, inkMax)[0]!;
    for (let S = 0; S < qAlone.ink.length; S++) expect(qWith.ink[S]).toBeCloseTo(qAlone.ink[S]!, 9);
    // a fixed scene selects the same quadrant pattern + score either way.
    const ctx = ctxFor(grayTarget((_lx, ly) => (ly < CELL_H / 2 ? 0.85 : 0.15)));
    const a = solveFamily(qAlone, ctx), b = solveFamily(qWith, ctx);
    expect(b.pattern).toBe(a.pattern);
    expect(b.score).toBeCloseTo(a.score, 9);
  });
});

describe('families: selection priors apply identically to family patterns (M3-fix §3)', () => {
  const NAMES: FamilyName[] = ['quadrant', 'sextant', 'braille'];

  // The reference: every prior (split/antibleed/orientation) scored on the ACTUAL summed
  // pattern mask α_S, exactly the way match.ts scores a text glyph of that mask. solveFamily
  // must reproduce this argmin+score to 1e-6 — i.e. a family pattern earns the byte-identical
  // bonus a text glyph of the same mask would, so meta-selection is fair.
  function chSse(Saa: number, Sa1: number, S11: number, SaT: number, S1T: number, STT: number,
                 mn: number, mx: number): number {
    const free = fitFree({ Saa, Sa1, S11 }, SaT, S1T, STT); const F = free.a + free.b, B = free.b;
    if (F >= mn && F <= mx && B >= mn && B <= mx) return free.sse;
    return fitBox({ Saa, Sa1, S11 }, SaT, S1T, STT, mn, mx, mn, mx).sse;
  }

  it('brute force over summed masks (base + split + antibleed + orient) == solveFamily', () => {
    for (const name of NAMES) {
      const f = buildFamily(name, CELL_W, CELL_H);
      for (let trial = 0; trial < 3; trial++) {
        const rnd = mulberry32(7000 + trial * 31);
        const T = new Float32Array(3 * P);
        const ST = new Float32Array(3), STT = new Float32Array(3);
        const minT = new Float32Array(3), maxT = new Float32Array(3);
        for (let c = 0; c < 3; c++) { minT[c] = Infinity; maxT[c] = -Infinity; }
        for (let c = 0; c < 3; c++) {
          const b = c * P;
          for (let p = 0; p < P; p++) { const v = rnd(); T[b + p] = v; ST[c] = ST[c]! + v; STT[c] = STT[c]! + v * v; if (v < minT[c]!) minT[c] = v; if (v > maxT[c]!) maxT[c] = v; }
        }
        // shading-luma patch (split), object-id indicator (antibleed), edge field (orient).
        const Lpatch = new Float32Array(P); let SL = 0, SLL = 0;
        const idm = new Float32Array(P); let SI = 0;
        for (let p = 0; p < P; p++) {
          const l = rnd(); Lpatch[p] = l; SL += l; SLL += l * l;
          const on = rnd() > 0.5 ? 1 : 0; idm[p] = on; SI += on;
        }
        const eta = 0.5, kappa = 0.05, orientKappa = 0.05, eac = 0.7, oriTheta = 0.4, oriWe = 1.3;

        const ctx: CellFitCtx = {
          P, T, ST, STT, minT, maxT,
          dxT: new Float32Array(3 * P), dyT: new Float32Array(3 * P), gradTT: new Float32Array(3),
          quality: 3, isQ4: false, lam2: 0, ffg: [1, 1, 1], fbg: [0, 0, 0], mdlLambda: 0.02, eacScale: eac,
          eta, Lpatch, SL, SLL, boundary: true, idm, SI, antibleedKappa: kappa,
          oriBoundary: true, oriTheta, oriWe, orientKappa,
        };
        const sol = solveFamily(f, ctx);

        let bestScore = Infinity, bestPat = 0;
        for (let S = 0; S < (1 << f.k); S++) {
          const mask = new Float32Array(P), dxM = new Float32Array(P), dyM = new Float32Array(P);
          for (let i = 0; i < f.k; i++) if ((S >> i) & 1) {
            const a = f.regions[i]!, dx = f.dxR[i]!, dy = f.dyR[i]!;
            for (let p = 0; p < P; p++) { mask[p] = mask[p]! + a[p]!; dxM[p] = dxM[p]! + dx[p]!; dyM[p] = dyM[p]! + dy[p]!; }
          }
          let sumA = 0, sumAA = 0; for (let p = 0; p < P; p++) { sumA += mask[p]!; sumAA += mask[p]! * mask[p]!; }
          let sse = 0;
          for (let c = 0; c < 3; c++) { let saT = 0; for (let p = 0; p < P; p++) saT += mask[p]! * T[c * P + p]!; sse += chSse(sumAA, sumA, P, saT, ST[c]!, STT[c]!, minT[c]!, maxT[c]!); }
          let score = sse + 0.02 * f.ink[S]! * eac;
          // split: shading-luma channel on the summed mask
          let saL = 0; for (let p = 0; p < P; p++) saL += mask[p]! * Lpatch[p]!;
          score += eta * fitFree({ Saa: sumAA, Sa1: sumA, S11: P }, saL, SL, SLL).sse;
          // antibleed: object-id correlation on the summed mask
          let sai = 0; for (let p = 0; p < P; p++) sai += mask[p]! * idm[p]!;
          const num = sai - (sumA * SI) / P, varA = sumAA - (sumA * sumA) / P, varI = SI - (SI * SI) / P, denom = varA * varI;
          const rho = denom > 1e-12 ? num / Math.sqrt(denom) : 0;
          score -= kappa * Math.abs(rho) * eac;
          // orientation: structure tensor of the summed mask gradient (== identical-mask text glyph)
          score -= orientationBonus(structureTensor(dxM, dyM, P), oriTheta, oriWe, eac, orientKappa);
          if (score < bestScore) { bestScore = score; bestPat = S; }
        }
        expect(sol.pattern).toBe(bestPat);
        expect(sol.score).toBeCloseTo(bestScore, 5);
      }
    }
  });
});

describe('families: braille sub-cell resolution (M3-SPEC §2.4, honest)', () => {
  // M3-SPEC §2.4 predicts braille beats the best block family on a "smooth vertical
  // gradient". Measured, that prediction is FALSE in the unconstrained 2-color (Q3)
  // regime: on a smooth gradient the block families win, because a solid half-block's
  // split lands on the gradient median with zero cross-axis error, while braille's
  // sparse disk coverage injects error at every gap. This is the M1 selection-prior
  // theorem (docs/M1-RESULTS.md) recurring — extra coverage DOF cannot help a target the
  // 2-color fit already reconstructs well. We assert the falsification so it is on record.
  it('does NOT beat blocks on a smooth vertical gradient (M1 selection-prior null holds)', () => {
    const T = grayTarget((_lx, ly) => ly / (CELL_H - 1));
    const ctx = ctxFor(T);
    const quad = solveFamily(buildFamily('quadrant', CELL_W, CELL_H), ctx).sse;
    const sext = solveFamily(buildFamily('sextant', CELL_W, CELL_H), ctx).sse;
    const brl = solveFamily(buildFamily('braille', CELL_W, CELL_H), ctx).sse;
    expect(brl).toBeGreaterThan(Math.min(quad, sext)); // blocks win the smooth gradient
  });

  // The TRUE braille win: sub-cell structure the block families cannot separate. On a
  // target whose bright regions sit on the 2×4 braille dot lattice (with dark gaps),
  // braille reconstructs the structure while any 2×2/2×3 block must average across it.
  it('strictly beats the best block family on lattice-matched sub-cell structure', () => {
    const r2 = (0.21 * CELL_W) ** 2;
    const cx = [0.25 * CELL_W, 0.75 * CELL_W];
    const cy = [0.125 * CELL_H, 0.375 * CELL_H, 0.625 * CELL_H, 0.875 * CELL_H];
    const T = grayTarget((lx, ly) => {
      for (const X of cx) for (const Y of cy)
        if ((lx + 0.5 - X) ** 2 + (ly + 0.5 - Y) ** 2 <= r2) return 1;
      return 0;
    });
    const ctx = ctxFor(T);
    const quad = solveFamily(buildFamily('quadrant', CELL_W, CELL_H), ctx).sse;
    const sext = solveFamily(buildFamily('sextant', CELL_W, CELL_H), ctx).sse;
    const brl = solveFamily(buildFamily('braille', CELL_W, CELL_H), ctx).sse;
    expect(brl).toBeLessThan(Math.min(quad, sext) - 1e-6); // braille resolves the lattice
  });
});
