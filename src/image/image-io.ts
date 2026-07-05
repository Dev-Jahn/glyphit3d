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

// PNG → raw u8 (R channel only), NO sRGB decode. For objectid / coverage AOVs
// where pixel values are data (mesh id / mask), not color with a transfer curve.
export async function loadRaw(path: string): Promise<{ w: number; h: number; data: Uint8Array }> {
  const src = await loadImage(path);
  const w = src.width;
  const h = src.height;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(src, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const data = new Uint8Array(w * h);
  for (let p = 0, q = 0; p < rgba.length; p += 4, q++) data[q] = rgba[p]!;
  return { w, h, data };
}
