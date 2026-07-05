import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAtlas } from '../src/atlas/atlas.js';
import { matchGrid, contourPostPass } from '../src/core/match.js';
import { loadLinear, loadRaw } from '../src/image/image-io.js';
import { rasterizeGrid } from '../src/render/raster.js';
import { savePng } from '../src/render/raster-io.js';
import { ssim } from '../src/metric/ssim.js';
import { edgeSSIM, type EdgeBand } from '../src/metric/edge-ssim.js';
import { luma, linearToSrgb } from '../src/core/color.js';
import { resampleArea } from '../src/image/image.js';
import { maskedSsim, objectMask, otsuThreshold, cellMeanLuma01 } from '../bench/masked-ssim.js';
import { buildFamilies, augmentAtlas, type FamilyName } from '../src/atlas/families.js';
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

// ============================================================================
// M3-SPEC §3 contour ablation (CONTOUR-INT wiring). Activated by --orient-kappa V
// and/or --contour; runs base / +orient / +contour / +all per model and reports
// overall SSIM (the §3 guard) alongside edgeSSIM (§3.5, the primary contour metric)
// on the boundary band. The full 3-value sweeps + verdicts are phase-3 ABLATION's
// job — this provides the wiring and a single-point measurement.
// ============================================================================
function parseOrientKappa(): number | null {
  const i = process.argv.indexOf('--orient-kappa');
  if (i < 0) return null;
  const k = Number(process.argv[i + 1]);
  if (!Number.isFinite(k) || k < 0) throw new Error(`--orient-kappa must be ≥ 0, got ${process.argv[i + 1]}`);
  return k;
}
function parseContourKappa(): number {
  const i = process.argv.indexOf('--contour-kappa');
  if (i < 0) return 0.15;
  const k = Number(process.argv[i + 1]);
  if (!Number.isFinite(k) || k < 0) throw new Error(`--contour-kappa must be ≥ 0, got ${process.argv[i + 1]}`);
  return k;
}

// per-pixel coverage [0,1] → per-cell mean (contour polylines) and boundary cells
// (coverage crosses 0.5 inside the cell → the edgeSSIM band).
function coverageGrids(covPix: Float32Array, w: number, h: number, cellW: number, cellH: number) {
  const cols = Math.floor(w / cellW), rows = Math.floor(h / cellH);
  const cellMean = new Float32Array(cols * rows);
  const boundary = new Uint8Array(cols * rows);
  let count = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    let s = 0, mn = Infinity, mx = -Infinity;
    for (let ly = 0; ly < cellH; ly++) { const gy = r * cellH + ly; for (let lx = 0; lx < cellW; lx++) { const v = covPix[gy * w + (c * cellW + lx)]!; s += v; if (v < mn) mn = v; if (v > mx) mx = v; } }
    cellMean[r * cols + c] = s / (cellW * cellH);
    if (mn < 0.5 && mx >= 0.5) { boundary[r * cols + c] = 1; count++; }
  }
  return { cellMean, boundary, cols, rows, count };
}

