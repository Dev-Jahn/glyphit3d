import { mkdir } from 'node:fs/promises';
import { createCanvas } from '@napi-rs/canvas';
import { writeFile } from 'node:fs/promises';
import type { LinearImage, Grid, Atlas } from '../src/core/types.js';
import { buildAtlas } from '../src/atlas/atlas.js';
import { loadLinear } from '../src/image/image-io.js';
import { resampleArea } from '../src/image/image.js';
import { matchGrid } from '../src/core/match.js';
import { rampGrid } from '../src/core/ramp.js';
import { rasterizeGrid } from '../src/render/raster.js';
import { ssim } from '../src/metric/ssim.js';
import { linearToSrgb } from '../src/core/color.js';
import { defaultOptions, gridRows } from '../src/core/options.js';

const COLS = 120;
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
const FONT_SIZE = 16;
const IMAGES = ['sphere', 'torus', 'spheres'];
const LABELH = 26;

// Returns the grid AND the space it must be rasterized in (fit space == composite
// space, always paired). Q0 rampGrid always bakes linear-encoded colors and ignores
// opts.space, so it is rasterized in linear; Q1..Q4 pair with the fit space.
function runQuality(ref: LinearImage, atlas: Atlas, q: 0 | 1 | 2 | 3 | 4): { grid: Grid; space: 'linear' | 'gamma' } {
  const opts = defaultOptions(q);
  if (q === 0) return { grid: rampGrid(ref, atlas, opts), space: 'linear' };
  return { grid: matchGrid(ref, atlas, opts), space: opts.space ?? 'gamma' };
}

// Blit a LinearImage (sRGB-encoded) into an ImageData region and place it.
function blit(ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>, img: LinearImage, x0: number, y0: number): void {
  const id = ctx.createImageData(img.w, img.h);
  const d = id.data;
  const n = img.w * img.h;
  for (let i = 0; i < n; i++) {
    d[i * 4] = Math.round(linearToSrgb(img.data[i * 3]!));
    d[i * 4 + 1] = Math.round(linearToSrgb(img.data[i * 3 + 1]!));
    d[i * 4 + 2] = Math.round(linearToSrgb(img.data[i * 3 + 2]!));
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(id, x0, y0);
}

async function main(): Promise<void> {
  await mkdir('bench/out', { recursive: true });
  const atlas = await buildAtlas(FONT, FONT_SIZE, 'blocks');

  const table: Record<string, number[]> = {};
  let allMonotone = true;
  let timings: number[] | null = null; // per-quality ms for the first 120-col image

  for (const name of IMAGES) {
    const img = await loadLinear(`bench/images/${name}.png`);
    const rows = gridRows(COLS, img.w, img.h, atlas.cellW, atlas.cellH);
    const ref = resampleArea(img, COLS * atlas.cellW, rows * atlas.cellH);

    const panels: LinearImage[] = [ref];
    const labels = ['reference'];
    const scores: number[] = [];
    const localTimings: number[] = [];

    for (let q = 0 as 0 | 1 | 2 | 3 | 4; q <= 4; q = (q + 1) as 0 | 1 | 2 | 3 | 4) {
      const t0 = performance.now();
      const { grid, space } = runQuality(ref, atlas, q);
      localTimings.push(performance.now() - t0);
      const out = rasterizeGrid(grid, atlas, space);
      scores.push(ssim(out, ref));
      panels.push(out);
      labels.push(`Q${q}`);
    }
    table[name] = scores;
    if (timings === null) timings = localTimings;

    if (!(scores[0]! < scores[3]!)) {
      allMonotone = false;
      console.error(`SANITY FAIL ${name}: Q0 ${scores[0]!.toFixed(4)} !< Q3 ${scores[3]!.toFixed(4)}`);
    }

    // compose side-by-side
    const pw = ref.w, ph = ref.h;
    const canvas = createCanvas(pw * panels.length, ph + LABELH);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < panels.length; i++) blit(ctx, panels[i]!, i * pw, LABELH);
    ctx.fillStyle = '#eee';
    ctx.font = '16px sans-serif';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < labels.length; i++) {
      const extra = i === 0 ? '' : `  SSIM ${scores[i - 1]!.toFixed(3)}`;
      ctx.fillText(labels[i]! + extra, i * pw + 6, LABELH / 2);
    }
    await writeFile(`bench/out/ladder-${name}.png`, await canvas.encode('png'));
  }

  // markdown table
  console.log('\n| image | Q0 | Q1 | Q2 | Q3 | Q4 |');
  console.log('|---|---|---|---|---|---|');
  for (const name of IMAGES) {
    const s = table[name]!;
    console.log(`| ${name} | ${s.map((x) => x.toFixed(4)).join(' | ')} |`);
  }

  if (timings) {
    console.log(`\nWall-clock (one ${COLS}-col run, image=${IMAGES[0]}):`);
    console.log('| Q0 | Q1 | Q2 | Q3 | Q4 |');
    console.log('|---|---|---|---|---|');
    console.log(`| ${timings.map((t) => t.toFixed(0) + 'ms').join(' | ')} |`);
  }

  console.log(`\nsanity gate (Q0<Q3 per image): ${allMonotone ? 'PASS' : 'FAIL'}`);
  if (!allMonotone) process.exit(1);
}

main();
