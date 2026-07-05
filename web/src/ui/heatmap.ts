import type { Grid } from '../../../src/core/types.js';
import { cellDiffHeatmap } from '../../../src/metric/heatmap.js';
import { linearToSrgb } from '../../../src/core/color.js';
import { imageDataToLinear } from '../browser-image.js';

// Diff-heatmap device (M2-SPEC §3, DESIGN §9). Reuses the existing cellDiffHeatmap
// module verbatim: it needs the reference (native render) and output (glyph raster)
// as LinearImages at the grid footprint, plus the grid. Both are available on the
// main thread — #scene (WebGL, native) and #raster (2D, glyph raster) are both at
// gridW×gridH after a run — so no worker round-trip and no forked logic.

function toImageData(canvas: HTMLCanvasElement): ImageData {
  const w = canvas.width;
  const h = canvas.height;
  const scratch = document.createElement('canvas');
  scratch.width = w;
  scratch.height = h;
  const ctx = scratch.getContext('2d')!;
  ctx.drawImage(canvas, 0, 0);
  return ctx.getImageData(0, 0, w, h);
}

// Returns an offscreen canvas tinted green(match)→red(worst-cell), or null if the
// canvases are not yet sized to the grid footprint.
export function heatmapCanvas(
  sceneCanvas: HTMLCanvasElement,
  rasterCanvas: HTMLCanvasElement,
  grid: Grid,
): HTMLCanvasElement | null {
  const w = grid.cols * grid.cellW;
  const h = grid.rows * grid.cellH;
  if (sceneCanvas.width !== w || sceneCanvas.height !== h) return null;
  if (rasterCanvas.width !== w || rasterCanvas.height !== h) return null;

  const ref = imageDataToLinear(toImageData(sceneCanvas));
  const out = imageDataToLinear(toImageData(rasterCanvas));
  const heat = cellDiffHeatmap(ref, out, grid);

  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, q = 0; i < w * h; i++, q += 3) {
    rgba[i * 4] = Math.round(linearToSrgb(heat.data[q]!));
    rgba[i * 4 + 1] = Math.round(linearToSrgb(heat.data[q + 1]!));
    rgba[i * 4 + 2] = Math.round(linearToSrgb(heat.data[q + 2]!));
    rgba[i * 4 + 3] = 255;
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.putImageData(new ImageData(rgba, w, h), 0, 0);
  return c;
}
