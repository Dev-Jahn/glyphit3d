import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { dirname, join } from 'node:path';
import { buildAtlas } from '../src/atlas/atlas.js';
import { CHARSETS } from '../src/atlas/charsets.js';
import { resampleArea } from '../src/image/image.js';
import { loadLinear } from '../src/image/image-io.js';
import { matchGrid } from '../src/core/match.js';
import { rasterizeGrid } from '../src/render/raster.js';
import { savePng } from '../src/render/raster-io.js';
import { ssim } from '../src/metric/ssim.js';
import { parseAnsiToGrid } from './ansi-parse.js';
import { objectMask, otsuThreshold, maskedSsim, cellMeanLuma01 } from './masked-ssim.js';
import { buildFamilies, type Family, type FamilyName } from '../src/atlas/families.js';
import type { Atlas, Glyph, Grid, LinearImage, MatchOptions } from '../src/core/types.js';

// M3-SPEC §4 criterion-2 fairness run: synthesized families the matcher can use, and
// the SAME braille/sextant symbol classes granted to chafa (fair both ways). augmentAtlas
// appends the exact synth masks so BOTH engines' sub-cell picks re-rasterize identically.
const M3_FAMS: FamilyName[] = ['quadrant', 'sextant', 'braille'];
function augmentAtlas(atlas: Atlas, fams: Family[]): Atlas {
  const have = new Set(atlas.glyphs.map((g) => g.ch));
  const P = atlas.P;
  const extra: Glyph[] = [];
  for (const f of fams) {
    for (let S = 0; S < (1 << f.k); S++) {
      const ch = f.ch[S]!;
      if (have.has(ch)) continue;
      have.add(ch);
      const alpha = new Float32Array(P), dxA = new Float32Array(P), dyA = new Float32Array(P);
      for (let i = 0; i < f.k; i++) {
        if (!((S >> i) & 1)) continue;
        const ri = f.regions[i]!, dxi = f.dxR[i]!, dyi = f.dyR[i]!;
        for (let p = 0; p < P; p++) { alpha[p] = alpha[p]! + ri[p]!; dxA[p] = dxA[p]! + dxi[p]!; dyA[p] = dyA[p]! + dyi[p]!; }
      }
      extra.push({ ch, cp: ch.codePointAt(0)!, alpha, dxA, dyA, sumA: f.sumA[S]!, sumAA: f.sumAA[S]!, gradAA: f.gradAA[S]!, ink: f.ink[S]! });
    }
  }
  return { ...atlas, glyphs: [...atlas.glyphs, ...extra] };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CHAFA = join(ROOT, 'tools', 'chafa', 'chafa');
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
const FONT_SIZE = 16;
const COLS = 120;
// default = the 3 synthetic renders; override with --images a,b,c (e.g. to add the
// Khronos zoo screenshots). The listed names resolve to bench/images/<name>.png.
let IMAGES = ['sphere', 'torus', 'spheres'];
// charset preset fed to buildAtlas; chafa's repertoire is derived from the
// resulting atlas glyphs, so this flag steers BOTH engines in lockstep.
let CHARSET: keyof typeof CHARSETS = 'blocks';

type Space = 'linear' | 'gamma';

function baseOpts(): MatchOptions {
  return {
    quality: 3,
    edgeLambda: 0.35,
    gateTau: 2e-4,
    mdlLambda: 0.02,
    fixedBg: [0, 0, 0],
    fixedFg: [1, 1, 1],
  };
}

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

// chafa invocation is UNCHANGED across the whole matrix (Step 3 constraint).
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

// SSIM of a grid re-rasterized through OUR atlas (in the given raster mode) vs the
// reference resampled to that grid's exact pixel footprint.
function scoreGrid(grid: Grid, atlas: Atlas, src: LinearImage, mode: Space): number {
  const baked = rasterizeGrid(grid, atlas, mode);
  const ref = resampleArea(src, baked.w, baked.h);
  return ssim(baked, ref);
}

// Be generous to chafa: bake its grid BOTH ways and keep whichever scores higher.
function bestChafa(grid: Grid, atlas: Atlas, src: LinearImage): { score: number; mode: Space } {
  const lin = scoreGrid(grid, atlas, src, 'linear');
  const gam = scoreGrid(grid, atlas, src, 'gamma');
  return gam > lin ? { score: gam, mode: 'gamma' } : { score: lin, mode: 'linear' };
}

interface ImgCtx {
  name: string;
  src: LinearImage;
  gridImg: LinearImage;       // resampled to grid footprint (linear)
  refFoot: LinearImage;       // reference at grid footprint (== gridImg, kept explicit)
  builtinGrid: Grid;
  dejavuGrid: Grid;
  builtin: { score: number; mode: Space };
  dejavu: { score: number; mode: Space };
  mask: Uint8Array;
  objFrac: number;
  otsu: number;
}

async function buildContexts(atlas: Atlas, symbols: string): Promise<ImgCtx[]> {
  const { cellW, cellH } = atlas;
  const tmp = await mkdtemp(join(tmpdir(), 'chafa-gate-'));
  const ctxs: ImgCtx[] = [];
  for (const name of IMAGES) {
    const imgPath = join(ROOT, 'bench', 'images', `${name}.png`);
    const src = await loadLinear(imgPath);
    const rows = Math.round(COLS * (src.h / src.w) * (cellW / cellH));
    const gridImg = resampleArea(src, COLS * cellW, rows * cellH);

    // Protocol fairness (correction): chafa must optimize the SAME pixels ours fits and
    // every contestant is graded on — the grid-footprint reference, NOT the 512px
    // original. Feeding chafa the original biased the margin in our favor (ours fit the
    // exact graded array while chafa fit a different, higher-res image). Save gridImg to
    // a temp PNG and hand THAT to chafa.
    const gridPngPath = join(tmp, `${name}-gridfoot.png`);
    await savePng(gridImg, gridPngPath);

    const builtinGrid = parseAnsiToGrid(runChafa(gridPngPath, symbols, COLS, rows, cellW, cellH), cellW, cellH, atlas.fontPath);
    const dejavuGrid = parseAnsiToGrid(runChafa(gridPngPath, symbols, COLS, rows, cellW, cellH, FONT), cellW, cellH, atlas.fontPath);
    const builtin = bestChafa(builtinGrid, atlas, src);
    const dejavu = bestChafa(dejavuGrid, atlas, src);

    // object mask from the reference at the grid footprint (Otsu threshold, documented).
    // The grid-footprint reference IS gridImg (same exact linear area-resample). The Otsu
    // split is derived from the per-CELL-mean histogram — the same statistic objectMask
    // thresholds (consistency fix; diagnostic only).
    const refFoot = gridImg;
    const glOtsu = otsuThreshold(cellMeanLuma01(refFoot, cellW, cellH));
    const { mask, objFrac } = objectMask(refFoot, cellW, cellH, glOtsu);

    ctxs.push({ name, src, gridImg, refFoot, builtinGrid, dejavuGrid, builtin, dejavu, mask, objFrac, otsu: glOtsu });
  }
  return ctxs;
}

function scoreOurs(ctx: ImgCtx, atlas: Atlas, opts: MatchOptions): number {
  const space = opts.space ?? 'linear';
  const grid = matchGrid(ctx.gridImg, atlas, opts);
  return scoreGrid(grid, atlas, ctx.src, space);
}

function fmt(x: number): string { return Number.isFinite(x) ? x.toFixed(4) : 'n/a'; }

// ---- single-run mode (flags): --space --gate-tau --quality --edge-lambda ----
async function singleRun(atlas: Atlas, symbols: string, opts: MatchOptions): Promise<void> {
  const { cellW, cellH } = atlas;
  const space = opts.space ?? 'linear';
  console.log(`config: Q${opts.quality} space=${space} gateTau=${opts.gateTau} edgeLambda=${opts.edgeLambda}`);
  console.log(`atlas: ${atlas.glyphs.length} glyphs, cell ${cellW}x${cellH}\n`);
  console.log('| image | ours | chafa builtin (best raster) | chafa DejaVu (best raster) |');
  console.log('|---|---|---|---|');
  const ctxs = await buildContexts(atlas, symbols);
  let sO = 0, sB = 0, sD = 0;
  for (const ctx of ctxs) {
    const o = scoreOurs(ctx, atlas, opts);
    sO += o; sB += ctx.builtin.score; sD += ctx.dejavu.score;
    console.log(`| ${ctx.name} | ${fmt(o)} | ${fmt(ctx.builtin.score)} (${ctx.builtin.mode}) | ${fmt(ctx.dejavu.score)} (${ctx.dejavu.mode}) |`);
  }
  const n = ctxs.length;
  const mO = sO / n, mB = sB / n, mD = sD / n;
  const chafaBest = Math.max(mB, mD);
  console.log(`| **mean** | **${fmt(mO)}** | **${fmt(mB)}** | **${fmt(mD)}** |`);
  const pass = mO > chafaBest;
  console.log(`\nchafa best mean SSIM ${fmt(chafaBest)} · ours ${fmt(mO)}`);
  console.log(`GATE: ${pass ? 'PASS' : 'FAIL'} (ours ${pass ? '>' : '<='} chafa best by ${(mO - chafaBest).toFixed(4)})`);
  process.exit(pass ? 0 : 1);
}

// ---- families fairness mode (--families): ours+families vs chafa granted braille/sextant ----
// Our matcher keeps the BASE atlas for the text scan (families are the region solver, not
// extra text glyphs) + opts.families; the AUGMENTED atlas is used only to re-rasterize both
// engines' grids so every sub-cell glyph (incl. chafa's braille/sextant picks) is scored on
// identical synth masks. chafa's symbol repertoire is the union of our atlas cps + the family
// codepoints, so chafa may pick the very braille/sextant classes families gave us. Fair both ways.
async function familiesRun(baseAtlas: Atlas, augAtlas: Atlas, symbols: string, opts: MatchOptions): Promise<void> {
  const space = opts.space ?? 'gamma';
  console.log(`FAMILIES fairness run: Q${opts.quality} space=${space} gateTau=${opts.gateTau} families=[${(opts.families ?? []).join(',')}]`);
  console.log(`atlas ${baseAtlas.glyphs.length} → augmented ${augAtlas.glyphs.length} glyphs; chafa symbols include braille+sextant\n`);
  console.log('| image | ours+families | chafa builtin (best raster) | chafa DejaVu (best raster) |');
  console.log('|---|---|---|---|');
  const ctxs = await buildContexts(augAtlas, symbols); // chafa scored via augmented raster
  let sO = 0, sB = 0, sD = 0;
  for (const ctx of ctxs) {
    const grid = matchGrid(ctx.gridImg, baseAtlas, opts);   // text scan on base atlas + families solve
    const baked = rasterizeGrid(grid, augAtlas, space);     // families glyphs rendered from synth masks
    const ref = resampleArea(ctx.src, baked.w, baked.h);
    const o = ssim(baked, ref);
    sO += o; sB += ctx.builtin.score; sD += ctx.dejavu.score;
    console.log(`| ${ctx.name} | ${fmt(o)} | ${fmt(ctx.builtin.score)} (${ctx.builtin.mode}) | ${fmt(ctx.dejavu.score)} (${ctx.dejavu.mode}) |`);
  }
  const n = ctxs.length, mO = sO / n, mB = sB / n, mD = sD / n, chafaBest = Math.max(mB, mD);
  console.log(`| **mean** | **${fmt(mO)}** | **${fmt(mB)}** | **${fmt(mD)}** |`);
  const pass = mO > chafaBest;
  console.log(`\nchafa best (granted braille+sextant) mean SSIM ${fmt(chafaBest)} · ours+families ${fmt(mO)}`);
  console.log(`GATE (families, fair both ways): ${pass ? 'PASS' : 'FAIL'} (ours ${pass ? '>' : '<='} chafa best by ${(mO - chafaBest >= 0 ? '+' : '')}${(mO - chafaBest).toFixed(4)})`);
  process.exit(pass ? 0 : 1);
}

// ---- matrix mode: the full Step-3 experiment matrix + Step-2 masked breakdown ----
interface RunSpec { id: string; note: string; quality: 0 | 1 | 2 | 3 | 4; space: Space; gateTau: number; edgeLambda: number; }

async function matrix(atlas: Atlas, symbols: string): Promise<void> {
  const runs: RunSpec[] = [
    { id: 'A', note: 'baseline re-run', quality: 3, space: 'linear', gateTau: 2e-4, edgeLambda: 0.35 },
    { id: 'B', note: '', quality: 3, space: 'gamma', gateTau: 2e-4, edgeLambda: 0.35 },
    { id: 'C', note: '', quality: 3, space: 'gamma', gateTau: 0, edgeLambda: 0.35 },
    { id: 'D', note: '', quality: 3, space: 'linear', gateTau: 0, edgeLambda: 0.35 },
    { id: 'E1', note: '', quality: 4, space: 'gamma', gateTau: 2e-4, edgeLambda: 0.2 },
    { id: 'E2', note: '', quality: 4, space: 'gamma', gateTau: 2e-4, edgeLambda: 0.35 },
    { id: 'E3', note: '', quality: 4, space: 'gamma', gateTau: 2e-4, edgeLambda: 0.7 },
  ];

  const ctxs = await buildContexts(atlas, symbols);
  const n = ctxs.length;

  // chafa reference (constant across runs): per-image best variant × best raster.
  const chafaPer = ctxs.map((c) => Math.max(c.builtin.score, c.dejavu.score));
  const chafaMean = chafaPer.reduce((a, b) => a + b, 0) / n;

  const L: string[] = [];
  L.push('# Gate matrix — working-space experiment (H2 predict-terminal) + gate sweep');
  L.push('');
  L.push(`chafa 1.18.2 · DejaVu Sans Mono @ ${FONT_SIZE}px · ${CHARSET} charset · ${COLS} cols · atlas ${atlas.glyphs.length} glyphs · cell ${atlas.cellW}x${atlas.cellH} · grid ${COLS}x${ctxs[0]!.builtinGrid.rows}`);
  L.push('');
  L.push('chafa runs are UNCHANGED; its grid is baked BOTH ways and the better SSIM kept (generous to chafa). Per-image chafa reference = max(builtin, DejaVu) × best raster:');
  L.push('');
  L.push(`| chafa reference | ${IMAGES.join(' | ')} | mean |`);
  L.push(`|---|${IMAGES.map(() => '---').join('|')}|---|`);
  L.push(`| builtin (best raster) | ${ctxs.map((c) => `${fmt(c.builtin.score)} (${c.builtin.mode})`).join(' | ')} | ${fmt(ctxs.reduce((a, c) => a + c.builtin.score, 0) / n)} |`);
  L.push(`| DejaVu (best raster) | ${ctxs.map((c) => `${fmt(c.dejavu.score)} (${c.dejavu.mode})`).join(' | ')} | ${fmt(ctxs.reduce((a, c) => a + c.dejavu.score, 0) / n)} |`);
  L.push(`| **max (gate target)** | ${chafaPer.map((v) => fmt(v)).join(' | ')} | **${fmt(chafaMean)}** |`);
  L.push('');

  // Experiment matrix.
  L.push('## Experiment matrix (ours)');
  L.push('');
  L.push(`| run | quality | space | gateTau | edgeLambda | ${IMAGES.join(' | ')} | mean | Δ vs chafa | verdict |`);
  L.push(`|---|---|---|---|---|${IMAGES.map(() => '---').join('|')}|---|---|---|`);
  const perRun: Record<string, number[]> = {};
  for (const r of runs) {
    const opts = baseOpts();
    opts.quality = r.quality; opts.space = r.space; opts.gateTau = r.gateTau; opts.edgeLambda = r.edgeLambda;
    const scores = ctxs.map((c) => scoreOurs(c, atlas, opts));
    perRun[r.id] = scores;
    const mean = scores.reduce((a, b) => a + b, 0) / n;
    const delta = mean - chafaMean;
    const verdict = mean > chafaMean ? 'PASS' : 'FAIL';
    const el = r.quality === 4 ? r.edgeLambda.toString() : '—';
    L.push(`| ${r.id}${r.note ? ` (${r.note})` : ''} | Q${r.quality} | ${r.space} | ${r.gateTau} | ${el} | ${scores.map((s) => fmt(s)).join(' | ')} | **${fmt(mean)}** | ${delta >= 0 ? '+' : ''}${delta.toFixed(4)} | ${verdict} |`);
  }
  L.push('');

  // Masked localization (Step 2): ours A (Q3 linear), ours B (Q3 gamma), chafa builtin.
  L.push('## Masked SSIM localization (object vs background)');
  L.push('');
  L.push('Object mask = reference gamma-luma per-cell mean > Otsu threshold (per image), dilated one cell so silhouette cells count as object. The spec\'s literal τ≈0.06 is degenerate here (marks 100% of these bright-gradient backgrounds as object), so a data-driven Otsu split is used and reported:');
  L.push('');
  L.push(`| image | Otsu τ (gamma) | object-cell fraction |`);
  L.push(`|---|---|---|`);
  for (const c of ctxs) L.push(`| ${c.name} | ${c.otsu.toFixed(3)} | ${(c.objFrac * 100).toFixed(1)}% |`);
  L.push('');

  const linOpts = baseOpts(); linOpts.space = 'linear';
  const gamOpts = baseOpts(); gamOpts.space = 'gamma';
  const rows: Array<{ label: string; get: (c: ImgCtx) => { obj: number; bg: number; all: number } }> = [
    {
      label: 'ours Q3 linear (A)',
      get: (c) => maskedSsim(rasterizeGrid(matchGrid(c.gridImg, atlas, linOpts), atlas, 'linear'), c.refFoot, c.mask),
    },
    {
      label: 'ours Q3 gamma (B)',
      get: (c) => maskedSsim(rasterizeGrid(matchGrid(c.gridImg, atlas, gamOpts), atlas, 'gamma'), c.refFoot, c.mask),
    },
    {
      label: 'chafa builtin',
      get: (c) => maskedSsim(rasterizeGrid(c.builtinGrid, atlas, c.builtin.mode), c.refFoot, c.mask),
    },
  ];
  L.push(`| target | region | ${IMAGES.join(' | ')} | mean |`);
  L.push(`|---|---|${IMAGES.map(() => '---').join('|')}|---|`);
  for (const row of rows) {
    const res = ctxs.map((c) => row.get(c));
    const meanOf = (k: 'obj' | 'bg' | 'all') => res.reduce((a, r) => a + r[k], 0) / n;
    L.push(`| ${row.label} | object | ${res.map((r) => fmt(r.obj)).join(' | ')} | ${fmt(meanOf('obj'))} |`);
    L.push(`| ${row.label} | background | ${res.map((r) => fmt(r.bg)).join(' | ')} | ${fmt(meanOf('bg'))} |`);
  }
  L.push('');

  const md = L.join('\n');
  await mkdir(join(ROOT, 'bench', 'out'), { recursive: true });
  await writeFile(join(ROOT, 'bench', 'out', 'gate-matrix.md'), md + '\n');
  console.log(md);
  console.log(`\nwrote bench/out/gate-matrix.md`);
}

async function main(): Promise<void> {
  if (!existsSync(CHAFA)) {
    console.error(`chafa binary missing at ${CHAFA}; download the static build first.`);
    process.exit(2);
  }
  const { values } = parseArgs({
    options: {
      matrix: { type: 'boolean', default: false },
      space: { type: 'string', default: 'gamma' },
      'gate-tau': { type: 'string' },
      quality: { type: 'string', default: '3' },
      'edge-lambda': { type: 'string' },
      images: { type: 'string' },
      charset: { type: 'string', default: 'blocks' },
      families: { type: 'boolean', default: false },
      collapse: { type: 'string' },
    },
  });
  if (values.images) IMAGES = values.images.split(',').map((s) => s.trim()).filter(Boolean);
  if (!(values.charset! in CHARSETS)) {
    console.error(`--charset must be one of ${Object.keys(CHARSETS).join('|')}; got '${values.charset}'`);
    process.exit(2);
  }
  CHARSET = values.charset as keyof typeof CHARSETS;

  const version = execFileSync(CHAFA, ['--version']).toString('utf8').split('\n')[0];
  console.log(`chafa: ${version}`);
  const atlas = await buildAtlas(FONT, FONT_SIZE, CHARSET);
  const symbols = toSymbolArg(atlas.glyphs.map((g) => g.cp));

  if (values.matrix) {
    await matrix(atlas, symbols);
    return;
  }

  if (values.families) {
    const fams = buildFamilies(M3_FAMS, atlas.cellW, atlas.cellH);
    const aug = augmentAtlas(atlas, fams);
    const famCps = new Set<number>(atlas.glyphs.map((g) => g.cp));
    for (const f of fams) for (const ch of f.ch) famCps.add(ch.codePointAt(0)!);
    const famSymbols = toSymbolArg([...famCps]);
    const opts = baseOpts();
    opts.quality = parseInt(values.quality!, 10) as 0 | 1 | 2 | 3 | 4;
    opts.space = values.space === 'linear' ? 'linear' : 'gamma';
    opts.gateTau = values['gate-tau'] !== undefined ? parseFloat(values['gate-tau']) : 2e-5; // §1 chosen default
    opts.families = M3_FAMS;
    await familiesRun(atlas, aug, famSymbols, opts);
    return;
  }

  const opts = baseOpts();
  opts.quality = parseInt(values.quality!, 10) as 0 | 1 | 2 | 3 | 4;
  opts.space = values.space === 'gamma' ? 'gamma' : 'linear';
  if (values['gate-tau'] !== undefined) opts.gateTau = parseFloat(values['gate-tau']);
  if (values['edge-lambda'] !== undefined) opts.edgeLambda = parseFloat(values['edge-lambda']);
  if (values.collapse !== undefined) opts.collapseThreshold = parseFloat(values.collapse); // post-selection invisibility collapse (0 = off = default)
  await singleRun(atlas, symbols, opts);
}

main().catch((e) => { console.error(e); process.exit(2); });
