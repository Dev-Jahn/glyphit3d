import type { LinearImage } from '../src/core/types.js';
import { luma, linearToSrgb } from '../src/core/color.js';
import { cellMeanLuma01, otsuThreshold } from './masked-ssim.js';

// Cell-AC structure metric (CAS) — the headline reconstruction-structure metric that
// DEMOTES mean SSIM to a guardrail (ADR-0002; DESIGN §10). Rationale: in the
// unconstrained truecolor two-color fit the per-cell DC (mean color) is reproduced
// EXACTLY (DESIGN §3.3 corollary), so SSIM's luminance term ≡ 1 per cell and, because
// most of a frame is smooth background, the 11×11-window mean saturates at ~0.98 — the
// glyph's sub-cell structural contribution lands in the 3rd–4th decimal (why Q3↔Q4 were
// indistinguishable). CAS strips the saturating DC term and scores structure at CELL
// scale, over an object mask, as a DISTRIBUTION (low percentiles headline).
//
// The metric channel is gamma-encoded u8 luma extracted IDENTICALLY to
// src/metric/ssim.ts, computed on the RE-RASTERIZED predict-terminal composite (not the
// fit residual). So it lives in the same space as the guardrail SSIM and the terminal
// composite (fit/metric space pairing, DESIGN §3.1) and inherits the gate's
// harness-fairness protocol — it cannot be gamed by fitting to the graded array.

// SSIM stability constant (K2=0.03, L=255), reused verbatim so CAS is exactly the
// contrast·structure factor `cs = (2σxy+C2)/(σx²+σy²+C2)` of SSIM, at cell scale.
export const C2 = (0.03 * 255) ** 2;

// gamma-encoded luma rounded to u8 — the perceptual channel, identical to ssim.ts.
function lumaU8(img: LinearImage): Float64Array {
  const n = img.w * img.h;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const y = luma(img.data[i * 3]!, img.data[i * 3 + 1]!, img.data[i * 3 + 2]!);
    out[i] = Math.round(linearToSrgb(y));
  }
  return out;
}

export interface CellMaps {
  cols: number;
  rows: number;
  cs: Float64Array;        // cols*rows, per-cell DC-removed contrast·structure in [-1,1]
  acEnergy: Float64Array;  // cols*rows, per-cell REFERENCE AC energy σy² (structure present)
}

// Per-cell DC-removed contrast·structure (the SSIM `cs` factor) with the CELL as the
// window: uniform weight over all P = cellW·cellH pixels, NOT an 11×11 Gaussian, so the
// window never reads a neighbour cell (a neighbour's glyph choice must not leak into this
// cell's structural score) and "cell scale" is literal. DC removal = the luminance term is
// dropped, so cs is invariant to the cell's mean color (the color-fill that saturates SSIM).
//
//   cs_k = (2·σxy + C2) / (σx² + σy² + C2)
//
// with population moments over the P pixels. Bounded in [-1,1] (Cauchy–Schwarz). Edge cases:
//   both flat (σx²=σy²=σxy=0)        → C2/C2 = 1  (structure trivially reproduced)
//   ref flat, out structured (σy=0)  → C2/(σx²+C2) < 1  (HALLUCINATED structure punished)
//   out flat, ref structured (σx=0)  → C2/(σy²+C2) < 1  (FAILURE to reproduce punished)
//   cs = 1  ⇔  Var(x−y)=0  ⇔  out == ref up to a per-cell DC offset (exact AC match)
// Contrast/amplitude must MATCH for cs=1 (not just correlation sign) — this is what makes
// CAS un-gameable by injecting arbitrary tiny structure, unlike a contrast-normalised NCC.
export function cellCsMap(out: LinearImage, ref: LinearImage, cellW: number, cellH: number): CellMaps {
  if (out.w !== ref.w || out.h !== ref.h) throw new Error('cellCsMap: dimension mismatch');
  const { w, h } = out;
  const cols = Math.floor(w / cellW);
  const rows = Math.floor(h / cellH);
  if (cols < 1 || rows < 1) throw new Error('cellCsMap: image smaller than one cell');
  const X = lumaU8(out);
  const Y = lumaU8(ref);
  const P = cellW * cellH;
  const cs = new Float64Array(cols * rows);
  const acEnergy = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
      for (let ly = 0; ly < cellH; ly++) {
        const rowBase = (r * cellH + ly) * w + c * cellW;
        for (let lx = 0; lx < cellW; lx++) {
          const xv = X[rowBase + lx]!;
          const yv = Y[rowBase + lx]!;
          sx += xv; sy += yv; sxx += xv * xv; syy += yv * yv; sxy += xv * yv;
        }
      }
      const mx = sx / P, my = sy / P;
      let vx = sxx / P - mx * mx;
      let vy = syy / P - my * my;
      const vxy = sxy / P - mx * my;
      if (vx < 0) vx = 0;               // guard float noise (variance is non-negative)
      if (vy < 0) vy = 0;
      const idx = r * cols + c;
      cs[idx] = (2 * vxy + C2) / (vx + vy + C2);
      acEnergy[idx] = vy;               // reference AC energy — output-independent weight
    }
  }
  return { cols, rows, cs, acEnergy };
}