async function contourMain(orientKappa: number, doContour: boolean, contourKappa: number): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const models = MODELS.filter((m) => existsSync(join(AOV, m, 'meta.json')));
  const atlas = await buildAtlas(FONT, 16, 'blocks');
  console.log(`contour-ablate: orientKappa=${orientKappa} contour=${doContour} κ_c=${contourKappa} on ${models.join(', ')}`);

  const runCfg = (ref: LinearImage, cellMean: Float32Array, band: EdgeBand, count: number, o: MatchOptions, contour: boolean) => {
    const grid = matchGrid(ref, atlas, o);
    if (contour) contourPostPass(grid, atlas, cellMean, contourKappa);
    const out = rasterizeGrid(grid, atlas, SPACE);
    return { overall: ssim(out, ref), edge: count > 0 ? edgeSSIM(out, ref, band) : NaN };
  };

  const L: string[] = [];
  L.push('# M3 contour ablation (M3-SPEC §3, CONTOUR-INT wiring)');
  L.push('');
  L.push(`- atlas: DejaVu Sans Mono @16, blocks, cell ${atlas.cellW}x${atlas.cellH}; space ${SPACE}, Q${QUALITY}`);
  L.push(`- orientKappa=${orientKappa}, contour κ_c=${contourKappa}; edgeSSIM over the coverage-boundary band (§3.5)`);
  L.push('');
  L.push('| model | boundary cells | metric | base | +orient | +contour | +all |');
  L.push('|---|---|---|---|---|---|---|');
  for (const name of models) {
    const dir = join(AOV, name);
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as Meta;
    const ref = await loadLinear(join(dir, 'shaded.png'));
    const covRaw = (await loadRaw(join(dir, 'coverage.png'))).data;
    const covPix = new Float32Array(covRaw.length);
    for (let i = 0; i < covPix.length; i++) covPix[i] = covRaw[i]! / 255;
    const cg = coverageGrids(covPix, ref.w, ref.h, meta.cellW, meta.cellH);
    const band: EdgeBand = { boundaryCells: cg.boundary, cols: cg.cols, rows: cg.rows, cellW: meta.cellW, cellH: meta.cellH };
    const base = runCfg(ref, cg.cellMean, band, cg.count, opts({}), false);
    const orient = runCfg(ref, cg.cellMean, band, cg.count, opts({ orientKappa, aov: { coverage: covPix } }), false);
    const contour = runCfg(ref, cg.cellMean, band, cg.count, opts({ topK: 8 }), true);
    const all = runCfg(ref, cg.cellMean, band, cg.count, opts({ orientKappa, topK: 8, aov: { coverage: covPix } }), true);
    L.push(`| ${name} | ${cg.count} | overall | ${f(base.overall)} | ${f(orient.overall)} | ${f(contour.overall)} | ${f(all.overall)} |`);
    L.push(`| | | edgeSSIM | ${f(base.edge)} | ${f(orient.edge)} | ${f(contour.edge)} | ${f(all.edge)} |`);
    console.log(`  ${name}: boundary=${cg.count} base edge=${f(base.edge)} +orient=${f(orient.edge)} +contour=${f(contour.edge)} +all=${f(all.edge)}`);
  }
  const md = L.join('\n');
  await writeFile(join(OUT, `contour-ablate${QTAG}.md`), md);
  console.log('\n' + md + `\n\nwrote ${join(OUT, `contour-ablate${QTAG}.md`)}`);
}

// ============================================================================
// M3-SPEC §4 comprehensive ABLATION (phase 3). One command `tsx scripts/ablate.ts
// --families` runs the full matrix (base / +families / +orient / +contour / +all)
// on zoo 6 + synthetics 3 at the §1 GATE-chosen defaults (gateTau=2e-5, λ_mdl=0.02),
// the fixed 3-value orientKappa & κ_c sweeps, the four §4 verify verdicts, and the
// base-vs-+all side-by-side PNGs. Families are SYNTHESIZED (M3-SPEC §2) so their
// braille/sextant glyphs are not in the blocks atlas — augmentAtlas() appends the
// exact synth masks so rasterizeGrid/SSIM measure the reconstruction the solver
// actually fit (DESIGN §5.6 "our own raster").
// ============================================================================

const GATE_TAU_M3 = 2e-5;   // §1 chosen gate default
const MDL_M3 = 0.02;        // §1 chosen MDL default
const M3_FAMS: FamilyName[] = ['quadrant', 'sextant', 'braille'];
const ORIENT_SWEEP = [0.02, 0.05, 0.1];   // §3.3 fixed 3-value sweep
const CONTOUR_SWEEP = [0.05, 0.15, 0.3];  // §3.4 fixed 3-value sweep
const ORIENT_DEF = 0.05;                  // matrix default = sweep midpoint (not result-tuned)
const CONTOUR_DEF = 0.15;

function m3opts(over: Partial<MatchOptions>): MatchOptions {
  return {
    quality: QUALITY, space: SPACE, edgeLambda: 0.35, gateTau: GATE_TAU_M3, mdlLambda: MDL_M3,
    fixedBg: [0, 0, 0], fixedFg: [1, 1, 1], ...over,
  };
}

