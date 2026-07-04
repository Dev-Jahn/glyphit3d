import type { LinearImage, Atlas, Grid, GridCell, MatchOptions } from './types.js';
import { luma, linearToSrgb } from './color.js';

// Q0 strawman (DESIGN §6): fixed-brightness ramp. Demo/ladder comparison only.
const RAMP = ' .:-=+*#%@'; // 10 levels

function toU8(v: number): number {
  const s = Math.round(linearToSrgb(v));
  return s < 0 ? 0 : s > 255 ? 255 : s;
}

function srgb(rgb: ArrayLike<number>): [number, number, number] {
  return [toU8(rgb[0]!), toU8(rgb[1]!), toU8(rgb[2]!)];
}

export function rampGrid(img: LinearImage, atlas: Atlas, opts: MatchOptions): Grid {
  const { cellW, cellH } = atlas;
  const cols = Math.floor(img.w / cellW);
  const rows = Math.floor(img.h / cellH);
  const P = cellW * cellH;
  const w = img.w;
  const data = img.data;
  const bg = srgb(opts.fixedBg);
  const cells: GridCell[] = new Array(cols * rows);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x0 = col * cellW;
      const y0 = row * cellH;
      let sr = 0, sg = 0, sb = 0;
      for (let ly = 0; ly < cellH; ly++) {
        const gy = y0 + ly;
        for (let lx = 0; lx < cellW; lx++) {
          const gi = (gy * w + (x0 + lx)) * 3;
          sr += data[gi]!;
          sg += data[gi + 1]!;
          sb += data[gi + 2]!;
        }
      }
      const mr = sr / P, mg = sg / P, mb = sb / P;
      let y = luma(mr, mg, mb);
      y = y < 0 ? 0 : y > 1 ? 1 : y;
      // gamma-encoded luma → perceptual ramp index
      let idx = Math.round(Math.pow(y, 1 / 2.2) * 9);
      if (idx < 0) idx = 0; else if (idx > 9) idx = 9;
      cells[row * cols + col] = { ch: RAMP[idx]!, fg: srgb([mr, mg, mb]), bg };
    }
  }

  return { cols, rows, cells, cellW, cellH, font: atlas.fontPath };
}
