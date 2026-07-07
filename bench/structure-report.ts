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
import { defaultOptions } from '../src/core/options.js';
import { parseAnsiToGrid } from './ansi-parse.js';
import { cellCsMap, cellObjectMask, aggregateCas, type CasStats } from './cell-ac.js';
import type { Atlas, Grid, LinearImage } from '../src/core/types.js';

// Cell-AC structure report (ADR-0002 / DESIGN §10). Sibling to chafa-gate.ts — it does NOT
// import or alter the gate; the gate's SSIM output is unchanged. Emits the de-saturated
// headline metric: per-cell DC-removed AC structure (CAS) over an object mask, reported as a
// DISTRIBUTION (low percentiles + AC-energy-weighted mean), with mean SSIM kept only as a
// guardrail. Every contestant (Q1..Q4 + chafa) is re-rasterized through the SAME atlas in the
// SAME predict-terminal (gamma) space and scored against the SAME grid-footprint reference —
// the gate's harness-fairness protocol, so CAS cannot be gamed by fitting to the graded array.
//
// No-flag repro:  npx tsx bench/structure-report.ts
//   (defaults to the 6-image standard bench set: 3 synthetic renders + 3 Khronos screenshots)

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CHAFA = join(ROOT, 'tools', 'chafa', 'chafa');
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
const FONT_SIZE = 16;
const COLS = 120;
let IMAGES = ['sphere', 'torus', 'spheres', 'DamagedHelmet', 'FlightHelmet', 'BoomBox'];
let CHARSET: keyof typeof CHARSETS = 'blocks';

function toSymbolArg(cps: number[]): string {
  const sorted = [...cps].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    const lo = sorted[i]!.toString(16), hi = sorted[j]!.toString(16);
    parts.push(i === j ? lo : `${lo}..${hi}`);
    i = j + 1;
  }
  return parts.join('+');
}

