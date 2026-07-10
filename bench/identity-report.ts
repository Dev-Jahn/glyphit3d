import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { dirname, join } from 'node:path';
import { buildAtlas } from '../src/atlas/atlas.js';
import { CHARSETS } from '../src/atlas/charsets.js';
import { resampleArea } from '../src/image/image.js';
import { loadLinear } from '../src/image/image-io.js';
import { matchGrid } from '../src/core/match.js';
import { rasterizeGrid } from '../src/render/raster.js';
import { luma, linearToSrgb } from '../src/core/color.js';
import { ssim } from '../src/metric/ssim.js';
import { defaultOptions } from '../src/core/options.js';
import { cellCsMap, cellObjectMask, aovCellMask, aggregateCas, type CasStats } from './cell-ac.js';
import { identityProxies, TAU_VIS, type ProxyResult } from './identity-proxies.js';
import type { Atlas, LinearImage, MatchOptions } from '../src/core/types.js';

// ASCII-identity report (ADR-0002 §5; aesthetic-pivot spec §5/§6). Sibling to structure-report.ts
// — it does NOT import or alter chafa-gate.ts or cell-ac.ts (CAS is consumed UNMODIFIED). It runs
// the aesthetic-pivot contestant matrix × charsets × (6 bench images + 2 AOV bakes) and emits, per
// object mask:
//   (1) the ASCII-identity PROXIES (readability / coverage-luma corr / fg-luma+sat corr / raster
//       DC-luma error / full-block rate / near-floor rate) — the feature-specific OBJECTIVE, and
//   (2) the reconstruction GUARDRAILS (mean SSIM + CAS object p10/wmean) as FLOORS relative to the
//       SAME-RUN baseline (ADR-0002 §5 / spec §6.2: aesthetic features may not improve
//       reconstruction and must not drop it below the pre-registered floor).
// The two-sided acceptance (proxy must improve ∧ SSIM/CAS floors held) is what blocks proxy-gaming
// (spraying dense glyphs everywhere raises readability but the CAS floor catches the washout).
//
// The 6 bench images use the 2D Otsu-fallback object mask (ADR-0002 §2). The 2 AOV bakes
// (DamagedHelmet, FlightHelmet, produced by scripts/bake-aov.ts) exercise the renderer illumination
// path: the reference is the baked `shaded` render, the object mask is the GEOMETRIC aovCellMask
// (silhouette coverage>0, not the luma heuristic), AND the albedo-free `shading` render is fed to the
// coupling contestants as aov.shadingLuma so shape-color coupling takes its true-illumination path
// (spec §4.1: ℓ = mean shadingLuma over the cell) rather than the 2D ℓ = Ȳ fallback — the one path
// the AOV bakes were added to validate end-to-end. Every contestant is re-rasterized in
// predict-terminal (gamma) space vs the identical grid-footprint reference — the gate's
// harness-fairness protocol (structure-report.ts idiom).
//
// No-flag repro:  npx tsx bench/identity-report.ts   → bench/out/identity-report.md
//   (contestants = baseline + demonstrator until the core feat/selection-prior +
//    feat/shape-color-coupling land — see contestants() below.)

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
const FONT_SIZE = 16;
const COLS = 120;
let IMAGES = ['sphere', 'torus', 'spheres', 'DamagedHelmet', 'FlightHelmet', 'BoomBox'];
// AOV bakes (bench/aov/<name>/{shaded,coverage}.png via scripts/bake-aov.ts). Rendered N/A if absent.
const AOV_BAKES = ['DamagedHelmet', 'FlightHelmet'];
const CHARSET_LIST: (keyof typeof CHARSETS)[] = ['blocks', 'ascii'];

// Pre-registered guardrail floors (ADR-0002 §5 / spec §6.2), relative to the SAME-RUN baseline (per
// charset). A contestant PASSES iff it stays within these margins below the baseline (improvement is
// NOT required — selection-prior theorem). SSIM is two-tier (spec §6.2): the 6-image MEAN must hold
// within 0.05 AND every per-image SSIM within 0.08. CAS floors are on the mean (wmean 0.05, p10 0.06).
const FLOOR = { ssimMean: 0.05, ssimPerImage: 0.08, casWmean: 0.05, casP10: 0.06 } as const;

