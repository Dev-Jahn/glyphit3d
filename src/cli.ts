import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import type { MatchOptions } from './core/types.js';
import { buildAtlas } from './atlas/atlas.js';
import type { CHARSETS } from './atlas/charsets.js';
import { loadLinear, resampleArea } from './image/image.js';
import { matchGrid } from './core/match.js';
import { rampGrid } from './core/ramp.js';
import { rasterizeGrid, savePng } from './render/raster.js';
import { toAnsi } from './render/ansi.js';
import { toHtml } from './render/html.js';
import { ssim } from './metric/ssim.js';
import { cellDiffHeatmap } from './metric/heatmap.js';

export function defaultOptions(quality: 0 | 1 | 2 | 3 | 4): MatchOptions {
  return {
    quality,
    edgeLambda: 0.35,
    gateTau: 2e-4,
    mdlLambda: 0.02,
    fixedBg: [0, 0, 0],
    fixedFg: [1, 1, 1],
  };
}

// rows = round(cols · (imgH/imgW) · cellW/cellH) — corrects for non-square cells.
export function gridRows(cols: number, imgW: number, imgH: number, cellW: number, cellH: number): number {
  return Math.max(1, Math.round((cols * (imgH / imgW) * cellW) / cellH));
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      cols: { type: 'string', default: '120' },
      quality: { type: 'string', default: '3' },
      charset: { type: 'string', default: 'blocks' },
      font: { type: 'string', default: '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf' },
      'font-size': { type: 'string', default: '16' },
      o: { type: 'string' },
      html: { type: 'string' },
      png: { type: 'string' },
      diff: { type: 'string' },
      stats: { type: 'boolean', default: false },
    },
  });

  if (positionals[0] !== 'image' || !positionals[1]) {
    console.error('usage: cli image <input.png> --cols N --quality 0..4 --charset <set> --font <ttf> --font-size N [-o out.ansi] [--html f] [--png f] [--diff f] [--stats]');
    process.exit(2);
  }
  const input = positionals[1];
  const cols = parseInt(values.cols!, 10);
  const quality = parseInt(values.quality!, 10) as 0 | 1 | 2 | 3 | 4;
  const charset = values.charset as keyof typeof CHARSETS;
  const fontSize = parseInt(values['font-size']!, 10);

  const atlas = await buildAtlas(values.font!, fontSize, charset);
  const img = await loadLinear(input);
  const rows = gridRows(cols, img.w, img.h, atlas.cellW, atlas.cellH);
  const ref = resampleArea(img, cols * atlas.cellW, rows * atlas.cellH);

  const t0 = performance.now();
  const opts = defaultOptions(quality);
  const grid = quality === 0 ? rampGrid(ref, atlas, opts) : matchGrid(ref, atlas, opts);
  const elapsed = performance.now() - t0;

  if (values.o) await writeFile(values.o, toAnsi(grid));
  if (values.html) await writeFile(values.html, toHtml(grid));
  const out = rasterizeGrid(grid, atlas);
  if (values.png) await savePng(out, values.png);
  if (values.diff) await savePng(cellDiffHeatmap(ref, out, grid), values.diff);
  if (!values.o && !values.html) process.stdout.write(toAnsi(grid));

  if (values.stats) {
    const s = ssim(out, ref);
    console.error(`grid ${grid.cols}x${grid.rows}  cell ${atlas.cellW}x${atlas.cellH}  glyphs ${atlas.glyphs.length}`);
    console.error(`Q${quality} SSIM ${s.toFixed(4)}  match ${elapsed.toFixed(1)}ms`);
  }
}

// Only run the CLI when invoked directly (not when imported for defaultOptions/gridRows).
if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) main();
