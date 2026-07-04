import { describe, it, expect } from 'vitest';
import { srgbToLinear, linearToSrgb, luma } from '../src/core/color.js';

describe('color', () => {
  it('round-trips u8 -> linear -> u8 for all 256 values', () => {
    for (let u = 0; u < 256; u++) {
      const back = Math.round(linearToSrgb(srgbToLinear(u)));
      expect(back).toBe(u);
    }
  });

  it('linear endpoints map exactly', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(255)).toBeCloseTo(1, 12);
    expect(linearToSrgb(0)).toBe(0);
    expect(linearToSrgb(1)).toBeCloseTo(255, 9);
  });

  it('honors the sRGB toe boundary (linear 0.0031308 <-> sRGB 0.04045)', () => {
    // decode toe: sRGB c=0.04045 -> linear 0.04045/12.92
    const toeU8 = 0.04045 * 255;
    const uLo = Math.floor(toeU8), uHi = Math.ceil(toeU8);
    // below/at the toe the decode is linear (c/12.92)
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo((1 / 255) / 12.92, 12);
    // encode toe: linear 0.0031308 -> sRGB 0.04045 (in [0,1]) -> *255
    expect(linearToSrgb(0.0031308) / 255).toBeCloseTo(0.0031308 * 12.92, 9);
    // continuity of encode across the toe
    const eps = 1e-9;
    expect(linearToSrgb(0.0031308 + eps)).toBeCloseTo(linearToSrgb(0.0031308 - eps), 4);
    expect(uLo).toBeGreaterThanOrEqual(0);
    expect(uHi).toBeLessThanOrEqual(255);
  });

  it('clamps out-of-range linear input', () => {
    expect(linearToSrgb(-0.5)).toBe(0);
    expect(linearToSrgb(2)).toBeCloseTo(255, 9);
  });

  it('luma uses Rec.709 linear weights', () => {
    expect(luma(1, 0, 0)).toBeCloseTo(0.2126, 12);
    expect(luma(0, 1, 0)).toBeCloseTo(0.7152, 12);
    expect(luma(0, 0, 1)).toBeCloseTo(0.0722, 12);
    expect(luma(1, 1, 1)).toBeCloseTo(1, 12);
  });
});
