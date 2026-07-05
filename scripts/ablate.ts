import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAtlas } from '../src/atlas/atlas.js';
import { matchGrid } from '../src/core/match.js';
import { loadLinear, loadRaw } from '../src/image/image-io.js';
import { rasterizeGrid } from '../src/render/raster.js';
import { savePng } from '../src/render/raster-io.js';
import { ssim } from '../src/metric/ssim.js';
import { luma, linearToSrgb } from '../src/core/color.js';
import { maskedSsim } from '../bench/masked-ssim.js';
import type { Atlas, Grid, LinearImage, MatchOptions } from '../src/core/types.js';

// M1-SPEC §4: the ablation harness. Per zoo model, 4 runs (base / +split / +antibleed /
// +both) at a κ chosen from a FIXED sweep {0.02,0.05,0.1}. Reports overall,
// object-cell and boundary-cell SSIM vs the shaded reference; writes bench/out/ablate.md
// + side-by-side PNGs; evaluates the four M1 verify criteria. No result-based tuning.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
const AOV = join(ROOT, 'bench', 'aov');
const OUT = join(ROOT, 'bench', 'out');
const MODELS = ['DamagedHelmet', 'FlightHelmet', 'BoomBox', 'SciFiHelmet', 'Fox', 'Sponza'];
const TEXTURED = ['DamagedHelmet', 'BoomBox', 'FlightHelmet']; // §4.1 hypothesis targets
const KAPPAS = [0.02, 0.05, 0.1];
const ETA = 0.5;
const GUARD = 0.002; // regression guard: feature-on overall SSIM ≥ base − 0.002
const SPACE: 'gamma' = 'gamma';

// --quality N (default 3): fit/color mode for the whole ablation. Q3=fg-bg (M1 default),
// Q2=fg-only (fixed bg) — the constrained regime where selection priors have room to
// improve even photometric metrics. Behavior is bit-identical to before when omitted.
function parseQuality(): 0 | 1 | 2 | 3 | 4 {
  const i = process.argv.indexOf('--quality');
  if (i < 0) return 3;
  const q = Number(process.argv[i + 1]);
  if (![0, 1, 2, 3, 4].includes(q)) throw new Error(`--quality must be 0..4, got ${process.argv[i + 1]}`);
  return q as 0 | 1 | 2 | 3 | 4;
}
const QUALITY = parseQuality();
const MODE = QUALITY === 1 ? 'mono' : QUALITY === 2 ? 'fg' : 'fg-bg';
function parseKappa(): number | null {
  const i = process.argv.indexOf('--kappa');
  if (i < 0) return null;
  const k = Number(process.argv[i + 1]);
  if (!Number.isFinite(k) || k < 0) throw new Error(`--kappa must be ≥ 0, got ${process.argv[i + 1]}`);
  return k;
}
const PINNED_K = parseKappa();
const QTAG = `${QUALITY === 3 ? '' : `-q${QUALITY}`}${PINNED_K != null ? `-k${PINNED_K}` : ''}`; // non-default quality/κ → suffixed outputs (preserve Q3 ablate.md)

interface Meta { model: string; cols: number; rows: number; cellW: number; cellH: number; gridW: number; gridH: number }

interface Bundle {
  name: string;
  meta: Meta;
  ref: LinearImage;            // shaded, linear (fit target + SSIM reference)
  shadingLuma: Float32Array;   // working-space luma of the albedo-free shading render (§4.1)
  objectId: Uint16Array;       // per-mesh id, 0 = background (§4.2)
  objMask: Uint8Array;         // pixel mask: per-cell mean coverage > 0.3
  boundaryMask: Uint8Array;    // pixel mask: §4.2 boundary cells
  boundaryCells: number;       // number of boundary cells (0 ⇒ anti-bleed cannot act)
}

function opts(over: Partial<MatchOptions>): MatchOptions {
  return {
    quality: QUALITY, space: SPACE, edgeLambda: 0.35, gateTau: 2e-4, mdlLambda: 0.02,
    fixedBg: [0, 0, 0], fixedFg: [1, 1, 1], ...over,
  };
}