interface Contestant { label: string; opts: MatchOptions }

// Contestant matrix (FROZEN spec §5 option interface). Q2 baseline, Q2+A (feat/ascii-identity-
// selection), Q2+B (feat/shape-color-coupling), Q2+A+B, and the shipped preset (A+B+contrast floor).
// Preset values per spec §5: identityLambda=5, identityTau=2.5e-4, coupling={} (defaults),
// contrastFloor=24/255 (the u8-24 visibility threshold in working luma). The floor mechanism is the
// parallel contrast-floor lane's; it is referenced, not re-implemented.
function contestants(): Contestant[] {
  const idA = { identityLambda: 5, identityTau: 2.5e-4 };
  const mk = (o: Partial<MatchOptions>): MatchOptions => Object.assign(defaultOptions(2), o);
  return [
    { label: 'Q2 baseline', opts: defaultOptions(2) },
    { label: 'Q2+A', opts: mk({ ...idA }) },
    { label: 'Q2+B', opts: mk({ coupling: {} }) },
    { label: 'Q2+A+B', opts: mk({ ...idA, coupling: {} }) },
    { label: 'preset', opts: mk({ ...idA, coupling: {}, contrastFloor: 24 / 255 }) },
  ];
}

// shadingLuma: gridW*gridH working-space (gamma) luma of the albedo-free shading render, present
// only on AOV-bake ctxs. It drives coupling's true-illumination path (spec §4.1: ℓ = mean shadingLuma
// over the cell) instead of the 2D fallback ℓ = Ȳ; absent on 2D ctxs → coupling uses the fallback.
interface Ctx { name: string; ref: LinearImage; mask: Uint8Array; objFrac: number; maskSrc: string; shadingLuma?: Float32Array }

// 2D bench image ctx: reference resampled to the grid footprint, object mask = 2D Otsu fallback.
async function build2dCtx(atlas: Atlas, name: string): Promise<Ctx> {
  const { cellW, cellH } = atlas;
  const src = await loadLinear(join(ROOT, 'bench', 'images', `${name}.png`));
  const rows = Math.round(COLS * (src.h / src.w) * (cellW / cellH));
  const ref = resampleArea(src, COLS * cellW, rows * cellH); // reference AT the grid footprint
  const { mask, objFrac } = cellObjectMask(ref, cellW, cellH);
  return { name, ref, mask, objFrac, maskSrc: `Otsu` };
}

// Per-cell max of an image's R channel over cellW×cellH blocks → length cols*rows. Used to reduce a
// pixel-resolution AOV (coverage) to the per-cell array aovCellMask consumes; max keeps a cell
// "covered" if ANY of its pixels carries geometry (silhouette cells included, matching aovCellMask).
function perCellMaxR(img: LinearImage, cellW: number, cellH: number, cols: number, rows: number): Float32Array {
  const out = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let m = 0;
      for (let ly = 0; ly < cellH; ly++) {
        for (let lx = 0; lx < cellW; lx++) {
          const p = (((r * cellH + ly) * img.w) + (c * cellW + lx)) * 3;
          if (img.data[p]! > m) m = img.data[p]!;
        }
      }
      out[r * cols + c] = m;
    }
  }
  return out;
}

