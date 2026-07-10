// JS mirror of matcher-wgsl.ts (Q3 branch). A faithful hand-transcription of the WGSL fit so
// a vitest unit can prove it is algebraically identical to src/core/match.ts's channelSse /
// channelFB (quality===3) — which cannot run in WGSL, and WGSL cannot run in node. The
// end-to-end SHADER↔CPU proof is the WebGPU parity harness; this guards the algebra.
//
// The kernel must reproduce matchGrid's EXACT objective, which uses the atlas's STORED
// sumAA (Saa) — NOT Σα² of the u8-quantized coverage (they differ by up to ~0.08). So the
// SSE cannot be a pixel-loop residual (that would use the quantized α); it must be the
// algebraic form. To survive f32 (WGSL has no f64) without the STT−a·SaT−b·S1T cancellation
// (~P·mean², ~3e-6 f32 error → flips low-contrast glyphs), everything is computed in CENTERED
// coordinates: with mean=S1T/S11, Saa_c=Saa−Sa1²/S11, STT_c=STT−S1T²/S11 (both precomputed on
// the CPU in f64 and uploaded), SaT_c=SaT−Sa1·mean, the free OLS is a*=SaT_c/Saa_c,
// b*=mean−a*·Sa1/S11, and its min SSE is STT_c−a*·SaT_c (all AC-scale ⇒ no cancellation). A
// box-constrained (a,b) scores SSE = sseFree + Saa·(a−a*)² + 2·Sa1·(a−a*)(b−b*) + S11·(b−b*)²
// — the exact quadratic expansion of sseAt about the optimum, cancellation-free. Both use the
// STORED Saa/Sa1/S11, so this equals matchGrid's f64 channelSse to f64 precision.

export interface ChannelFit { F: number; B: number; sse: number }

function clampf(x: number, lo: number, hi: number): number { return x < lo ? lo : x > hi ? hi : x; }

