import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage, type Canvas } from '@napi-rs/canvas';
import { writeFile } from 'node:fs/promises';
import type { LinearImage } from '../src/core/types.js';
import { buildAtlas } from '../src/atlas/atlas.js';
import { loadLinear } from '../src/image/image-io.js';
import { matchGrid } from '../src/core/match.js';
import { rasterizeGrid } from '../src/render/raster.js';
import { linearToSrgb } from '../src/core/color.js';
import { defaultOptions } from '../src/core/options.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';

// Render the shaded reference through the Q3 two-color matcher and return an
// sRGB-encoded canvas of the glyph raster (same footprint as the reference).
async function glyphCanvas(refPath: string): Promise<Canvas> {
  const atlas = await buildAtlas(FONT, 16, 'blocks');
  const ref: LinearImage = await loadLinear(refPath); // already at grid footprint
  const opts = defaultOptions(3);
  const grid = matchGrid(ref, atlas, opts);
  const out = rasterizeGrid(grid, atlas, opts.space ?? 'gamma');

  const c = createCanvas(out.w, out.h);
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(out.w, out.h);
  const d = id.data;
  const n = out.w * out.h;
  for (let i = 0; i < n; i++) {
    d[i * 4] = Math.round(linearToSrgb(out.data[i * 3]!));
    d[i * 4 + 1] = Math.round(linearToSrgb(out.data[i * 3 + 1]!));
    d[i * 4 + 2] = Math.round(linearToSrgb(out.data[i * 3 + 2]!));
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

// Side-by-side native (left) vs glyph (right), ~1600px total, thin divider, subtle labels.
async function main(): Promise<void> {
  const shaded = `${ROOT}/bench/aov/DamagedHelmet/shaded.png`;
  const ref = await loadImage(shaded);          // 3D render
  const glyph = await glyphCanvas(shaded);      // text (Q3 glyph raster)

  const halfW = 800;                                   // each panel width
  const scale = halfW / ref.width;                     // 1200 -> 800
  const panelH = Math.round(ref.height * scale);       // 1197 -> 798
  const div = 2;                                       // divider thickness
  const totalW = halfW * 2 + div;

  const canvas = createCanvas(totalW, panelH);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  ctx.fillStyle = '#0d1115';
  ctx.fillRect(0, 0, totalW, panelH);

  ctx.drawImage(ref, 0, 0, halfW, panelH);
  ctx.drawImage(glyph, halfW + div, 0, halfW, panelH);

  // thin divider
  ctx.fillStyle = 'rgba(235,238,245,0.85)';
  ctx.fillRect(halfW, 0, div, panelH);

  // subtle labels: small pill, low opacity
  const label = (text: string, x: number, align: 'left' | 'right'): void => {
    ctx.font = '600 15px sans-serif';
    ctx.textBaseline = 'alphabetic';
    const pad = 8;
    const tw = ctx.measureText(text).width;
    const bw = tw + pad * 2;
    const bh = 24;
    const bx = align === 'left' ? x : x - bw;
    const by = panelH - 14 - bh;
    ctx.fillStyle = 'rgba(10,12,16,0.55)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = 'rgba(230,233,240,0.92)';
    ctx.fillText(text, bx + pad, by + bh - 8);
  };
  label('3D render', 14, 'left');
  label('text', totalW - 14, 'right');

  await writeFile(`${ROOT}/docs/assets/hero.png`, await canvas.encode('png'));
  console.log(`hero.png ${totalW}x${panelH}`);
}
main();
