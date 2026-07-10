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
import { loadLinear, loadRaw } from './image/image-io.js';
import { resampleArea } from './image/image.js';
import { matchGrid, contourPostPass } from './core/match.js';
import { rampGrid } from './core/ramp.js';
import { rasterizeGrid } from './render/raster.js';
import { savePng } from './render/raster-io.js';
import { toAnsi } from './render/ansi.js';
import { toHtml } from './render/html.js';
import { ssim } from './metric/ssim.js';
import { luma, linearToSrgb } from './core/color.js';
import { cellDiffHeatmap } from './metric/heatmap.js';
import { defaultOptions, gridRows } from './core/options.js';
// Re-exported for existing node-side importers (scripts/tests) that expect these
// on cli.js; the pure definitions live in core/options.js for browser reuse.
export { defaultOptions, gridRows } from './core/options.js';

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
      'orient-kappa': { type: 'string', default: '0' },
      contour: { type: 'boolean', default: false },
      'contour-kappa': { type: 'string', default: '0.15' },
      palette: { type: 'string' },
      'palette-k': { type: 'string' },
      identity: { type: 'boolean', default: false },
      'identity-lambda': { type: 'string' },
      'identity-tau': { type: 'string' },
      'couple-strength': { type: 'string' },
      'sat-knee': { type: 'string' },
      'sat-min': { type: 'string' },
      'k-max': { type: 'string' },
      floor: { type: 'string' },
      o: { type: 'string' },
      html: { type: 'string' },
      png: { type: 'string' },
      diff: { type: 'string' },
      stats: { type: 'boolean', default: false },
    },
  });
  const target = positionals[0];
  if (!target) {
    console.error('usage: cli bake <model.glb|.gltf|aov-dir> --cols 120 --quality 3 [--split N] [--antibleed N] [--style-albedo] [--orient-kappa N] [--contour --contour-kappa N] [--identity [--identity-lambda N] [--identity-tau N] [--couple-strength N] [--sat-knee N] [--sat-min N] [--k-max N] [--floor N]] [-o out.ansi] [--html f] [--png f] [--diff f] [--stats]');
    process.exit(2);
  }
  const cols = parseInt(values.cols!, 10);
  const quality = identityQuality(values.identity!, parseInt(values.quality!, 10) as 0 | 1 | 2 | 3 | 4);
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
  applyPalette(opts, values.palette, values['palette-k']);
  applyIdentity(opts, values);
  const eta = parseFloat(values.split!);
  const kappa = parseFloat(values.antibleed!);
  const styleAlbedo = values['style-albedo']!;
  const orientKappa = parseFloat(values['orient-kappa']!);
  const contourKappa = parseFloat(values['contour-kappa']!);
  const doContour = values.contour! && quality !== 0;
  const aov: NonNullable<MatchOptions['aov']> = {};
  if (eta > 0) aov.shadingLuma = await shadingLumaOf(req('shading.png'), space);
  if (kappa > 0) aov.objectId = Uint16Array.from((await loadRaw(req('objectid.png'))).data);
  if (styleAlbedo) aov.albedo = await loadLinear(req('albedo.png'));
  // §3.2 silhouette coverage AOV (per-pixel [0,1]) drives the orientation edge field and
  // the contour polylines; load once when either mechanism is on.
  let coveragePix: Float32Array | undefined;
  if (orientKappa > 0 || doContour) {
    const cov = await loadRaw(req('coverage.png'));
    coveragePix = new Float32Array(cov.data.length);
    for (let i = 0; i < coveragePix.length; i++) coveragePix[i] = cov.data[i]! / 255;
  }
  if (eta > 0) opts.splitSelection = eta;
  if (kappa > 0) opts.antibleedKappa = kappa;
  if (styleAlbedo) opts.styleAlbedoColors = true;
  if (orientKappa > 0) { aov.coverage = coveragePix; opts.orientKappa = orientKappa; }
  if (doContour) opts.topK = 8;
  if (eta > 0 || kappa > 0 || styleAlbedo || orientKappa > 0) opts.aov = aov;

  const t0 = performance.now();
  const grid = quality === 0 ? rampGrid(ref, atlas, opts) : matchGrid(ref, atlas, opts);
  if (doContour) contourPostPass(grid, atlas, perCellMean(coveragePix!, ref.w, ref.h, atlas.cellW, atlas.cellH), contourKappa);
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