// share of grid cells emitting a synthesized sub-cell glyph. Braille U+2800–28FF and
// sextant U+1FB00–1FB3B are synth-ONLY (never in the blocks atlas), so their count is
// an unambiguous families-usage signal. Quadrant/half/full block chars are reported
// SEPARATELY because the text scan can also emit them (provenance is conflated there).
function familyShare(grid: Grid): { braille: number; sextant: number; total: number } {
  let braille = 0, sextant = 0;
  for (const c of grid.cells) {
    const cp = c.ch.codePointAt(0) ?? 0;
    if (cp >= 0x2800 && cp <= 0x28ff) braille++;
    else if (cp >= 0x1fb00 && cp <= 0x1fb3b) sextant++;
  }
  return { braille, sextant, total: grid.cells.length };
}

interface M3Img {
  name: string; isSynth: boolean;
  foot: LinearImage;         // reference at grid footprint (fit target + SSIM ref)
  covPix: Float32Array;      // per-pixel coverage [0,1] (AOV for zoo; gamma-luma proxy for synth)
  objMask: Uint8Array;       // object-cell pixel mask
  cellMean: Float32Array;    // per-cell mean coverage (contour polylines)
  band: EdgeBand;            // boundary-cell band for edgeSSIM
  bandCount: number;
}

async function loadM3Zoo(name: string, cellW: number, cellH: number): Promise<M3Img> {
  const dir = join(AOV, name);
  const foot = await loadLinear(join(dir, 'shaded.png'));
  const covRaw = (await loadRaw(join(dir, 'coverage.png'))).data;
  const covPix = new Float32Array(covRaw.length);
  for (let i = 0; i < covPix.length; i++) covPix[i] = covRaw[i]! / 255;
  const objMask = objMaskOf(covRaw, foot.w, foot.h, cellW, cellH);
  const cg = coverageGrids(covPix, foot.w, foot.h, cellW, cellH);
  const band: EdgeBand = { boundaryCells: cg.boundary, cols: cg.cols, rows: cg.rows, cellW, cellH };
  return { name, isSynth: false, foot, covPix, objMask, cellMean: cg.cellMean, band, bandCount: cg.count };
}

async function loadM3Synth(name: string, cellW: number, cellH: number): Promise<M3Img> {
  const src = await loadLinear(join(ROOT, 'bench', 'images', `${name}.png`));
  const COLS = 120;
  const rows = Math.round(COLS * (src.h / src.w) * (cellW / cellH));
  const foot = resampleArea(src, COLS * cellW, rows * cellH);
  // 2D silhouette proxy: per-pixel gamma luma in [0,1] stands in for the (absent)
  // coverage AOV, so orient/contour have an edge field. Documented as a proxy.
  const covPix = new Float32Array(foot.w * foot.h);
  for (let i = 0; i < covPix.length; i++) {
    covPix[i] = linearToSrgb(luma(foot.data[i * 3]!, foot.data[i * 3 + 1]!, foot.data[i * 3 + 2]!)) / 255;
  }
  const otsu = otsuThreshold(cellMeanLuma01(foot, cellW, cellH));
  const { mask } = objectMask(foot, cellW, cellH, otsu);
  const cg = coverageGrids(covPix, foot.w, foot.h, cellW, cellH);
  const band: EdgeBand = { boundaryCells: cg.boundary, cols: cg.cols, rows: cg.rows, cellW, cellH };
  return { name, isSynth: true, foot, covPix, objMask: mask, cellMean: cg.cellMean, band, bandCount: cg.count };
}

interface M3Run { out: LinearImage; overall: number; obj: number; edge: number; braille: number; sextant: number }

