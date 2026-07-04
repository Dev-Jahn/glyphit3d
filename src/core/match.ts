import type { LinearImage, Atlas, Grid, GridCell, MatchOptions, FitStatsG } from './types.js';
import { sseAt, fitFree, fitFgOnly, fitBox } from './fit.js';
import { cellStats } from './stats.js';
import { gradients } from '../image/image.js';
import { linearToSrgb } from './color.js';

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
  const ffg = opts.fixedFg;
  const fbg = opts.fixedBg;
  const cells: GridCell[] = new Array(cols * rows);

  // reused glyph-side Gram stats (mutated per glyph, never per channel)
  const gStats: FitStatsG = { Saa: 0, Sa1: 0, S11: P };

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cs = cellStats(work, dx, dy, cellW, cellH, col, row);
      const T = cs.T, dxT = cs.dxT, dyT = cs.dyT;
      const ST = cs.ST, STT = cs.STT, minT = cs.minT, maxT = cs.maxT, gradTT = cs.gradTT;
      const cellIdx = row * cols + col;

      // 1. contrast gate BEFORE the scan
      if (cs.EacLuma / P < opts.gateTau) {
        const mean: [number, number, number] = [ST[0]! / P, ST[1]! / P, ST[2]! / P];
        if (quality === 1) cells[cellIdx] = { ch: ' ', fg: encode(ffg), bg: encode(fbg) };
        else if (quality === 2) cells[cellIdx] = { ch: ' ', fg: encode(mean), bg: encode(fbg) };
        else cells[cellIdx] = { ch: ' ', fg: null, bg: encode(mean) };
        continue;
      }

      // AC-energy scale for the MDL penalty (plain per-channel AC energy summed)
      const eacScale =
        (STT[0]! - (ST[0]! * ST[0]!) / P) +
        (STT[1]! - (ST[1]! * ST[1]!) / P) +
        (STT[2]! - (ST[2]! * ST[2]!) / P);

      // 2. scan all glyphs
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
        if (score < bestScore) { bestScore = score; bestGi = gi; }
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

      if (quality === 1) cells[cellIdx] = { ch: g.ch, fg: encode(ffg), bg: encode(fbg) };
      else if (quality === 2) cells[cellIdx] = { ch: g.ch, fg: encode(F), bg: encode(fbg) };
      else cells[cellIdx] = { ch: g.ch, fg: encode(F), bg: encode(B) };
    }
  }

  return { cols, rows, cells, cellW, cellH, font: atlas.fontPath };
}
