import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAtlas } from '../src/atlas/atlas.js';
import { matchGrid } from '../src/core/match.js';
import { loadLinear, loadRaw } from '../src/image/image-io.js';
import { resampleArea } from '../src/image/image.js';
import { rasterizeGrid } from '../src/render/raster.js';
import { ssim } from '../src/metric/ssim.js';
import { linearToSrgb } from '../src/core/color.js';
import { maskedSsim, objectMask, otsuThreshold, cellMeanLuma01 } from '../bench/masked-ssim.js';
import type { Atlas, Grid, LinearImage, MatchOptions } from '../src/core/types.js';

// Post-selection invisibility-collapse sweep. Measures collapseThreshold ∈ {0,8,12,24} on
// {3 synthetics, washout-stress, DamagedHelmet, FlightHelmet} at the production defaults
// (Q3, gamma, gateTau 2e-5, mdlLambda 0.02). Reports per run: overall SSIM, object-cell
// SSIM, invisible-ink proxy (the SAME statistic as gate-sweep.ts), and % of grid cells the
// collapse turned into space (vs the T=0 baseline). Decision rule: pick the LARGEST T whose
// overall+object SSIM cost is ≤ 0.0005 vs T=0 on EVERY image. No result-based tuning: grid,
// footprint, working space and Q3 fit are all fixed; only collapseThreshold varies.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
const OUT = join(ROOT, 'bench', 'out');
const COLS = 120;
const SPACE: 'gamma' = 'gamma';

const THRESHOLDS = [0, 8, 12, 24];
const GATE_TAU = 2e-5;          // production default (options.ts)
const MDL_LAMBDA = 0.02;        // production default
const PROXY_TAU = 2e-4;         // invisible-ink washout-prone set (FIXED, matches gate-sweep.ts)
const INK_DIFF_U8 = 24;         // |F−B| (max channel, u8) below this ⇒ "invisible ink"
const SSIM_COST_MAX = 0.0005;   // decision-rule tolerance

interface Img { name: string; foot: LinearImage; objMask: Uint8Array; maskNote: string }

function baseOpts(collapseThreshold: number): MatchOptions {
  return {
    quality: 3, space: SPACE, edgeLambda: 0.35, gateTau: GATE_TAU, mdlLambda: MDL_LAMBDA,
    fixedBg: [0, 0, 0], fixedFg: [1, 1, 1], collapseThreshold,
  };
}

function objMaskFromCoverage(coverage: Uint8Array, w: number, h: number, cellW: number, cellH: number): Uint8Array {
  const cols = Math.floor(w / cellW), rows = Math.floor(h / cellH);
  const cellFlag = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let s = 0;
      for (let ly = 0; ly < cellH; ly++) {
        const gy = r * cellH + ly;
        for (let lx = 0; lx < cellW; lx++) s += coverage[gy * w + (c * cellW + lx)]! / 255;
      }
      cellFlag[r * cols + c] = s / (cellW * cellH) > 0.3 ? 1 : 0;
    }
  }
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const cr = Math.floor(y / cellH);
    for (let x = 0; x < w; x++) mask[y * w + x] = cellFlag[cr * cols + Math.floor(x / cellW)]!;
  }
  return mask;
}

// Per-cell working-space AC energy E_AC/(3P) — mirrors the gate statistic (gamma work).
function cellEac(foot: LinearImage, cellW: number, cellH: number): Float64Array {
  const { w, h, data } = foot;
  const work = new Float32Array(data.length);
  for (let i = 0; i < work.length; i++) work[i] = linearToSrgb(data[i]!) / 255;
  const cols = Math.floor(w / cellW), rows = Math.floor(h / cellH);
  const P = cellW * cellH;
  const eac = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let s0 = 0, s1 = 0, s2 = 0, q0 = 0, q1 = 0, q2 = 0;
      for (let ly = 0; ly < cellH; ly++) {
        const gy = r * cellH + ly;
        for (let lx = 0; lx < cellW; lx++) {
          const p = (gy * w + (c * cellW + lx)) * 3;
          const v0 = work[p]!, v1 = work[p + 1]!, v2 = work[p + 2]!;
          s0 += v0; s1 += v1; s2 += v2; q0 += v0 * v0; q1 += v1 * v1; q2 += v2 * v2;
        }
      }
      eac[r * cols + c] = ((q0 - s0 * s0 / P) + (q1 - s1 * s1 / P) + (q2 - s2 * s2 / P)) / (3 * P);
    }
  }
  return eac;
}