// Per-cell mean of a per-pixel [0,1] scalar → cols*rows grid for the contour post-pass
// (marching squares thresholds this at 0.5). Used both for the silhouette-coverage AOV
// (bake) and the 2D luma proxy (image, no AOV).
function perCellMean(field: Float32Array, w: number, h: number, cellW: number, cellH: number): Float32Array {
  const cols = Math.floor(w / cellW), rows = Math.floor(h / cellH);
  const out = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    let s = 0;
    for (let ly = 0; ly < cellH; ly++) { const gy = r * cellH + ly; for (let lx = 0; lx < cellW; lx++) s += field[gy * w + (c * cellW + lx)]!; }
    out[r * cols + c] = s / (cellW * cellH);
  }
  return out;
}

// Working-space (gamma) luma in [0,1] per pixel — the 2D fallback silhouette proxy for
// the contour pass when there is no coverage AOV.
function lumaField01(ref: { w: number; h: number; data: Float32Array }): Float32Array {
  const out = new Float32Array(ref.w * ref.h);
  for (let i = 0; i < out.length; i++) out[i] = linearToSrgb(luma(ref.data[i * 3]!, ref.data[i * 3 + 1]!, ref.data[i * 3 + 2]!)) / 255;
  return out;
}

// Map the --palette flag (theme16|16 / palette256|256) onto MatchOptions. Palette modes are
// CPU-only, Q3/Q4 (DESIGN §6); matchGrid enforces the quality/feature constraints.
function applyPalette(opts: MatchOptions, palette: string | undefined, k: string | undefined): void {
  if (!palette) {
    // --palette-k without --palette is a silent no-op; reject loudly (matches the k-range guard below).
    if (k !== undefined) { console.error('--palette-k requires --palette'); process.exit(2); }
    return;
  }
  // Palette modes are Q3/Q4 (fg-bg) only (DESIGN §6). matchGrid enforces this, but Q0 (rampGrid)
  // never reaches matchGrid and would SILENTLY drop --palette — so reject any quality < 3 here.
  if (opts.quality < 3) { console.error('--palette requires --quality 3 or 4 (fg-bg)'); process.exit(2); }
  const p = palette === 'theme16' || palette === '16' ? 'theme16'
    : palette === 'palette256' || palette === '256' ? 'palette256'
      : undefined;
  if (!p) { console.error('--palette must be theme16|256'); process.exit(2); }
  opts.palette = p;
  if (k) {
    const kn = parseInt(k, 10);
    if (!Number.isFinite(kn) || kn < 1) { console.error('--palette-k must be an integer >= 1'); process.exit(2); }
    opts.paletteRefineK = kn;
  }
}

// ASCII-identity mode (spec §5). --identity is the fixed-bg Q2 aesthetic family (selection prior +
// shape-color coupling + contrast floor), so it IMPLIES --quality 2. An EXPLICIT --quality other
// than 2 is a hard error (no silent override). Returns the quality matchGrid will run at.
function identityQuality(identity: boolean, quality: 0 | 1 | 2 | 3 | 4): 0 | 1 | 2 | 3 | 4 {
  if (!identity) return quality;
  const qExplicit = argv.some((a) => a === '--quality' || a.startsWith('--quality='));
  if (qExplicit && quality !== 2) { console.error('--identity requires --quality 2 (fixed-bg fg fit)'); process.exit(2); }
  return 2;
}

