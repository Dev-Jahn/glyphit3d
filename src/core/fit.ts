import type { FitStatsG } from './types.js';
import { luma } from './color.js';

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

export type Vec3 = [number, number, number];
// Contrast-floor decision (Round A ASCII-identity, feat/contrast-floor-fill). `space`=true
// means demote the winning glyph to a solid flat cell (space + `mean`); false means keep the
// glyph with the contrast-boosted colors (F,B). When null is returned the free fit already
// clears the floor — the caller keeps it verbatim.
export interface FloorDecision { space: boolean; F: Vec3; B: Vec3; mean: Vec3 }

// Perceptual contrast floor on a two-color fit, in WORKING-space luma units (DESIGN §3.1
// appearance model: pred = F·α + B·(1−α); a glyph is only legible as a *lightness* mark, so
// the visibility axis is Rec.709 luma — the same projection color.ts/ssim use). Inputs are the
// winner glyph's plain L2 Gram `g` {Saa=Σα², Sa1=Σα, S11=P}, its already-fit working-space
// colors (F,B), and the cell's per-channel plain stats (ST=ΣT, STT=ΣT², SaT=Σα·T). `bgFixed`
// is Q2 (fg-only: B is pinned at fixedBg and never re-solved).
//
// If ΔL = |luma(F−B)| < floor the fit is (near-)invisible. We enforce the floor along the fit's
// OWN chromatic direction (the LS-optimal fg/bg axis, DESIGN §3.2): scale a=F−B by s=floor/ΔL so
// luma(a')=floor. a' is then PINNED (an equality constraint from the feature), leaving the DC term
// b as the only DOF. The emit gamut is the working-space box [0,1] (gammaU8/toU8 both clamp there),
// so b must be re-solved UNDER that box, NOT projected onto it after the fact — DESIGN §3.2 sends
// out-of-gamut fits to §3.4's constrained fit, and §3.4 warns that clamping the free solution
// instead of re-solving the free variable is wrong (it silently breaks luma(a')=floor and the mean,
// exactly in the near-black regime this feature targets). With a' pinned, keeping both B'=b and
// F'=b+a' in [0,1] confines b to the 1-D box [max(0,−a'), min(1,1−a')]; the LS-optimal DC there is
// the mean-preserving b*=mean_c−a'·ρ clamped into that box (exact for a 1-D convex quadratic). When
// the box is EMPTY (|a'|>1: the floor separation exceeds the whole gamut on this channel — Q3/Q4 —
// or F'=b+a' leaves [0,1] with b pinned at fixedBg — Q2), the floor is unmeetable in gamut and we
// demote to a solid flat cell. So the mean is preserved when gamut allows and only shifts minimally
// when it binds, but luma(a')=floor is ALWAYS met on a kept glyph. The boosted fit is off the OLS
// optimum, so its residual MUST use §3.2 (2) sseAt, scored at the ACTUALLY-EMITTABLE (in-gamut) b.
// Decision rule (derived, not tuned): compare that constrained residual against the flat-fill
// residual (space) — E_AC for free bg, or the fixed-bg fill residual for Q2. Keep the boosted
// glyph iff it still reconstructs the cell no worse than a solid flat cell would; otherwise the
// boost is net-harmful and we demote to space. The rule picks the smaller-residual representation.
// Legibility of the two outcomes is NOT symmetric across qualities: for free-bg Q3/Q4 both are
// legible — a kept glyph meets the floor and a demote fills bg = cell-mean (a solid, visible cell).
// For fixed-bg Q2 only the KEEP branch is guaranteed legible: a Q2 demote emits space over the
// FIXED bg (here near-black), which is itself invisible ink — Q2 has no free bg to fill, so it can
// only trade a sub-floor glyph for a blank near-black cell. (The demo dark path is Q3, so its
// demotes are the legible cell-mean fill; Q2 demotes are the honest lesser-evil, not "legible".)
//
// NOTE (scope of the model): pinning a' = a·(floor/ΔL) is a deliberate HUE-PRESERVING restriction —
// it lifts contrast along the fit's OWN chromatic axis, not the full 6-DOF box-constrained-LS
// minimizer of the floored problem (which could rotate the fg/bg hue to trade a smaller residual).
// A consequence: the clean keep/demote reduction is closed-form ONLY in the gamut-non-binding
// regime. There, DC is mean-preserving (b* inside the box) and the residual is a quadratic in the
// AC scale s=floor/ΔL minimized at the free fit (s=1); the flat fill is s=0, so E_pin ≤ E_space ⟺
// (s−1)² ≤ 1 ⟺ s ≤ 2 ⟺ keep iff ΔL ≥ floor/2 — independent of content. In the near-black BINDING
// regime the box-constrained DC re-solve clamps b off the mean, breaking that quadratic, so the
// keep-vs-demote decision becomes content-dependent (it depends on how hard the gamut binds), which
// is exactly why it is computed per cell here rather than reduced to the ΔL ≥ floor/2 test.
export function contrastFloorFit(
  g: FitStatsG, F: ArrayLike<number>, B: ArrayLike<number>,
  ST: ArrayLike<number>, STT: ArrayLike<number>, SaT: ArrayLike<number>,
  P: number, floor: number, bgFixed: boolean,
): FloorDecision | null {
  const dL = Math.abs(luma(F[0]! - B[0]!, F[1]! - B[1]!, F[2]! - B[2]!));
  if (dL >= floor) return null; // free fit already clears the floor
  const mean: Vec3 = [ST[0]! / P, ST[1]! / P, ST[2]! / P];
  // flat-fill (space) residual: free bg minimizes at the cell mean → E_AC; fixed bg fills at B.
  let sseSpace = 0;
  for (let c = 0; c < 3; c++) {
    sseSpace += bgFixed
      ? STT[c]! - 2 * B[c]! * ST[c]! + P * B[c]! * B[c]!
      : STT[c]! - (ST[c]! * ST[c]!) / P;
  }
  // isoluminant fit (no lightness axis to lift) → cannot be made legible by scaling; flat-fill.
  if (dL < 1e-6) return { space: true, F: [...mean], B: [...mean], mean };
  const s = floor / dL;
  const rho = g.Sa1 / P; // ink fraction ρ; mean-preserving DC is b* = mean_c − a'·ρ (§3.2 normal eqn)
  const Fp: Vec3 = [0, 0, 0];
  const Bp: Vec3 = [0, 0, 0];
  let ssePin = 0;
  for (let c = 0; c < 3; c++) {
    const a = (F[c]! - B[c]!) * s; // pinned AC: luma(a')=floor by construction of s
    let b: number;
    if (bgFixed) {
      // Q2: bg pinned at fixedBg, so b is immovable. The only gamut lever is F'=b+a'; if it leaves
      // [0,1] the floor cannot be met in gamut (clamping F' would silently break luma(a')=floor).
      b = B[c]!;
      const Fc = b + a;
      if (Fc < 0 || Fc > 1) return { space: true, F: [...mean], B: [...mean], mean };
    } else {
      // Q3/Q4: re-solve b under its gamut box [max(0,−a'), min(1,1−a')] (keeps B'=b and F'=b+a' in
      // [0,1]). Empty box ⇔ |a'|>1 ⇔ the floor separation exceeds the whole gamut → demote to space.
      const lo = a < 0 ? -a : 0;      // = max(0, −a')
      const hi = a > 0 ? 1 - a : 1;   // = min(1, 1−a')
      if (lo > hi) return { space: true, F: [...mean], B: [...mean], mean };
      const bStar = mean[c]! - a * rho;
      b = bStar < lo ? lo : bStar > hi ? hi : bStar; // 1-D convex QP over the box: clamp is exact
    }
    Fp[c] = b + a; Bp[c] = b;
    ssePin += sseAt(g, a, b, SaT[c]!, ST[c]!, STT[c]!);
  }
  return { space: ssePin > sseSpace, F: Fp, B: Bp, mean };
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