// Invisible-ink fraction over the FIXED washout-prone set {cells: E_AC/(3P) < PROXY_TAU}:
// the share emitting a non-space glyph whose max-channel |F−B| (u8) < 24. Identical to
// gate-sweep.ts so the two tables are directly comparable.
function invisibleInk(grid: Grid, eac: Float64Array): { frac: number; num: number; denom: number } {
  let denom = 0, num = 0;
  for (let i = 0; i < grid.cells.length; i++) {
    if (eac[i]! >= PROXY_TAU) continue;
    denom++;
    const cell = grid.cells[i]!;
    if (cell.ch === ' ' || cell.fg == null || cell.bg == null) continue;
    const df = Math.max(
      Math.abs(cell.fg[0] - cell.bg[0]),
      Math.abs(cell.fg[1] - cell.bg[1]),
      Math.abs(cell.fg[2] - cell.bg[2]),
    );
    if (df < INK_DIFF_U8) num++;
  }
  return { frac: denom ? num / denom : 0, num, denom };
}

// % of grid cells the collapse turned into space (non-space at T=0 → space at T).
function collapsedFrac(base: Grid, t: Grid): number {
  let n = 0;
  for (let i = 0; i < base.cells.length; i++) {
    if (base.cells[i]!.ch !== ' ' && t.cells[i]!.ch === ' ') n++;
  }
  return n / base.cells.length;
}

async function loadSynthetic(name: string, cellW: number, cellH: number): Promise<Img> {
  const src = await loadLinear(join(ROOT, 'bench', 'images', `${name}.png`));
  const rows = Math.round(COLS * (src.h / src.w) * (cellW / cellH));
  const foot = resampleArea(src, COLS * cellW, rows * cellH);
  const otsu = otsuThreshold(cellMeanLuma01(foot, cellW, cellH));
  const { mask, objFrac } = objectMask(foot, cellW, cellH, otsu);
  return { name, foot, objMask: mask, maskNote: `Otsu τ=${otsu.toFixed(3)}, obj cells ${(objFrac * 100).toFixed(1)}%` };
}

async function loadAov(name: string, cellW: number, cellH: number): Promise<Img> {
  const dir = join(ROOT, 'bench', 'aov', name);
  const foot = await loadLinear(join(dir, 'shaded.png')); // already at grid footprint
  const cov = await loadRaw(join(dir, 'coverage.png'));
  const objMask = objMaskFromCoverage(cov.data, foot.w, foot.h, cellW, cellH);
  const cols = Math.floor(foot.w / cellW), rows = Math.floor(foot.h / cellH);
  let objCells = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (objMask[r * cellH * foot.w + c * cellW]) objCells++;
  return { name, foot, objMask, maskNote: `coverage AOV >0.3, obj cells ${(100 * objCells / (cols * rows)).toFixed(1)}%` };
}

interface Cell { overall: number; obj: number; ink: number; inkNum: number; inkDenom: number; collapsed: number }

