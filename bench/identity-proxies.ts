import type { Atlas, Grid, GridCell, LinearImage } from '../src/core/types.js';
import { luma, linearToSrgb, srgbToLinear } from '../src/core/color.js';
import { cellMeanLuma01 } from './masked-ssim.js';

// ASCII-identity quantitative proxies (ADR-0002 §5; aesthetic-pivot spec §5). These measure
// the ASCII-identity OBJECTIVE FUNCTION — explicitly DIFFERENT from reconstruction (CAS/SSIM)
// and in explicit trade-off with invisible-ink (reconstruction wants faint |F−B|<τ glyphs that
// encode sub-cell gradients; ASCII-identity wants VISIBLE character glyphs). The two-sided
// acceptance rule pairs these proxies (must improve) with CAS/SSIM guardrail floors (must not
// drop) so proxy-gaming (spraying dense glyphs everywhere) is caught by the CAS floor.
//
// Every function is PURE over Grid / LinearImage / cell-mask (+ the immutable Atlas as the glyph
// coverage lookup table). The cell-mask is the per-CELL object mask (Uint8Array length cols*rows)
// produced by bench/cell-ac.ts (cellObjectMask 2D fallback or aovCellMask geometric) — the SAME
// mask CAS is aggregated over, so proxies and guardrails score the identical object cells.
//
// All proxies are reported over OBJECT cells only (denominator = mask cells).

// Visibility floor τ_vis: max-channel |F−B| (u8) below which a glyph is invisible ink. 24 u8 per
// ADR-0002 §5 / scientific ledger (the same threshold collapseThreshold zeroes, and below which
// stripping reverts the chafa gate by −0.0064). Uses the max-channel metric identically to
// MatchOptions.collapseThreshold (types.ts) so "readable" here == "not collapsed" there.
export const TAU_VIS = 24;

// Full block █ (U+2588): a fully-inked solid cell. It reproduces the cell DC exactly but carries
// NO character identity (indistinguishable from a colored rectangle), so it is excluded from the
// readability numerator and tracked separately (a high full-block rate is washout, not identity).
export const FULL_BLOCK = '█';

// max over channels of |F−B| in u8 (matches collapseThreshold's contrast metric). fg/bg null
// (no glyph / space with null fg) → 0 contrast.
function maxChannelContrast(cell: GridCell): number {
  const { fg, bg } = cell;
  if (!fg || !bg) return 0;
  return Math.max(Math.abs(fg[0] - bg[0]), Math.abs(fg[1] - bg[1]), Math.abs(fg[2] - bg[2]));
}

// A cell READS as a visible character glyph — the exact population ADR-0002 §5 defines identity
// over: not space, not a full block (fg==DC by construction, no character identity), and fg/bg
// separated by ≥ τ_vis. This is ALSO the only population the aesthetic features (glyph selection /
// shape-color coupling) modulate, so every identity proxy scores over it — NOT over full-block
// washout cells (whose fg trivially equals the cell DC) or gated/near-floor cells (whose fg is
// invisible ink equal to the cell mean); including those saturates the fg↔luma correlations toward
// the DC-reproduction identity regardless of any feature. A readable cell always has non-null fg/bg.
function isReadable(cell: GridCell): boolean {
  return cell.ch !== ' ' && cell.ch !== FULL_BLOCK && maxChannelContrast(cell) >= TAU_VIS;
}

// HSV saturation of an sRGB-u8 fg color in [0,1]: (max−min)/max (0 for pure black). Hue-agnostic
// chroma strength — the axis feat/shape-color-coupling modulates alongside lightness (ADR-0002 §5).
function fgSaturation(fg: [number, number, number]): number {
  const mx = Math.max(fg[0], fg[1], fg[2]);
  const mn = Math.min(fg[0], fg[1], fg[2]);
  return mx <= 0 ? 0 : (mx - mn) / mx;
}

// gamma-luma of an sRGB-u8 color in [0,1], via the SAME transfer pipeline as the reference
// channel (srgb→linear→luma→srgb) so fg lightness is comparable to cellMeanLuma01(ref).
function fgGammaLuma01(fg: [number, number, number]): number {
  const y = luma(srgbToLinear(fg[0]), srgbToLinear(fg[1]), srgbToLinear(fg[2]));
  return linearToSrgb(y) / 255;
}

