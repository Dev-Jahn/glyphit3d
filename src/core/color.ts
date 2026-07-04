// All internal color math in linear RGB [0,1]. sRGB only at IO boundaries.
// srgbToLinear consumes a u8 (0..255); linearToSrgb produces a [0,255] float
// (caller rounds). The pair is an exact inverse of the sRGB transfer curve.

const SRGB_TO_LINEAR = new Float64Array(256);
for (let u = 0; u < 256; u++) {
  const c = u / 255;
  SRGB_TO_LINEAR[u] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function srgbToLinear(u8: number): number {
  return SRGB_TO_LINEAR[u8]!;
}

export function linearToSrgb(f: number): number {
  const c = f <= 0 ? 0 : f >= 1 ? 1 : f;
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return s * 255;
}

export function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