// Per-CELL object mask, 2D-image fallback (no renderer AOVs). Otsu splits the per-cell mean
// gamma-luma into two classes; the OBJECT is the class that is the MINORITY on the image
// border (the frame of edge cells), the BACKGROUND is the border-majority class. A photographic
// subject rarely fills the border ring, so the border votes reliably for background — this makes
// the polarity self-calibrating and correct for BOTH bright-subject-on-dark-bg (synthetic
// renders) AND dark-subject-on-bright-bg (e.g. FlightHelmet/BoomBox), where a fixed "object =
// brighter" rule inverts and scores the backdrop. Object cells are dilated by one cell so
// silhouette cells count as object. Reuses the gate's exact statistic (cellMeanLuma01 +
// otsuThreshold from masked-ssim.ts) so the mask matches the gate's localization. The renderer
// path supersedes this with a geometric mask (coverage>0 / objectId≠0) — see aovCellMask.
export function cellObjectMask(
  ref: LinearImage, cellW: number, cellH: number,
): { mask: Uint8Array; cols: number; rows: number; objFrac: number; otsu: number } {
  const means = cellMeanLuma01(ref, cellW, cellH);
  const otsu = otsuThreshold(means);
  const cols = Math.floor(ref.w / cellW);
  const rows = Math.floor(ref.h / cellH);
  // Decide polarity from the border: whichever Otsu class holds the majority of edge cells is
  // background; the object is the other (minority-on-border) class.
  let aboveBorder = 0, borderCells = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (r !== 0 && r !== rows - 1 && c !== 0 && c !== cols - 1) continue;
      if (means[r * cols + c]! > otsu) aboveBorder++;
      borderCells++;
    }
  }
  const objectIsBright = aboveBorder * 2 <= borderCells; // object = minority class on the border
  const raw = new Uint8Array(cols * rows);
  for (let i = 0; i < raw.length; i++) {
    const above = means[i]! > otsu;
    raw[i] = (objectIsBright ? above : !above) ? 1 : 0;
  }
  const mask = dilate1(raw, cols, rows);
  let objCells = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) objCells++;
  return { mask, cols, rows, objFrac: objCells / (cols * rows), otsu };
}