// Pearson correlation; NaN when fewer than 2 points or either side has zero variance.
export function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2 || ys.length !== n) return NaN;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]!; sy += ys[i]!; }
  const mx = sx / n, my = sy / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx, dy = ys[i]! - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const den = Math.sqrt(sxx * syy);
  return den > 0 ? sxy / den : NaN;
}

function assertGridMask(grid: Grid, cellMask: Uint8Array): void {
  if (cellMask.length !== grid.cols * grid.rows) {
    throw new Error(`identity-proxies: mask length ${cellMask.length} != grid ${grid.cols}x${grid.rows}`);
  }
}

function countObj(cellMask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < cellMask.length; i++) if (cellMask[i]) n++;
  return n;
}

// Glyph READABILITY rate: object cells that read as a visible character — not space, not a full
// block, and fg/bg separated by ≥ τ_vis — over all object cells. THE headline ASCII-identity proxy.
export function readabilityRate(grid: Grid, cellMask: Uint8Array): number {
  assertGridMask(grid, cellMask);
  let nObj = 0, nRead = 0;
  for (let i = 0; i < cellMask.length; i++) {
    if (!cellMask[i]) continue;
    nObj++;
    if (isReadable(grid.cells[i]!)) nRead++;
  }
  return nObj ? nRead / nObj : NaN;
}

// FULL-BLOCK rate: object cells emitting █ (solid, identity-free) over all object cells. High =
// washout. (ascii charset has no █, so this is ~0 there — the "not full-block" readability clause
// is then a no-op, by design.)
export function fullBlockRate(grid: Grid, cellMask: Uint8Array): number {
  assertGridMask(grid, cellMask);
  let nObj = 0, nFull = 0;
  for (let i = 0; i < cellMask.length; i++) {
    if (!cellMask[i]) continue;
    nObj++;
    if (grid.cells[i]!.ch === FULL_BLOCK) nFull++;
  }
  return nObj ? nFull / nObj : NaN;
}

// NEAR-FLOOR (invisible-ink) rate: object cells that PLACE a glyph (ch≠space) but whose fg/bg
// contrast is below τ_vis — faint sub-cell-gradient ink. This is the invisible-ink counterpart of
// readability; reconstruction WANTS it, ASCII-identity does not. Reported to make the explicit
// trade-off legible (a feature that raises readability by converting near-floor→visible is doing
// the intended exchange; one that only sprays new near-floor glyphs is not).
export function nearFloorRate(grid: Grid, cellMask: Uint8Array): number {
  assertGridMask(grid, cellMask);
  let nObj = 0, nFaint = 0;
  for (let i = 0; i < cellMask.length; i++) {
    if (!cellMask[i]) continue;
    nObj++;
    const cell = grid.cells[i]!;
    if (cell.ch !== ' ' && cell.ch !== FULL_BLOCK && maxChannelContrast(cell) < TAU_VIS) nFaint++;
  }
  return nObj ? nFaint / nObj : NaN;
}

// COVERAGE↔luma correlation: does the SELECTED glyph's ink area (Σα/P from the atlas) track the
// reference cell luma? feat/ascii-identity-selection modulates glyph AREA by region brightness
// (large-area glyphs in uniform/bright regions, small in subtle gradients), so a positive
// correlation is its signature. Pearson over object cells whose ch resolves in the atlas (space =
// 0 coverage resolves; non-atlas family glyphs are skipped). NaN if <2 resolvable cells.
export function coverageLumaCorr(grid: Grid, ref: LinearImage, atlas: Atlas, cellMask: Uint8Array): number {
  assertGridMask(grid, cellMask);
  const cov = new Map<string, number>();
  for (const g of atlas.glyphs) cov.set(g.ch, g.sumA / atlas.P);
  const refLuma = cellMeanLuma01(ref, grid.cellW, grid.cellH);
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < cellMask.length; i++) {
    if (!cellMask[i]) continue;
    const c = cov.get(grid.cells[i]!.ch);
    if (c === undefined) continue;
    xs.push(refLuma[i]!); ys.push(c);
  }
  return pearson(xs, ys);
}