// Per-cell contrast-gate flag in the working space, mirroring src/core/match.ts's gate:
// a cell is gated when Σ_c(STT_c − ST_c²/P)/(3P) < gateTau. Gated cells fall back to a flat
// fill BEFORE the glyph scan, so a §4.2 selection prior (which acts inside the scan) can
// never touch them — they must be excluded from the boundary-cell metric mask.
const GATE_TAU = 2e-4; // = opts().gateTau
function gateFiredMask(ref: LinearImage, cellW: number, cellH: number): Uint8Array {
  const { w, h, data } = ref;
  const work = new Float32Array(data.length); // SPACE='gamma': encode linear → sRGB [0,1] as match.ts does
  for (let i = 0; i < work.length; i++) work[i] = linearToSrgb(data[i]!) / 255;
  const cols = Math.floor(w / cellW), rows = Math.floor(h / cellH);
  const P = cellW * cellH;
  const flag = new Uint8Array(cols * rows);
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
      const eac = (q0 - (s0 * s0) / P) + (q1 - (s1 * s1) / P) + (q2 - (s2 * s2) / P);
      flag[r * cols + c] = eac / (3 * P) < GATE_TAU ? 1 : 0;
    }
  }
  return flag;
}

// §4.2 boundary detection (mirrors src/core/match.ts): majority id A, second id B over
// covered pixels (id≠0); a cell is boundary if B-fraction ≥ 15%. Gate-fired cells are
// excluded (gate runs BEFORE the scan in match.ts), so the metric only counts cells the
// prior can act on. Returns a pixel mask.
function boundaryMaskOf(objectId: Uint16Array, w: number, h: number, cellW: number, cellH: number, gateFired: Uint8Array): { mask: Uint8Array; cells: number } {
  const cols = Math.floor(w / cellW), rows = Math.floor(h / cellH);
  const cellFlag = new Uint8Array(cols * rows);
  let cells = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (gateFired[r * cols + c]) continue; // gate-then-boundary order (match.ts)
      const counts = new Map<number, number>();
      let covered = 0;
      for (let ly = 0; ly < cellH; ly++) {
        const gy = r * cellH + ly;
        for (let lx = 0; lx < cellW; lx++) {
          const id = objectId[gy * w + (c * cellW + lx)]!;
          if (id === 0) continue;
          covered++;
          counts.set(id, (counts.get(id) ?? 0) + 1);
        }
      }
      let best = 0, second = 0;
      for (const cnt of counts.values()) {
        if (cnt > best) { second = best; best = cnt; }
        else if (cnt > second) second = cnt;
      }
      if (covered > 0 && second / covered >= 0.15) { cellFlag[r * cols + c] = 1; cells++; }
    }
  }
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const cr = Math.floor(y / cellH);
    for (let x = 0; x < w; x++) {
      const cc = Math.floor(x / cellW);
      if (cellFlag[cr * cols + cc]) mask[y * w + x] = 1;
    }
  }
  return { mask, cells };
}

// object-cell mask: per-cell mean coverage > 0.3, expanded to pixels.
function objMaskOf(coverage: Uint8Array, w: number, h: number, cellW: number, cellH: number): Uint8Array {
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
    for (let x = 0; x < w; x++) {
      const cc = Math.floor(x / cellW);
      if (cellFlag[cr * cols + cc]) mask[y * w + x] = 1;
    }
  }
  return mask;
}

async function loadBundle(name: string): Promise<Bundle> {
  const dir = join(AOV, name);
  const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as Meta;
  const ref = await loadLinear(join(dir, 'shaded.png'));
  const sh = await loadLinear(join(dir, 'shading.png'));
  const shadingLuma = new Float32Array(sh.w * sh.h);
  for (let i = 0; i < shadingLuma.length; i++) {
    const y = luma(sh.data[i * 3]!, sh.data[i * 3 + 1]!, sh.data[i * 3 + 2]!);
    shadingLuma[i] = linearToSrgb(y) / 255; // gamma working space
  }
  const objectId = Uint16Array.from((await loadRaw(join(dir, 'objectid.png'))).data);
  const coverage = (await loadRaw(join(dir, 'coverage.png'))).data;
  const { w, h } = ref;
  const objMask = objMaskOf(coverage, w, h, meta.cellW, meta.cellH);
  const gateFired = gateFiredMask(ref, meta.cellW, meta.cellH);
  const bm = boundaryMaskOf(objectId, w, h, meta.cellW, meta.cellH, gateFired);
  return { name, meta, ref, shadingLuma, objectId, objMask, boundaryMask: bm.mask, boundaryCells: bm.cells };
}

interface Metrics { overall: number; obj: number; boundary: number }

