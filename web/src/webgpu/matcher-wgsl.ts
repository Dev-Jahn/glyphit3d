// Q3 default web-path matcher, WGSL compute shader (perf/webgpu-matcher, SPEC §3–§4).
// One invocation per grid cell (gated cells are re-emitted on the CPU). Per-cell target
// stats and the contrast gate are computed on the CPU (SPEC §4 permits it, keeping the gate
// byte-identical to src/core/match.ts). This kernel does the heavy per-glyph inner product +
// the closed-form two-colour fit, then the winner colours.
//
// It must reproduce matchGrid's EXACT objective, which uses the atlas's STORED sumAA — NOT
// Σα² of the u8-quantized coverage (they differ by up to ~0.08), so the SSE is the algebraic
// form, never a pixel-loop residual. To survive f32 (WGSL has no f64) without the
// STT−a·SaT−b·S1T cancellation (~P·mean², flips low-contrast glyphs), it works in CENTERED
// coordinates: mean = S1T/S11, Saa_c = Saa−Sa1²/S11 and STT_c = STT−S1T²/S11 are precomputed
// on the CPU in f64 and uploaded. The centered cross SaT_c is saT−Sa1·mean from the raw cross
// saT=Σα·T (accumulated 8-way-blocked — Kahan is miscompiled by this Dawn/Tint build). That
// subtraction is NOT itself cancellation-free, but the SSE is built from the AC-scale centered
// STT_c/Saa_c, so selection survives f32: parity vs the f64 CPU matcher is EXACT (ΔSSIM 0, 100%
// glyph agreement across the parity harness). The free OLS is a*=SaT_c/Saa_c, b*=mean−a*·Sa1/S11,
// min SSE = STT_c−a*·SaT_c
// (AC-scale ⇒ no cancellation). A box (a,b) scores SSE = sseFree + Saa·(a−a*)² + 2·Sa1·(a−a*)
// (b−b*) + S11·(b−b*)² — the exact expansion of sseAt about the optimum, cancellation-free,
// with the STORED Saa/Sa1/S11. Selection is first-wins-on-tie (strict <, gi ascending).