// FG-luma↔ref-luma correlation: does the SELECTED fg lightness track the reference cell luma?
// feat/shape-color-coupling modulates glyph fg lightness by cell light level (ADR-0002 §5), so a
// positive correlation is its signature. Pearson over the READABLE glyph cells (isReadable) — the
// cells the feature actually modulates. Full-block cells (fg==DC by the two-color fit, DESIGN §3.3)
// and gated/near-floor cells (ch=space, or an invisible fg==cell-mean) are EXCLUDED: including them
// pins the correlation near the DC-reproduction identity (≈1) regardless of the feature, which would
// make the proxy blind to feat B. NaN if <2 readable cells.
export function fgLumaCorr(grid: Grid, ref: LinearImage, cellMask: Uint8Array): number {
  assertGridMask(grid, cellMask);
  const refLuma = cellMeanLuma01(ref, grid.cellW, grid.cellH);
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < cellMask.length; i++) {
    if (!cellMask[i]) continue;
    const cell = grid.cells[i]!;
    if (!isReadable(cell)) continue;
    xs.push(refLuma[i]!); ys.push(fgGammaLuma01(cell.fg!));
  }
  return pearson(xs, ys);
}

// FG-saturation↔ref-luma correlation: does the SELECTED fg SATURATION track the reference cell luma?
// ADR-0002 §5 pairs fg lightness AND saturation as the shape-color-coupling signature (셀 참조 휘도 ↔
// 선택 fg 명도/채도 상관), so this is the saturation half of fgLumaCorr. Same readable-cell population
// (feat B only modulates visible glyphs), same NaN rule. Reported alongside fgLumaCorr; the coupling
// is active when either lightness OR saturation tracks the cell light level.
export function fgSatCorr(grid: Grid, ref: LinearImage, cellMask: Uint8Array): number {
  assertGridMask(grid, cellMask);
  const refLuma = cellMeanLuma01(ref, grid.cellW, grid.cellH);
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < cellMask.length; i++) {
    if (!cellMask[i]) continue;
    const cell = grid.cells[i]!;
    if (!isReadable(cell)) continue;
    xs.push(refLuma[i]!); ys.push(fgSaturation(cell.fg!));
  }
  return pearson(xs, ys);
}

// Raster DC (cell-mean) luma error, u8: mean over object cells of |cellMean(raster)−cellMean(ref)|
// in gamma-luma u8. This is a GUARDRAIL-flavored proxy — the cell DC is exactly the term CAS is
// invariant to and the two-color fit reproduces exactly (DESIGN §3.3), so a well-behaved aesthetic
// feature keeps it ≈0; a feature that trades DC fidelity for glyph identity shows up here.
export function rasterDcLumaError(
  raster: LinearImage, ref: LinearImage, cellW: number, cellH: number, cellMask: Uint8Array,
): number {
  const rL = cellMeanLuma01(raster, cellW, cellH);
  const fL = cellMeanLuma01(ref, cellW, cellH);
  if (rL.length !== cellMask.length || fL.length !== cellMask.length) {
    throw new Error('rasterDcLumaError: cell-grid / mask size mismatch');
  }
  let acc = 0, n = 0;
  for (let i = 0; i < cellMask.length; i++) {
    if (!cellMask[i]) continue;
    acc += Math.abs(rL[i]! - fL[i]!) * 255;
    n++;
  }
  return n ? acc / n : NaN;
}

export interface ProxyResult {
  nObj: number;
  readabilityRate: number;   // ↑ = more visible-character cells (headline)
  fullBlockRate: number;     // ↓ = less solid-block washout
  nearFloorRate: number;     // invisible-ink fraction (trade-off tracker)
  coverageLumaCorr: number;  // feat A signature (glyph area ↔ luma)
  fgLumaCorr: number;        // feat B signature (fg lightness ↔ luma, readable cells)
  fgSatCorr: number;         // feat B signature (fg saturation ↔ luma, readable cells)
  rasterDcLumaError: number; // guardrail-flavored (cell-mean fidelity, u8)
}

// Convenience: all six proxies for one (grid, baked-raster, reference, atlas, object-mask) tuple.
export function identityProxies(
  grid: Grid, raster: LinearImage, ref: LinearImage, atlas: Atlas, cellMask: Uint8Array,
): ProxyResult {
  return {
    nObj: countObj(cellMask),
    readabilityRate: readabilityRate(grid, cellMask),
    fullBlockRate: fullBlockRate(grid, cellMask),
    nearFloorRate: nearFloorRate(grid, cellMask),
    coverageLumaCorr: coverageLumaCorr(grid, ref, atlas, cellMask),
    fgLumaCorr: fgLumaCorr(grid, ref, cellMask),
    fgSatCorr: fgSatCorr(grid, ref, cellMask),
    rasterDcLumaError: rasterDcLumaError(raster, ref, grid.cellW, grid.cellH, cellMask),
  };
}