// chafa invocation identical to the gate (fair geometry / repertoire); glyphFile optional.
function runChafa(image: string, symbols: string, cols: number, rows: number,
                  cellW: number, cellH: number): string {
  const args = ['-w', '9', '--fill', 'none', '--symbols', symbols, '--colors', 'full',
    '--size', `${cols}x${rows}`, '--font-ratio', `${cellW}/${cellH}`, '-f', 'symbols', image];
  return execFileSync(CHAFA, args, { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
}

interface Ctx { name: string; ref: LinearImage; mask: Uint8Array; objFrac: number; otsu: number; gridPng: string; rows: number; }

async function buildCtxs(atlas: Atlas): Promise<Ctx[]> {
  const { cellW, cellH } = atlas;
  const tmp = await mkdtemp(join(tmpdir(), 'structure-report-'));
  const out: Ctx[] = [];
  for (const name of IMAGES) {
    const src = await loadLinear(join(ROOT, 'bench', 'images', `${name}.png`));
    const rows = Math.round(COLS * (src.h / src.w) * (cellW / cellH));
    const ref = resampleArea(src, COLS * cellW, rows * cellH); // reference AT the grid footprint
    const gridPng = join(tmp, `${name}.png`);
    await savePng(ref, gridPng);                               // chafa fits the SAME pixels ours does
    const { mask, objFrac, otsu } = cellObjectMask(ref, cellW, cellH);
    out.push({ name, ref, mask, objFrac, otsu, gridPng, rows });
  }
  return out;
}

// CAS (object mask) + SSIM guardrail for one baked grid vs the footprint reference.
function score(grid: Grid, atlas: Atlas, ctx: Ctx): CasStats & { ssim: number } {
  const baked = rasterizeGrid(grid, atlas, 'gamma'); // predict-terminal composite for everyone
  const maps = cellCsMap(baked, ctx.ref, atlas.cellW, atlas.cellH);
  return { ...aggregateCas(maps, ctx.mask), ssim: ssim(baked, ctx.ref) };
}

function f4(x: number): string { return Number.isFinite(x) ? x.toFixed(4) : 'n/a'; }
type Scored = CasStats & { ssim: number };
type ScoreKey = keyof CasStats | 'ssim'; // every scored field is a number → direct indexing is type-safe
type Row = { label: string; per: Scored[] };
function mean(xs: number[]): number { return xs.reduce((a, b) => a + b, 0) / xs.length; }

async function main(): Promise<void> {
  if (!existsSync(CHAFA)) { console.error(`chafa binary missing at ${CHAFA}`); process.exit(2); }
  const { values } = parseArgs({ options: { images: { type: 'string' }, charset: { type: 'string', default: 'blocks' } } });
  if (values.images) IMAGES = values.images.split(',').map((s) => s.trim()).filter(Boolean);
  if (!(values.charset! in CHARSETS)) { console.error(`bad charset`); process.exit(2); }
  CHARSET = values.charset as keyof typeof CHARSETS;

  const version = execFileSync(CHAFA, ['--version']).toString('utf8').split('\n')[0];
  const atlas = await buildAtlas(FONT, FONT_SIZE, CHARSET);
  const symbols = toSymbolArg(atlas.glyphs.map((g) => g.cp));
  const ctxs = await buildCtxs(atlas);
  const n = ctxs.length;

  // contestants: ours Q1..Q4 (production defaults per quality) + chafa builtin.
  const qRows: Row[] = [1, 2, 3, 4].map((q) => ({
    label: `ours Q${q}`,
    per: ctxs.map((ctx) => score(matchGrid(ctx.ref, atlas, defaultOptions(q as 1 | 2 | 3 | 4)), atlas, ctx)),
  }));
  const chafaRow: Row = {
    label: 'chafa',
    per: ctxs.map((ctx) => score(
      parseAnsiToGrid(runChafa(ctx.gridPng, symbols, COLS, ctx.rows, atlas.cellW, atlas.cellH), atlas.cellW, atlas.cellH, atlas.fontPath),
      atlas, ctx)),
  };
  const rows = [...qRows, chafaRow];

  const L: string[] = [];
  L.push('# Cell-AC structure report — de-saturated reconstruction metric (ADR-0002, DESIGN §10)');
  L.push('');
  L.push(`${version} · DejaVu Sans Mono @ ${FONT_SIZE}px · ${CHARSET} · ${COLS} cols · atlas ${atlas.glyphs.length} glyphs · cell ${atlas.cellW}x${atlas.cellH}`);
  L.push('');
  L.push('CAS = per-cell DC-removed contrast·structure `cs=(2σxy+C2)/(σx²+σy²+C2)`, cell as window, gamma-luma, over the object mask. Headline = **p05/p10** (worst structural cells) + **wmean** (AC-energy-weighted). Mean SSIM is the GUARDRAIL only. All contestants re-rasterized in predict-terminal (gamma) space vs the identical grid-footprint reference.');
  L.push('');
  L.push('Object mask (2D fallback: per-cell luma Otsu + 1-cell dilation — no AOVs on these 2D inputs):');
  L.push('');
  L.push(`| image | grid | Otsu τ | object-cell frac | structured cells (σy²>C2) |`);
  L.push(`|---|---|---|---|---|`);
  for (let i = 0; i < n; i++) {
    const c = ctxs[i]!;
    L.push(`| ${c.name} | ${COLS}x${c.rows} | ${c.otsu.toFixed(3)} | ${(c.objFrac * 100).toFixed(1)}% | ${qRows[2]!.per[i]!.nStructured} |`);
  }
  L.push('');

  // headline distribution table (per image + mean), one block per statistic.
  const stats: { key: ScoreKey; title: string }[] = [
    { key: 'p05', title: 'CAS p05 (object) — worst structural cells' },
    { key: 'p10', title: 'CAS p10 (object)' },
    { key: 'p50', title: 'CAS p50 / median (object)' },
    { key: 'wmean', title: 'CAS wmean (object, AC-energy-weighted) — structure-dominant headline' },
    { key: 'ssim', title: 'mean SSIM (GUARDRAIL — full frame, saturated)' },
  ];
  for (const st of stats) {
    L.push(`## ${st.title}`);
    L.push('');
    L.push(`| contestant | ${IMAGES.join(' | ')} | mean |`);
    L.push(`|---|${IMAGES.map(() => '---').join('|')}|---|`);
    for (const row of rows) {
      const vals = row.per.map((p) => p[st.key]);
      L.push(`| ${row.label} | ${vals.map(f4).join(' | ')} | **${f4(mean(vals))}** |`);
    }
    L.push('');
  }

  // de-saturation proof: spread of each metric across the Q1..Q4 ladder (per image, then mean).
  L.push('## De-saturation: metric spread across the Q1..Q4 ladder');
  L.push('');
  L.push('For each image, `max−min` of the metric over {Q1,Q2,Q3,Q4}. A metric that SEPARATES the ladder has a large spread; a SATURATED one collapses to ~0. This is the core claim — SSIM compresses the ladder into its 3rd–4th decimal while CAS resolves it.');
  L.push('');
  L.push(`| metric | ${IMAGES.join(' | ')} | mean spread |`);
  L.push(`|---|${IMAGES.map(() => '---').join('|')}|---|`);
  for (const st of stats) {
    const spreads = ctxs.map((_, i) => {
      const ladder = qRows.map((r) => r.per[i]![st.key]);
      return Math.max(...ladder) - Math.min(...ladder);
    });
    L.push(`| ${String(st.key)} | ${spreads.map((s) => s.toFixed(4)).join(' | ')} | **${f4(mean(spreads))}** |`);
  }
  L.push('');
  // Q3 vs Q4 explicit (the user's example of SSIM indistinguishability).
  L.push('### Q3 vs Q4 delta (the pair SSIM could not tell apart)');
  L.push('');
  L.push(`| metric | ${IMAGES.join(' | ')} | mean |`);
  L.push(`|---|${IMAGES.map(() => '---').join('|')}|---|`);
  for (const st of stats) {
    const d = ctxs.map((_, i) => qRows[3]!.per[i]![st.key] - qRows[2]!.per[i]![st.key]);
    L.push(`| Δ ${String(st.key)} (Q4−Q3) | ${d.map((x) => (x >= 0 ? '+' : '') + x.toFixed(4)).join(' | ')} | ${(mean(d) >= 0 ? '+' : '') + mean(d).toFixed(4)} |`);
  }
  L.push('');

  // headline de-saturation: the object-structure margin CAS resolves vs the full-frame SSIM
  // margin it compresses. ours Q3 − chafa, per metric, with the amplification ratio.
  L.push('## Headline: ours-Q3 − chafa margin — CAS resolves what full-frame SSIM compresses');
  L.push('');
  L.push('The same reconstruction lead, measured by each metric. SSIM (full frame, DC-saturated) compresses it into the 3rd–4th decimal; CAS (object mask, DC-removed, structure-weighted) resolves the object-cell structure margin several× larger. This is the concrete de-saturation.');
  L.push('');
  L.push(`| metric | ${IMAGES.join(' | ')} | mean margin | × vs SSIM |`);
  L.push(`|---|${IMAGES.map(() => '---').join('|')}|---|---|`);
  const q3 = qRows[2]!;
  const ssimMargin = mean(ctxs.map((_, i) => q3.per[i]!.ssim - chafaRow.per[i]!.ssim));
  for (const st of stats) {
    const m = ctxs.map((_, i) => q3.per[i]![st.key] - chafaRow.per[i]![st.key]);
    const mm = mean(m);
    const ratio = st.key === 'ssim' ? '1.0×' : `${(mm / ssimMargin).toFixed(1)}×`;
    L.push(`| ${String(st.key)} | ${m.map((x) => (x >= 0 ? '+' : '') + x.toFixed(4)).join(' | ')} | ${(mm >= 0 ? '+' : '') + mm.toFixed(4)} | ${ratio} |`);
  }
  L.push('');

  // invisible-ink guard: CAS must NOT rank the ink-stripped variant above the ink-keeping one.
  L.push('## Invisible-ink guard (scientific-ledger constraint)');
  L.push('');
  L.push('Faint glyphs (|F−B|<24 u8) that encode REAL sub-cell gradients are reconstruction-positive; stripping them (collapseThreshold=24) reverts the chafa gate by −0.0064. A valid structure metric must AGREE that stripping is worse. Below: Q3 with ink kept (collapse=0) vs stripped (collapse=24) — CAS(keep) must be ≥ CAS(strip).');
  L.push('');
  L.push(`| metric | ${IMAGES.join(' | ')} | mean |`);
  L.push(`|---|${IMAGES.map(() => '---').join('|')}|---|`);
  const keep = ctxs.map((ctx) => score(matchGrid(ctx.ref, atlas, defaultOptions(3)), atlas, ctx));
  const stripOpts = defaultOptions(3); stripOpts.collapseThreshold = 24;
  const strip = ctxs.map((ctx) => score(matchGrid(ctx.ref, atlas, stripOpts), atlas, ctx));
  const guardKeys: (keyof CasStats)[] = ['p10', 'wmean'];
  for (const key of guardKeys) {
    const dk = ctxs.map((_, i) => keep[i]![key] - strip[i]![key]);
    L.push(`| Δ ${key} (keep − strip) | ${dk.map((x) => (x >= 0 ? '+' : '') + x.toFixed(4)).join(' | ')} | ${(mean(dk) >= 0 ? '+' : '') + mean(dk).toFixed(4)} |`);
  }
  const allGE = guardKeys.every((key) =>
    ctxs.every((_, i) => keep[i]![key] + 1e-9 >= strip[i]![key]));
  L.push('');
  L.push(`Invisible-ink guard: **${allGE ? 'PASS' : 'FAIL'}** (CAS ${allGE ? 'does not punish' : 'PUNISHES'} faint reconstruction-positive glyphs — keep ≥ strip on every image).`);
  L.push('');

  const md = L.join('\n');
  await mkdir(join(ROOT, 'bench', 'out'), { recursive: true });
  await writeFile(join(ROOT, 'bench', 'out', 'structure-report.md'), md + '\n');
  console.log(md);
  console.log(`\nwrote bench/out/structure-report.md`);
}

main().catch((e) => { console.error(e); process.exit(2); });
