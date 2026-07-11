import type { LinearImage, Atlas, Grid, GridCell, MatchOptions, FitStatsG, Candidate } from './types.js';
import { sseAt, fitFree, fitFgOnly, fitBox, contrastFloorFit } from './fit.js';
import { cellStats } from './stats.js';
import { gradients } from '../image/image.js';
import { linearToSrgb, luma } from './color.js';
import { buildFamilies, solveFamily } from '../atlas/families.js';
import type { CellFitCtx, FamilySolve } from '../atlas/families.js';
import { glyphOrientations, orientationBonus, borderProfiles, structureTensor } from '../atlas/orientation.js';
import type { Orientation } from '../atlas/orientation.js';
import { extractPolylines, viterbiContour } from './contour.js';
import { buildPalette, bestPair, paletteSrgb } from './palette.js';
import { precomputeIdentity, rhoStar, uWeight, rampSet } from './identity.js';
import { coupleFg, resolveCoupling } from './coupling.js';

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }

// linear working value → sRGB u8.
function toU8(v: number): number {
  const s = Math.round(linearToSrgb(v));
  return s < 0 ? 0 : s > 255 ? 255 : s;
}

// gamma working value (already sRGB-encoded [0,1]) → u8 directly (no re-encode).
function gammaU8(v: number): number {
  return Math.round(clamp01(v) * 255);
}

// Per-channel residual for the current fit mode. Q3/Q4 refit via fitBox whenever
// the free optimum leaves the per-channel [minT,maxT] box, and score with sseAt
// (never the regression identity) — fitBox already does this internally.
function channelSse(
  g: FitStatsG, SaT: number, S1T: number, STT: number,
  quality: number, minTc: number, maxTc: number, ffg: number, fbg: number,
): number {
  if (quality === 1) return sseAt(g, ffg - fbg, fbg, SaT, S1T, STT);
  if (quality === 2) {
    const r = fitFgOnly(g, SaT, S1T, STT, fbg);
    const F = clamp01(r.a + fbg);
    return sseAt(g, F - fbg, fbg, SaT, S1T, STT);
  }
  const free = fitFree(g, SaT, S1T, STT);
  const F = free.a + free.b;
  const B = free.b;
  if (F >= minTc && F <= maxTc && B >= minTc && B <= maxTc) return free.sse;
  return fitBox(g, SaT, S1T, STT, minTc, maxTc, minTc, maxTc).sse;
}

// Same fit, returning the (F,B) linear colors. Called once per winning cell.
function channelFB(
  g: FitStatsG, SaT: number, S1T: number, STT: number,
  quality: number, minTc: number, maxTc: number, ffg: number, fbg: number,
): [number, number] {
  if (quality === 1) return [ffg, fbg];
  if (quality === 2) {
    const r = fitFgOnly(g, SaT, S1T, STT, fbg);
    return [clamp01(r.a + fbg), fbg];
  }
  const free = fitFree(g, SaT, S1T, STT);
  const F = free.a + free.b;
  const B = free.b;
  if (F >= minTc && F <= maxTc && B >= minTc && B <= maxTc) return [F, B];
  const box = fitBox(g, SaT, S1T, STT, minTc, maxTc, minTc, maxTc);
  return [box.F, box.B];
}