function runConfig(b: Bundle, atlas: Atlas, o: MatchOptions): { grid: Grid; out: LinearImage; m: Metrics } {
  const grid = matchGrid(b.ref, atlas, o);
  const out = rasterizeGrid(grid, atlas, SPACE);
  const overall = ssim(out, b.ref);
  const obj = maskedSsim(out, b.ref, b.objMask).obj;
  const boundary = b.boundaryCells > 0 ? maskedSsim(out, b.ref, b.boundaryMask).obj : NaN;
  return { grid, out, m: { overall, obj, boundary } };
}

function composeH(panels: LinearImage[], gap = 6): LinearImage {
  const h = Math.max(...panels.map((p) => p.h));
  const w = panels.reduce((s, p) => s + p.w, 0) + gap * (panels.length - 1);
  const data = new Float32Array(w * h * 3);
  let x0 = 0;
  for (const p of panels) {
    for (let y = 0; y < p.h; y++) {
      for (let x = 0; x < p.w; x++) {
        const si = (y * p.w + x) * 3, di = (y * w + (x0 + x)) * 3;
        data[di] = p.data[si]!; data[di + 1] = p.data[si + 1]!; data[di + 2] = p.data[si + 2]!;
      }
    }
    x0 += p.w + gap;
  }
  return { w, h, data };
}

