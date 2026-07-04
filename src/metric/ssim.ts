import type { LinearImage } from '../core/types.js';
import { luma, linearToSrgb } from '../core/color.js';

// gamma-encoded luma, rounded to u8 (the perceptual channel SSIM operates on).
function lumaU8(img: LinearImage): Float64Array {
  const n = img.w * img.h;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const y = luma(img.data[i * 3]!, img.data[i * 3 + 1]!, img.data[i * 3 + 2]!);
    out[i] = Math.round(linearToSrgb(y));
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

// Grayscale mean SSIM over the valid region (11×11 Gaussian σ=1.5, K1=0.01, K2=0.03, L=255).
export function ssim(a: LinearImage, b: LinearImage): number {
  if (a.w !== b.w || a.h !== b.h) throw new Error('ssim: dimension mismatch');
  const w = a.w;
  const h = a.h;
  if (w < WIN || h < WIN) throw new Error('ssim: image smaller than 11×11 window');
  const X = lumaU8(a);
  const Y = lumaU8(b);
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;

  let acc = 0;
  let count = 0;
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
          mx += wgt * xv;
          my += wgt * yv;
          mxx += wgt * xv * xv;
          myy += wgt * yv * yv;
          mxy += wgt * xv * yv;
        }
      }
      const vx = mxx - mx * mx;
      const vy = myy - my * my;
      const vxy = mxy - mx * my;
      const s = ((2 * mx * my + C1) * (2 * vxy + C2)) /
                ((mx * mx + my * my + C1) * (vx + vy + C2));
      acc += s;
      count++;
    }
  }
  return acc / count;
}
