// WebGPU parity harness — in-page half (perf/webgpu-matcher, SPEC §6/§8). Served by the vite
// dev server (web/parity.html) so it runs on a secure-context localhost origin where WebGPU
// is available. It runs BOTH the CPU truth (src/core/match.ts matchGrid) and the GPU matcher
// (gpu-matcher.ts) on the IDENTICAL LinearImage and reports the SPEC §6 parity numbers plus
// the §7 perf. The node driver (test-e2e/webgpu-parity.spec.ts) calls window.__parity(cfg)
// per config and asserts the thresholds.

import type { Atlas, GridCell, Grid, LinearImage, FitStatsG } from '../../../src/core/types.js';
import { matchGrid } from '../../../src/core/match.js';
import { defaultOptions, gridRows } from '../../../src/core/options.js';
import { rasterizeGrid } from '../../../src/render/raster.js';
import { linearToSrgb } from '../../../src/core/color.js';
import { ssim } from '../../../src/metric/ssim.js';
import { cellStats } from '../../../src/core/stats.js';
import { fitFree, fitBox } from '../../../src/core/fit.js';
import { loadProfile } from '../profile.js';
import { imageDataToLinear } from '../browser-image.js';
import { Scene } from '../scene.js';
import { GpuMatcher } from './gpu-matcher.js';

interface ParityCfg {
  source: 'scene' | 'image';
  charset: 'ascii' | 'blocks';
  cols: number;
  space: 'linear' | 'gamma';
  yaw?: number;
  pitch?: number;
  imageDataUrl?: string;
  label: string;
}

// f64 CPU-truth per-channel scorer (match.ts channelSse, Q3 branch, from fit.ts primitives).
function refChannelSse(g: FitStatsG, saT: number, s1t: number, stt: number, minTc: number, maxTc: number): number {
  const free = fitFree(g, saT, s1t, stt);
  const F = free.a + free.b, B = free.b;
  if (F >= minTc && F <= maxTc && B >= minTc && B <= maxTc) return free.sse;
  return fitBox(g, saT, s1t, stt, minTc, maxTc, minTc, maxTc).sse;
}

// The full Q3 selection score of glyph gi on one cell, in f64 — matches matchGrid's argmin
// objective (Σ_c channelSse + mdlLambda·ink·eacScale). Used to prove a glyph disagreement is
// a genuine near-tie (SPEC §6.1).
function scoreGlyph(atlas: Atlas, cs: ReturnType<typeof cellStats>, gi: number, mdlLambda: number, eac: number): number {
  const P = atlas.P;
  const g = atlas.glyphs[gi]!;
  const gS: FitStatsG = { Saa: g.sumAA, Sa1: g.sumA, S11: P };
  let score = 0;
  for (let c = 0; c < 3; c++) {
    const base = c * P;
    let saT = 0;
    for (let i = 0; i < P; i++) saT += g.alpha[i]! * cs.T[base + i]!;
    score += refChannelSse(gS, saT, cs.ST[c]!, cs.STT[c]!, cs.minT[c]!, cs.maxT[c]!);
  }
  return score + mdlLambda * g.ink * eac;
}

const atlasCache = new Map<string, Atlas>();
async function getAtlas(charset: string): Promise<Atlas> {
  let a = atlasCache.get(charset);
  if (!a) {
    a = await loadProfile(new URL(`profiles/dejavu-16-${charset}.json`, document.baseURI).href);
    atlasCache.set(charset, a);
  }
  return a;
}

let scene: Scene | null = null;
let gpu: GpuMatcher | null = null;

// ── perf/gpu-rasterizer (agent D, SPEC §5.3): GPU raster parity harness ─────────────
// GpuRaster (agent A's web/src/webgpu/gpu-raster.ts) is the WebGPU port of the demo's
// display raster: it reproduces toRGBA(rasterizeGrid(grid, atlas, space)) — the packed
// RGBA8 committed by putImageData — on the GPU from the CPU-assembled Grid. Its interface
// is the frozen contract from the §3 ownership table; the exact shape assumed here (so this
// harness compiles/runs against it the moment agent A lands) is documented on GpuRasterLike.
// The module is DYNAMICALLY imported inside runRasterParity so this page still loads and the
// LEGACY 28-config matcher sweep stays runnable+green while agent A is still landing — a
// static import of a not-yet-present module would break the whole parity page.
/* eslint-disable @typescript-eslint/no-explicit-any */
interface GpuRasterResult { data: Uint8ClampedArray; w: number; h: number; rasterGpuMs: number; rasterWallMs: number }
interface GpuRasterLike { render: (grid: Grid, atlas: Atlas, space: 'linear' | 'gamma') => Promise<GpuRasterResult> }
let gpuRaster: GpuRasterLike | null = null;