export const MATCHER_WGSL = /* wgsl */ `
struct Params {
  mdlLambda : f32,
  G : u32,
  P : u32,
  numCells : u32,
};

// Per-cell target stats. st.xyz = ST_c, st.w = eacScale; sttc.xyz = STT_c (centered);
// mnt.xyz = minT_c; mxt.xyz = maxT_c.
struct CStat {
  st   : vec4<f32>,
  sttc : vec4<f32>,
  mnt  : vec4<f32>,
  mxt  : vec4<f32>,
};

@group(0) @binding(0) var<storage, read>       alpha   : array<f32>;        // G*P, glyph-major
@group(0) @binding(1) var<storage, read>       gscal   : array<vec4<f32>>;  // G: (sumA, sumAA, ink, Saa_c)
@group(0) @binding(2) var<storage, read>       targetT : array<f32>;        // cells*3*P, cell*3P + c*P + i
@group(0) @binding(3) var<storage, read>       cstat   : array<CStat>;      // cells
@group(0) @binding(4) var<storage, read_write> outGlyph: array<u32>;        // cells
@group(0) @binding(5) var<storage, read_write> outFB   : array<f32>;        // cells*6: F0 F1 F2 B0 B1 B2
@group(0) @binding(6) var<uniform>             params  : Params;

fn clampf(x: f32, lo: f32, hi: f32) -> f32 {
  return select(select(x, hi, x > hi), lo, x < lo);
}

struct ChannelFit { F: f32, B: f32, sse: f32 };

// SSE(a,b) − sseFree expansion: matchGrid's sseAt about the free optimum (a*,b*).
fn devSse(sseFree: f32, Saa: f32, Sa1: f32, S11: f32, aStar: f32, bStar: f32, F: f32, B: f32) -> f32 {
  let da = (F - B) - aStar;
  let db = B - bStar;
  return sseFree + Saa * da * da + 2.0 * Sa1 * da * db + S11 * db * db;
}

// One channel's Q3 fit (matches src/core/match.ts channelSse + channelFB). SaTc is the centered
// cross saT−Sa1·mean; SaT is the raw 8-way-blocked cross Σα·T (box candidates use SaT directly).
fn fitChannelQ3(Saa: f32, Sa1: f32, S11: f32, SaT: f32, S1T: f32, SaTc: f32, Saac: f32, STTc: f32, minTc: f32, maxTc: f32) -> ChannelFit {
  let mean = S1T / S11;
  var aStar: f32; var bStar: f32; var sseFree: f32;
  if (Saa == 0.0 || Saac <= 1e-9 * Saa) {
    aStar = 0.0;
    bStar = select(mean, 0.0, S11 == 0.0);
    sseFree = STTc;
  } else {
    aStar = SaTc / Saac;
    bStar = mean - (aStar * Sa1) / S11;
    sseFree = STTc - aStar * SaTc;
  }
  let Fstar = aStar + bStar;
  let Bstar = bStar;
  if (Fstar >= minTc && Fstar <= maxTc && Bstar >= minTc && Bstar <= maxTc) {
    return ChannelFit(Fstar, Bstar, select(sseFree, 0.0, sseFree < 0.0));
  }
  let loF = minTc; let hiF = maxTc; let loB = minTc; let hiB = maxTc;
  var candF: array<f32, 4>;
  var candB: array<f32, 4>;
  let a0 = select((SaT - loB * Sa1) / Saa, 0.0, Saa == 0.0);
  candF[0] = clampf(a0 + loB, loF, hiF); candB[0] = loB;
  let a1 = select((SaT - hiB * Sa1) / Saa, 0.0, Saa == 0.0);
  candF[1] = clampf(a1 + hiB, loF, hiF); candB[1] = hiB;
  let denom = S11 - 2.0 * Sa1 + Saa;
  let b2 = select((S1T - SaT - loF * (Sa1 - Saa)) / denom, loB, denom == 0.0);
  candF[2] = loF; candB[2] = clampf(b2, loB, hiB);
  let b3 = select((S1T - SaT - hiF * (Sa1 - Saa)) / denom, loB, denom == 0.0);
  candF[3] = hiF; candB[3] = clampf(b3, loB, hiB);
  var bF = candF[0]; var bB = candB[0];
  var bSse = devSse(sseFree, Saa, Sa1, S11, aStar, bStar, bF, bB);
  for (var i = 1; i < 4; i = i + 1) {
    let s = devSse(sseFree, Saa, Sa1, S11, aStar, bStar, candF[i], candB[i]);
    if (s < bSse) { bSse = s; bF = candF[i]; bB = candB[i]; }
  }
  return ChannelFit(bF, bB, bSse);
}

struct GlyphResult { score: f32, F: vec3<f32>, B: vec3<f32> };

// Full Q3 selection score of one glyph on one cell, plus its fitted (F,B). Reads the cell's
// target patch from workgroup shared memory sT (channel-major c*P+i). Per-glyph and
// per-channel independent, so this is BIT-IDENTICAL regardless of which thread runs it — the
// argmin over these scores reproduces matchGrid exactly.
fn fitCellGlyph(cell: u32, gi: u32, P: u32) -> GlyphResult {
  let S11 = f32(P);
  let cs = cstat[cell];
  let gs = gscal[gi];
  let Sa1 = gs.x; let Saa = gs.y; let ink = gs.z; let Saac = gs.w;
  var ST   = array<f32, 3>(cs.st.x,   cs.st.y,   cs.st.z);
  var STTc = array<f32, 3>(cs.sttc.x, cs.sttc.y, cs.sttc.z);
  var MN   = array<f32, 3>(cs.mnt.x,  cs.mnt.y,  cs.mnt.z);
  var MX   = array<f32, 3>(cs.mxt.x,  cs.mxt.y,  cs.mxt.z);
  let abase = gi * P;
  var Fv = vec3<f32>(0.0, 0.0, 0.0);
  var Bv = vec3<f32>(0.0, 0.0, 0.0);
  var score = 0.0;
  for (var c = 0u; c < 3u; c = c + 1u) {
    let cbase = c * P;
    let mean = ST[c] / S11;
    // Raw cross SaT = Σ_i α_i·T_i via 8-way blocked accumulation: 8 independent partial sums
    // cut the O(n·ε) naive error ~8× and — unlike Kahan — carry no compensation term for Tint
    // to reassociate away (Kahan is silently miscompiled on this Dawn/Tint build).
    var acc = array<f32, 8>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    for (var i = 0u; i < P; i = i + 1u) {
      let k = i & 7u;
      acc[k] = acc[k] + alpha[abase + i] * sT[cbase + i];
    }
    let saT = ((acc[0] + acc[1]) + (acc[2] + acc[3])) + ((acc[4] + acc[5]) + (acc[6] + acc[7]));
    let saTc = saT - Sa1 * mean;
    let fit = fitChannelQ3(Saa, Sa1, S11, saT, ST[c], saTc, Saac, STTc[c], MN[c], MX[c]);
    Fv[c] = fit.F; Bv[c] = fit.B; score = score + fit.sse;
  }
  score = score + params.mdlLambda * ink * cs.st.w;
  return GlyphResult(score, Fv, Bv);
}

// One WORKGROUP per cell: the cell's target patch is loaded once into shared memory, then the
// 64 threads scan the G glyphs strided (each keeps its lowest-gi minimum), and a workgroup
// reduction picks the global minimum with first-wins-on-tie (lowest gi). This is the SPEC §4
// design; it raises occupancy from cells threads to cells·64 and reuses the patch across
// glyphs. Output is bit-identical to the sequential scan (same per-glyph scores + tie rule).
const WG : u32 = 64u;
var<workgroup> sT : array<f32, 768>; // 3·P scratch, P ≤ 256 (these profiles: P = 190)
var<workgroup> rScore : array<f32, 64>;
var<workgroup> rGi : array<u32, 64>;

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let cell = wid.x;
  if (cell >= params.numCells) { return; }
  let P = params.P;
  let G = params.G;
  let tbase = cell * 3u * P;
  let n3 = 3u * P;

  // cooperative load of the cell's target patch into shared memory.
  for (var idx = lid.x; idx < n3; idx = idx + WG) { sT[idx] = targetT[tbase + idx]; }
  workgroupBarrier();

  // strided glyph scan; strict < keeps the lowest gi on a tie within this thread.
  var localScore = 1e30;
  var localGi = 0u;
  for (var gi = lid.x; gi < G; gi = gi + WG) {
    let r = fitCellGlyph(cell, gi, P);
    if (r.score < localScore) { localScore = r.score; localGi = gi; }
  }
  rScore[lid.x] = localScore;
  rGi[lid.x] = localGi;
  workgroupBarrier();

  // reduce to global min score, lowest gi on tie (matchGrid first-wins).
  for (var stride = WG / 2u; stride > 0u; stride = stride >> 1u) {
    if (lid.x < stride) {
      let s2 = rScore[lid.x + stride]; let g2 = rGi[lid.x + stride];
      let s1 = rScore[lid.x]; let g1 = rGi[lid.x];
      if (s2 < s1 || (s2 == s1 && g2 < g1)) { rScore[lid.x] = s2; rGi[lid.x] = g2; }
    }
    workgroupBarrier();
  }

  if (lid.x == 0u) {
    let bestGi = rGi[0];
    let w = fitCellGlyph(cell, bestGi, P); // recompute the winner's (F,B)
    outGlyph[cell] = bestGi;
    outFB[cell * 6u + 0u] = w.F.x; outFB[cell * 6u + 1u] = w.F.y; outFB[cell * 6u + 2u] = w.F.z;
    outFB[cell * 6u + 3u] = w.B.x; outFB[cell * 6u + 4u] = w.B.y; outFB[cell * 6u + 5u] = w.B.z;
  }
}
`;
