import type { Grid, LinearImage } from '../core/types.js';
import { luma } from '../core/color.js';

// Per-cell mean abs luma diff → green(0)→red(max) tinting, cell-sized tiles.
export function cellDiffHeatmap(ref: LinearImage, out: LinearImage, grid: Grid): LinearImage {
  const cw = grid.cellW;
  const cH = grid.cellH;
  const w = grid.cols * cw;
  const h = grid.rows * cH;
  if (ref.w !== w || ref.h !== h || out.w !== w || out.h !== h) {
    throw new Error('cellDiffHeatmap: image size does not match grid');
  }

  const diffs = new Float64Array(grid.cols * grid.rows);
  let maxD = 0;
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      let s = 0;
      for (let py = 0; py < cH; py++) {
        for (let px = 0; px < cw; px++) {
          const idx = ((r * cH + py) * w + (c * cw + px)) * 3;
          const lr = luma(ref.data[idx]!, ref.data[idx + 1]!, ref.data[idx + 2]!);
          const lo = luma(out.data[idx]!, out.data[idx + 1]!, out.data[idx + 2]!);
          s += Math.abs(lr - lo);
        }
      }
      const d = s / (cw * cH);
      diffs[r * grid.cols + c] = d;
      if (d > maxD) maxD = d;
    }
  }

  const data = new Float32Array(w * h * 3);
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const t = maxD > 0 ? diffs[r * grid.cols + c]! / maxD : 0;
      const red = t;
      const green = 1 - t;
      for (let py = 0; py < cH; py++) {
        for (let px = 0; px < cw; px++) {
          const idx = ((r * cH + py) * w + (c * cw + px)) * 3;
          data[idx] = red;
          data[idx + 1] = green;
          data[idx + 2] = 0;
        }
      }
    }
  }
  return { w, h, data };
}