// Apply the --identity preset (spec §5) + override flags onto MatchOptions. The preset turns on all
// three members of the aesthetic family: the selection prior (λ=5, τ=2.5e-4), shape-color coupling
// (defaults) and the contrast floor (24/255≈0.0941 working luma — the u8-24 visibility threshold).
// Override flags refine individual knobs; any override without --identity is rejected loudly.
function applyIdentity(opts: MatchOptions, values: Record<string, string | boolean | undefined>): void {
  const num = (k: string): number | undefined => {
    const v = values[k];
    if (v === undefined) return undefined;
    const n = parseFloat(v as string);
    if (!Number.isFinite(n)) { console.error(`--${k} must be a number`); process.exit(2); }
    return n;
  };
  const overrideKeys = ['identity-lambda', 'identity-tau', 'couple-strength', 'sat-knee', 'sat-min', 'k-max', 'floor'];
  const anyOverride = overrideKeys.some((k) => values[k] !== undefined);
  if (!values.identity) {
    if (anyOverride) { console.error('--identity-* / --couple-strength / --sat-knee / --sat-min / --k-max / --floor require --identity'); process.exit(2); }
    return;
  }
  // preset
  opts.identityLambda = 5;
  opts.identityTau = 2.5e-4;
  opts.contrastFloor = 24 / 255;
  const coupling: NonNullable<MatchOptions['coupling']> = {};
  // overrides (diagnostic sweeps, spec §6.4 — acceptance is judged on the defaults only)
  const lam = num('identity-lambda'); if (lam !== undefined) { if (lam < 0) { console.error('--identity-lambda must be >= 0'); process.exit(2); } opts.identityLambda = lam; }
  const tau = num('identity-tau'); if (tau !== undefined) { if (tau <= 0) { console.error('--identity-tau must be > 0'); process.exit(2); } opts.identityTau = tau; }
  const floor = num('floor'); if (floor !== undefined) { if (floor < 0) { console.error('--floor must be >= 0'); process.exit(2); } opts.contrastFloor = floor; }
  const cs = num('couple-strength'); if (cs !== undefined) coupling.strength = cs;
  const sk = num('sat-knee'); if (sk !== undefined) coupling.satKnee = sk;
  const sm = num('sat-min'); if (sm !== undefined) coupling.satMin = sm;
  const km = num('k-max'); if (km !== undefined) coupling.kMax = km;
  opts.coupling = coupling;
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
      'orient-kappa': { type: 'string', default: '0' },
      contour: { type: 'boolean', default: false },
      'contour-kappa': { type: 'string', default: '0.15' },
      palette: { type: 'string' },
      'palette-k': { type: 'string' },
      identity: { type: 'boolean', default: false },
      'identity-lambda': { type: 'string' },
      'identity-tau': { type: 'string' },
      'couple-strength': { type: 'string' },
      'sat-knee': { type: 'string' },
      'sat-min': { type: 'string' },
      'k-max': { type: 'string' },
      floor: { type: 'string' },
      o: { type: 'string' },
      html: { type: 'string' },
      png: { type: 'string' },
      diff: { type: 'string' },
      stats: { type: 'boolean', default: false },
    },
  });

  if (positionals[0] !== 'image' || !positionals[1]) {
    console.error('usage: cli image <input.png> --cols N --quality 0..4 --space linear|gamma --charset <set> --font <ttf> --font-size N [--palette theme16|256 [--palette-k K]] [--orient-kappa N] [--contour --contour-kappa N] [--identity [--identity-lambda N] [--identity-tau N] [--couple-strength N] [--sat-knee N] [--sat-min N] [--k-max N] [--floor N]] [-o out.ansi] [--html f] [--png f] [--diff f] [--stats]');
    process.exit(2);
  }
  const input = positionals[1];
  const cols = parseInt(values.cols!, 10);
  const quality = identityQuality(values.identity!, parseInt(values.quality!, 10) as 0 | 1 | 2 | 3 | 4);
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
  applyPalette(opts, values.palette, values['palette-k']);
  applyIdentity(opts, values);
  // M3 §3.3/§3.4: orientation prior + contour post-pass. 2D image mode has no AOVs, so
  // both fall back to the reference luma (orientation via the luma edge field internally,
  // contour via a per-cell luma silhouette proxy). Q0 (ramp) has no per-cell candidates.
  const orientKappa = parseFloat(values['orient-kappa']!);
  const contourKappa = parseFloat(values['contour-kappa']!);
  if (orientKappa > 0) opts.orientKappa = orientKappa;
  if (values.contour && quality !== 0) opts.topK = 8;
  const grid = quality === 0 ? rampGrid(ref, atlas, opts) : matchGrid(ref, atlas, opts);
  if (values.contour && quality !== 0) {
    contourPostPass(grid, atlas, perCellMean(lumaField01(ref), ref.w, ref.h, atlas.cellW, atlas.cellH), contourKappa);
  }
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
