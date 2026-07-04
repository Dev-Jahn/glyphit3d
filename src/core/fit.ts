import type { FitStatsG } from './types.js';

export interface FitResult { a: number; b: number; sse: number }

// Full quadratic SSE at ANY (a,b) — the only valid scorer off the OLS optimum (DESIGN §3.2 (2)).
export function sseAt(g: FitStatsG, a: number, b: number, SaT: number, S1T: number, STT: number): number {
  return STT - 2 * (a * SaT + b * S1T) + (a * a * g.Saa + 2 * a * b * g.Sa1 + b * b * g.S11);
}

// Unconstrained OLS; uses the regression identity for sse (valid ONLY here).
export function fitFree(g: FitStatsG, SaT: number, S1T: number, STT: number): FitResult {
  const det = g.Saa * g.S11 - g.Sa1 * g.Sa1;
  if (g.Saa === 0 || det <= 1e-9 * g.Saa * g.S11) {
    const b = g.S11 === 0 ? 0 : S1T / g.S11;
    return { a: 0, b, sse: sseAt(g, 0, b, SaT, S1T, STT) };
  }
  const a = (g.S11 * SaT - g.Sa1 * S1T) / det;
  const b = (g.Saa * S1T - g.Sa1 * SaT) / det;
  let sse = STT - a * SaT - b * S1T;
  if (sse < 0) sse = 0; // clamp tiny negatives from roundoff
  return { a, b, sse };
}

// B fixed (fg-only mode, Q2): substitute a = F-B, b = B; minimize over a.
export function fitFgOnly(g: FitStatsG, SaT: number, S1T: number, STT: number, B: number): FitResult {
  const a = g.Saa === 0 ? 0 : (SaT - B * g.Sa1) / g.Saa;
  return { a, b: B, sse: sseAt(g, a, B, SaT, S1T, STT) };
}

// Box-constrained on F = a+b and B = b (DESIGN §3.4; exact convex-QP-over-box).
export function fitBox(g: FitStatsG, SaT: number, S1T: number, STT: number,
                       loF: number, hiF: number, loB: number, hiB: number): { F: number; B: number; sse: number } {
  const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

  // 1. unconstrained optimum
  const free = fitFree(g, SaT, S1T, STT);
  const Ffree = free.a + free.b;
  const Bfree = free.b;
  if (Ffree >= loF && Ffree <= hiF && Bfree >= loB && Bfree <= hiB) {
    return { F: Ffree, B: Bfree, sse: sseAt(g, Ffree - Bfree, Bfree, SaT, S1T, STT) };
  }

  // 2. edge candidates — each a 1-D convex quadratic solved then clamped (exact).
  const cands: Array<{ F: number; B: number }> = [];

  // B fixed at box bounds: solve F via fitFgOnly, clamp F.
  for (const B of [loB, hiB]) {
    const r = fitFgOnly(g, SaT, S1T, STT, B);
    const F = clamp(r.a + B, loF, hiF);
    cands.push({ F, B });
  }

  // F fixed at box bounds: minimize over b with a = F-b => pred = F·m + b·(1ext−m).
  const denom = g.S11 - 2 * g.Sa1 + g.Saa; // Σ(1ext−m)²
  for (const F of [loF, hiF]) {
    const bStar = denom === 0 ? loB : (S1T - SaT - F * (g.Sa1 - g.Saa)) / denom;
    const B = clamp(bStar, loB, hiB);
    cands.push({ F, B });
  }

  // 3. score every candidate with sseAt (never the identity), return min.
  let best = cands[0]!;
  let bestSse = sseAt(g, best.F - best.B, best.B, SaT, S1T, STT);
  for (let i = 1; i < cands.length; i++) {
    const c = cands[i]!;
    const s = sseAt(g, c.F - c.B, c.B, SaT, S1T, STT);
    if (s < bestSse) { bestSse = s; best = c; }
  }
  return { F: best.F, B: best.B, sse: bestSse };
}