// Geometric per-CELL object mask from renderer AOVs (DESIGN §4.2): a cell is object if its
// silhouette coverage > 0 (or object-id ≠ 0), dilated one cell. This is the principled mask
// — geometric truth, not a luma heuristic — used whenever the render supplies AOVs.
export function aovCellMask(
  cols: number, rows: number, aov: { coverage?: Float32Array; objectId?: Uint16Array },
): Uint8Array {
  const raw = new Uint8Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) {
    const cov = aov.coverage ? aov.coverage[i]! > 0 : false;
    const oid = aov.objectId ? aov.objectId[i]! !== 0 : false;
    raw[i] = cov || oid ? 1 : 0;
  }
  return dilate1(raw, cols, rows);
}

function dilate1(cell: Uint8Array, cols: number, rows: number): Uint8Array {
  const out = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let d = 0;
      for (let dr = -1; dr <= 1 && !d; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr >= 0 && rr < rows && cc >= 0 && cc < cols && cell[rr * cols + cc]) { d = 1; break; }
        }
      }
      out[r * cols + c] = d;
    }
  }
  return out;
}

// Linear-interpolated percentile of an ascending-sorted array. p in [0,100].
export function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  if (n === 1) return sortedAsc[0]!;
  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo]!;
  const frac = rank - lo;
  return sortedAsc[lo]! * (1 - frac) + sortedAsc[hi]! * frac;
}

export interface CasStats {
  nObj: number;         // object cells scored
  nStructured: number;  // object cells with reference AC energy σy² > C2 (real structure)
  p05: number;          // headline: worst-reproduced structural cells
  p10: number;
  p25: number;
  p50: number;          // median
  mean: number;         // plain masked mean (comparable to a masked SSIM guardrail)
  wmean: number;        // AC-energy-weighted mean (structure-dominant single number)
}

// Aggregate the per-cell cs map over the object mask as a DISTRIBUTION. The low percentiles
// are the headline: smooth object cells score cs≈1 (top of the distribution), so the bottom
// percentiles isolate the structured, hard cells — exactly the signal SSIM's mean diluted.
// wmean weights each cell by REFERENCE AC energy σy² (output-independent → un-gameable),
// yielding a structure-dominant scalar that does not saturate on flat cells.
export function aggregateCas(maps: CellMaps, cellMask: Uint8Array): CasStats {
  const { cs, acEnergy, cols, rows } = maps;
  if (cellMask.length !== cols * rows) throw new Error('aggregateCas: mask/grid size mismatch');
  const vals: number[] = [];
  let wnum = 0, wden = 0, nStructured = 0;
  for (let i = 0; i < cols * rows; i++) {
    if (!cellMask[i]) continue;
    const v = cs[i]!;
    vals.push(v);
    const wt = acEnergy[i]!;
    wnum += wt * v; wden += wt;
    if (wt > C2) nStructured++;
  }
  vals.sort((a, b) => a - b);
  const n = vals.length;
  const mean = n ? vals.reduce((a, b) => a + b, 0) / n : NaN;
  return {
    nObj: n,
    nStructured,
    p05: percentile(vals, 5),
    p10: percentile(vals, 10),
    p25: percentile(vals, 25),
    p50: percentile(vals, 50),
    mean,
    wmean: wden > 0 ? wnum / wden : NaN,
  };
}

// Convenience: full CAS report for one (output, reference) pair with the 2D fallback mask.
// `mask` overrides the fallback (pass an AOV-derived cell mask when the render has AOVs).
export function casReport(
  out: LinearImage, ref: LinearImage, cellW: number, cellH: number, mask?: Uint8Array,
): CasStats & { objFrac: number; otsu: number } {
  const maps = cellCsMap(out, ref, cellW, cellH);
  let objFrac = NaN, otsu = NaN, cellMask: Uint8Array;
  if (mask) {
    cellMask = mask;
    let objCells = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) objCells++;
    objFrac = objCells / (maps.cols * maps.rows);
  } else {
    const m = cellObjectMask(ref, cellW, cellH);
    cellMask = m.mask; objFrac = m.objFrac; otsu = m.otsu;
  }
  return { ...aggregateCas(maps, cellMask), objFrac, otsu };
}