export function matchGrid(img: LinearImage, atlas: Atlas, opts: MatchOptions): Grid {
  const { cellW, cellH, P, glyphs } = atlas;
  const cols = Math.floor(img.w / cellW);
  const rows = Math.floor(img.h / cellH);
  const space = opts.space ?? 'gamma';

  // gamma / predict-terminal mode (DESIGN §3.1): after the (correctly linear) area
  // resample, encode the working image to gamma floats [0,1] BEFORE gradients/stats;
  // the closed forms are space-agnostic so the whole fit runs unchanged, and output
  // colors are the gamma floats mapped straight to u8 (no second encode).
  let work = img;
  if (space === 'gamma') {
    const g = new Float32Array(img.data.length);
    for (let i = 0; i < g.length; i++) g[i] = linearToSrgb(img.data[i]!) / 255;
    work = { w: img.w, h: img.h, data: g };
  }
  const encode = space === 'gamma'
    ? (rgb: ArrayLike<number>): [number, number, number] => [gammaU8(rgb[0]!), gammaU8(rgb[1]!), gammaU8(rgb[2]!)]
    : (rgb: ArrayLike<number>): [number, number, number] => [toU8(rgb[0]!), toU8(rgb[1]!), toU8(rgb[2]!)];

  const { dx, dy } = gradients(work);
  const quality = opts.quality;
  const isQ4 = quality === 4;
  const lam2 = opts.edgeLambda * opts.edgeLambda;
  const G = glyphs.length;
  // fixedFg/fixedBg are documented linear RGB. The fit, gate branch and emit all run
  // in the WORKING space, so in gamma mode convert them to gamma floats [0,1] once
  // here (the option contract stays space-invariant; only internals convert).
  const toWork = (rgb: [number, number, number]): [number, number, number] =>
    space === 'gamma'
      ? [linearToSrgb(rgb[0]) / 255, linearToSrgb(rgb[1]) / 255, linearToSrgb(rgb[2]) / 255]
      : rgb;
  const ffg = toWork(opts.fixedFg);
  const fbg = toWork(opts.fixedBg);

  // ASCII-identity aesthetic mode (spec §3/§4): structure-aware selection prior + shape-color
  // coupling, layered on the fixed-bg Q2 machinery. Both default OFF → the guarded blocks below
  // never execute and output stays byte-identical (V1). L_B/L_F are the fixed bg/fg working luma;
  // ρ* and the coupling gain are derived for general (L_B,L_F) but validated only for bright-fg-on-
  // dark-bg (L_F−L_B ≥ 0.5) this round. All guards fail fast (no fallback, spec §3.4/§4.2).
  const identityLambda = opts.identityLambda ?? 0;
  const identityTau = opts.identityTau ?? 2.5e-4;
  const couplingParams = opts.coupling ? resolveCoupling(opts.coupling) : null;
  const LB = luma(fbg[0], fbg[1], fbg[2]);
  const LF = luma(ffg[0], ffg[1], ffg[2]);
  if (identityLambda > 0) {
    if (quality !== 2) throw new Error('identity selection prior (identityLambda>0) requires quality 2 (fixed-bg fg fit)');
    if ((opts.families?.length ?? 0) > 0) throw new Error('identity selection prior is not supported with families in v1 (penalty not forwarded into solveFamily)');
    if (LF - LB < 0.5) throw new Error('identity selection prior requires L_F − L_B ≥ 0.5 working luma (bright-fg-on-dark-bg; ρ* degenerates otherwise)');
  }
  // feat/identity-ascii-charset-coherence (spec): selectable charset-coherence mode. 'none'/absent →
  // no new logic runs → byte-identical (top invariant). Any non-'none' mode requires the identity
  // prior on (identityLambda>0) AND quality 2 — same loud-throw contract as the other identity flags
  // (no fallback). Both guards are independent of the identityLambda block above (which is skipped when
  // identityLambda=0), so coherence≠none with identityLambda=0 still fails fast here.
  const coherence = opts.identityCoherence ?? 'none';
  if (coherence !== 'none') {
    if (quality !== 2) throw new Error('identity charset-coherence requires quality 2 (fixed-bg fg fit)');
    if (identityLambda <= 0) throw new Error('identity charset-coherence requires the identity prior on (identityLambda > 0)');
  }
  const cohRampBias = coherence === 'ramp-bias';
  const cohPureRamp = coherence === 'pure-ramp';
  const cohSmooth = coherence === 'smooth';
  const cohRestrict = cohRampBias || cohPureRamp; // object-cell scan candidates limited to R
  // Ramp candidate set R (spec) built once per atlas — only when a coherence mode is active.
  const ramp = coherence !== 'none' ? rampSet(atlas) : null;
  // ramp-bias/pure-ramp restrict the object-cell scan to R; an empty R would skip every glyph and
  // silently emit glyphs[0] (a fallback). Fail fast instead (spec no-fallback), mirroring the other
  // identity guards. CLI-unreachable (all shipped charsets ⊇ ASCII) but matchGrid is a public API.
  if (cohRestrict && ramp!.idx.length === 0) throw new Error('identity charset-coherence ramp-bias/pure-ramp requires a non-empty ramp set R (atlas contains none of the ramp glyphs)');
  const U_MIN = 0.5; // ramp-bias uniformity-weight floor: u' = max(u, u_min) (spec, no extra knob)
  if (couplingParams) {
    if (quality !== 2) throw new Error('shape-color coupling requires quality 2 (fixed-bg fg fit)');
    if (opts.styleAlbedoColors) throw new Error('shape-color coupling is incompatible with styleAlbedoColors (two competing color-rewrite passes)');
    // Families are emitted via emitWinner (§2b/3a) which applies NO coupling, so a family winner
    // would ship uncoupled fg while text/gated winners ship coupled fg — two inconsistent color
    // pipelines in one grid. Fail fast (spec §4.3: this state is unreachable/thrown), mirroring the
    // identity-prior families guard above; coupling is not forwarded into solveFamily in v1.
    if ((opts.families?.length ?? 0) > 0) throw new Error('shape-color coupling is not supported with families in v1 (coupling not forwarded into the family emit)');
  }
  // Per-atlas ink coverage ρ_g = sumA/P (spec §3.1), precomputed once. Only when the prior is on.
  const idRho = identityLambda > 0 ? precomputeIdentity(atlas).rho : null;
  // Coupling illumination source (spec §4.1): the albedo-free shading-luma AOV cell mean drives the
  // true 광량/조도 saturation transfer; absent → the 2D fallback ℓ = Ȳ is used per cell.
  const couplingShading = couplingParams ? opts.aov?.shadingLuma : undefined;
  if (couplingShading && couplingShading.length !== img.w * img.h) throw new Error('aov.shadingLuma must be gridW*gridH');
  // Cell illumination ℓ (spec §4.1): mean shadingLuma over the cell (true illumination, bake path)
  // when the AOV is present, else the 2D fallback Ȳ. O(P), only on the winning/gated emit path.
  const cellIllum = (x0: number, y0: number, Ybar: number): number => {
    if (!couplingShading) return Ybar;
    let s = 0;
    for (let ly = 0; ly < cellH; ly++) {
      const gy = y0 + ly;
      for (let lx = 0; lx < cellW; lx++) s += couplingShading[gy * img.w + (x0 + lx)]!;
    }
    return s / P;
  };

  // Palette-constrained color (DESIGN §6, core/palette.ts). Built in the WORKING space so the
  // fit/scoring/nearest-neighbor distances pair with the fit space (gamma default). The truecolor
  // path is completely untouched when opts.palette is absent (pal === null → every guarded block
  // below is skipped and output stays byte-identical). Only Q3/Q4 (fg-bg) is meaningful, and the
  // mode is a clean hook point kept free of the M1/M3 selection priors — reject the combination
  // loudly rather than silently producing a wrong constrained fit.
  const pal = opts.palette ? buildPalette(opts.palette, space) : null;
  const refineK = opts.paletteRefineK ?? 8;
  if (pal) {
    if (quality < 3) throw new Error('palette mode requires quality 3 or 4 (fg-bg)');
    if ((opts.families?.length ?? 0) > 0 || (opts.topK ?? 0) > 0 || (opts.splitSelection ?? 0) > 0 ||
        (opts.antibleedKappa ?? 0) > 0 || opts.styleAlbedoColors || (opts.collapseThreshold ?? 0) > 0 ||
        (opts.orientKappa ?? 0) > 0) {
      throw new Error('palette mode is incompatible with families/contour/topK/split/antibleed/style-albedo/collapse/orient');
    }
  }
  // scratch for the palette pair scorer (per-channel saT/STT with the Q4 edge augmentation folded in)
  const paSaT = pal ? new Float64Array(3) : null;
  const paSTT = pal ? new Float64Array(3) : null;

  // Post-selection invisibility collapse (GATE finding, bench/out/gate-sweep.md). After the
  // winner (text glyph OR family pattern) is chosen, if its fitted fg/bg are visually
  // indistinguishable in the OUTPUT encoding — max-channel |F−B| (u8) < collapseThreshold —
  // replace the cell with space + the winner's coverage-weighted flat mean (sumA·F+(P−sumA)·B)/P
  // per channel (the exact flat fill matching the chosen prediction's DC). It was proposed to
  // REPLACE M3's soft MDL washout defense (λ·ink·E_AC), which was falsified — that penalty
  // scales WITH E_AC and vanishes exactly in the low-energy washout regime, so on washout-stress
  // 99.35% of near-flat cells still emitted faint invisible-ink glyphs; this exact rule instead
  // has full leverage at low energy and zeroes the proxy deterministically (0.00% on all bench
  // images at threshold 24). BUT the "SSIM-neutral by construction" premise was itself FALSIFIED
  // by measurement: on real gradient interiors the faint glyphs carry sub-cell structure SSIM
  // rewards, so collapsing them costs overall+object SSIM > 0.0005 at every tested threshold on
  // every image (and flips the chafa gate PASS→FAIL). Hence the default is OFF (options.ts,
  // collapseThreshold=0 → byte-identical output); it is an opt-in for washout-dominated inputs.
  // Q1 (mono, fixed colors) is exempt. Emits mirror the gated-cell convention (Q2: mean in fg,
  // bg fixed; Q3/Q4: mean in bg, fg null); B is fbg in Q2 (fixed bg), the fitted bg in Q3/Q4.
  const collapseThreshold = opts.collapseThreshold ?? 0;
  // Perceptual contrast floor (Round A ASCII-identity, feat/contrast-floor-fill). DISPLAY-space
  // (sRGB) luma units — space-invariant: contrastFloorFit rescales it into the working space per
  // cell (gamma → identity, bit-identical). 0 = off = byte-identical. Applied to the fitted TEXT
  // winner only (below), NOT to
  // gated/family winners; Q1 exempt. See fit.ts contrastFloorFit for the constrained-LS + demote
  // decision. Opposite remedy to collapseThreshold: it lifts faint dark-region glyphs to legible
  // contrast (or flat-fills them) instead of removing them.
  const contrastFloor = opts.contrastFloor ?? 0;
  // Set by emitWinner on each call: true iff the invisibility collapse fired (winner
  // replaced by space + flat mean). Read right after the call to decide whether a topK
  // text candidate list must be overwritten with the collapsed single candidate (§3.4
  // cands fix) — the greedy emit and cand[0] must stay in lockstep for the contour pass.
  let lastCollapsed = false;
  const emitWinner = (
    ch: string, F: [number, number, number], B: [number, number, number], sumA: number,
  ): GridCell => {
    lastCollapsed = false;
    if (quality === 1) return { ch, fg: encode(ffg), bg: encode(fbg) };
    const fgEnc = encode(F);
    const bgEnc = quality === 2 ? encode(fbg) : encode(B);
    if (collapseThreshold > 0 &&
        Math.max(Math.abs(fgEnc[0] - bgEnc[0]), Math.abs(fgEnc[1] - bgEnc[1]), Math.abs(fgEnc[2] - bgEnc[2])) < collapseThreshold) {
      lastCollapsed = true;
      const Bc = quality === 2 ? fbg : B;
      const mean: [number, number, number] = [
        (sumA * F[0] + (P - sumA) * Bc[0]) / P,
        (sumA * F[1] + (P - sumA) * Bc[1]) / P,
        (sumA * F[2] + (P - sumA) * Bc[2]) / P,
      ];
      return quality === 2 ? { ch: ' ', fg: encode(mean), bg: bgEnc } : { ch: ' ', fg: null, bg: encode(mean) };
    }
    return { ch, fg: fgEnc, bg: bgEnc };
  };
  // A single-entry candidate list that reproduces `cell` exactly under contourPostPass —
  // used for every winner whose cands entry must be the forced emit (family, collapse,
  // gated flat). fgNull carries the space/gated null-fg semantics; ch names non-atlas
  // (family) glyphs directly. B is never null on any emit path here.
  const singleCand = (cell: GridCell, glyphIdx: number, score: number): Candidate[] => [{
    glyphIdx, score, ch: cell.ch,
    F: cell.fg ?? [0, 0, 0], B: cell.bg ?? [0, 0, 0], fgNull: cell.fg === null,
  }];

  const cells: GridCell[] = new Array(cols * rows);
  // smooth coherence: per-cell chosen glyph coverage ρ, filled in raster order so each cell's
  // scan can read its already-decided left/top neighbors' coverage for the consistency penalty.
  const chosenRho = cohSmooth ? new Float64Array(cols * rows) : null;

  // M1 score-prior extensions (M1-SPEC §3). All default off → the loop below runs
  // the exact M0 statements (bit-identical output). Every addition is guarded so no
  // extra arithmetic touches the score when its feature is off.
  const eta = opts.splitSelection ?? 0;
  const kappa = opts.antibleedKappa ?? 0;
  const shadingLuma = eta > 0 ? opts.aov?.shadingLuma : undefined;
  const objectId = kappa > 0 ? opts.aov?.objectId : undefined;
  const styleAlbedo = (opts.styleAlbedoColors ?? false) && opts.aov?.albedo != null;
  if (shadingLuma && shadingLuma.length !== img.w * img.h) throw new Error('aov.shadingLuma must be gridW*gridH');
  if (objectId && objectId.length !== img.w * img.h) throw new Error('aov.objectId must be gridW*gridH');
  // albedo → working space once (stylization recolor only).
  let albData: Float32Array | undefined;
  if (styleAlbedo) {
    const alb = opts.aov!.albedo!;
    if (alb.w !== img.w || alb.h !== img.h) throw new Error('aov.albedo must match image dimensions');
    if (space === 'gamma') {
      albData = new Float32Array(alb.data.length);
      for (let i = 0; i < albData.length; i++) albData[i] = linearToSrgb(alb.data[i]!) / 255;
    } else albData = alb.data;
  }
  const Lpatch = shadingLuma ? new Float32Array(P) : undefined; // per-cell shading-luma patch
  const idm = objectId ? new Float32Array(P) : undefined;       // per-cell object-id indicator (id==A)
  const lStats: FitStatsG = { Saa: 0, Sa1: 0, S11: P };         // plain glyph stats for the shading channel

  // reused glyph-side Gram stats (mutated per glyph, never per channel)
  const gStats: FitStatsG = { Saa: 0, Sa1: 0, S11: P };

  // M3 synthesized families (M3-SPEC §2). Built once; each competes its exact region
  // solve with the text scan per cell in the same score space. Empty → the family block
  // below is skipped entirely so default output stays byte-identical to M0/M1.
  const families = buildFamilies(opts.families ?? [], cellW, cellH, atlas.inkMin, atlas.inkMax);
  // per-cell fit context reused across the family solves (mutable fields set per cell).
  const famCtx: CellFitCtx | null = families.length
    ? { P, T: new Float32Array(0), ST: new Float32Array(0), STT: new Float32Array(0),
        minT: new Float32Array(0), maxT: new Float32Array(0), dxT: new Float32Array(0),
        dyT: new Float32Array(0), gradTT: new Float32Array(0),
        quality, isQ4, lam2, ffg, fbg, mdlLambda: opts.mdlLambda, eacScale: 0 }
    : null;

  // M3 §3.3 orientation prior (in-scan, boundary cells only) + §3.4 topK emission.
  // Both default off → the guarded blocks below never run and output stays byte-identical.
  const orientKappa = opts.orientKappa ?? 0;
  const K = opts.topK ?? 0;
  const glyphOri: Orientation[] | undefined = orientKappa > 0 ? glyphOrientations(atlas) : undefined;
  // §3.2 edge-field source: silhouette COVERAGE when present (the true 3D edge signal),
  // else object-id boundaries, else the 2D fallback = Sobel-ish luma gradients. Built once
  // over the full working image; per-cell structure tensor + boundary test happen in-loop.
  const covPix = orientKappa > 0 ? opts.aov?.coverage : undefined;
  const objIdOri = orientKappa > 0 ? opts.aov?.objectId : undefined;
  if (covPix && covPix.length !== img.w * img.h) throw new Error('aov.coverage must be gridW*gridH');
  let oriField: Float32Array | undefined;   // per-pixel scalar the edge tensor is taken over
  let oriDx: Float32Array | undefined, oriDy: Float32Array | undefined;
  if (orientKappa > 0) {
    oriField = new Float32Array(img.w * img.h);
    if (covPix) { for (let i = 0; i < oriField.length; i++) oriField[i] = covPix[i]!; }
    else { for (let i = 0; i < oriField.length; i++) oriField[i] = luma(work.data[i * 3]!, work.data[i * 3 + 1]!, work.data[i * 3 + 2]!); }
    oriDx = new Float32Array(img.w * img.h);
    oriDy = new Float32Array(img.w * img.h);
    for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
      const i = y * img.w + x;
      if (x > 0 && x < img.w - 1) oriDx[i] = (oriField[i + 1]! - oriField[i - 1]!) / 2;
      if (y > 0 && y < img.h - 1) oriDy[i] = (oriField[i + img.w]! - oriField[i - img.w]!) / 2;
    }
  }
  const cellGx = orientKappa > 0 ? new Float32Array(P) : undefined; // per-cell edge gradient scratch
  const cellGy = orientKappa > 0 ? new Float32Array(P) : undefined;

  // §3.4 top-K max-heap over the text scan (K smallest scores kept). Preallocated so the
  // scan does ZERO per-glyph allocation: only score/index are pushed; F,B for the ≤K
  // winners are recomputed once per cell after the scan. cands is emitted densely (every
  // cell, incl. gated/family cells) so the contour Viterbi always has a candidate list.
  const cands: Candidate[][] | undefined = K > 0 ? new Array(cols * rows) : undefined;
  const heapScore = K > 0 ? new Float64Array(K) : undefined;
  const heapIdx = K > 0 ? new Int32Array(K) : undefined;
  let heapN = 0;
  const heapPush = (sc: number, gi: number): void => {
    const hs = heapScore!, hi = heapIdx!;
    if (heapN < K) {
      let c = heapN++;
      hs[c] = sc; hi[c] = gi;
      while (c > 0) { const p = (c - 1) >> 1; if (hs[p]! >= hs[c]!) break; const ts = hs[p]!; hs[p] = hs[c]!; hs[c] = ts; const ti = hi[p]!; hi[p] = hi[c]!; hi[c] = ti; c = p; }
    } else if (sc < hs[0]!) {
      hs[0] = sc; hi[0] = gi;
      let c = 0;
      for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; if (l < K && hs[l]! > hs[m]!) m = l; if (r < K && hs[r]! > hs[m]!) m = r; if (m === c) break; const ts = hs[m]!; hs[m] = hs[c]!; hs[c] = ts; const ti = hi[m]!; hi[m] = hi[c]!; hi[c] = ti; c = m; }
    }
  };

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cs = cellStats(work, dx, dy, cellW, cellH, col, row);
      const T = cs.T, dxT = cs.dxT, dyT = cs.dyT;
      const ST = cs.ST, STT = cs.STT, minT = cs.minT, maxT = cs.maxT, gradTT = cs.gradTT;
      const cellIdx = row * cols + col;
      const x0 = col * cellW;
      const y0 = row * cellH;

      // Patch AC energy E_AC = Σ_c (STT_c − ST_c²/P) — the full per-channel AC energy
      // (DESIGN §3.4). Used BOTH for the contrast gate and the MDL penalty scale.
      const eacScale =
        (STT[0]! - (ST[0]! * ST[0]!) / P) +
        (STT[1]! - (ST[1]! * ST[1]!) / P) +
        (STT[2]! - (ST[2]! * ST[2]!) / P);

      // 1. contrast gate BEFORE the scan. Gate on full per-channel E_AC (working space),
      // not luma-only: luma-only flattens isoluminant chroma structure to a muddy mean.
      // M3-SPEC §1: τ is a COMPUTE-SAVER only — the flat candidate (space) is always in the
      // scan, so gating cannot improve quality, only skip work. Default lowered to 2e-5
      // (options.ts) to unflatten smooth interiors; MDL (λ·ink·E_AC), not τ, is the washout
      // defense. Caveat (bench/out/gate-sweep.md): MDL's penalty scales WITH E_AC, so it has
      // little leverage in exactly the washout regime — the invisible-ink proxy is not held.
      if (eacScale / (3 * P) < opts.gateTau) {
        let mr = ST[0]! / P, mg = ST[1]! / P, mb = ST[2]! / P; // shaded working-space mean
        // Stylization (§4.1): a gated cell is a flat surface or background — recolor it
        // from the ALBEDO patch mean (working space) so it too carries the material color,
        // not the shaded mean. Colors only; the cell stays gated (ch=' '). Visual-only.
        if (styleAlbedo) {
          let ar = 0, ag = 0, ab = 0;
          for (let ly = 0; ly < cellH; ly++) {
            const gy = y0 + ly;
            for (let lx = 0; lx < cellW; lx++) {
              const p = (gy * img.w + (x0 + lx)) * 3;
              ar += albData![p]!; ag += albData![p + 1]!; ab += albData![p + 2]!;
            }
          }
          mr = ar / P; mg = ag / P; mb = ab / P;
        }
        const mean: [number, number, number] = [mr, mg, mb];
        // P0 (Round P) gate-contract fix: emit the best FLAT glyph representation under the
        // quality's colour constraints, chosen by the SAME per-channel scorer the full scan
        // uses (channelSse) — so on a flat cell the gated emit IS the full exhaustive scan's
        // argmin, INCLUDING the Q2 per-channel fg clamp and a nonzero fixedBg (both of which a
        // constant argmax-sumA²/sumAA glyph would get wrong for bright/saturated or fbg≠0 cells).
        // A flat cell has T_c ≡ m_c, so its per-glyph stats are pure scalars — saT=m_c·sumA,
        // S1T=P·m_c, STT=P·m_c² — and the scorer runs with NO pixel loops: O(G) per gated cell,
        // still ≪ the full scan. Q3+ (bg free) is unchanged: its flat fill IS the cell mean.
        let gatedGi = 0;
        if (quality === 1 || quality === 2) {
          // Identity prior on the gated flat scan (spec §3.3): the gate's argmin-flat glyph for a
          // bright uniform cell is U+2588 full block — the pixel-fill anti-pattern. Adding the SAME
          // λ·u·D·P·(ρ_g−ρ*)² penalty (u≈1 here, D from the flat mean) makes the primary target —
          // uniform bright regions — pick ramp glyphs instead. identityLambda>0 ⇒ quality===2 (guard).
          let gW = 0, gRs = 0;
          if (identityLambda > 0) {
            const YbarG = luma(mean[0], mean[1], mean[2]);
            const sG = eacScale / (3 * P);
            const DG = (mean[0] - fbg[0]) * (mean[0] - fbg[0]) + (mean[1] - fbg[1]) * (mean[1] - fbg[1]) + (mean[2] - fbg[2]) * (mean[2] - fbg[2]);
            gRs = rhoStar(YbarG, LB, LF);
            gW = identityLambda * uWeight(sG, identityTau) * DG * P;
          }
          let bestScore = Infinity;
          for (let gi = 0; gi < G; gi++) {
            const g = glyphs[gi]!;
            gStats.Saa = g.sumAA; gStats.Sa1 = g.sumA; gStats.S11 = P;
            let sc = 0;
            for (let c = 0; c < 3; c++) {
              const m = mean[c]!;
              sc += channelSse(gStats, m * g.sumA, P * m, P * m * m, quality, m, m, ffg[c]!, fbg[c]!);
            }
            if (gW !== 0) { const d = idRho![gi]! - gRs; sc += gW * d * d; }
            if (sc < bestScore) { bestScore = sc; gatedGi = gi; }
          }
          const g = glyphs[gatedGi]!;
          if (quality === 1) {
            cells[cellIdx] = { ch: g.ch, fg: encode(ffg), bg: encode(fbg) };
          } else {
            // fg fitted (fg_c = clamp(fbg_c + sumA·(m_c−fbg_c)/sumAA)), bg fixed — via channelFB
            // so the emitted colour is byte-identical to the winner's full-scan refit.
            gStats.Saa = g.sumAA; gStats.Sa1 = g.sumA; gStats.S11 = P;
            const fg: [number, number, number] = [0, 0, 0];
            for (let c = 0; c < 3; c++) {
              const m = mean[c]!;
              fg[c] = channelFB(gStats, m * g.sumA, P * m, P * m * m, quality, m, m, ffg[c]!, fbg[c]!)[0];
            }
            // Shape-color coupling on the gated Q2 emit (spec §4.3: gated Q2 emits are IN scope —
            // uniform bright regions are the primary target). The gated glyph's own ρ̄ drives k.
            if (couplingParams) {
              const YbarC = luma(mean[0], mean[1], mean[2]);
              const cf = coupleFg([fg[0], fg[1], fg[2]], g.sumA / P, YbarC, LB, cellIllum(x0, y0, YbarC), couplingParams);
              fg[0] = cf[0]; fg[1] = cf[1]; fg[2] = cf[2];
            }
            cells[cellIdx] = { ch: g.ch, fg: encode(fg), bg: encode(fbg) };
          }
        } else if (pal) {
          // Palette Q3+ gated cell (P0 gate contract): a flat cell has T_c ≡ m_c, so the full
          // scan's per-glyph stats are pure scalars — saT_c=m_c·sumA, S1T_c=P·m_c, STT_c=P·m_c²,
          // and the Q4 edge augmentation (saT dot / gradTT) both vanish on a constant patch. Unlike
          // truecolor — where any glyph reaches SSE 0 (F=B=mean) and mdl breaks the tie toward space —
          // a palette pair CANNOT reach the mean exactly, and a partial-coverage glyph mixing two
          // palette colors can beat snapping to the single nearest entry (e.g. flat orange → '@' with
          // fg=red bg=yellow < space+olive). So run the SAME palette pair scorer per glyph over the
          // scalar stats (no pixel loops: O(G·pairs)) and emit its global (glyph×pair) argmin — the
          // gated emit IS the full exhaustive scan's argmin, matching the Q1/Q2 branch above.
          const flatST: [number, number, number] = [P * mean[0]!, P * mean[1]!, P * mean[2]!];
          let bestScore = Infinity, bestPFg = 0, bestPBg = 0;
          for (let gi = 0; gi < G; gi++) {
            const g = glyphs[gi]!;
            gStats.Sa1 = g.sumA; gStats.S11 = P;
            gStats.Saa = isQ4 ? g.sumAA + lam2 * g.gradAA : g.sumAA;
            for (let c = 0; c < 3; c++) { paSaT![c] = mean[c]! * g.sumA; paSTT![c] = P * mean[c]! * mean[c]!; }
            const pr = bestPair(gStats, paSaT!, flatST, paSTT!, pal, refineK);
            const sc = pr.score + opts.mdlLambda * g.ink * eacScale;
            if (sc < bestScore) { bestScore = sc; gatedGi = gi; bestPFg = pr.fg; bestPBg = pr.bg; }
          }
          const g = glyphs[gatedGi]!;
          cells[cellIdx] = { ch: g.ch, fg: paletteSrgb(pal, bestPFg), bg: paletteSrgb(pal, bestPBg) };
        } else {
          cells[cellIdx] = { ch: ' ', fg: null, bg: encode(mean) };
        }
        // gated cell → single forced candidate = the emitted glyph (Q1/Q2 now a real atlas
        // glyph, Q3+ still space), so the contour Viterbi keeps the exact gated emit.
        if (cands) {
          const c = cells[cellIdx]!;
          cands[cellIdx] = [{ glyphIdx: gatedGi, score: eacScale, F: c.fg ?? encode(mean), B: c.bg ?? encode(mean), fgNull: c.fg === null }];
        }
        // smooth: a gated cell keeps the gate contract, but its glyph's coverage still seeds the
        // neighbor-consistency penalty for the object cells to its right/below.
        if (chosenRho) chosenRho[cellIdx] = idRho![gatedGi]!;
        continue;
      }

      // M1 per-cell AOV patch stats (same grid geometry as cellStats). Only run
      // when the corresponding feature is on, so the M0 path is untouched.
      let SL = 0, SLL = 0; // shading-luma patch DC/AC accumulators (§4.1)
      if (Lpatch) {
        for (let ly = 0; ly < cellH; ly++) {
          const gy = y0 + ly;
          for (let lx = 0; lx < cellW; lx++) {
            const v = shadingLuma![gy * img.w + (x0 + lx)]!;
            Lpatch[ly * cellW + lx] = v;
            SL += v; SLL += v * v;
          }
        }
      }
      // §4.2 boundary-cell detection over covered pixels (objectId != 0 == coverage).
      let boundary = false, SI = 0;
      if (idm) {
        const counts = new Map<number, number>();
        let covered = 0;
        for (let ly = 0; ly < cellH; ly++) {
          const gy = y0 + ly;
          for (let lx = 0; lx < cellW; lx++) {
            const id = objectId![gy * img.w + (x0 + lx)]!;
            if (id === 0) continue;
            covered++;
            counts.set(id, (counts.get(id) ?? 0) + 1);
          }
        }
        let bestId = 0, bestCount = 0, secondCount = 0;
        for (const [id, c] of counts) {
          if (c > bestCount) { secondCount = bestCount; bestId = id; bestCount = c; }
          else if (c > secondCount) { secondCount = c; }
        }
        if (covered > 0 && secondCount / covered >= 0.15) {
          boundary = true;
          SI = bestCount;
          for (let ly = 0; ly < cellH; ly++) {
            const gy = y0 + ly;
            for (let lx = 0; lx < cellW; lx++) {
              idm[ly * cellW + lx] = objectId![gy * img.w + (x0 + lx)] === bestId ? 1 : 0;
            }
          }
        }
      }

      // §3.2/§3.3 per-cell edge field for the orientation prior. A cell is a boundary
      // cell when the silhouette coverage crosses 0.5 inside it (AOV path), or ≥2 object
      // ids meet (id path), or — with no AOV — its luma edge is strongly oriented (2D
      // fallback, anisotropy ≥ 0.5). θ_e/w_e come from the per-cell structure tensor of
      // the edge-field gradients. Only boundary cells receive the in-scan bonus.
      let oriBoundary = false, oriTheta = 0, oriWe = 0;
      if (orientKappa > 0) {
        let covMin = Infinity, covMax = -Infinity;
        const idCounts = objIdOri && !covPix ? new Map<number, number>() : null;
        let covered = 0;
        for (let ly = 0; ly < cellH; ly++) {
          const gy = y0 + ly;
          for (let lx = 0; lx < cellW; lx++) {
            const gp = gy * img.w + (x0 + lx), li = ly * cellW + lx;
            cellGx![li] = oriDx![gp]!;
            cellGy![li] = oriDy![gp]!;
            if (covPix) { const v = oriField![gp]!; if (v < covMin) covMin = v; if (v > covMax) covMax = v; }
            else if (idCounts) { const id = objIdOri![gp]!; if (id !== 0) { covered++; idCounts.set(id, (idCounts.get(id) ?? 0) + 1); } }
          }
        }
        const ef = structureTensor(cellGx!, cellGy!, P);
        oriTheta = ef.theta; oriWe = ef.energy;
        if (covPix) oriBoundary = covMin < 0.5 && covMax >= 0.5;
        else if (idCounts) {
          let best = 0, second = 0;
          for (const c of idCounts.values()) { if (c > best) { second = best; best = c; } else if (c > second) second = c; }
          oriBoundary = covered > 0 && second / covered >= 0.15;
        } else oriBoundary = ef.anisotropy >= 0.5;
      }

      // Identity selection prior per-cell prefactor (spec §3.1): W = λ·u·D·P and the ramp target
      // ρ*, both O(1) from the per-cell stats (m_c=ST_c/P, s=eacScale/3P, D=Σ(m_c−fbg_c)²). Added
      // to every glyph's score in the scan below and folded into the topK heap so cand[0]==winner.
      // identityLambda=0 → idOn false → the scan is byte-identical (V1).
      let idW = 0, idRs = 0, idWbias = 0, smoothW = 0;
      const idOn = identityLambda > 0;
      if (idOn) {
        const mr = ST[0]! / P, mg = ST[1]! / P, mb = ST[2]! / P;
        const s = eacScale / (3 * P);
        const D = (mr - fbg[0]) * (mr - fbg[0]) + (mg - fbg[1]) * (mg - fbg[1]) + (mb - fbg[2]) * (mb - fbg[2]);
        idRs = rhoStar(luma(mr, mg, mb), LB, LF);
        const uCell = uWeight(s, identityTau);
        idW = identityLambda * uCell * D * P;
        // ramp-bias: widen the ramp pull by flooring the uniformity weight (u' = max(u, u_min)).
        if (cohRampBias) idWbias = identityLambda * Math.max(uCell, U_MIN) * D * P;
        // smooth: neighbor-consistency weight μ = λ·D·P — the ramp weight WITHOUT the uniformity
        // factor u, so the neighbor pull does not vanish on structured object cells (where u→0);
        // it stays commensurate with the cell-contrast SSE scale D·P it competes with. No new knob.
        if (cohSmooth) smoothW = identityLambda * D * P;
      }
      const nRhoLeft = cohSmooth && col > 0 ? chosenRho![cellIdx - 1]! : 0;
      const nRhoTop = cohSmooth && row > 0 ? chosenRho![cellIdx - cols]! : 0;

      // 2. scan all glyphs
      if (cands) heapN = 0;
      let bestScore = Infinity;
      let bestGi = 0;
      let bestPFg = 0, bestPBg = 0; // palette winner's (fg,bg) palette indices
      for (let gi = 0; gi < G; gi++) {
        const g = glyphs[gi]!;
        // ramp-bias / pure-ramp: restrict the object-cell candidate set to R (spec).
        if (cohRestrict && ramp!.member[gi] === 0) continue;
        gStats.Sa1 = g.sumA;
        gStats.S11 = P;
        gStats.Saa = isQ4 ? g.sumAA + lam2 * g.gradAA : g.sumAA;
        const alpha = g.alpha, dxA = g.dxA, dyA = g.dyA;
        let score = 0;
        // pure-ramp: pure brightness→glyph, argmin_{g∈R}(ρ_g−ρ*)². NO LS shape term (spec).
        if (cohPureRamp) {
          const d = idRho![gi]! - idRs;
          score = d * d;
          if (cands) heapPush(score, gi);
          if (score < bestScore) { bestScore = score; bestGi = gi; }
          continue;
        }
        if (pal) {
          // Palette pair search: same per-channel saT/STT (Q4 edge augmentation folded in), but
          // the fit argmins over discrete palette (fg,bg) pairs via sseAt (§3.2 (2)) instead of
          // solving a continuous optimum. ST stays the plain per-channel sum (the S1T basis). The
          // mdl ink penalty is applied identically to the truecolor path. All M1/M3 priors are
          // guaranteed off here (rejected above), so no prior/heap bookkeeping runs.
          for (let c = 0; c < 3; c++) {
            const base = c * P;
            let saT = 0;
            for (let i = 0; i < P; i++) saT += alpha[i]! * T[base + i]!;
            let stt = STT[c]!;
            if (isQ4) {
              let dot = 0;
              for (let i = 0; i < P; i++) dot += dxA[i]! * dxT[base + i]! + dyA[i]! * dyT[base + i]!;
              saT += lam2 * dot;
              stt += lam2 * gradTT[c]!;
            }
            paSaT![c] = saT;
            paSTT![c] = stt;
          }
          const pr = bestPair(gStats, paSaT!, ST, paSTT!, pal, refineK);
          score = pr.score + opts.mdlLambda * g.ink * eacScale;
          if (score < bestScore) { bestScore = score; bestGi = gi; bestPFg = pr.fg; bestPBg = pr.bg; }
          continue;
        }
        for (let c = 0; c < 3; c++) {
          const base = c * P;
          let saT = 0;
          for (let i = 0; i < P; i++) saT += alpha[i]! * T[base + i]!;
          let stt = STT[c]!;
          if (isQ4) {
            let dot = 0;
            for (let i = 0; i < P; i++) dot += dxA[i]! * dxT[base + i]! + dyA[i]! * dyT[base + i]!;
            saT += lam2 * dot;
            stt += lam2 * gradTT[c]!;
          }
          score += channelSse(gStats, saT, ST[c]!, stt, quality, minT[c]!, maxT[c]!, ffg[c]!, fbg[c]!);
        }
        score += opts.mdlLambda * g.ink * eacScale;
        // Identity selection prior (spec §3.1): pull ρ_g toward the ramp ρ*, weighted by u·D·P.
        // ramp-bias uses the floored-uniformity weight idWbias (wider pull); else the plain idW.
        if (idOn) { const d = idRho![gi]! - idRs; score += (cohRampBias ? idWbias : idW) * d * d; }
        // §4.1: extra shading-luma channel, own closed-form (a,b), SSE weighted by η.
        // Fitted colors are discarded — only its SSE enters the selection score.
        if (Lpatch) {
          lStats.Saa = g.sumAA; lStats.Sa1 = g.sumA; lStats.S11 = P;
          let saL = 0;
          for (let i = 0; i < P; i++) saL += alpha[i]! * Lpatch[i]!;
          score += eta * fitFree(lStats, saL, SL, SLL).sse;
        }
        // §4.2: boundary cells get a bonus for glyph masks whose ink partition
        // matches the object partition (centered correlation ρ_id of α and idm).
        if (boundary) {
          let sai = 0;
          for (let i = 0; i < P; i++) sai += alpha[i]! * idm![i]!;
          const num = sai - (g.sumA * SI) / P;
          const varA = g.sumAA - (g.sumA * g.sumA) / P;
          const varI = SI - (SI * SI) / P;
          const denom = varA * varI;
          const rho = denom > 1e-12 ? num / Math.sqrt(denom) : 0;
          score -= kappa * Math.abs(rho) * eacScale;
        }
        // §3.3 orientation prior: boundary cells only, bonus for glyphs whose dominant
        // stroke angle aligns with the cell edge (π-periodic via cos 2Δ), weighted by the
        // edge strength w_e, the glyph anisotropy a_g and the cell AC energy.
        if (oriBoundary) score -= orientationBonus(glyphOri![gi]!, oriTheta, oriWe, eacScale, orientKappa);
        // smooth: neighbor-consistency penalty over the already-decided left/top neighbors, so a
        // region converges onto one glyph family (spec). μ = smoothW (the cell's own ramp weight).
        if (cohSmooth) {
          const rg = idRho![gi]!;
          let np = 0;
          if (col > 0) { const dl = rg - nRhoLeft; np += dl * dl; }
          if (row > 0) { const dt = rg - nRhoTop; np += dt * dt; }
          score += smoothW * np;
        }
        if (cands) heapPush(score, gi);
        if (score < bestScore) { bestScore = score; bestGi = gi; }
      }

      // 2p. Palette winner emit — the winning glyph's best palette (fg,bg) pair, emitted as the
      // exact sRGB u8 palette entries (no encode round-trip). Palette mode has no families/topK,
      // so it never reaches the blocks below.
      if (pal) {
        const g = glyphs[bestGi]!;
        cells[cellIdx] = { ch: g.ch, fg: paletteSrgb(pal, bestPFg), bg: paletteSrgb(pal, bestPBg) };
        continue;
      }

      // 2a. §3.4 topK: materialize the ≤K best text candidates for this cell (sorted best
      // first). Colors are recomputed here (once per kept glyph) and encoded exactly as the
      // cell would emit them, so cand[0] == the emitted winner and the contour post-pass can
      // write a GridCell straight from any candidate. Skipped when topK is off.
      if (cands) {
        const order = Array.from({ length: heapN }, (_, i) => i).sort((a, b) => heapScore![a]! - heapScore![b]!);
        const list: Candidate[] = new Array(heapN);
        // Coupling cell constants (spec §4.3): the SAME Ȳ/ℓ for every candidate; ρ̄ differs per glyph.
        const YbarC = couplingParams ? luma(ST[0]! / P, ST[1]! / P, ST[2]! / P) : 0;
        const ellC = couplingParams ? cellIllum(x0, y0, YbarC) : 0;
        for (let r = 0; r < heapN; r++) {
          const gi = heapIdx![order[r]!]!;
          const gg = glyphs[gi]!;
          gStats.Sa1 = gg.sumA; gStats.S11 = P;
          gStats.Saa = isQ4 ? gg.sumAA + lam2 * gg.gradAA : gg.sumAA;
          const cF: [number, number, number] = [0, 0, 0], cB: [number, number, number] = [0, 0, 0];
          for (let c = 0; c < 3; c++) {
            const base = c * P;
            let saT = 0;
            for (let i = 0; i < P; i++) saT += gg.alpha[i]! * T[base + i]!;
            let stt = STT[c]!;
            if (isQ4) {
              let dot = 0;
              for (let i = 0; i < P; i++) dot += gg.dxA[i]! * dxT[base + i]! + gg.dyA[i]! * dyT[base + i]!;
              saT += lam2 * dot; stt += lam2 * gradTT[c]!;
            }
            const fb = channelFB(gStats, saT, ST[c]!, stt, quality, minT[c]!, maxT[c]!, ffg[c]!, fbg[c]!);
            cF[c] = fb[0]; cB[c] = fb[1];
          }
          // §4.3 cand[0]==emit invariant: apply the SAME coupling per candidate (each with its own
          // glyph's ρ̄) BEFORE encoding — else contourPostPass would resurrect uncoupled colors. Q2.
          if (couplingParams) {
            const cf = coupleFg([cF[0], cF[1], cF[2]], gg.sumA / P, YbarC, LB, ellC, couplingParams);
            cF[0] = cf[0]; cF[1] = cf[1]; cF[2] = cf[2];
          }
          const fgEnc = quality === 1 ? encode(ffg) : encode(cF);
          const bgEnc = quality >= 3 ? encode(cB) : encode(fbg);
          list[r] = { glyphIdx: gi, score: heapScore![order[r]!]!, F: fgEnc, B: bgEnc };
        }
        cands[cellIdx] = list;
      }

      // 2b. M3 families meta-selection (M3-SPEC §2.3). Each requested family's exact
      // region solve competes with the text-scan winner in the SAME (SSE + λ_mdl·ink·
      // scale) score space. A family wins only if it strictly beats the text score. The
      // gate above already excluded flat cells, so families only run on structured cells.
      let famWin: FamilySolve | null = null;
      if (famCtx) {
        famCtx.T = T; famCtx.ST = ST; famCtx.STT = STT;
        famCtx.minT = minT; famCtx.maxT = maxT;
        famCtx.dxT = dxT; famCtx.dyT = dyT; famCtx.gradTT = gradTT;
        famCtx.eacScale = eacScale;
        // Forward the SAME per-cell selection priors the text scan applied (M3-fix §3): a
        // family pattern must earn/lose the identical split/antibleed/orientation bonus a
        // text glyph of the same mask would, or the meta-selection is rigged toward text.
        famCtx.eta = eta; famCtx.Lpatch = Lpatch ?? null; famCtx.SL = SL; famCtx.SLL = SLL;
        famCtx.boundary = boundary; famCtx.idm = idm ?? null; famCtx.SI = SI; famCtx.antibleedKappa = kappa;
        famCtx.oriBoundary = oriBoundary; famCtx.oriTheta = oriTheta; famCtx.oriWe = oriWe; famCtx.orientKappa = orientKappa;
        for (const f of families) {
          const sol = solveFamily(f, famCtx);
          if (famWin === null || sol.score < famWin.score) famWin = sol;
        }
        if (famWin && famWin.score >= bestScore) famWin = null; // text scan kept the win
      }

      // 3a. family winner → emit its solved ch + colors (colors already fit), via the
      // invisibility collapse (emitWinner). famWin.B is fbg in Q2, the fitted bg in Q3/Q4.
      if (famWin) {
        const cell = emitWinner(famWin.ch, famWin.F, famWin.B, famWin.sumA);
        cells[cellIdx] = cell;
        // §3.4 cands fix: the family win (or its collapse to space) IS the emit, so the
        // cell's sole candidate must be that emit — else the text topK list set above
        // leaks through and contourPostPass reverts the family win back to a text glyph.
        if (cands) cands[cellIdx] = singleCand(cell, 0, famWin.score);
        continue;
      }

      // 3. winner → colors (recompute F,B for the argmin glyph only)
      const g = glyphs[bestGi]!;
      gStats.Sa1 = g.sumA;
      gStats.S11 = P;
      gStats.Saa = isQ4 ? g.sumAA + lam2 * g.gradAA : g.sumAA;
      const F: [number, number, number] = [0, 0, 0];
      const B: [number, number, number] = [0, 0, 0];
      const saTc: [number, number, number] = [0, 0, 0]; // plain Σα·T per channel (pre-Q4 aug), for the contrast floor
      for (let c = 0; c < 3; c++) {
        const base = c * P;
        let saT = 0;
        for (let i = 0; i < P; i++) saT += g.alpha[i]! * T[base + i]!;
        saTc[c] = saT;
        let stt = STT[c]!;
        if (isQ4) {
          let dot = 0;
          for (let i = 0; i < P; i++) dot += g.dxA[i]! * dxT[base + i]! + g.dyA[i]! * dyT[base + i]!;
          saT += lam2 * dot;
          stt += lam2 * gradTT[c]!;
        }
        const fb = channelFB(gStats, saT, ST[c]!, stt, quality, minT[c]!, maxT[c]!, ffg[c]!, fbg[c]!);
        F[c] = fb[0];
        B[c] = fb[1];
      }

      // Stylization variant (§4.1): discard the shaded-fit colors and refit the
      // SELECTED glyph against the ALBEDO patch (box-constrained). Colors only —
      // glyph choice is unchanged. Output no longer approximates the shaded ref.
      if (styleAlbedo) {
        gStats.Saa = g.sumAA; gStats.Sa1 = g.sumA; gStats.S11 = P;
        for (let c = 0; c < 3; c++) {
          let saT = 0, s1t = 0, stt = 0, mn = Infinity, mx = -Infinity;
          for (let ly = 0; ly < cellH; ly++) {
            const gy = y0 + ly;
            for (let lx = 0; lx < cellW; lx++) {
              const v = albData![(gy * img.w + (x0 + lx)) * 3 + c]!;
              const a = g.alpha[ly * cellW + lx]!;
              saT += a * v; s1t += v; stt += v * v;
              if (v < mn) mn = v;
              if (v > mx) mx = v;
            }
          }
          const fb = channelFB(gStats, saT, s1t, stt, quality, mn, mx, ffg[c]!, fbg[c]!);
          F[c] = fb[0];
          B[c] = fb[1];
        }
      }

      // Shape-color coupling (spec §4.3): applied to the fitted fg AFTER the fg fit and BEFORE the
      // contrast floor — the floor is the family's legibility guarantor and must see the colors that
      // will actually be emitted. Q2 only (guard); coupling∧styleAlbedo is thrown, so styleAlbedo is
      // off here. Mutates F in place so the floor, emitWinner and singleCand all see the coupled fg.
      if (couplingParams) {
        const YbarC = luma(ST[0]! / P, ST[1]! / P, ST[2]! / P);
        const cf = coupleFg([F[0], F[1], F[2]], g.sumA / P, YbarC, LB, cellIllum(x0, y0, YbarC), couplingParams);
        F[0] = cf[0]; F[1] = cf[1]; F[2] = cf[2];
      }

      // Contrast floor (Round A, feat/contrast-floor-fill): before the normal emit, if the fitted
      // fg/bg luma separation is below the floor, either lift it to the floor along the fit's own
      // chromatic axis or demote to a solid flat cell (fit.ts contrastFloorFit derives the rule).
      // Scored on the PLAIN L2 Gram/stats (g.sumAA/saTc) — a perceptual contrast decision, not the
      // Q4 edge objective (which only picked the glyph). Q1 exempt; families/stylization skip this
      // (handled above / colors already committed). contrastFloor=0 → this whole block is dead.
      let floored = false;
      if (contrastFloor > 0 && quality !== 1 && !styleAlbedo) {
        const gPlain: FitStatsG = { Saa: g.sumAA, Sa1: g.sumA, S11: P };
        const fr = contrastFloorFit(gPlain, F, B, ST, STT, saTc, P, contrastFloor, quality === 2, space);
        if (fr) {
          let cell: GridCell;
          if (fr.space) {
            cell = quality === 2
              ? { ch: ' ', fg: encode(fr.mean), bg: encode(fbg) }   // Q2: bg fixed, mean in (invisible) fg
              : { ch: ' ', fg: null, bg: encode(fr.mean) };          // Q3/Q4: solid bg fill = cell mean
          } else {
            cell = quality === 2
              ? { ch: g.ch, fg: encode(fr.F), bg: encode(fbg) }
              : { ch: g.ch, fg: encode(fr.F), bg: encode(fr.B) };
          }
          cells[cellIdx] = cell;
          // cand[0] must equal the emit so contourPostPass(kappaC=0) reproduces it byte-for-byte.
          if (cands) cands[cellIdx] = singleCand(cell, bestGi, bestScore);
          floored = true;
        }
      }
      if (!floored) {
        // winner → emit via the invisibility collapse (emitWinner). B is fbg in Q2 (channelFB
        // fixes it), the fitted bg in Q3/Q4; collapseThreshold=0 → byte-identical to pre-collapse.
        cells[cellIdx] = emitWinner(g.ch, F, B, g.sumA);
        // §3.4 cands fix: when the winner collapses to space, cand[0] (the un-collapsed text
        // glyph from the topK scan) no longer matches the emit — overwrite with the collapsed
        // single candidate so contourPostPass cannot resurrect the collapsed glyph. Un-collapsed
        // text winners keep their full topK list (cand[0] already reproduces the emit).
        if (cands && lastCollapsed) cands[cellIdx] = singleCand(cells[cellIdx]!, bestGi, bestScore);
      }
      // smooth: record the EMITTED glyph's coverage for its right/below neighbors — 0 when the
      // contrast floor or the invisibility collapse demoted the emit to space, so neighbors are not
      // pulled toward the phantom (unemitted) scan-winner glyph. Matches the gated path's seed of
      // the emitted glyph (space glyphs carry ρ=0 anyway, so this is exact for a true space winner).
      if (chosenRho) chosenRho[cellIdx] = cells[cellIdx]!.ch === ' ' ? 0 : idRho![bestGi]!;
    }
  }

  return { cols, rows, cells, cellW, cellH, font: atlas.fontPath, ...(cands ? { cands } : {}) };
}