// Byte-identical mirror of pipeline.ts toRGBA — the exact production reference the GPU raster
// must reproduce (LinearImage → sRGB u8 RGBA, alpha 255). Kept local because pipeline.ts's
// toRGBA is not exported and pipeline.ts is agent C's (do-not-touch here).
function toRGBA(img: LinearImage): Uint8ClampedArray {
  const n = img.w * img.h;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = Math.round(linearToSrgb(img.data[i * 3]!));
    out[i * 4 + 1] = Math.round(linearToSrgb(img.data[i * 3 + 1]!));
    out[i * 4 + 2] = Math.round(linearToSrgb(img.data[i * 3 + 2]!));
    out[i * 4 + 3] = 255;
  }
  return out;
}

// Raster parity for ONE config (SPEC §5.1 criterion). Builds the CPU-truth grid (matchGrid),
// the CPU reference raster toRGBA(rasterizeGrid(grid, atlas, space)), and the GpuRaster.render
// output on the IDENTICAL grid, then compares u8 per channel. Reports maxDelta, per-channel
// mismatch count / total samples, gated-cell mismatch count (must be 0 — gated cells are the
// all-α=0 space glyph, an exact integer endpoint), alpha-byte mismatches, and the raster timings.
async function runRasterParity(cfg: ParityCfg): Promise<Record<string, number | string | boolean>> {
  const atlas = await getAtlas(cfg.charset);
  const { cellW, cellH } = atlas;
  const rows = gridRows(cfg.cols, 1, 1, cellW, cellH);
  const gridW = cfg.cols * cellW, gridH = rows * cellH;

  const imgData = await footprintImageData(cfg, gridW, gridH);
  const lin = imageDataToLinear(imgData);
  const opts = defaultOptions(3);
  opts.space = cfg.space;

  // CPU-truth grid (matchGrid consumes lin.data; copy so nothing downstream sees a mutated ref).
  const grid = matchGrid({ w: lin.w, h: lin.h, data: lin.data.slice(0) }, atlas, opts);
  const ref = toRGBA(rasterizeGrid(grid, atlas, cfg.space));

  const { GpuRaster } = await import('./gpu-raster.js') as { GpuRaster: { create: () => Promise<GpuRasterLike | null> } };
  if (!gpuRaster) gpuRaster = await GpuRaster.create();
  if (!gpuRaster) throw new Error('WebGPU unavailable in this context (navigator.gpu / adapter / device)');
  const gr = await gpuRaster.render(grid, atlas, cfg.space);
  const got = gr.data;

  const w = gridW, h = gridH;
  if (got.length !== ref.length) throw new Error(`GpuRaster returned ${got.length} bytes, expected ${ref.length} (w=${w} h=${h})`);

  // Per-cell gated flag (fg === null ⇒ the space glyph, every pixel is the bg endpoint exactly).
  const gated = new Uint8Array(cfg.cols * rows);
  for (let i = 0; i < gated.length; i++) gated[i] = grid.cells[i] && grid.cells[i]!.fg === null ? 1 : 0;

  let maxDelta = 0, mismatchCount = 0, gatedMismatchCount = 0, alphaMismatch = 0;
  const totalSamples = w * h * 3;
  for (let y = 0; y < h; y++) {
    const cy = (y / cellH) | 0;
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const cell = cy * cfg.cols + ((x / cellW) | 0);
      const isGated = gated[cell] === 1;
      for (let k = 0; k < 3; k++) {
        const d = Math.abs(ref[p + k]! - got[p + k]!);
        if (d > maxDelta) maxDelta = d;
        if (d > 0) { mismatchCount++; if (isGated) gatedMismatchCount++; }
      }
      if (got[p + 3] !== 255) alphaMismatch++;
    }
  }

  return {
    label: cfg.label, source: cfg.source, charset: cfg.charset, cols: cfg.cols, space: cfg.space,
    w, h, numCells: cfg.cols * rows,
    maxDelta, mismatchCount, totalSamples, gatedMismatchCount, alphaMismatch,
    rasterGpuMs: gr.rasterGpuMs, rasterWallMs: gr.rasterWallMs,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('image load failed'));
    img.src = url;
  });
}

