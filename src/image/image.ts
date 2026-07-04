import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { LinearImage } from '../core/types.js';
import { srgbToLinear } from '../core/color.js';

// Load a PNG/image into linear RGB. Straight alpha composited over black IN
// linear space: out = a · linear(rgb). Compositing before linearization is wrong.
export async function loadLinear(path: string): Promise<LinearImage> {
  const src = await loadImage(path);
  const w = src.width;
  const h = src.height;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(src, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data; // Uint8ClampedArray, RGBA
  const data = new Float32Array(w * h * 3);
  for (let p = 0, q = 0; p < rgba.length; p += 4, q += 3) {
    const a = rgba[p + 3]! / 255;
    data[q] = a * srgbToLinear(rgba[p]!);
    data[q + 1] = a * srgbToLinear(rgba[p + 1]!);
    data[q + 2] = a * srgbToLinear(rgba[p + 2]!);
  }
  return { w, h, data };
}

// Exact area (box) resampling in linear space. Each output pixel is the
// overlap-area-weighted mean of the input pixels its footprint covers, so the
// operation is separable and energy-preserving. Downscale is the required case;
// the formula is also correct for upscale and non-integer ratios.
export function resampleArea(img: LinearImage, w: number, h: number): LinearImage {
  // Horizontal pass: img.w -> w, height unchanged.
  const tmp = new Float32Array(w * img.h * 3);
  const sx = img.w / w;
  for (let ox = 0; ox < w; ox++) {
    const inStart = ox * sx;
    const inEnd = inStart + sx;
    const ixFirst = Math.floor(inStart);
    // clamp: float rounding of inEnd can push Math.ceil one past the last input
    // column (OOB read → NaN in the trailing output pixel).
    const ixLast = Math.min(img.w - 1, Math.ceil(inEnd) - 1);
    for (let iy = 0; iy < img.h; iy++) {
      let r = 0, g = 0, b = 0;
      const rowBase = iy * img.w * 3;
      for (let ix = ixFirst; ix <= ixLast; ix++) {
        const wgt = Math.min(inEnd, ix + 1) - Math.max(inStart, ix);
        const s = rowBase + ix * 3;
        r += wgt * img.data[s]!;
        g += wgt * img.data[s + 1]!;
        b += wgt * img.data[s + 2]!;
      }
      const d = (iy * w + ox) * 3;
      tmp[d] = r / sx;
      tmp[d + 1] = g / sx;
      tmp[d + 2] = b / sx;
    }
  }
  // Vertical pass: img.h -> h, width already w.
  const out = new Float32Array(w * h * 3);
  const sy = img.h / h;
  for (let oy = 0; oy < h; oy++) {
    const inStart = oy * sy;
    const inEnd = inStart + sy;
    const iyFirst = Math.floor(inStart);
    // clamp: float rounding can push Math.ceil one past the last input row.
    const iyLast = Math.min(img.h - 1, Math.ceil(inEnd) - 1);
    for (let ox = 0; ox < w; ox++) {
      let r = 0, g = 0, b = 0;
      for (let iy = iyFirst; iy <= iyLast; iy++) {
        const wgt = Math.min(inEnd, iy + 1) - Math.max(inStart, iy);
        const s = (iy * w + ox) * 3;
        r += wgt * tmp[s]!;
        g += wgt * tmp[s + 1]!;
        b += wgt * tmp[s + 2]!;
      }
      const d = (oy * w + ox) * 3;
      out[d] = r / sy;
      out[d + 1] = g / sy;
      out[d + 2] = b / sy;
    }
  }
  return { w, h, data: out };
}

// Central-difference gradients per channel over the FULL image (target = full
// support side of the boundary convention), zero-padded at image borders.
export function gradients(img: LinearImage): { dx: Float32Array; dy: Float32Array } {
  const { w, h, data } = img;
  const dx = new Float32Array(w * h * 3);
  const dy = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const base = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) {
        if (x > 0 && x < w - 1) {
          dx[base + c] = (data[base + 3 + c]! - data[base - 3 + c]!) / 2;
        }
        if (y > 0 && y < h - 1) {
          dy[base + c] = (data[base + w * 3 + c]! - data[base - w * 3 + c]!) / 2;
        }
      }
    }
  }
  return { dx, dy };
}
