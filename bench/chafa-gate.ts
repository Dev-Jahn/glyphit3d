import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildAtlas } from '../src/atlas/atlas.js';
import { loadLinear, resampleArea } from '../src/image/image.js';
import { matchGrid } from '../src/core/match.js';
import { rasterizeGrid } from '../src/render/raster.js';
import { ssim } from '../src/metric/ssim.js';
import { parseAnsiToGrid } from './ansi-parse.js';
import type { Atlas, Grid, LinearImage, MatchOptions } from '../src/core/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CHAFA = join(ROOT, 'tools', 'chafa', 'chafa');
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
const FONT_SIZE = 16;
const COLS = 120;
const IMAGES = ['sphere', 'torus', 'spheres'];

const Q3: MatchOptions = {
  quality: 3,
  edgeLambda: 0.35,
  gateTau: 2e-4,
  mdlLambda: 0.02,
  fixedBg: [0, 0, 0],
  fixedFg: [1, 1, 1],
};

// Compress a sorted unique code-point list into chafa's --symbols range syntax
// (`lo..hi` runs joined by `+`). Feeding chafa the EXACT repertoire our atlas
// retained is the only fair mapping: every glyph chafa can pick is one our
// DejaVu atlas can re-rasterize, and both engines draw from an identical set.
function toSymbolArg(cps: number[]): string {
  const sorted = [...cps].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    const lo = sorted[i]!.toString(16);
    const hi = sorted[j]!.toString(16);
    parts.push(i === j ? lo : `${lo}..${hi}`);
    i = j + 1;
  }
  return parts.join('+');
}

function runChafa(image: string, symbols: string, cols: number, rows: number,
                  cellW: number, cellH: number, glyphFile?: string): string {
  const args = [
    '-w', '9',
    '--fill', 'none',
    '--symbols', symbols,
    '--colors', 'full',
    '--size', `${cols}x${rows}`,
    '--font-ratio', `${cellW}/${cellH}`,
    '-f', 'symbols',
  ];
  if (glyphFile) args.push('--glyph-file', glyphFile);
  args.push(image);
  return execFileSync(CHAFA, args, { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
}

// SSIM of a grid re-rasterized through OUR atlas vs the reference resampled to
// that grid's exact pixel footprint (each grid scored at its own resolution).
function scoreGrid(grid: Grid, atlas: Atlas, src: LinearImage): number {
  const baked = rasterizeGrid(grid, atlas);
  const ref = resampleArea(src, baked.w, baked.h);
  return ssim(baked, ref);
}

async function main(): Promise<void> {
  if (!existsSync(CHAFA)) {
    console.error(`chafa binary missing at ${CHAFA}; download the static build first.`);
    process.exit(2);
  }
  const version = execFileSync(CHAFA, ['--version']).toString('utf8').split('\n')[0];
  console.log(`chafa: ${version}`);

  const atlas = await buildAtlas(FONT, FONT_SIZE, 'blocks');
  const { cellW, cellH } = atlas;
  const symbols = toSymbolArg(atlas.glyphs.map((g) => g.cp));
  console.log(`atlas: ${atlas.glyphs.length} glyphs, cell ${cellW}x${cellH}`);
  console.log(`chafa --symbols repertoire (== our atlas): ${symbols}\n`);

  const rowsOf: Record<string, { ours: number; builtin: number; dejavu: number }> = {};
  let sumOurs = 0, sumBuiltin = 0, sumDejavu = 0;

  console.log('| image | ours Q3 | chafa builtin | chafa DejaVu |');
  console.log('|---|---|---|---|');

  for (const name of IMAGES) {
    const imgPath = join(ROOT, 'bench', 'images', `${name}.png`);
    const src = await loadLinear(imgPath);
    const rows = Math.round(COLS * (src.h / src.w) * (cellW / cellH));

    // ours: resample to the grid footprint, then match
    const gridImg = resampleArea(src, COLS * cellW, rows * cellH);
    const ourGrid = matchGrid(gridImg, atlas, Q3);
    const sOurs = scoreGrid(ourGrid, atlas, src);

    const builtinAnsi = runChafa(imgPath, symbols, COLS, rows, cellW, cellH);
    const builtinGrid = parseAnsiToGrid(builtinAnsi, cellW, cellH, atlas.fontPath);
    const sBuiltin = scoreGrid(builtinGrid, atlas, src);

    const dejavuAnsi = runChafa(imgPath, symbols, COLS, rows, cellW, cellH, FONT);
    const dejavuGrid = parseAnsiToGrid(dejavuAnsi, cellW, cellH, atlas.fontPath);
    const sDejavu = scoreGrid(dejavuGrid, atlas, src);

    rowsOf[name] = { ours: ourGrid.rows, builtin: builtinGrid.rows, dejavu: dejavuGrid.rows };
    sumOurs += sOurs; sumBuiltin += sBuiltin; sumDejavu += sDejavu;
    console.log(`| ${name} | ${sOurs.toFixed(4)} | ${sBuiltin.toFixed(4)} | ${sDejavu.toFixed(4)} |`);
  }

  const n = IMAGES.length;
  const mOurs = sumOurs / n, mBuiltin = sumBuiltin / n, mDejavu = sumDejavu / n;
  console.log(`| **mean** | **${mOurs.toFixed(4)}** | **${mBuiltin.toFixed(4)}** | **${mDejavu.toFixed(4)}** |`);

  const chafaBest = Math.max(mBuiltin, mDejavu);
  const bestName = mDejavu >= mBuiltin ? 'DejaVu glyph-file' : 'builtin glyphs';
  const pass = mOurs > chafaBest;
  console.log(`\ngrid rows (ours/builtin/dejavu): ${IMAGES.map((n2) => `${n2} ${rowsOf[n2]!.ours}/${rowsOf[n2]!.builtin}/${rowsOf[n2]!.dejavu}`).join(', ')}`);
  console.log(`\nchafa best variant: ${bestName} (mean SSIM ${chafaBest.toFixed(4)})`);
  console.log(`ours mean SSIM: ${mOurs.toFixed(4)}`);
  console.log(`GATE: ${pass ? 'PASS' : 'FAIL'} (ours ${pass ? '>' : '<='} chafa best by ${(mOurs - chafaBest).toFixed(4)})`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
