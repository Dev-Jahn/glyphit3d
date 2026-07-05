// Edge metric (M3-SPEC §3.5). SSIM computed on Sobel gradient-magnitude maps of
// gamma-luma output vs reference, averaged over the boundary-cell band only
// (±1 cell dilation of the boundary cells). This is the PRIMARY metric for the
// contour pass (§3); overall SSIM is the guard. Kept separate from ssim.ts so no
// shared file is touched; the window/constants mirror the overall SSIM.

import type { LinearImage } from '../core/types.js';
import { luma, linearToSrgb } from '../core/color.js';

function lumaU8(img: LinearImage): Float64Array {
  const n = img.w * img.h;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const y = luma(img.data[i * 3]!, img.data[i * 3 + 1]!, img.data[i * 3 + 2]!);
    out[i] = Math.round(linearToSrgb(y));
  }
  return out;
}

// Sobel gradient magnitude of a scalar (u8-luma) field, zero-padded at borders.
function sobelMag(L: Float64Array, w: number, h: number): Float64Array {
  const out = new Float64Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = L[i - w - 1]!, tc = L[i - w]!, tr = L[i - w + 1]!;
      const ml = L[i - 1]!, mr = L[i + 1]!;
      const bl = L[i + w - 1]!, bc = L[i + w]!, br = L[i + w + 1]!;
      const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
      const gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
      out[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return out;
}

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

export interface EdgeBand {
  boundaryCells: ArrayLike<boolean> | ArrayLike<number>; // cols*rows, truthy = boundary cell
  cols: number; rows: number; cellW: number; cellH: number;
}

// pixel mask = boundary cells dilated by ±1 cell, expanded to pixels.
function bandPixelMask(band: EdgeBand, w: number, h: number): Uint8Array {
  const { boundaryCells, cols, rows, cellW, cellH } = band;
  const cellMask = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!boundaryCells[r * cols + c]) continue;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) cellMask[rr * cols + cc] = 1;
        }
      }
    }
  }
  const px = new Uint8Array(w * h);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!cellMask[r * cols + c]) continue;
      const y0 = r * cellH, x0 = c * cellW;
      for (let ly = 0; ly < cellH; ly++) {
        const gy = y0 + ly;
        if (gy >= h) break;
        for (let lx = 0; lx < cellW; lx++) {
          const gx = x0 + lx;
          if (gx < w) px[gy * w + gx] = 1;
        }
      }
    }
  }
  return px;
}

// Mean SSIM of the two Sobel-magnitude maps over the 11×11 windows whose CENTRE
// pixel lies in the boundary band. Identical inputs ⇒ 1 (each window SSIM ≡ 1);
// a shifted/degraded edge inside the band scores lower. Throws if the band
// contains no window centre (nothing to measure).
export function edgeSSIM(out: LinearImage, ref: LinearImage, band: EdgeBand): number {
  if (out.w !== ref.w || out.h !== ref.h) throw new Error('edgeSSIM: dimension mismatch');
  const w = out.w, h = out.h;
  if (w < WIN || h < WIN) throw new Error('edgeSSIM: image smaller than 11×11 window');
  const X = sobelMag(lumaU8(out), w, h);
  const Y = sobelMag(lumaU8(ref), w, h);
  const mask = bandPixelMask(band, w, h);
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;

  let acc = 0, count = 0;
  for (let y0 = 0; y0 <= h - WIN; y0++) {
    for (let x0 = 0; x0 <= w - WIN; x0++) {
      // window centre gates membership in the band.
      if (!mask[(y0 + RADIUS) * w + (x0 + RADIUS)]) continue;
      let mx = 0, my = 0, mxx = 0, myy = 0, mxy = 0;
      for (let j = 0; j < WIN; j++) {
        const rowBase = (y0 + j) * w + x0;
        const kBase = j * WIN;
        for (let i = 0; i < WIN; i++) {
          const wgt = KERNEL[kBase + i]!;
          const xv = X[rowBase + i]!;
          const yv = Y[rowBase + i]!;
          mx += wgt * xv; my += wgt * yv;
          mxx += wgt * xv * xv; myy += wgt * yv * yv;
          mxy += wgt * xv * yv;
        }
      }
      const vx = mxx - mx * mx, vy = myy - my * my, vxy = mxy - mx * my;
      const s = ((2 * mx * my + C1) * (2 * vxy + C2)) /
                ((mx * mx + my * my + C1) * (vx + vy + C2));
      acc += s; count++;
    }
  }
  if (count === 0) throw new Error('edgeSSIM: boundary band contains no window centre');
  return acc / count;
}
