import type { Grid, Atlas, Glyph, LinearImage } from '../core/types.js';
import { linearToSrgb, srgbToLinear } from '../core/color.js';
import { createCanvas } from '@napi-rs/canvas';
import { writeFile } from 'node:fs/promises';

// null fg/bg → black [0,0,0] linear (the fixedBg convention at M0).
function toLinear(c: [number, number, number] | null): [number, number, number] {
  if (!c) return [0, 0, 0];
  return [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])];
}

// null fg/bg → sRGB u8 black [0,0,0].
function toU8(c: [number, number, number] | null): [number, number, number] {
  return c ?? [0, 0, 0];
}

function clampU8(v: number): number {
  const r = Math.round(v);
  return r < 0 ? 0 : r > 255 ? 255 : r;
}

// Bake a grid to a LinearImage container. `mode`:
//  - 'linear' (default, DESIGN §10 golden metric): pred = α·F + (1−α)·B composited
//    in linear light (colors decoded sRGB→linear first).
//  - 'gamma' (predict-terminal, §3.1): composite in the ENCODED sRGB space the way a
//    terminal blends glyph AA, quantize to the 8-bit framebuffer, then decode back to
//    linear so the container stays consistent (ssim() encodes internally — no double-encode).
export function rasterizeGrid(grid: Grid, atlas: Atlas, mode: 'linear' | 'gamma' = 'linear'): LinearImage {
  const cellW = atlas.cellW;
  const cellH = atlas.cellH;
  const w = grid.cols * cellW;
  const h = grid.rows * cellH;
  const data = new Float32Array(w * h * 3);

  const map = new Map<string, Glyph>();
  for (const g of atlas.glyphs) map.set(g.ch, g);

  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const cell = grid.cells[r * grid.cols + c];
      if (!cell) continue;
      const alpha = map.get(cell.ch)?.alpha;
      if (mode === 'gamma') {
        const [fr, fg, fb] = toU8(cell.fg);
        const [br, bg, bb] = toU8(cell.bg);
        for (let py = 0; py < cellH; py++) {
          for (let px = 0; px < cellW; px++) {
            const a = alpha ? alpha[py * cellW + px]! : 0;
            const ia = 1 - a;
            const x = c * cellW + px;
            const y = r * cellH + py;
            const idx = (y * w + x) * 3;
            data[idx] = srgbToLinear(clampU8(a * fr + ia * br));
            data[idx + 1] = srgbToLinear(clampU8(a * fg + ia * bg));
            data[idx + 2] = srgbToLinear(clampU8(a * fb + ia * bb));
          }
        }
        continue;
      }
      const [fr, fg, fb] = toLinear(cell.fg);
      const [br, bg, bb] = toLinear(cell.bg);
      for (let py = 0; py < cellH; py++) {
        for (let px = 0; px < cellW; px++) {
          const a = alpha ? alpha[py * cellW + px]! : 0;
          const ia = 1 - a;
          const x = c * cellW + px;
          const y = r * cellH + py;
          const idx = (y * w + x) * 3;
          data[idx] = a * fr + ia * br;
          data[idx + 1] = a * fg + ia * bg;
          data[idx + 2] = a * fb + ia * bb;
        }
      }
    }
  }
  return { w, h, data };
}

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