// AOV-bake ctx: reference = baked `shaded` render (renderer illumination path); object mask =
// GEOMETRIC aovCellMask over the baked `coverage` silhouette (ADR-0002 §2 principled mask), computed
// at THIS atlas's footprint (shaded/coverage resampled to COLS·cellW × rows·cellH). Returns null if
// the bake dir is absent (assemble/local run without a prior `scripts/bake-aov.ts`).
async function buildAovCtx(atlas: Atlas, name: string): Promise<Ctx | null> {
  const { cellW, cellH } = atlas;
  const dir = join(ROOT, 'bench', 'aov', name);
  const shadedPath = join(dir, 'shaded.png'), coveragePath = join(dir, 'coverage.png'), shadingPath = join(dir, 'shading.png');
  if (!existsSync(shadedPath) || !existsSync(coveragePath)) return null;
  const shaded = await loadLinear(shadedPath);
  const coverage = await loadLinear(coveragePath);
  const rows = Math.round(COLS * (shaded.h / shaded.w) * (cellW / cellH));
  const ref = resampleArea(shaded, COLS * cellW, rows * cellH);
  const covR = resampleArea(coverage, COLS * cellW, rows * cellH);
  const covCell = perCellMaxR(covR, cellW, cellH, COLS, rows);
  const mask = aovCellMask(COLS, rows, { coverage: covCell });
  let obj = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) obj++;
  // Albedo-free shading AOV → gridW*gridH working-space (gamma) luma, so the coupling contestants
  // exercise the spec-§4.1 illumination path (ℓ = mean shadingLuma over the cell) rather than the
  // 2D fallback ℓ = Ȳ. Built at THIS atlas's grid footprint (same resample as ref), matching the
  // canonical construction in scripts/ablate.ts. Absent shading.png → undefined (fallback used).
  let shadingLuma: Float32Array | undefined;
  if (existsSync(shadingPath)) {
    const shadingRes = resampleArea(await loadLinear(shadingPath), COLS * cellW, rows * cellH);
    shadingLuma = new Float32Array(shadingRes.w * shadingRes.h);
    for (let i = 0; i < shadingLuma.length; i++) {
      const y = luma(shadingRes.data[i * 3]!, shadingRes.data[i * 3 + 1]!, shadingRes.data[i * 3 + 2]!);
      shadingLuma[i] = linearToSrgb(y) / 255; // gamma working space (spec §4.1)
    }
  }
  return { name: `${name}·AOV`, ref, mask, objFrac: obj / (COLS * rows), maskSrc: `geom`, shadingLuma };
}

async function buildCtxs(atlas: Atlas): Promise<Ctx[]> {
  const out: Ctx[] = [];
  for (const name of IMAGES) out.push(await build2dCtx(atlas, name));
  for (const name of AOV_BAKES) {
    const ctx = await buildAovCtx(atlas, name);
    if (ctx) out.push(ctx);
  }
  return out;
}

interface Scored { proxies: ProxyResult; cas: CasStats; ssim: number }

// Proxies + CAS (UNMODIFIED cell-ac.ts) + SSIM guardrail for one contestant on one image.
function score(atlas: Atlas, ctx: Ctx, opts: MatchOptions): Scored {
  // On AOV bakes, feed the albedo-free shading AOV so the coupling contestants take the true-
  // illumination path (spec §4.1). It is consumed by match.ts ONLY when opts.coupling is set (the
  // couplingShading source is gated on couplingParams), so baseline / selection-only contestants are
  // unaffected and stay byte-identical. Never mutate the shared contestant opts — clone.
  const effOpts: MatchOptions = ctx.shadingLuma
    ? { ...opts, aov: { ...opts.aov, shadingLuma: ctx.shadingLuma } }
    : opts;
  const grid = matchGrid(ctx.ref, atlas, effOpts);
  const baked = rasterizeGrid(grid, atlas, 'gamma'); // predict-terminal composite for everyone
  const proxies = identityProxies(grid, baked, ctx.ref, atlas, ctx.mask);
  const cas = aggregateCas(cellCsMap(baked, ctx.ref, atlas.cellW, atlas.cellH), ctx.mask);
  return { proxies, cas, ssim: ssim(baked, ctx.ref) };
}

