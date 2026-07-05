import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { writeFile } from 'node:fs/promises';
import type { LinearImage, Grid, Atlas } from '../src/core/types.js';
import { buildAtlas } from '../src/atlas/atlas.js';
import { loadLinear } from '../src/image/image-io.js';
import { matchGrid } from '../src/core/match.js';
import { rampGrid } from '../src/core/ramp.js';
import { rasterizeGrid } from '../src/render/raster.js';
import { ssim } from '../src/metric/ssim.js';
import { linearToSrgb } from '../src/core/color.js';
import { defaultOptions } from '../src/core/options.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';

// Q0 bakes linear-encoded colors and ignores opts.space -> raster linear; Q1..Q4 pair with fit space.
function runQuality(ref: LinearImage, atlas: Atlas, q: 0 | 1 | 2 | 3 | 4): { grid: Grid; space: 'linear' | 'gamma' } {
  const opts = defaultOptions(q);
  if (q === 0) return { grid: rampGrid(ref, atlas, opts), space: 'linear' };
  return { grid: matchGrid(ref, atlas, opts), space: opts.space ?? 'gamma' };
}

// Blit a linear-RGB LinearImage into an ImageData region, scaling by `s`.
function blitScaled(ctx: any, img: LinearImage, x0: number, y0: number, s: number): void {
  const src = createCanvas(img.w, img.h);
  const sctx = src.getContext('2d');
  const id = sctx.createImageData(img.w, img.h);
  const d = id.data;
  const n = img.w * img.h;
  for (let i = 0; i < n; i++) {
    d[i * 4] = Math.round(linearToSrgb(img.data[i * 3]!));
    d[i * 4 + 1] = Math.round(linearToSrgb(img.data[i * 3 + 1]!));
    d[i * 4 + 2] = Math.round(linearToSrgb(img.data[i * 3 + 2]!));
    d[i * 4 + 3] = 255;
  }
  sctx.putImageData(id, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, x0, y0, Math.round(img.w * s), Math.round(img.h * s));
}

async function main(): Promise<void> {
  const atlas = await buildAtlas(FONT, 16, 'blocks');
  const ref = await loadLinear(`${ROOT}/bench/aov/DamagedHelmet/shaded.png`); // already at grid footprint

  const panels: LinearImage[] = [ref];
  const labels = ['reference'];
  const scores: (number | null)[] = [null];

  for (let q = 0 as 0 | 1 | 2 | 3 | 4; q <= 4; q = (q + 1) as 0 | 1 | 2 | 3 | 4) {
    const { grid, space } = runQuality(ref, atlas, q);
    const out = rasterizeGrid(grid, atlas, space);
    scores.push(ssim(out, ref));
    panels.push(out);
    labels.push(`Q${q}`);
  }

  const PANEL_W = 300;
  const s = PANEL_W / ref.w;
  const panelH = Math.round(ref.h * s);
  const CAP = 30;
  const GAP = 6;
  const pad = 6;
  const totalW = panels.length * PANEL_W + (panels.length - 1) * GAP + pad * 2;
  const totalH = panelH + CAP + pad * 2;

  const canvas = createCanvas(totalW, totalH);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0d1115';
  ctx.fillRect(0, 0, totalW, totalH);

  for (let i = 0; i < panels.length; i++) {
    const x = pad + i * (PANEL_W + GAP);
    blitScaled(ctx, panels[i]!, x, pad, s);
    // caption
    ctx.fillStyle = '#e6e9f0';
    ctx.textBaseline = 'middle';
    ctx.font = '600 15px sans-serif';
    const capY = pad + panelH + CAP / 2;
    ctx.fillText(labels[i]!, x + 4, capY);
    const sc = scores[i];
    if (sc != null) {
      ctx.fillStyle = '#8fb7ff';
      ctx.font = '13px sans-serif';
      ctx.fillText(`SSIM ${sc.toFixed(4)}`, x + 44, capY);
    }
  }

  await writeFile(`${ROOT}/docs/assets/ladder.png`, await canvas.encode('png'));
  console.log(`ladder.png ${totalW}x${totalH}`);
  console.log('scores:', labels.map((l, i) => scores[i] == null ? l : `${l}=${scores[i]!.toFixed(4)}`).join('  '));
}
main();