// One channel's Q3 fit: returns the fitted (F,B) and the selection SSE, matching
// src/core/match.ts channelSse+channelFB. `Saac`/`STTc` are the centered stats (uploaded,
// f64-accurate); `SaTc` = SaT − Sa1·mean is the centered cross-term (the kernel accumulates
// the raw cross saT = Σα·T via 8-way blocked summation — NOT Kahan, which is silently
// miscompiled on this Dawn/Tint build — then forms saTc = saT − Sa1·mean; that subtraction is
// not itself cancellation-free, but the centered/AC-scale SSE formulation above is what avoids
// the f32 cancellation); the raw Saa/Sa1/S11/SaT/S1T
// are the stored/raw stats (Saa = STORED sumAA — the objective matchGrid uses).
export function fitChannelQ3(
  Saa: number, Sa1: number, S11: number, SaT: number, S1T: number,
  SaTc: number, Saac: number, STTc: number, minTc: number, maxTc: number,
): ChannelFit {
  const mean = S1T / S11;
  // Free OLS. matchGrid fitFree degenerates iff Saa==0 || det <= 1e-9·Saa·S11, and
  // det = Saa·S11 − Sa1² = S11·Saac, so the condition is Saa==0 || Saac <= 1e-9·Saa.
  let aStar: number, bStar: number, sseFree: number;
  if (Saa === 0 || Saac <= 1e-9 * Saa) {
    aStar = 0;
    bStar = S11 === 0 ? 0 : mean;
    sseFree = STTc; // sseAt(0, mean) = STT − S1T²/S11 = STTc
  } else {
    aStar = SaTc / Saac;
    bStar = mean - (aStar * Sa1) / S11;
    sseFree = STTc - aStar * SaTc; // = STTc − SaTc²/Saac
  }
  const Fstar = aStar + bStar;
  const Bstar = bStar;
  if (Fstar >= minTc && Fstar <= maxTc && Bstar >= minTc && Bstar <= maxTc) {
    return { F: Fstar, B: Bstar, sse: sseFree < 0 ? 0 : sseFree }; // matchGrid clamps free.sse
  }

  // Box-constrained: 4 edge candidates (matchGrid fitBox), scored by the deviation form.
  const loF = minTc, hiF = maxTc, loB = minTc, hiB = maxTc;
  const candF = [0, 0, 0, 0];
  const candB = [0, 0, 0, 0];
  // B fixed at box bounds: a via fitFgOnly (raw SaT, stored Saa), clamp F.
  const a0 = Saa === 0 ? 0 : (SaT - loB * Sa1) / Saa;
  candF[0] = clampf(a0 + loB, loF, hiF); candB[0] = loB;
  const a1 = Saa === 0 ? 0 : (SaT - hiB * Sa1) / Saa;
  candF[1] = clampf(a1 + hiB, loF, hiF); candB[1] = hiB;
  // F fixed at box bounds: minimize over b; denom = S11 − 2·Sa1 + Saa.
  const denom = S11 - 2 * Sa1 + Saa;
  const b2 = denom === 0 ? loB : (S1T - SaT - loF * (Sa1 - Saa)) / denom;
  candF[2] = loF; candB[2] = clampf(b2, loB, hiB);
  const b3 = denom === 0 ? loB : (S1T - SaT - hiF * (Sa1 - Saa)) / denom;
  candF[3] = hiF; candB[3] = clampf(b3, loB, hiB);
  // SSE(a,b) = sseFree + Saa·da² + 2·Sa1·da·db + S11·db² (da=a−a*, db=b−b*). Use the UNCLAMPED
  // sseFree here so this equals matchGrid's sseAt exactly (its box path never clamps).
  let bF = candF[0]!, bB = candB[0]!;
  const dev = (F: number, B: number): number => {
    const da = (F - B) - aStar, db = B - bStar;
    return sseFree + Saa * da * da + 2 * Sa1 * da * db + S11 * db * db;
  };
  let bSse = dev(bF, bB);
  for (let i = 1; i < 4; i++) {
    const s = dev(candF[i]!, candB[i]!);
    if (s < bSse) { bSse = s; bF = candF[i]!; bB = candB[i]!; }
  }
  return { F: bF, B: bB, sse: bSse };
}

// JS mirror of TEMPORAL_MATCHER_WGSL's thread-0 glyph-hysteresis select (matcher-wgsl.ts §4.1,
// feat/temporal-animation). Given a cell's per-glyph selection scores (index = glyph index; lower =
// better residual, the SAME quantity src/core/match.ts argmins), it (1) picks the fresh winner g*
// with the kernel's exact rule — strict `<`, ascending gi, so an EXACT score tie keeps the lowest
// gi (first-wins) — then (2) RETAINS the predecessor glyph prevGi iff hysteresis holds: hystDelta>0
// AND the fresh winner does not beat the retained glyph by a decisive margin δ·eac, i.e.
// scores[prevGi] − scores[g*] < hystDelta·eac. The δ>0 guard is STRICT: at hystDelta<=0 the branch
// is fully short-circuited (returns g*), which is why an ε=0/δ=0 delta frame is byte-identical to a
// full rematch (an exact tie at δ=0 resolves to g* via first-wins, never hijacked by prevGi). `eac`
// is the cell's E_AC (cstat.st.w) — all Q3 score differences are O(E_AC), so the margin scales with
// it. This is the precise rule the GPU applies; the fuzz suite pins it to an independent fit.ts
// oracle. Replace uses `>=` (retained−best >= δ·eac ⇒ replace) to match the harness δ-margin
// oracle's `margin >= delta` boundary; here that is `< δ·eac ⇒ retain`.
export function selectWithHysteresis(scores: number[], prevGi: number, hystDelta: number, eac: number): number {
  let bestGi = 0, best = Infinity;
  for (let gi = 0; gi < scores.length; gi++) if (scores[gi]! < best) { best = scores[gi]!; bestGi = gi; }
  if (hystDelta <= 0) return bestGi;
  const retained = scores[prevGi]!;
  return (retained - best) < hystDelta * eac ? prevGi : bestGi;
}