async function m3Main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const atlas = await buildAtlas(FONT, 16, 'blocks');
  const { cellW, cellH } = atlas;
  const fams = buildFamilies(M3_FAMS, cellW, cellH, atlas.inkMin, atlas.inkMax);
  // --override-blocks (M3-fix §7): re-rasterize U+2580–259F block chars through the IDEAL
  // synth mask (the predict-terminal geometry, DESIGN §5.6) instead of DejaVu's font mask.
  // Default off reproduces the legacy raster; report the +families delta under both.
  const OVERRIDE_BLOCKS = process.argv.includes('--override-blocks');
  const aug = augmentAtlas(atlas, fams, OVERRIDE_BLOCKS);

  const zooNames = MODELS.filter((m) => existsSync(join(AOV, m, 'meta.json')));
  const synthNames = ['sphere', 'torus', 'spheres'].filter((n) => existsSync(join(ROOT, 'bench', 'images', `${n}.png`)));
  const imgs: M3Img[] = [];
  for (const n of zooNames) imgs.push(await loadM3Zoo(n, cellW, cellH));
  for (const n of synthNames) imgs.push(await loadM3Synth(n, cellW, cellH));
  console.log(`m3-ablate: zoo ${zooNames.join(', ')} + synth ${synthNames.join(', ')}`);

  const measure = (grid: Grid, im: M3Img): M3Run => {
    const out = rasterizeGrid(grid, aug, SPACE);
    const fs = familyShare(grid);
    return {
      out, overall: ssim(out, im.foot), obj: maskedSsim(out, im.foot, im.objMask).obj,
      edge: im.bandCount > 0 ? edgeSSIM(out, im.foot, im.band) : NaN,
      braille: fs.braille, sextant: fs.sextant,
    };
  };

  // 5-config matrix per image ------------------------------------------------------
  const R = new Map<string, Record<'base' | 'fam' | 'orient' | 'contour' | 'all', M3Run>>();
  for (const im of imgs) {
    const base = measure(matchGrid(im.foot, atlas, m3opts({})), im);
    const fam = measure(matchGrid(im.foot, atlas, m3opts({ families: M3_FAMS })), im);
    const orient = measure(matchGrid(im.foot, atlas, m3opts({ orientKappa: ORIENT_DEF, aov: { coverage: im.covPix } })), im);
    const gc = matchGrid(im.foot, atlas, m3opts({ topK: 8 }));
    contourPostPass(gc, atlas, im.cellMean, CONTOUR_DEF);
    const contour = measure(gc, im);
    const ga = matchGrid(im.foot, atlas, m3opts({ families: M3_FAMS, orientKappa: ORIENT_DEF, topK: 8, aov: { coverage: im.covPix } }));
    contourPostPass(ga, atlas, im.cellMean, CONTOUR_DEF);
    const all = measure(ga, im);
    R.set(im.name, { base, fam, orient, contour, all });
    // base-vs-+all side-by-side PNG (zoo only — the 육안 deliverable of §4 criterion 3).
    if (!im.isSynth) await savePng(composeH([im.foot, base.out, all.out]), join(OUT, `m3-${im.name}.png`));
    console.log(`  ${im.name}: base=${f(base.overall)} +fam=${f(fam.overall)} (braille ${fam.braille}, sextant ${fam.sextant}) +orient=${f(orient.overall)} +contour=${f(contour.overall)} +all=${f(all.overall)}`);
  }

  // fixed sweeps (edgeSSIM, zoo only — synth uses a luma proxy so its edge band is noisy)
  const orientSweep = new Map<string, number[]>(); // model → edge per orientKappa
  const contourSweep = new Map<string, number[]>();
  for (const im of imgs) {
    if (im.isSynth || im.bandCount === 0) continue;
    orientSweep.set(im.name, ORIENT_SWEEP.map((k) => {
      const g = matchGrid(im.foot, atlas, m3opts({ orientKappa: k, aov: { coverage: im.covPix } }));
      return edgeSSIM(rasterizeGrid(g, aug, SPACE), im.foot, im.band);
    }));
    contourSweep.set(im.name, CONTOUR_SWEEP.map((k) => {
      const g = matchGrid(im.foot, atlas, m3opts({ topK: 8 }));
      contourPostPass(g, atlas, im.cellMean, k);
      return edgeSSIM(rasterizeGrid(g, aug, SPACE), im.foot, im.band);
    }));
    console.log(`  swept ${im.name}`);
  }

  // ---- markdown ----
  const L: string[] = [];
  L.push('# M3 ablation — families / orientation / contour (M3-SPEC §4)');
  L.push('');
  L.push(`- atlas: DejaVu Sans Mono @16, blocks (${atlas.glyphs.length} glyphs) + synth families [${M3_FAMS.join(', ')}] → augmented ${aug.glyphs.length} glyphs for raster; cell ${cellW}×${cellH}; space ${SPACE}, Q${QUALITY}`);
  L.push(`- block-mask override (§7, --override-blocks): **${OVERRIDE_BLOCKS ? 'ON' : 'off'}** — U+2580–259F rasterized through ${OVERRIDE_BLOCKS ? 'IDEAL synth' : 'DejaVu font'} masks.`);
  L.push(`- GATE defaults: gateTau=${GATE_TAU_M3}, mdlLambda=${MDL_M3} (M3-SPEC §1). orientKappa default=${ORIENT_DEF}, κ_c default=${CONTOUR_DEF} (sweep midpoints).`);
  L.push(`- reference: zoo = shaded AOV at footprint; synth = 120-col resample. object-cell = coverage>0.3 (zoo) / Otsu (synth); edgeSSIM over the coverage-boundary band (§3.5).`);
  L.push(`- **synthetics have no coverage AOV** — orient/contour there use a per-pixel gamma-luma silhouette proxy (documented; their edgeSSIM column is proxy-derived and excluded from the §3 zoo verdict).`);
  L.push('');

  const isSynthName = (n: string) => synthNames.includes(n);
  const metricTable = (title: string, pick: (r: M3Run) => number) => {
    L.push(`## ${title}`);
    L.push('');
    L.push('| image | base | +families | +orient | +contour | +all |');
    L.push('|---|---|---|---|---|---|');
    for (const im of imgs) {
      const r = R.get(im.name)!;
      const tag = im.isSynth ? ' *(synth)*' : '';
      L.push(`| ${im.name}${tag} | ${f(pick(r.base))} | ${f(pick(r.fam))} | ${f(pick(r.orient))} | ${f(pick(r.contour))} | ${f(pick(r.all))} |`);
    }
    L.push('');
  };
  metricTable('Overall SSIM', (r) => r.overall);
  metricTable('Object-cell SSIM', (r) => r.obj);
  metricTable('edgeSSIM (§3.5 boundary band)', (r) => r.edge);

  // family usage
  L.push('## Synthesized-family usage (cells, +families run)');
  L.push('');
  L.push('| image | grid cells | braille | sextant | braille+sextant % |');
  L.push('|---|---|---|---|---|');
  for (const im of imgs) {
    const r = R.get(im.name)!.fam;
    const cells = Math.round((r.out.w / cellW) * (r.out.h / cellH));
    L.push(`| ${im.name} | ${cells} | ${r.braille} | ${r.sextant} | ${((100 * (r.braille + r.sextant)) / cells).toFixed(2)}% |`);
  }
  L.push('');

  // sweeps
  const sweepTable = (title: string, sweep: Map<string, number[]>, vals: number[], label: string) => {
    L.push(`## ${title}`);
    L.push('');
    L.push(`| model | base edge | ${vals.map((v) => `${label}=${v}`).join(' | ')} | best Δ |`);
    L.push(`|---|---|${vals.map(() => '---').join('|')}|---|`);
    for (const im of imgs) {
      if (im.isSynth || !sweep.has(im.name)) continue;
      const baseEdge = R.get(im.name)!.base.edge;
      const row = sweep.get(im.name)!;
      const best = Math.max(...row.map((e) => e - baseEdge));
      L.push(`| ${im.name} | ${f(baseEdge)} | ${row.map((e) => f(e)).join(' | ')} | ${d(best)} |`);
    }
    L.push('');
  };
  sweepTable('orientKappa sweep — edgeSSIM (zoo, §3.3)', orientSweep, ORIENT_SWEEP, 'κ');
  sweepTable('κ_c sweep — edgeSSIM (zoo, §3.4)', contourSweep, CONTOUR_SWEEP, 'κ_c');

  // ---- §4 verify criteria ----
  L.push('## M3 verify criteria (§4)');
  L.push('');

  // Criterion 2 — FAMILIES: overall improves on all 3 synth AND ≥4/6 zoo.
  const synthImgs = imgs.filter((i) => i.isSynth);
  const zooImgs = imgs.filter((i) => !i.isSynth);
  const synthImproved = synthImgs.filter((i) => R.get(i.name)!.fam.overall - R.get(i.name)!.base.overall > 0);
  const zooImproved = zooImgs.filter((i) => R.get(i.name)!.fam.overall - R.get(i.name)!.base.overall > 0);
  const c2 = synthImproved.length === synthImgs.length && zooImproved.length >= 4;
  L.push(`**Criterion 2 — FAMILIES (overall SSIM improves on all ${synthImgs.length} synth AND ≥4/6 zoo):** ${c2 ? 'PASS' : 'FAIL'}. synth ${synthImproved.length}/${synthImgs.length} [${synthImgs.map((i) => `${i.name} ${d(R.get(i.name)!.fam.overall - R.get(i.name)!.base.overall)}`).join(', ')}]; zoo ${zooImproved.length}/${zooImgs.length} [${zooImgs.map((i) => `${i.name} ${d(R.get(i.name)!.fam.overall - R.get(i.name)!.base.overall)}`).join(', ')}].`);
  L.push('');

  // Criterion 3 — CONTOUR: edgeSSIM improves ≥4/6 zoo at defaults, overall ≥ base−0.002.
  const orientEdgeUp = zooImgs.filter((i) => R.get(i.name)!.orient.edge - R.get(i.name)!.base.edge > 0);
  const contourEdgeUp = zooImgs.filter((i) => R.get(i.name)!.contour.edge - R.get(i.name)!.base.edge > 0);
  const guardOrient = zooImgs.every((i) => R.get(i.name)!.orient.overall >= R.get(i.name)!.base.overall - 0.002);
  const guardContour = zooImgs.every((i) => R.get(i.name)!.contour.overall >= R.get(i.name)!.base.overall - 0.002);
  const c3orient = orientEdgeUp.length >= 4 && guardOrient;
  const c3contour = contourEdgeUp.length >= 4 && guardContour;
  const c3 = c3orient || c3contour;
  L.push(`**Criterion 3 — CONTOUR (edgeSSIM improves ≥4/6 zoo at defaults, overall ≥ base−0.002):** ${c3 ? 'PASS' : 'FAIL'}.`);
  L.push(`- +orient (κ=${ORIENT_DEF}): edgeSSIM up on ${orientEdgeUp.length}/6 [${zooImgs.map((i) => `${i.name} ${d(R.get(i.name)!.orient.edge - R.get(i.name)!.base.edge)}`).join(', ')}]; overall-guard ${guardOrient ? 'ok' : 'VIOLATED'} → ${c3orient ? 'PASS' : 'FAIL'}.`);
  L.push(`- +contour (κ_c=${CONTOUR_DEF}): edgeSSIM up on ${contourEdgeUp.length}/6 [${zooImgs.map((i) => `${i.name} ${d(R.get(i.name)!.contour.edge - R.get(i.name)!.base.edge)}`).join(', ')}]; overall-guard ${guardContour ? 'ok' : 'VIOLATED'} → ${c3contour ? 'PASS' : 'FAIL'}.`);
  L.push('');

  L.push('## Side-by-side renders (base | +all)');
  L.push('');
  L.push('Panel order: **reference | base | +all**.');
  L.push('');
  for (const im of zooImgs) L.push(`- ![${im.name}](m3-${im.name}.png)`);
  L.push('');

  const md = L.join('\n');
  await writeFile(join(OUT, 'ablate-m3.md'), md);
  console.log('\n' + md);
  console.log(`\nwrote ${join(OUT, 'ablate-m3.md')}`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--families')) { await m3Main(); return; }
  const OK = parseOrientKappa();
  const DC = process.argv.includes('--contour');
  if (OK !== null || DC) { await contourMain(OK ?? 0, DC, parseContourKappa()); return; }
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
