import { parseArgs } from 'node:util';
import { writeFile, readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import type { MatchOptions } from './core/types.js';
import { buildAtlas } from './atlas/atlas.js';
import type { CHARSETS } from './atlas/charsets.js';
import { loadLinear, loadRaw, resampleArea } from './image/image.js';
import { matchGrid } from './core/match.js';
import { rampGrid } from './core/ramp.js';
import { rasterizeGrid, savePng } from './render/raster.js';
import { toAnsi } from './render/ansi.js';
import { toHtml } from './render/html.js';
import { ssim } from './metric/ssim.js';
import { luma, linearToSrgb } from './core/color.js';
import { cellDiffHeatmap } from './metric/heatmap.js';

export function defaultOptions(quality: 0 | 1 | 2 | 3 | 4): MatchOptions {
  return {
    quality,
    space: 'gamma',
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

// M1-SPEC §4: `bake` — model|aov-dir → AOV-driven glyph match. A model file is
// rendered to AOVs via scripts/bake-aov.ts (child process) first; an existing AOV
// dir skips rendering. The shaded render is the fit target AND the SSIM reference.
async function bakeCmd(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv.slice(3),
    allowPositionals: true,
    options: {
      cols: { type: 'string', default: '120' },
      quality: { type: 'string', default: '3' },
      space: { type: 'string', default: 'gamma' },
      charset: { type: 'string', default: 'blocks' },
      font: { type: 'string', default: '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf' },
      'font-size': { type: 'string', default: '16' },
      split: { type: 'string', default: '0' },
      antibleed: { type: 'string', default: '0' },
      'style-albedo': { type: 'boolean', default: false },
      o: { type: 'string' },
      html: { type: 'string' },
      png: { type: 'string' },
      diff: { type: 'string' },
      stats: { type: 'boolean', default: false },
    },
  });
  const target = positionals[0];
  if (!target) {
    console.error('usage: cli bake <model.glb|.gltf|aov-dir> --cols 120 --quality 3 [--split N] [--antibleed N] [--style-albedo] [-o out.ansi] [--html f] [--png f] [--diff f] [--stats]');
    process.exit(2);
  }
  const cols = parseInt(values.cols!, 10);
  const quality = parseInt(values.quality!, 10) as 0 | 1 | 2 | 3 | 4;
  const space = values.space === 'linear' ? 'linear' : 'gamma';
  const charset = values.charset as keyof typeof CHARSETS;
  const fontSize = parseInt(values['font-size']!, 10);

  // Resolve the AOV directory: a directory input is used directly; a model file is
  // rendered to bench/aov/<name> via the RENDERER driver as a child process.
  let aovDir: string;
  if (statSync(target).isDirectory()) {
    aovDir = target;
  } else {
    const name = basename(target).replace(/\.(gltf|glb)$/i, '');
    aovDir = join('bench', 'aov', name);
    const here = fileURLToPath(new URL('.', import.meta.url));
    const driver = join(here, '..', 'scripts', 'bake-aov.ts');
    // forward --font/--font-size so bake-aov's footprint matches this atlas (else the
    // AOV gridW×gridH is not a multiple of the cell and the multiple check below errors).
    const r = spawnSync('npx', ['tsx', driver, target, '--cols', String(cols), '--out', aovDir,
      '--font', values.font!, '--font-size', String(fontSize)], { stdio: 'inherit' });
    if (r.status !== 0) { console.error(`bake-aov failed for ${target}`); process.exit(1); }
  }
  const req = (f: string) => {
    const p = join(aovDir, f);
    if (!existsSync(p)) { console.error(`missing AOV: ${p}`); process.exit(2); }
    return p;
  };

  const atlas = await buildAtlas(values.font!, fontSize, charset);
  const ref = await loadLinear(req('shaded.png'));          // fit target + SSIM reference
  if (ref.w % atlas.cellW !== 0 || ref.h % atlas.cellH !== 0) {
    console.error(`AOV footprint ${ref.w}x${ref.h} not a multiple of cell ${atlas.cellW}x${atlas.cellH}`);
    process.exit(2);
  }

  const opts = defaultOptions(quality);
  opts.space = space;
  const eta = parseFloat(values.split!);
  const kappa = parseFloat(values.antibleed!);
  const styleAlbedo = values['style-albedo']!;
  const aov: NonNullable<MatchOptions['aov']> = {};
  if (eta > 0) aov.shadingLuma = await shadingLumaOf(req('shading.png'), space);
  if (kappa > 0) aov.objectId = Uint16Array.from((await loadRaw(req('objectid.png'))).data);
  if (styleAlbedo) aov.albedo = await loadLinear(req('albedo.png'));
  if (eta > 0) opts.splitSelection = eta;
  if (kappa > 0) opts.antibleedKappa = kappa;
  if (styleAlbedo) opts.styleAlbedoColors = true;
  if (eta > 0 || kappa > 0 || styleAlbedo) opts.aov = aov;

  const t0 = performance.now();
  const grid = quality === 0 ? rampGrid(ref, atlas, opts) : matchGrid(ref, atlas, opts);
  const elapsed = performance.now() - t0;

  if (values.o) await writeFile(values.o, toAnsi(grid));
  if (values.html) await writeFile(values.html, toHtml(grid));
  const rasterSpace = quality === 0 ? 'linear' : space;
  const out = rasterizeGrid(grid, atlas, rasterSpace);
  if (values.png) await savePng(out, values.png);
  if (values.diff) await savePng(cellDiffHeatmap(ref, out, grid), values.diff);
  if (!values.o && !values.html) process.stdout.write(toAnsi(grid));

  if (values.stats) {
    const s = ssim(out, ref);
    console.error(`grid ${grid.cols}x${grid.rows}  cell ${atlas.cellW}x${atlas.cellH}  glyphs ${atlas.glyphs.length}  split ${eta} antibleed ${kappa}${styleAlbedo ? ' style-albedo' : ''}`);
    console.error(`Q${quality} SSIM ${s.toFixed(4)}  match ${elapsed.toFixed(1)}ms`);
  }
}

// Working-space luma of the albedo-free shading render (§4.1). loadLinear gives
// linear RGB; gamma mode encodes luma to sRGB [0,1] to match the fit's working space.
async function shadingLumaOf(path: string, space: 'linear' | 'gamma'): Promise<Float32Array> {
  const sh = await loadLinear(path);
  const out = new Float32Array(sh.w * sh.h);
  for (let i = 0; i < out.length; i++) {
    const y = luma(sh.data[i * 3]!, sh.data[i * 3 + 1]!, sh.data[i * 3 + 2]!);
    out[i] = space === 'gamma' ? linearToSrgb(y) / 255 : y;
  }
  return out;
}

async function main(): Promise<void> {
  if (argv[2] === 'bake') { await bakeCmd(); return; }
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      cols: { type: 'string', default: '120' },
      quality: { type: 'string', default: '3' },
      space: { type: 'string', default: 'gamma' },
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
    console.error('usage: cli image <input.png> --cols N --quality 0..4 --space linear|gamma --charset <set> --font <ttf> --font-size N [-o out.ansi] [--html f] [--png f] [--diff f] [--stats]');
    process.exit(2);
  }
  const input = positionals[1];
  const cols = parseInt(values.cols!, 10);
  const quality = parseInt(values.quality!, 10) as 0 | 1 | 2 | 3 | 4;
  const space = values.space === 'gamma' ? 'gamma' : 'linear';
  const charset = values.charset as keyof typeof CHARSETS;
  const fontSize = parseInt(values['font-size']!, 10);

  const atlas = await buildAtlas(values.font!, fontSize, charset);
  const img = await loadLinear(input);
  const rows = gridRows(cols, img.w, img.h, atlas.cellW, atlas.cellH);
  const ref = resampleArea(img, cols * atlas.cellW, rows * atlas.cellH);

  const t0 = performance.now();
  const opts = defaultOptions(quality);
  opts.space = space;
  const grid = quality === 0 ? rampGrid(ref, atlas, opts) : matchGrid(ref, atlas, opts);
  const elapsed = performance.now() - t0;

  if (values.o) await writeFile(values.o, toAnsi(grid));
  if (values.html) await writeFile(values.html, toHtml(grid));
  // raster space MUST equal the fit space. Q0 rampGrid always bakes linear-encoded
  // colors (ignores opts.space), so it is always rasterized in linear.
  const rasterSpace = quality === 0 ? 'linear' : space;
  const out = rasterizeGrid(grid, atlas, rasterSpace);
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