const f = (v: number) => (Number.isNaN(v) ? '  n/a ' : v.toFixed(4));
const d = (v: number) => (Number.isNaN(v) ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(4));

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const models = MODELS.filter((m) => existsSync(join(AOV, m, 'meta.json')));
  console.log(`ablate: ${models.length} baked model(s): ${models.join(', ')}`);
  const atlas = await buildAtlas(FONT, 16, 'blocks');

  const bundles: Bundle[] = [];
  for (const m of models) bundles.push(await loadBundle(m));

  // base + κ-sweep antibleed runs -------------------------------------------------
  const base = new Map<string, Metrics>();
  const sweep = new Map<string, Map<number, Metrics>>(); // model → κ → metrics
  for (const b of bundles) {
    base.set(b.name, runConfig(b, atlas, opts({})).m);
    const perK = new Map<number, Metrics>();
    for (const k of KAPPAS) {
      perK.set(k, runConfig(b, atlas, opts({ antibleedKappa: k, aov: { objectId: b.objectId } })).m);
    }
    sweep.set(b.name, perK);
    console.log(`  swept ${b.name} (boundary cells=${b.boundaryCells})`);
  }

  // κ choice: mean boundary-cell improvement over models WITH boundary cells, subject
  // to the regression guard (overall SSIM ≥ base−GUARD on EVERY model).
  const withBoundary = bundles.filter((b) => b.boundaryCells > 0).map((b) => b.name);
  const meanBoundaryDelta = new Map<number, number>();
  const guardOk = new Map<number, boolean>();
  for (const k of KAPPAS) {
    let sum = 0, n = 0, ok = true;
    for (const b of bundles) {
      const s = sweep.get(b.name)!.get(k)!;
      if (s.overall < base.get(b.name)!.overall - GUARD) ok = false;
      if (b.boundaryCells > 0) { sum += s.boundary - base.get(b.name)!.boundary; n++; }
    }
    meanBoundaryDelta.set(k, n ? sum / n : NaN);
    guardOk.set(k, ok);
  }
  const candidates = KAPPAS.filter((k) => guardOk.get(k));
  const pool = candidates.length ? candidates : KAPPAS;
  const autoK = pool.reduce((bestK, k) =>
    (meanBoundaryDelta.get(k)! > meanBoundaryDelta.get(bestK)! ? k : bestK), pool[0]!);
  // --kappa V (default off): pin the 4-run κ instead of auto-choosing, so the ablation
  // can be reported at a task-specified κ. When omitted, auto-choice is byte-identical.
  const chosenK = PINNED_K ?? autoK;
  const choiceNote = PINNED_K != null
    ? `κ PINNED via --kappa to ${chosenK} (auto-choice would have picked κ=${autoK}; guard passes: ${guardOk.get(chosenK) ?? 'κ not in sweep'})`
    : candidates.length
    ? `guard-passing κ = {${candidates.join(', ')}}; chose κ=${chosenK} (max mean boundary-cell Δ = ${d(meanBoundaryDelta.get(chosenK)!)} over ${withBoundary.length} multi-mesh model(s): ${withBoundary.join(', ')})`
    : `NO κ passed the regression guard on all models; fell back to max mean boundary-cell Δ → κ=${chosenK}`;
  console.log(`  κ choice: ${choiceNote}`);

  // 4-run ablation at chosen κ -----------------------------------------------------
  const runs = ['base', '+split', '+antibleed', '+both'] as const;
  const results = new Map<string, Record<(typeof runs)[number], { out: LinearImage; m: Metrics }>>();
  for (const b of bundles) {
    const rBase = runConfig(b, atlas, opts({}));
    const rSplit = runConfig(b, atlas, opts({ splitSelection: ETA, aov: { shadingLuma: b.shadingLuma } }));
    const rAnti = runConfig(b, atlas, opts({ antibleedKappa: chosenK, aov: { objectId: b.objectId } }));
    const rBoth = runConfig(b, atlas, opts({ splitSelection: ETA, antibleedKappa: chosenK, aov: { shadingLuma: b.shadingLuma, objectId: b.objectId } }));
    results.set(b.name, {
      base: { out: rBase.out, m: rBase.m }, '+split': { out: rSplit.out, m: rSplit.m },
      '+antibleed': { out: rAnti.out, m: rAnti.m }, '+both': { out: rBoth.out, m: rBoth.m },
    });
    // side-by-side: reference | base | +split | +antibleed | +both
    const strip = composeH([b.ref, rBase.out, rSplit.out, rAnti.out, rBoth.out]);
    await savePng(strip, join(OUT, `ablate${QTAG}-${b.name}.png`));
    console.log(`  ablated ${b.name} -> ablate${QTAG}-${b.name}.png`);
  }

  // markdown --------------------------------------------------------------------
  const L: string[] = [];
  L.push('# M1 AOV ablation (M1-SPEC §4)');
  L.push('');
  L.push(`- atlas: DejaVu Sans Mono @16, blocks charset, ${atlas.glyphs.length} glyphs, cell ${atlas.cellW}x${atlas.cellH}`);
  L.push(`- working space: ${SPACE}; quality: Q${QUALITY} (${MODE}); split η=${ETA}; κ sweep {${KAPPAS.join(', ')}}`);
  L.push(`- reference: each model's shaded AOV (already at grid footprint ${bundles[0]!.meta.gridW}×${bundles[0]!.meta.gridH}); overall = golden SSIM, object-cell = coverage>0.3 masked SSIM, boundary-cell = §4.2 masked SSIM`);
  L.push('');
  L.push('## Per-model geometry');
  L.push('');
  L.push('| model | grid (cols×rows) | distinct mesh ids | boundary cells | object cells (cov>0.3) |');
  L.push('|---|---|---|---|---|');
  for (const b of bundles) {
    const ids = new Set<number>(); for (const v of b.objectId) if (v > 0) ids.add(v);
    const objCells = countCells(b.objMask, b.meta);
    L.push(`| ${b.name} | ${b.meta.cols}×${b.meta.rows} | ${ids.size} | ${b.boundaryCells} | ${objCells} |`);
  }
  L.push('');

  // κ sweep table
  L.push('## κ sweep — boundary-cell SSIM (anti-bleed only, vs base)');
  L.push('');
  L.push('| model | base | κ=0.02 | κ=0.05 | κ=0.1 | best Δ |');
  L.push('|---|---|---|---|---|---|');
  for (const b of bundles) {
    const bb = base.get(b.name)!.boundary;
    const cols2 = KAPPAS.map((k) => f(sweep.get(b.name)!.get(k)!.boundary));
    const bestDelta = b.boundaryCells > 0
      ? d(Math.max(...KAPPAS.map((k) => sweep.get(b.name)!.get(k)!.boundary - bb)))
      : 'n/a';
    L.push(`| ${b.name} | ${f(bb)} | ${cols2.join(' | ')} | ${bestDelta} |`);
  }
  L.push(`| **mean Δ (boundary models)** | — | ${d(meanBoundaryDelta.get(0.02)!)} | ${d(meanBoundaryDelta.get(0.05)!)} | ${d(meanBoundaryDelta.get(0.1)!)} | |`);
  L.push(`| **guard passes all models** | — | ${guardOk.get(0.02)} | ${guardOk.get(0.05)} | ${guardOk.get(0.1)} | |`);
  L.push('');
  L.push(`**κ choice rule:** ${choiceNote}. Chosen **κ=${chosenK}**.`);
  L.push('');

  // three metric tables at chosen κ
  const metricTable = (title: string, pick: keyof Metrics) => {
    L.push(`## ${title} (at κ=${chosenK})`);
    L.push('');
    L.push('| model | base | +split | +antibleed | +both |');
    L.push('|---|---|---|---|---|');
    for (const b of bundles) {
      const r = results.get(b.name)!;
      L.push(`| ${b.name} | ${f(r.base.m[pick])} | ${f(r['+split'].m[pick])} | ${f(r['+antibleed'].m[pick])} | ${f(r['+both'].m[pick])} |`);
    }
    L.push('');
  };
  metricTable('Overall SSIM', 'overall');
  metricTable('Object-cell SSIM (coverage>0.3)', 'obj');
  metricTable('Boundary-cell SSIM (§4.2)', 'boundary');

  // ---- criteria ----
  L.push('## M1 verify criteria (§4)');
  L.push('');

  // 1. regression guard on every feature-on run
  let worst = Infinity, worstWhere = '';
  for (const b of bundles) {
    const r = results.get(b.name)!;
    for (const run of ['+split', '+antibleed', '+both'] as const) {
      const delta = r[run].m.overall - r.base.m.overall;
      if (delta < worst) { worst = delta; worstWhere = `${b.name}/${run}`; }
    }
  }
  const c1 = worst >= -GUARD;
  L.push(`**Criterion 1 — regression guard (overall SSIM ≥ base−0.002 on every feature-on run):** ${c1 ? 'PASS' : 'FAIL'}. Worst delta = ${d(worst)} at ${worstWhere} (threshold −${GUARD.toFixed(3)}).`);
  L.push('');

  // 2. §4.2 boundary-cell improves on ≥4/6 models at chosen κ
  let improved2 = 0; const detail2: string[] = [];
  for (const b of bundles) {
    const r = results.get(b.name)!;
    if (b.boundaryCells === 0) { detail2.push(`${b.name}: no boundary cells (single-mesh) → no effect`); continue; }
    const delta = r['+antibleed'].m.boundary - r.base.m.boundary;
    if (delta > 0) improved2++;
    detail2.push(`${b.name}: ${d(delta)}`);
  }
  const c2 = improved2 >= 4;
  L.push(`**Criterion 2 — §4.2 boundary-cell SSIM improves on ≥4/6 models at κ=${chosenK}:** ${c2 ? 'PASS' : 'FAIL'}. Improved on ${improved2}/6. ${detail2.join('; ')}.`);
  L.push('');

  // 3. §4.1 object-cell improves on ≥2/3 textured models without violating guard
  let improved3 = 0; const detail3: string[] = [];
  for (const name of TEXTURED) {
    const r = results.get(name); if (!r) { detail3.push(`${name}: not baked`); continue; }
    const dObj = r['+split'].m.obj - r.base.m.obj;
    const dOverall = r['+split'].m.overall - r.base.m.overall;
    const guarded = dOverall >= -GUARD;
    if (dObj > 0 && guarded) improved3++;
    detail3.push(`${name}: obj Δ=${d(dObj)} (overall Δ=${d(dOverall)}${guarded ? '' : ', GUARD VIOLATED'})`);
  }
  const c3 = improved3 >= 2;
  L.push(`**Criterion 3 — §4.1 object-cell SSIM improves on ≥2/3 textured models (guard-respecting):** ${c3 ? 'PASS' : 'FAIL'}. Improved on ${improved3}/3. ${detail3.join('; ')}.`);
  L.push('');

  // 4. zoo bake completes on ≥5/6 with re-rasterize SSIM
  const c4 = bundles.length >= 5;
  L.push(`**Criterion 4 — zoo bake completes on ≥5/6 with re-rasterize SSIM recorded:** ${c4 ? 'PASS' : 'FAIL'}. Baked ${bundles.length}/6; base overall SSIM: ${bundles.map((b) => `${b.name}=${base.get(b.name)!.overall.toFixed(4)}`).join(', ')}.`);
  L.push('');

  L.push('## Side-by-side renders');
  L.push('');
  L.push('Panel order per strip: **reference | base | +split | +antibleed | +both**.');
  L.push('');
  for (const b of bundles) L.push(`- ![${b.name}](ablate${QTAG}-${b.name}.png)`);
  L.push('');

  const md = L.join('\n');
  await writeFile(join(OUT, `ablate${QTAG}.md`), md);
  console.log('\n' + md);
  console.log(`\nwrote ${join(OUT, `ablate${QTAG}.md`)}`);
}

function countCells(mask: Uint8Array, meta: Meta): number {
  const { cellW, cellH, cols, rows, gridW } = meta;
  let n = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (mask[(r * cellH) * gridW + c * cellW]) n++;
  return n;
}

main().catch((e) => { console.error(e); process.exit(1); });
