import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCanvas } from '@napi-rs/canvas';
import { srgbToLinear } from '../src/core/color.js';
import type { LinearImage } from '../src/core/types.js';
import { loadLinear, resampleArea, gradients } from '../src/image/image.js';

function makeImage(w: number, h: number, fill: (x: number, y: number, c: number) => number): LinearImage {
  const data = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) data[(y * w + x) * 3 + c] = fill(x, y, c);
  return { w, h, data };
}

function energy(img: LinearImage): number {
  // area-weighted total: each pixel area normalized so total = mean·count·area.
  // Use pixel value · pixel area; pixel area = 1/(w·h) so energy is the mean.
  let s = 0;
  for (let i = 0; i < img.data.length; i++) s += img.data[i]!;
  return s / (img.w * img.h);
}

describe('resampleArea', () => {
  it('constant image resamples exactly', () => {
    const img = makeImage(7, 5, (_x, _y, c) => 0.3 + c * 0.2);
    const out = resampleArea(img, 3, 2);
    expect(out.w).toBe(3);
    expect(out.h).toBe(2);
    for (let i = 0; i < out.data.length; i++) {
      expect(out.data[i]).toBeCloseTo(0.3 + (i % 3) * 0.2, 6);
    }
  });

  it('2x1 checker downsampled to 1x1 equals the mean (linear space)', () => {
    // left pixel value 0.0, right pixel value 0.8 in each channel
    const img = makeImage(2, 1, (x) => (x === 0 ? 0.0 : 0.8));
    const out = resampleArea(img, 1, 1);
    for (let c = 0; c < 3; c++) expect(out.data[c]).toBeCloseTo(0.4, 6);
  });

  it('2x2 checker to 1x1 equals mean of four', () => {
    const vals = [0.1, 0.2, 0.3, 0.4];
    const img = makeImage(2, 2, (x, y) => vals[y * 2 + x]!);
    const out = resampleArea(img, 1, 1);
    for (let c = 0; c < 3; c++) expect(out.data[c]).toBeCloseTo(0.25, 6);
  });

  it('preserves energy under a non-integer downscale ratio', () => {
    const img = makeImage(13, 11, (x, y, c) => Math.sin(x * 0.7 + y * 0.3 + c) * 0.4 + 0.5);
    const out = resampleArea(img, 5, 4);
    expect(energy(out)).toBeCloseTo(energy(img), 4);
  });

  it('preserves energy under an integer downscale ratio', () => {
    const img = makeImage(8, 8, (x, y, c) => ((x + y + c) % 3) * 0.3);
    const out = resampleArea(img, 2, 2);
    expect(energy(out)).toBeCloseTo(energy(img), 6);
  });

  it('does not read out of bounds on a float-rounding overrun pair (512→210, no NaN)', () => {
    // 512px area-resampled to 210 (== a 512px image at --cols 21, cellW 10): the last
    // output pixel's inEnd lands at 512.0000000000001, so pre-fix Math.ceil(inEnd)-1
    // read column/row 512 (one past the end) → NaN in the bottom-right pixel. The clamp
    // to img.w-1 / img.h-1 fixes both the horizontal and vertical pass; hitting both
    // needs a 512×512 source. Assert no NaN anywhere + energy (mean) preserved.
    const img = makeImage(512, 512, (x, y, c) => Math.sin(x * 0.11 + y * 0.07 + c) * 0.4 + 0.5);
    const out = resampleArea(img, 210, 210);
    expect(out.w).toBe(210);
    expect(out.h).toBe(210);
    for (let i = 0; i < out.data.length; i++) expect(Number.isNaN(out.data[i]!)).toBe(false);
    expect(energy(out)).toBeCloseTo(energy(img), 4);
  });
});

describe('gradients', () => {
  it('central differences, zero-padded at borders', () => {
    // horizontal ramp: value = x in channel 0
    const img = makeImage(4, 3, (x, _y, c) => (c === 0 ? x : 0));
    const { dx, dy } = gradients(img);
    for (let y = 0; y < 3; y++) {
      // border columns are zero
      expect(dx[(y * 4 + 0) * 3]).toBe(0);
      expect(dx[(y * 4 + 3) * 3]).toBe(0);
      // interior: (x+1 - (x-1))/2 = 1
      expect(dx[(y * 4 + 1) * 3]).toBeCloseTo(1, 12);
      expect(dx[(y * 4 + 2) * 3]).toBeCloseTo(1, 12);
    }
    // no vertical variation -> dy all zero
    for (let i = 0; i < dy.length; i++) expect(dy[i]).toBe(0);
  });
});

describe('loadLinear', () => {
  it('linearizes sRGB and composites straight alpha over black in linear', async () => {
    const w = 2, h = 1;
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(w, h);
    // pixel 0: opaque sRGB 128 gray
    imgData.data.set([128, 128, 128, 255], 0);
    // pixel 1: white with alpha 128
    imgData.data.set([255, 255, 255, 128], 4);
    ctx.putImageData(imgData, 0, 0);
    const path = join(tmpdir(), `loadlinear-${Date.now()}.png`);
    writeFileSync(path, canvas.toBuffer('image/png'));

    const img = await loadLinear(path);
    expect(img.w).toBe(2);
    expect(img.h).toBe(1);
    for (let c = 0; c < 3; c++) {
      expect(img.data[c]).toBeCloseTo(srgbToLinear(128), 5);
      expect(img.data[3 + c]).toBeCloseTo((128 / 255) * 1.0, 5);
    }
  });
});
