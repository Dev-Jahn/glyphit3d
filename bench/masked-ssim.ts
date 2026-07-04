import type { LinearImage } from '../src/core/types.js';
import { luma, linearToSrgb } from '../src/core/color.js';

// Object/background localization for the gate matrix (Step 2). The SSIM math here
// mirrors src/metric/ssim.ts EXACTLY (same gamma-luma u8 channel, same 11×11 σ=1.5
// Gaussian, same K1/K2/L) so the masked means are comparable to ssim(); we only add
// a per-window map + a reference-derived object mask. ssim.ts itself is untouched.

const WIN = 11;
const RADIUS = 5;

function gaussKernel(sigma: number): Float64Array {
  const k = new Float64Array(WIN * WIN);
  let sum = 0;
  for (let j = -RADIUS; j <= RADIUS; j++) {
    for (let i = -RADIUS; i <= RADIUS; i++) {
      const v = Math.exp(-(i * i + j * j) / (2 * sigma * sigma));
      k[(j + RADIUS) * WIN + (i + RADIUS)] = v;
      sum += v;
    }
  }
  for (let n = 0; n < k.length; n++) k[n]! /= sum;
  return k;
}
const KERNEL = gaussKernel(1.5);

// gamma-encoded luma in [0,1] per pixel (the perceptual channel).
export function gammaLuma01(img: LinearImage): Float64Array {
  const n = img.w * img.h;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const y = luma(img.data[i * 3]!, img.data[i * 3 + 1]!, img.data[i * 3 + 2]!);
    out[i] = linearToSrgb(y) / 255;
  }
  return out;
}
function lumaU8From(gl01: Float64Array): Float64Array {
  const out = new Float64Array(gl01.length);
  for (let i = 0; i < gl01.length; i++) out[i] = Math.round(gl01[i]! * 255);
  return out;
}

// Per-cell mean gamma-luma in [0,1] — the SAME statistic objectMask thresholds. The
// Otsu split must be derived from THIS histogram (per-cell means), not the per-pixel
// luma histogram, or the threshold is computed on a different distribution than it is
// applied to (diagnostic-consistency fix; no verdict impact).
export function cellMeanLuma01(img: LinearImage, cellW: number, cellH: number): Float64Array {
  const { w } = img;
  const gl = gammaLuma01(img);
  const cols = Math.floor(w / cellW);
  const rows = Math.floor(img.h / cellH);
  const out = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let s = 0;
      for (let ly = 0; ly < cellH; ly++) {
        const y = r * cellH + ly;
        for (let lx = 0; lx < cellW; lx++) s += gl[y * w + (c * cellW + lx)]!;
      }
      out[r * cols + c] = s / (cellW * cellH);
    }
  }
  return out;
}

// Otsu threshold (in [0,1]) on the gamma-luma histogram — automatic, data-driven
// object/background split. Used because the spec's literal τ≈0.06 marks 100% of
// these bright-gradient-background renders as object (degenerate).
export function otsuThreshold(gl01: Float64Array): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < gl01.length; i++) hist[Math.round(gl01[i]! * 255)]!++;
  const total = gl01.length;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t]!;
  let wB = 0, sumB = 0, best = -1, thr = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr / 255;
}

// Reference-derived object mask at full-pixel resolution: a cell is "object" if its
// mean gamma-luma exceeds `t`; the cell mask is dilated by one cell (3×3, so
// silhouette cells count as object) and expanded back to pixels.
export function objectMask(
  ref: LinearImage, cellW: number, cellH: number, t: number,
): { mask: Uint8Array; objFrac: number } {
  const { w, h } = ref;
  const gl = gammaLuma01(ref);
  const cols = Math.floor(w / cellW);
  const rows = Math.floor(h / cellH);
  const cellObj = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let s = 0;
      for (let ly = 0; ly < cellH; ly++) {
        const y = r * cellH + ly;
        for (let lx = 0; lx < cellW; lx++) s += gl[y * w + (c * cellW + lx)]!;
      }
      cellObj[r * cols + c] = s / (cellW * cellH) > t ? 1 : 0;
    }
  }
  const dil = new Uint8Array(cols * rows);
  let objCells = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let d = 0;
      for (let dr = -1; dr <= 1 && !d; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr >= 0 && rr < rows && cc >= 0 && cc < cols && cellObj[rr * cols + cc]) { d = 1; break; }
        }
      }
      dil[r * cols + c] = d;
      if (d) objCells++;
    }
  }
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const cr = Math.floor(y / cellH);
    for (let x = 0; x < w; x++) {
      const cc = Math.floor(x / cellW);
      if (cr < rows && cc < cols) mask[y * w + x] = dil[cr * cols + cc]!;
    }
  }
  return { mask, objFrac: objCells / (cols * rows) };
}

// SSIM restricted to object cells and to background cells (and overall), bucketed by
// the window-center pixel's mask value — i.e. masked mean over the SSIM map.
export function maskedSsim(
  a: LinearImage, b: LinearImage, mask: Uint8Array,
): { obj: number; bg: number; all: number } {
  if (a.w !== b.w || a.h !== b.h) throw new Error('maskedSsim: dimension mismatch');
  const w = a.w, h = a.h;
  const X = lumaU8From(gammaLuma01(a));
  const Y = lumaU8From(gammaLuma01(b));
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;

  let accO = 0, nO = 0, accB = 0, nB = 0;
  for (let y0 = 0; y0 <= h - WIN; y0++) {
    for (let x0 = 0; x0 <= w - WIN; x0++) {
      let mx = 0, my = 0, mxx = 0, myy = 0, mxy = 0;
      for (let j = 0; j < WIN; j++) {
        const rowBase = (y0 + j) * w + x0;
        const kBase = j * WIN;
        for (let i = 0; i < WIN; i++) {
          const wgt = KERNEL[kBase + i]!;
          const xv = X[rowBase + i]!;
          const yv = Y[rowBase + i]!;
          mx += wgt * xv; my += wgt * yv;
          mxx += wgt * xv * xv; myy += wgt * yv * yv; mxy += wgt * xv * yv;
        }
      }
      const vx = mxx - mx * mx, vy = myy - my * my, vxy = mxy - mx * my;
      const s = ((2 * mx * my + C1) * (2 * vxy + C2)) /
                ((mx * mx + my * my + C1) * (vx + vy + C2));
      const center = (y0 + RADIUS) * w + (x0 + RADIUS);
      if (mask[center]) { accO += s; nO++; } else { accB += s; nB++; }
    }
  }
  return {
    obj: nO ? accO / nO : NaN,
    bg: nB ? accB / nB : NaN,
    all: (accO + accB) / (nO + nB),
  };
}