// §3.4 contour post-pass. Runs marching-squares polyline extraction on a per-cell
// coverage grid, then a Viterbi over each polyline's cells (states = that cell's topK
// candidates, unary = candidate score, pairwise = stroke continuity via border profiles)
// and REPLACES those cells' glyph/colors with the continuity-optimal path. Requires the
// grid to carry topK candidates (matchGrid with opts.topK>0). kappaC=0 is a no-op (each
// cell keeps its greedy argmin). Deterministic; mutates grid in place.
export function contourPostPass(grid: Grid, atlas: Atlas, coverageCells: Float32Array, kappaC: number): void {
  const cbc = grid.cands;
  if (!cbc) throw new Error('contourPostPass requires topK candidates — run matchGrid with opts.topK>0');
  if (coverageCells.length !== grid.cols * grid.rows) throw new Error('coverageCells must be cols*rows');
  const profiles = borderProfiles(atlas);
  const polylines = extractPolylines(coverageCells, grid.cols, grid.rows, 0.5);
  for (const pl of polylines) {
    const chosen = viterbiContour(pl, cbc, profiles, grid.cols, kappaC);
    for (const [idx, cand] of chosen) {
      // cand.ch names non-atlas (family/collapse/gated) winners directly; fall back to the
      // atlas glyph for plain text candidates. fgNull preserves the space/gated null-fg
      // semantics that a raw cand.F (a phantom mean) would otherwise overwrite.
      grid.cells[idx] = {
        ch: cand.ch ?? atlas.glyphs[cand.glyphIdx]!.ch,
        fg: cand.fgNull ? null : cand.F,
        bg: cand.B,
      };
    }
  }
}
