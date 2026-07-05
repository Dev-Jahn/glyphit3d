import type { LinearImage } from '../../src/core/types.js';
import { srgbToLinear } from '../../src/core/color.js';

// Browser replacement for src/image/image.ts:loadLinear. Straight alpha composited
// over black IN linear space: out = a · linear(rgb). Compositing before
// linearization is wrong — this mirrors loadLinear's semantics exactly, only the
// pixel source (a canvas ImageData) differs from the node PNG decoder.
export function imageDataToLinear(img: {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}): LinearImage {
  const w = img.width;
  const h = img.height;
  const rgba = img.data;
  const data = new Float32Array(w * h * 3);
  for (let p = 0, q = 0; p < rgba.length; p += 4, q += 3) {
    const a = rgba[p + 3]! / 255;
    data[q] = a * srgbToLinear(rgba[p]!);
    data[q + 1] = a * srgbToLinear(rgba[p + 1]!);
    data[q + 2] = a * srgbToLinear(rgba[p + 2]!);
  }
  return { w, h, data };
}