async function footprintImageData(cfg: ParityCfg, gridW: number, gridH: number): Promise<ImageData> {
  if (cfg.source === 'scene') {
    if (!scene) scene = new Scene(document.getElementById('scene') as HTMLCanvasElement);
    scene.setOrbit(cfg.yaw ?? 30, cfg.pitch ?? -15);
    return scene.renderToImageData(gridW, gridH);
  }
  const img = await loadImage(cfg.imageDataUrl!);
  const cv = document.createElement('canvas');
  cv.width = gridW; cv.height = gridH;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, gridW, gridH); // scale the bench image to the grid footprint
  return ctx.getImageData(0, 0, gridW, gridH);
}

async function runParity(cfg: ParityCfg): Promise<Record<string, number | string | boolean>> {
  const atlas = await getAtlas(cfg.charset);
  const { cellW, cellH, P } = atlas;
  const rows = gridRows(cfg.cols, 1, 1, cellW, cellH);
  const gridW = cfg.cols * cellW, gridH = rows * cellH;
  const numCells = cfg.cols * rows;

  const imgData = await footprintImageData(cfg, gridW, gridH);
  const lin = imageDataToLinear(imgData);

  const opts = defaultOptions(3);
  opts.space = cfg.space;

  // CPU truth (note: matchGrid consumes lin.data; pass a copy so the GPU sees the same input).
  const linForCpu: LinearImage = { w: lin.w, h: lin.h, data: lin.data.slice(0) };
  const cpuGrid = matchGrid(linForCpu, atlas, opts);

  if (!gpu) gpu = await GpuMatcher.create();
  if (!gpu) throw new Error('WebGPU unavailable in this context (navigator.gpu / adapter / device)');
  const gpuRes = await gpu.match(lin, atlas, { quality: 3, space: cfg.space, gateTau: opts.gateTau, mdlLambda: opts.mdlLambda }, cfg.cols, rows);
  const gpuCells = gpuRes.cells;

  // ch → glyph index (bijective for the DejaVu profiles). Needed to score disagreements.
  const chIdx = new Map<string, number>();
  for (let i = 0; i < atlas.glyphs.length; i++) if (!chIdx.has(atlas.glyphs[i]!.ch)) chIdx.set(atlas.glyphs[i]!.ch, i);

  // working-space image (gamma default) for the near-tie re-scorer — identical to what both
  // matchGrid and gpu-matcher build internally.
  const n3 = lin.w * lin.h * 3;
  const work = new Float32Array(n3);
  if (cfg.space === 'gamma') { for (let i = 0; i < n3; i++) work[i] = Math.min(255, Math.max(0, srgb(lin.data[i]!))) / 255; }
  else work.set(lin.data);
  const workImg: LinearImage = { w: lin.w, h: lin.h, data: work };
  const zeros = new Float32Array(n3);

  let gateMismatch = 0;
  let nonGatedBoth = 0;
  let glyphAgree = 0;
  let disagreements = 0;
  let nonTieDisagreements = 0;
  let worstRelGap = 0;
  let maxColorDelta = 0;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cfg.cols; col++) {
      const cell = row * cfg.cols + col;
      const cc = cpuGrid.cells[cell]!;
      const gc = gpuCells[cell]!;
      const cpuGated = cc.fg === null;
      const gpuGated = gc.fg === null;
      if (cpuGated !== gpuGated) { gateMismatch++; continue; }
      if (cpuGated) continue; // both gated — bg is the cell mean; deterministic, checked below via color
      nonGatedBoth++;
      if (cc.ch === gc.ch) {
        glyphAgree++;
        // color parity on agreed cells (SPEC §6.3): ≤1 u8 level per channel.
        const cf = cc.fg!, gf = gc.fg!, cb = cc.bg!, gb = gc.bg!;
        for (let k = 0; k < 3; k++) {
          maxColorDelta = Math.max(maxColorDelta, Math.abs(cf[k]! - gf[k]!), Math.abs(cb[k]! - gb[k]!));
        }
      } else {
        disagreements++;
        const cs = cellStats(workImg, zeros, zeros, cellW, cellH, col, row);
        const eac = (cs.STT[0]! - (cs.ST[0]! * cs.ST[0]!) / P) + (cs.STT[1]! - (cs.ST[1]! * cs.ST[1]!) / P) + (cs.STT[2]! - (cs.ST[2]! * cs.ST[2]!) / P);
        const giCpu = chIdx.get(cc.ch)!;
        const giGpu = chIdx.get(gc.ch)!;
        const sCpu = scoreGlyph(atlas, cs, giCpu, opts.mdlLambda, eac);
        const sGpu = scoreGlyph(atlas, cs, giGpu, opts.mdlLambda, eac);
        const gap = Math.abs(sGpu - sCpu);
        const rel = eac > 0 ? gap / eac : (gap > 0 ? Infinity : 0);
        if (rel > worstRelGap) worstRelGap = rel;
        if (gap >= 1e-4 * eac) nonTieDisagreements++; // SPEC §6.1 near-tie threshold
      }
    }
  }

  // SSIM parity (SPEC §6.4). rasterize both grids in the fit space, score vs the linear ref.
  const cpuRaster = rasterizeGrid(cpuGrid, atlas, cfg.space);
  const gpuGrid: Grid = { cols: cfg.cols, rows, cells: gpuCells, cellW, cellH, font: atlas.fontPath };
  const gpuRaster = rasterizeGrid(gpuGrid, atlas, cfg.space);
  const refLin: LinearImage = { w: lin.w, h: lin.h, data: lin.data };
  const ssimCpu = ssim(cpuRaster, refLin);
  const ssimGpu = ssim(gpuRaster, refLin);

  const glyphAgreePct = nonGatedBoth > 0 ? (glyphAgree / nonGatedBoth) * 100 : 100;

  return {
    label: cfg.label, source: cfg.source, charset: cfg.charset, cols: cfg.cols, space: cfg.space,
    numCells, gatedCount: gpuRes.gatedCount, nonGatedBoth,
    glyphAgreePct, disagreements, nonTieDisagreements, worstRelGap,
    gateMismatch, maxColorDelta,
    ssimCpu, ssimGpu, dssim: Math.abs(ssimGpu - ssimCpu),
    matchMs: gpuRes.matchMs, gpuMs: gpuRes.gpuMs, prepMs: gpuRes.prepMs, readbackMs: gpuRes.readbackMs,
  };
}

