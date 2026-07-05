import type { LinearImage, Atlas, Grid, GridCell, MatchOptions, FitStatsG, Candidate } from './types.js';
import { sseAt, fitFree, fitFgOnly, fitBox } from './fit.js';
import { cellStats } from './stats.js';
import { gradients } from '../image/image.js';
import { linearToSrgb, luma } from './color.js';
import { buildFamilies, solveFamily } from '../atlas/families.js';
import type { CellFitCtx, FamilySolve } from '../atlas/families.js';
import { glyphOrientations, orientationBonus, borderProfiles, structureTensor } from '../atlas/orientation.js';
import type { Orientation } from '../atlas/orientation.js';
import { extractPolylines, viterbiContour } from './contour.js';

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
  const emitWinner = (
    ch: string, F: [number, number, number], B: [number, number, number], sumA: number,
  ): GridCell => {
    if (quality === 1) return { ch, fg: encode(ffg), bg: encode(fbg) };
    const fgEnc = encode(F);
    const bgEnc = quality === 2 ? encode(fbg) : encode(B);
    if (collapseThreshold > 0 &&
        Math.max(Math.abs(fgEnc[0] - bgEnc[0]), Math.abs(fgEnc[1] - bgEnc[1]), Math.abs(fgEnc[2] - bgEnc[2])) < collapseThreshold) {
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

  const cells: GridCell[] = new Array(cols * rows);

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
  const families = buildFamilies(opts.families ?? [], cellW, cellH);
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
        if (quality === 1) cells[cellIdx] = { ch: ' ', fg: encode(ffg), bg: encode(fbg) };
        else if (quality === 2) cells[cellIdx] = { ch: ' ', fg: encode(mean), bg: encode(fbg) };
        else cells[cellIdx] = { ch: ' ', fg: null, bg: encode(mean) };
        // gated cell → the only candidate is the flat space glyph (glyphs[0]); score its
        // (already-known) SSE against the mean so the contour Viterbi can keep it.
        if (cands) {
          const c = cells[cellIdx]!;
          cands[cellIdx] = [{ glyphIdx: 0, score: eacScale, F: c.fg ?? encode(mean), B: c.bg ?? encode(mean) }];
        }
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

      // 2. scan all glyphs
      if (cands) heapN = 0;
      let bestScore = Infinity;
      let bestGi = 0;
      for (let gi = 0; gi < G; gi++) {
        const g = glyphs[gi]!;
        gStats.Sa1 = g.sumA;
        gStats.S11 = P;
        gStats.Saa = isQ4 ? g.sumAA + lam2 * g.gradAA : g.sumAA;
        const alpha = g.alpha, dxA = g.dxA, dyA = g.dyA;
        let score = 0;
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
        if (cands) heapPush(score, gi);
        if (score < bestScore) { bestScore = score; bestGi = gi; }
      }

      // 2a. §3.4 topK: materialize the ≤K best text candidates for this cell (sorted best
      // first). Colors are recomputed here (once per kept glyph) and encoded exactly as the
      // cell would emit them, so cand[0] == the emitted winner and the contour post-pass can
      // write a GridCell straight from any candidate. Skipped when topK is off.
      if (cands) {
        const order = Array.from({ length: heapN }, (_, i) => i).sort((a, b) => heapScore![a]! - heapScore![b]!);
        const list: Candidate[] = new Array(heapN);
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
        for (const f of families) {
          const sol = solveFamily(f, famCtx);
          if (famWin === null || sol.score < famWin.score) famWin = sol;
        }
        if (famWin && famWin.score >= bestScore) famWin = null; // text scan kept the win
      }

      // 3a. family winner → emit its solved ch + colors (colors already fit), via the
      // invisibility collapse (emitWinner). famWin.B is fbg in Q2, the fitted bg in Q3/Q4.
      if (famWin) {
        cells[cellIdx] = emitWinner(famWin.ch, famWin.F, famWin.B, famWin.sumA);
        continue;
      }

      // 3. winner → colors (recompute F,B for the argmin glyph only)
      const g = glyphs[bestGi]!;
      gStats.Sa1 = g.sumA;
      gStats.S11 = P;
      gStats.Saa = isQ4 ? g.sumAA + lam2 * g.gradAA : g.sumAA;
      const F: [number, number, number] = [0, 0, 0];
      const B: [number, number, number] = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const base = c * P;
        let saT = 0;
        for (let i = 0; i < P; i++) saT += g.alpha[i]! * T[base + i]!;
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

      // winner → emit via the invisibility collapse (emitWinner). B is fbg in Q2 (channelFB
      // fixes it), the fitted bg in Q3/Q4; collapseThreshold=0 → byte-identical to pre-collapse.
      cells[cellIdx] = emitWinner(g.ch, F, B, g.sumA);
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
      grid.cells[idx] = { ch: atlas.glyphs[cand.glyphIdx]!.ch, fg: cand.F, bg: cand.B };
    }
  }
}
