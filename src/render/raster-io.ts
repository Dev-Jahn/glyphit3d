import type { LinearImage } from '../core/types.js';
import { linearToSrgb } from '../core/color.js';
import { createCanvas } from '@napi-rs/canvas';
import { writeFile } from 'node:fs/promises';

export async function savePng(img: LinearImage, path: string): Promise<void> {
  const canvas = createCanvas(img.w, img.h);
  const ctx = canvas.getContext('2d');
  const id = ctx.createImageData(img.w, img.h);
  const d = id.data;
  const n = img.w * img.h;
  for (let i = 0; i < n; i++) {
    d[i * 4] = Math.round(linearToSrgb(img.data[i * 3]!));
    d[i * 4 + 1] = Math.round(linearToSrgb(img.data[i * 3 + 1]!));
    d[i * 4 + 2] = Math.round(linearToSrgb(img.data[i * 3 + 2]!));
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  const buf = await canvas.encode('png');
  await writeFile(path, buf);
}