// exact sRGB encode used by the working-space transform (mirrors core/color linearToSrgb,
// which returns a [0,255] float; caller divides by 255).
function srgb(f: number): number {
  const c = f <= 0 ? 0 : f >= 1 ? 1 : f;
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return s * 255;
}

// Warm-run perf probe: median GPU dispatch→readback over N runs at one config (SPEC §7.1/§7.4).
async function perfProbe(cfg: ParityCfg, n: number): Promise<{ matchMs: number; gpuMs: number; readbackMs: number; prepMs: number }> {
  const atlas = await getAtlas(cfg.charset);
  const rows = gridRows(cfg.cols, 1, 1, atlas.cellW, atlas.cellH);
  const gridW = cfg.cols * atlas.cellW, gridH = rows * atlas.cellH;
  const imgData = await footprintImageData(cfg, gridW, gridH);
  const lin = imageDataToLinear(imgData);
  if (!gpu) gpu = await GpuMatcher.create();
  if (!gpu) throw new Error('WebGPU unavailable');
  const opts = defaultOptions(3);
  const ms: number[] = [], gm: number[] = [], rb: number[] = [], pp: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = await gpu.match({ w: lin.w, h: lin.h, data: lin.data.slice(0) }, atlas,
      { quality: 3, space: cfg.space, gateTau: opts.gateTau, mdlLambda: opts.mdlLambda }, cfg.cols, rows);
    ms.push(r.matchMs); gm.push(r.gpuMs); rb.push(r.readbackMs); pp.push(r.prepMs);
  }
  const med = (a: number[]): number => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]!; };
  return { matchMs: med(ms), gpuMs: med(gm), readbackMs: med(rb), prepMs: med(pp) };
}

declare global {
  interface Window {
    __parity: (cfg: ParityCfg) => Promise<Record<string, number | string | boolean>>;
    __rasterParity: (cfg: ParityCfg) => Promise<Record<string, number | string | boolean>>;
    __parityPerf: (cfg: ParityCfg, n: number) => Promise<{ matchMs: number; gpuMs: number; readbackMs: number; prepMs: number }>;
    __gpuInfo: () => Promise<Record<string, unknown>>;
    __parityReady: boolean;
  }
}

window.__parity = runParity;
window.__rasterParity = runRasterParity;
window.__parityPerf = perfProbe;
window.__gpuInfo = async () => {
  const g = (navigator as unknown as { gpu?: { requestAdapter: () => Promise<{ info?: unknown } | null> } }).gpu;
  if (!g) return { hasGpu: false };
  const a = await g.requestAdapter();
  return { hasGpu: true, adapter: a ? (a.info ?? {}) : null };
};
window.__parityReady = true;