function f3(x: number): string { return Number.isFinite(x) ? x.toFixed(3) : 'n/a'; }
function f4(x: number): string { return Number.isFinite(x) ? x.toFixed(4) : 'n/a'; }
function f1(x: number): string { return Number.isFinite(x) ? x.toFixed(1) : 'n/a'; }
function meanStr(xs: number[]): string { return f4(mean(xs)); }
function mean(xs: number[]): number { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function sgn(x: number): string { return (x >= 0 ? '+' : '') + x.toFixed(4); }

// One charset section: contestants × (6 images + AOV bakes), proxy tables + guardrail floor table.
function charsetSection(atlas: Atlas, ctxs: Ctx[], L: string[]): void {
  const cons = contestants();
  const names = ctxs.map((c) => c.name);
  const scored: Scored[][] = cons.map((con) => ctxs.map((ctx) => score(atlas, ctx, con.opts)));
  const baseIdx = 0; // contestants()[0] is the baseline the floors are measured against

  // object mask summary
  L.push('Object mask — 6 bench images: 2D Otsu fallback (per-cell luma Otsu + border-polarity self-calibration + 1-cell dilation); AOV bakes: GEOMETRIC silhouette coverage>0 (ADR-0002 §2), shaded render as reference:');
  L.push('');
  L.push(`| scene | grid | mask | object-cell frac | object cells |`);
  L.push(`|---|---|---|---|---|`);
  ctxs.forEach((c, i) => {
    const rows = Math.round(c.ref.h / atlas.cellH);
    L.push(`| ${c.name} | ${COLS}x${rows} | ${c.maskSrc} | ${(c.objFrac * 100).toFixed(1)}% | ${scored[baseIdx]![i]!.proxies.nObj} |`);
  });
  L.push('');

  // ---- ASCII-identity proxy tables (one per proxy) ----
  const proxyDefs: { key: keyof ProxyResult; title: string; fmt: (x: number) => string; dir: string }[] = [
    { key: 'readabilityRate', title: `Readability rate (object cells: not space, not █, |F−B|≥${TAU_VIS} u8) — HEADLINE identity proxy`, fmt: f3, dir: '↑ better' },
    { key: 'coverageLumaCorr', title: 'Coverage↔luma corr (feat A signature: glyph ink-area ↔ cell luma)', fmt: f3, dir: '↑ = feature active' },
    { key: 'fgLumaCorr', title: 'FG-luma↔ref-luma corr (feat B signature: fg lightness ↔ cell luma, readable cells)', fmt: f3, dir: '↑ = feature active' },
    { key: 'fgSatCorr', title: 'FG-sat↔ref-luma corr (feat B signature: fg saturation ↔ cell luma, readable cells)', fmt: f3, dir: '↑ = feature active' },
    { key: 'fullBlockRate', title: 'Full-block █ rate (object cells) — washout indicator', fmt: f3, dir: '↓ better' },
    { key: 'nearFloorRate', title: `Near-floor / invisible-ink rate (glyph with |F−B|<${TAU_VIS} u8) — trade-off tracker`, fmt: f3, dir: 'trade-off' },
    { key: 'rasterDcLumaError', title: 'Raster DC-luma error, u8 (cell-mean fidelity) — guardrail-flavored', fmt: f1, dir: '↓ better' },
  ];
  for (const pd of proxyDefs) {
    L.push(`### ${pd.title} — ${pd.dir}`);
    L.push('');
    L.push(`| contestant | ${names.join(' | ')} | mean |`);
    L.push(`|---|${names.map(() => '---').join('|')}|---|`);
    cons.forEach((con, ci) => {
      const vals = scored[ci]!.map((s) => s.proxies[pd.key]);
      const finite = vals.filter((v) => Number.isFinite(v));
      L.push(`| ${con.label} | ${vals.map(pd.fmt).join(' | ')} | **${finite.length ? meanStr(finite) : 'n/a'}** |`);
    });
    L.push('');
  }

  // ---- reconstruction guardrail floors (relative to same-run baseline) ----
  L.push('### Reconstruction guardrails — SSIM + CAS floors vs same-run baseline (spec §6.2)');
  L.push('');
  L.push(`Aesthetic features may NOT improve reconstruction (selection-prior theorem) and must NOT drop it below the pre-registered floor (ADR-0002 §5). PASS = SSIM mean within ${FLOOR.ssimMean} AND every image within ${FLOOR.ssimPerImage} of baseline, AND CAS wmean mean within ${FLOOR.casWmean} AND CAS p10 mean within ${FLOOR.casP10}.`);
  L.push('');
  L.push(`| contestant | mean SSIM | Δ SSIM | CAS p10 | Δ p10 | CAS wmean | Δ wmean | guardrail |`);
  L.push(`|---|---|---|---|---|---|---|---|`);
  const base = {
    ssim: scored[baseIdx]!.map((s) => s.ssim),
    p10: scored[baseIdx]!.map((s) => s.cas.p10),
    wmean: scored[baseIdx]!.map((s) => s.cas.wmean),
  };
  cons.forEach((con, ci) => {
    const ss = scored[ci]!.map((s) => s.ssim);
    const p10 = scored[ci]!.map((s) => s.cas.p10);
    const wm = scored[ci]!.map((s) => s.cas.wmean);
    const dSs = mean(ss) - mean(base.ssim);
    const dP = mean(p10) - mean(base.p10);
    const dW = mean(wm) - mean(base.wmean);
    // spec §6.2: SSIM two-tier (mean 0.05 + per-image 0.08); CAS wmean/p10 on the mean.
    const pass =
      mean(ss) >= mean(base.ssim) - FLOOR.ssimMean &&
      ctxs.every((_, i) => ss[i]! >= base.ssim[i]! - FLOOR.ssimPerImage) &&
      mean(wm) >= mean(base.wmean) - FLOOR.casWmean &&
      mean(p10) >= mean(base.p10) - FLOOR.casP10;
    const verdict = ci === baseIdx ? '— (baseline)' : (pass ? '**PASS**' : '**FAIL**');
    L.push(`| ${con.label} | ${f4(mean(ss))} | ${sgn(dSs)} | ${f4(mean(p10))} | ${sgn(dP)} | ${f4(mean(wm))} | ${sgn(dW)} | ${verdict} |`);
  });
  L.push('');
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { images: { type: 'string' } } });
  if (values.images) IMAGES = values.images.split(',').map((s) => s.trim()).filter(Boolean);

  const aovPresent = AOV_BAKES.filter((n) => existsSync(join(ROOT, 'bench', 'aov', n, 'shaded.png')));
  const aovMissing = AOV_BAKES.filter((n) => !aovPresent.includes(n));

  const L: string[] = [];
  L.push('# ASCII-identity report — aesthetic-pivot proxies + reconstruction guardrails (ADR-0002 §5)');
  L.push('');
  L.push(`DejaVu Sans Mono @ ${FONT_SIZE}px · ${COLS} cols · ${IMAGES.length} bench images + ${aovPresent.length} AOV bake(s) · contestants: ${contestants().map((c) => c.label.split(' ')[0]).join(', ')}`);
  L.push('');
  L.push('Proxies measure the ASCII-identity OBJECTIVE (visible character glyphs), explicitly different from reconstruction and in explicit trade-off with invisible-ink. Guardrails are reconstruction FLOORS relative to the same-run baseline. Acceptance (ADR-0002 §5) = blind A/B majority ∧ proxy improves by pre-registered margin ∧ SSIM+CAS floors held.');
  L.push('');
  if (aovMissing.length) {
    L.push(`> **AOV note:** ${aovMissing.join(', ')} bake(s) absent (no bench/aov/<name>/shaded.png). Run \`npx tsx scripts/bake-aov.ts bench/zoo/<name>/<name>.gltf --cols ${COLS}\` to produce them; those columns are omitted until present.`);
    L.push('');
  }

  for (const cs of CHARSET_LIST) {
    const atlas = await buildAtlas(FONT, FONT_SIZE, cs);
    const ctxs = await buildCtxs(atlas);
    L.push(`## charset = ${cs} (atlas ${atlas.glyphs.length} glyphs · cell ${atlas.cellW}x${atlas.cellH})`);
    L.push('');
    charsetSection(atlas, ctxs, L);
  }

  const md = L.join('\n');
  await mkdir(join(ROOT, 'bench', 'out'), { recursive: true });
  await writeFile(join(ROOT, 'bench', 'out', 'identity-report.md'), md + '\n');
  console.log(md);
  console.log('\nwrote bench/out/identity-report.md');
}

main().catch((e) => { console.error(e); process.exit(2); });