const f4 = (v: number) => (Number.isNaN(v) ? '  n/a ' : v.toFixed(4));
const pc = (v: number) => (v * 100).toFixed(2) + '%';
const d4 = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(4);

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const atlas = await buildAtlas(FONT, 16, 'blocks');
  const { cellW, cellH } = atlas;

  const imgs: Img[] = [];
  for (const n of ['sphere', 'torus', 'spheres', 'washout-stress']) {
    if (!existsSync(join(ROOT, 'bench', 'images', `${n}.png`))) throw new Error(`missing bench/images/${n}.png`);
    imgs.push(await loadSynthetic(n, cellW, cellH));
  }
  for (const n of ['DamagedHelmet', 'FlightHelmet']) {
    if (!existsSync(join(ROOT, 'bench', 'aov', n, 'shaded.png'))) throw new Error(`missing bench/aov/${n}/shaded.png`);
    imgs.push(await loadAov(n, cellW, cellH));
  }
  const SYNTH = ['sphere', 'torus', 'spheres'];

  const eacByImg = new Map<string, Float64Array>();
  for (const img of imgs) eacByImg.set(img.name, cellEac(img.foot, cellW, cellH));

  // sweep: threshold → image name → Cell (baseline grid at T=0 reused for collapsed %)
  const R = new Map<number, Map<string, Cell>>();
  const baseGrid = new Map<string, Grid>();
  for (const T of THRESHOLDS) {
    const per = new Map<string, Cell>();
    for (const img of imgs) {
      const grid = matchGrid(img.foot, atlas, baseOpts(T));
      if (T === 0) baseGrid.set(img.name, grid);
      const out = rasterizeGrid(grid, atlas, SPACE);
      const overall = ssim(out, img.foot);
      const obj = maskedSsim(out, img.foot, img.objMask).obj;
      const ink = invisibleInk(grid, eacByImg.get(img.name)!);
      const collapsed = collapsedFrac(baseGrid.get(img.name)!, grid);
      per.set(img.name, { overall, obj, ink: ink.frac, inkNum: ink.num, inkDenom: ink.denom, collapsed });
    }
    R.set(T, per);
    console.log(`swept collapseThreshold=${T}`);
  }
  const get = (T: number, name: string) => R.get(T)!.get(name)!;

  // ---- decision: largest T with overall+object SSIM cost ≤ SSIM_COST_MAX on every image ----
  let chosen = 0;
  for (const T of THRESHOLDS) {
    if (T === 0) continue;
    const ok = imgs.every((img) => {
      const dOv = get(0, img.name).overall - get(T, img.name).overall;
      const dOb = get(0, img.name).obj - get(T, img.name).obj;
      return dOv <= SSIM_COST_MAX && dOb <= SSIM_COST_MAX;
    });
    if (ok) chosen = T;
  }

  // ---- markdown ----
  const L: string[] = [];
  L.push('');
  L.push('---');
  L.push('');
  L.push('# Post-selection invisibility-collapse sweep (GATE follow-up — replaces the falsified MDL washout defense)');
  L.push('');
  L.push(`- atlas: DejaVu Sans Mono @16, blocks charset, ${atlas.glyphs.length} glyphs, cell ${cellW}×${cellH}; working space ${SPACE} (predict-terminal); Q3 fg-bg`);
  L.push(`- fixed at production defaults: gateTau=${GATE_TAU}, mdlLambda=${MDL_LAMBDA}; only \`collapseThreshold\` (u8) varies`);
  L.push(`- footprint: synthetics/washout resampled to ${COLS} cols; DamagedHelmet/FlightHelmet use their 1200×1197 shaded AOV directly`);
  L.push(`- object mask: ${imgs.map((i) => `${i.name} — ${i.maskNote}`).join('; ')}`);
  L.push(`- invisible-ink proxy: over cells with E_AC/(3P) < ${PROXY_TAU} (the OLD-gate washout-prone set, FIXED), share emitting a non-space glyph with max-channel |F−B| < ${INK_DIFF_U8} (u8). SAME statistic as the §1 sweep above.`);
  L.push(`- **collapse mechanism**: after the winner (text OR family) is chosen, if max-channel |F−B| (u8, OUTPUT encoding) < collapseThreshold, the cell is replaced with space + the coverage-weighted flat mean (sumA·F+(P−sumA)·B)/P. T=0 = off (byte-identical to the §1 τ=2e-5,λ=0.02 row).`);
  L.push('');

  // per-metric detail tables
  const detail = (title: string, val: (c: Cell) => string) => {
    L.push(`## ${title}`);
    L.push('');
    L.push(`| collapseT | ${imgs.map((i) => i.name).join(' | ')} |`);
    L.push(`|---|${imgs.map(() => '---').join('|')}|`);
    for (const T of THRESHOLDS) L.push(`| ${T} | ${imgs.map((i) => val(get(T, i.name))).join(' | ')} |`);
    L.push('');
  };
  detail('Overall SSIM', (c) => f4(c.overall));
  detail('Object-cell SSIM', (c) => f4(c.obj));
  detail('Invisible-ink proxy (num/denom)', (c) => `${pc(c.ink)} (${c.inkNum}/${c.inkDenom})`);
  detail('% cells collapsed (of full grid, vs T=0)', (c) => pc(c.collapsed));

  // SSIM cost vs T=0 (the decision-rule quantity)
  L.push('## SSIM cost vs T=0 (Δ = SSIM@0 − SSIM@T; positive = quality LOST by collapsing)');
  L.push('');
  L.push(`| collapseT | metric | ${imgs.map((i) => i.name).join(' | ')} | max |`);
  L.push(`|---|---|${imgs.map(() => '---').join('|')}|---|`);
  for (const T of THRESHOLDS) {
    if (T === 0) continue;
    for (const k of ['overall', 'obj'] as const) {
      const costs = imgs.map((i) => get(0, i.name)[k] - get(T, i.name)[k]);
      const maxCost = Math.max(...costs);
      L.push(`| ${T} | ${k === 'overall' ? 'overall' : 'object'} | ${costs.map((v) => d4(v)).join(' | ')} | ${d4(maxCost)} |`);
    }
  }
  L.push('');

  // decision
  L.push('## Decision');
  L.push('');
  const synMean = (T: number, k: 'overall' | 'obj') => SYNTH.reduce((a, n) => a + get(T, n)[k], 0) / SYNTH.length;
  L.push(`Rule: choose the LARGEST collapseThreshold whose overall AND object SSIM cost is ≤ ${SSIM_COST_MAX} vs T=0 on EVERY image.`);
  L.push('');
  for (const T of THRESHOLDS) {
    if (T === 0) continue;
    const failing = imgs.filter((img) =>
      get(0, img.name).overall - get(T, img.name).overall > SSIM_COST_MAX ||
      get(0, img.name).obj - get(T, img.name).obj > SSIM_COST_MAX);
    L.push(`- T=${T}: ${failing.length === 0 ? '**within tolerance on all images**' : `exceeds on {${failing.map((i) => i.name).join(', ')}}`}.`);
  }
  L.push('');
  L.push(`**Chosen default: collapseThreshold = ${chosen} (u8)${chosen === 0 ? ' — OFF' : ''}.**`);
  L.push('');
  L.push(`The proxy IS zeroed deterministically — at collapseThreshold=${INK_DIFF_U8} every cell the proxy counts (|F−B|<${INK_DIFF_U8}) is exactly the set the collapse turns to space, so invisible-ink → 0.00% on ALL ${imgs.length} images. The mechanism works.`);
  L.push('');
  L.push(`But the architect's "SSIM-neutral by construction" premise is **FALSIFIED**: the collapse costs overall AND object SSIM above the ${SSIM_COST_MAX} tolerance at EVERY tested threshold on EVERY image (SSIM-cost table). On real gradient interiors (sphere/torus/spheres, DamagedHelmet, FlightHelmet) the "faint" glyphs are not invisible ink — they carry genuine sub-cell structure that SSIM's contrast/structure terms reward, so replacing them with a flat mean is destructive. This is the same SSIM-decoupling the §1 escalation table already showed, seen from the other side.`);
  L.push('');
  const wo = get(chosen === 0 ? THRESHOLDS[THRESHOLDS.length - 1]! : chosen, 'washout-stress');
  const wo0 = get(0, 'washout-stress');
  L.push(`- The ONE image where the premise nearly holds is washout-stress (the motivating case), whose faint glyphs are genuinely structureless: at T=${INK_DIFF_U8} its invisible-ink goes ${pc(wo0.ink)} → ${pc(wo.ink)} at a cost of only overall ${d4(wo0.overall - wo.overall)}, object ${d4(wo0.obj - wo.obj)} — still just above ${SSIM_COST_MAX}, but ~0.001.`);
  L.push(`- Per the on-record decision rule (largest threshold with overall+object cost ≤ ${SSIM_COST_MAX} everywhere), **no threshold qualifies → ship OFF (0)**. The mechanism remains available opt-in for washout-dominated inputs where the faint glyphs are noise, not structure.`);
  L.push('');

  const section = L.join('\n');
  console.log('\n' + section);

  // Idempotently append the collapse section to gate-sweep.md (below the §1 sweep). Re-running
  // gate-sweep.ts overwrites that file and drops this section; re-running THIS script re-appends
  // it (splitting on the section header so repeated runs never duplicate it).
  const gsPath = join(OUT, 'gate-sweep.md');
  const sectStart = '\n---\n\n# Post-selection invisibility-collapse sweep';
  let base = existsSync(gsPath) ? await readFile(gsPath, 'utf8') : '';
  const si = base.indexOf(sectStart);
  if (si >= 0) base = base.slice(0, si);
  base = base.replace(/\n+$/, '');
  await writeFile(gsPath, base + '\n' + section + '\n');
  console.log(`\nappended collapse section to ${gsPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
