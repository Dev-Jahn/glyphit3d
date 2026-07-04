import { describe, it, expect } from 'vitest';
import type { LinearImage } from '../src/core/types.js';
import { ssim } from '../src/metric/ssim.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Textured base image so SSIM is sensitive to structure.
function makeBase(w: number, h: number): LinearImage {
  const data = new Float32Array(w * h * 3);
  const rnd = mulberry32(1234);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 3;
      const grad = x / (w - 1);
      const checker = (x + y) % 2 === 0 ? 0.15 : 0;
      const noise = rnd() * 0.1;
      const v = Math.min(1, grad * 0.6 + checker + noise);
      data[idx] = v;
      data[idx + 1] = v * 0.8;
      data[idx + 2] = 1 - v;
    }
  }
  return { w, h, data };
}

function addNoise(img: LinearImage, level: number, noise: Float32Array): LinearImage {
  const data = new Float32Array(img.data.length);
  for (let i = 0; i < data.length; i++) {
    const v = img.data[i]! + level * noise[i]!;
    data[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return { w: img.w, h: img.h, data };
}

describe('ssim', () => {
  it('is 1 for identical images', () => {
    const img = makeBase(24, 20);
    expect(ssim(img, img)).toBeCloseTo(1, 10);
  });

  it('decreases monotonically with increasing added noise', () => {
    const img = makeBase(24, 20);
    const rnd = mulberry32(99);
    const noise = new Float32Array(img.data.length);
    for (let i = 0; i < noise.length; i++) noise[i] = rnd() * 2 - 1;

    const s1 = ssim(img, addNoise(img, 0.05, noise));
    const s2 = ssim(img, addNoise(img, 0.15, noise));
    const s3 = ssim(img, addNoise(img, 0.4, noise));

    expect(s1).toBeLessThan(1);
    expect(s1).toBeGreaterThan(s2);
    expect(s2).toBeGreaterThan(s3);
  });

  it('throws on dimension mismatch', () => {
    const a = makeBase(16, 16);
    const b = makeBase(16, 20);
    expect(() => ssim(a, b)).toThrow();
  });
});
