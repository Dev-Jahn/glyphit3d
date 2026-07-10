import type { Atlas, Grid } from '../../../src/core/types.js';
import { srgbToLinear } from '../../../src/core/color.js';
import { RASTER_WGSL, RASTER_SENTINEL, RASTER_MODE_GAMMA, RASTER_MODE_LINEAR } from './raster-wgsl.js';

// WebGPU output raster for the Q3 default web path (perf/gpu-rasterizer, SPEC §4.1, §4.5).
// It reproduces toRGBA(rasterizeGrid(grid, atlas, space)) on the GPU: one thread per output
// pixel, blending the CPU-assembled Grid's two-colour endpoints under the glyph coverage and
// packing RGBA8. The display raster stays a PURE FUNCTION OF THE EXPORTED Grid — endpoints
// are pre-transformed on the CPU here per fit space, so display colours equal the export
// colours (SPEC §4.1). Own device/pipeline/atlas buffers (do NOT share GpuMatcher's).

// esbuild (vite/vitest) erases type annotations without resolving them, so the standard
// WebGPU type names document intent without needing @webgpu/types installed (matches
// gpu-matcher.ts).
/* eslint-disable @typescript-eslint/no-explicit-any */
type GPUDevice = any;
type GPUBuffer = any;
type GPUComputePipeline = any;

const F32 = Float32Array.BYTES_PER_ELEMENT;
const U32 = Uint32Array.BYTES_PER_ELEMENT;

// Usage flags (numeric, matching gpu-matcher.ts — @webgpu/types is not installed).
const STORAGE = 0x80;
const UNIFORM = 0x40;
const COPY_DST = 0x8;
const COPY_SRC = 0x4;
const MAP_READ = 0x1;
const QUERY_RESOLVE = 0x200;

export function spaceToMode(space: 'linear' | 'gamma'): number {
  return space === 'gamma' ? RASTER_MODE_GAMMA : RASTER_MODE_LINEAR;
}

// ch → glyph index with LAST-WINS semantics, byte-identical to rasterizeGrid's
// `new Map<string, Glyph>(); for (g of atlas.glyphs) map.set(g.ch, g)` — the later duplicate
// ch overwrites (SPEC RISKS: parity-page's chIdx is first-wins; do NOT copy that).
export function buildGlyphIndex(atlas: Atlas): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < atlas.glyphs.length; i++) m.set(atlas.glyphs[i]!.ch, i);
  return m;
}

// Per-cell GPU inputs from the assembled Grid. glyphIdx: resolved index or SENTINEL (missing
// glyph → α ≡ 0). fgbg: the two endpoints pre-transformed per fit space —
//   gamma:  u8-as-f32 (0..255), the encode is round+clamp of the integer-scale blend (the
//           u8 → linear-f32 → u8 round-trip is the identity, SPEC §4.1/§5.2);
//   linear: f32(srgbToLinear(u8)) — the f64 LUT value rounded once to f32, exactly what a
//           Float32Array store does on the CPU path.
// A null cell → SENTINEL + fg=bg=0 (mirrors rasterizeGrid's `if (!cell) continue;`, which
// leaves the pixels at the Float32Array zero default). A present cell whose ch is unknown →
// SENTINEL (α ≡ 0) but its REAL endpoints, so the pixel is the background (mirrors
// `map.get(cell.ch)?.alpha ?? 0`). A null fg/bg → [0,0,0] (mirrors toU8/toLinear).
export function packCells(
  grid: Grid,
  glyphIndex: Map<string, number>,
  space: 'linear' | 'gamma',
): { glyphIdx: Uint32Array; fgbg: Float32Array } {
  const numCells = grid.cols * grid.rows;
  const glyphIdx = new Uint32Array(numCells);
  const fgbg = new Float32Array(numCells * 6);
  const linear = space === 'linear';
  for (let i = 0; i < numCells; i++) {
    const cell = grid.cells[i];
    if (!cell) { glyphIdx[i] = RASTER_SENTINEL; continue; } // fgbg stays 0
    const gi = glyphIndex.get(cell.ch);
    glyphIdx[i] = gi === undefined ? RASTER_SENTINEL : gi;
    const o = i * 6;
    const fg = cell.fg, bg = cell.bg;
    if (linear) {
      if (fg) { fgbg[o] = srgbToLinear(fg[0]); fgbg[o + 1] = srgbToLinear(fg[1]); fgbg[o + 2] = srgbToLinear(fg[2]); }
      if (bg) { fgbg[o + 3] = srgbToLinear(bg[0]); fgbg[o + 4] = srgbToLinear(bg[1]); fgbg[o + 5] = srgbToLinear(bg[2]); }
    } else {
      if (fg) { fgbg[o] = fg[0]; fgbg[o + 1] = fg[1]; fgbg[o + 2] = fg[2]; }
      if (bg) { fgbg[o + 3] = bg[0]; fgbg[o + 4] = bg[1]; fgbg[o + 5] = bg[2]; }
    }
  }
  return { glyphIdx, fgbg };
}

// Cell-buffer reuse decision. glyphIdxBuf (numCells·U32) and fgbgBuf (numCells·6·F32) are
// sized ONLY by numCells (both are per-cell, P-independent — unlike GpuMatcher's targetBuf),
// so a change in numCells alone forces a realloc. `prev` is null before the first allocation.
export function needsRasterCellRealloc(prev: { numCells: number } | null, numCells: number): boolean {
  return prev === null || prev.numCells !== numCells;
}

// Pixel-buffer reuse decision. outPixBuf/stagingBuf are sized by the pixel count w·h.
export function needsRasterPixRealloc(prev: { pixels: number } | null, pixels: number): boolean {
  return prev === null || prev.pixels !== pixels;
}

export interface RasterResult {
  data: Uint8ClampedArray; // w*h*4 little-endian RGBA8, ready for putImageData
  w: number;
  h: number;
  rasterGpuMs: number;  // pure GPU compute-pass time from timestamp-query (0 if unsupported)
  rasterWallMs: number; // dispatch → readback wall-clock + staging copy (SPEC §4.5 timings.raster)
}

export class GpuRaster {
  private readonly device: GPUDevice;
  private readonly pipeline: GPUComputePipeline;
  private readonly hasTimestamp: boolean;
  private querySet: any = null;
  private queryResolve: GPUBuffer | null = null;
  private queryStaging: GPUBuffer | null = null;
  private lost = false;

  // atlas-scoped (own alpha copy — do NOT share GpuMatcher's; re-uploaded on charset change).
  private atlasRef: Atlas | null = null;
  private atlasP = 0;
  private glyphIndex: Map<string, number> = new Map();
  private alphaBuf: GPUBuffer | null = null;

  // run-scoped: cell buffers (by numCells) and pixel buffers (by w·h).
  private numCells = 0;
  private glyphIdxBuf: GPUBuffer | null = null;
  private fgbgBuf: GPUBuffer | null = null;
  private pixels = 0;
  private outPixBuf: GPUBuffer | null = null;
  private stagingBuf: GPUBuffer | null = null;
  private readonly paramsBuf: GPUBuffer;

  private constructor(device: GPUDevice, hasTimestamp: boolean) {
    this.device = device;
    this.hasTimestamp = hasTimestamp;
    const module = device.createShaderModule({ code: RASTER_WGSL });
    // Pipeline is compiled here at construction (SPEC §9 cold-start: not compile-bound on the
    // first rematch — Pipeline builds GpuRaster alongside GpuMatcher.create).
    this.pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    // Params: 7·u32 = 28B, rounded up to the 16B uniform-struct stride → 32B.
    this.paramsBuf = device.createBuffer({ size: 32, usage: UNIFORM | COPY_DST });
    if (hasTimestamp) {
      this.querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
      this.queryResolve = device.createBuffer({ size: 16, usage: QUERY_RESOLVE | COPY_SRC });
      this.queryStaging = device.createBuffer({ size: 16, usage: MAP_READ | COPY_DST });
    }
    device.lost.then((info: any) => { this.lost = true; void info; });
  }

  // Availability probe (SPEC §1 fallback semantics). Own device (do NOT share GpuMatcher's;
  // buffers are device-scoped). Returns null when WebGPU is absent / request fails → the
  // caller keeps the CPU pool raster.
  static async create(): Promise<GpuRaster | null> {
    const gpu = (navigator as any).gpu;
    if (!gpu) return null;
    try {
      const adapter = await gpu.requestAdapter();
      if (!adapter) return null;
      const hasTimestamp = !!adapter.features?.has?.('timestamp-query');
      const device = await adapter.requestDevice(hasTimestamp ? { requiredFeatures: ['timestamp-query'] } : {});
      if (!device) return null;
      return new GpuRaster(device, hasTimestamp);
    } catch {
      return null;
    }
  }

  get available(): boolean { return !this.lost; }

  private ensureAtlas(atlas: Atlas): void {
    if (this.atlasRef === atlas) return;
    const G = atlas.glyphs.length;
    const P = atlas.P;
    const alpha = new Float32Array(G * P);
    for (let g = 0; g < G; g++) alpha.set(atlas.glyphs[g]!.alpha, g * P);
    this.alphaBuf?.destroy();
    this.alphaBuf = this.device.createBuffer({ size: alpha.byteLength, usage: STORAGE | COPY_DST });
    this.device.queue.writeBuffer(this.alphaBuf, 0, alpha);
    this.atlasRef = atlas;
    this.atlasP = P;
    this.glyphIndex = buildGlyphIndex(atlas);
  }

  private ensureCellBuffers(numCells: number): void {
    const prev = this.glyphIdxBuf ? { numCells: this.numCells } : null;
    if (!needsRasterCellRealloc(prev, numCells)) return;
    this.glyphIdxBuf?.destroy();
    this.fgbgBuf?.destroy();
    this.glyphIdxBuf = this.device.createBuffer({ size: numCells * U32, usage: STORAGE | COPY_DST });
    this.fgbgBuf = this.device.createBuffer({ size: numCells * 6 * F32, usage: STORAGE | COPY_DST });
    this.numCells = numCells;
  }

  private ensurePixBuffers(pixels: number): void {
    const prev = this.outPixBuf ? { pixels: this.pixels } : null;
    if (!needsRasterPixRealloc(prev, pixels)) return;
    this.outPixBuf?.destroy();
    this.stagingBuf?.destroy();
    this.outPixBuf = this.device.createBuffer({ size: pixels * U32, usage: STORAGE | COPY_SRC });
    this.stagingBuf = this.device.createBuffer({ size: pixels * U32, usage: MAP_READ | COPY_DST });
    this.pixels = pixels;
  }

  // Render the assembled Grid to a display RGBA8 raster. `space` MUST equal the fit space that
  // produced the cells (ledger rule: fit-space and raster-space are always paired) — it selects
  // both the endpoint pre-transform here and the kernel's encode.
  async render(grid: Grid, atlas: Atlas, space: 'linear' | 'gamma'): Promise<RasterResult> {
    if (this.lost) throw new Error('gpu-raster: device lost');
    const { cellW, cellH } = atlas;
    const P = atlas.P;
    const w = grid.cols * cellW;
    const h = grid.rows * cellH;
    const numCells = grid.cols * grid.rows;
    const pixels = w * h;

    this.ensureAtlas(atlas);
    this.ensureCellBuffers(numCells);
    this.ensurePixBuffers(pixels);

    const { glyphIdx, fgbg } = packCells(grid, this.glyphIndex, space);
    const dev = this.device;
    dev.queue.writeBuffer(this.glyphIdxBuf, 0, glyphIdx);
    dev.queue.writeBuffer(this.fgbgBuf, 0, fgbg);

    const pbuf = new ArrayBuffer(32);
    const pv = new DataView(pbuf);
    pv.setUint32(0, w, true);
    pv.setUint32(4, h, true);
    pv.setUint32(8, grid.cols, true);
    pv.setUint32(12, cellW, true);
    pv.setUint32(16, cellH, true);
    pv.setUint32(20, P, true);
    pv.setUint32(24, spaceToMode(space), true);
    dev.queue.writeBuffer(this.paramsBuf, 0, pbuf);

    const bind = dev.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.alphaBuf } },
        { binding: 1, resource: { buffer: this.glyphIdxBuf } },
        { binding: 2, resource: { buffer: this.fgbgBuf } },
        { binding: 3, resource: { buffer: this.outPixBuf } },
        { binding: 4, resource: { buffer: this.paramsBuf } },
      ],
    });

    const tRaster = performance.now();
    const enc = dev.createCommandEncoder();
    const passDesc = this.hasTimestamp
      ? { timestampWrites: { querySet: this.querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } }
      : {};
    const pass = enc.beginComputePass(passDesc);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bind);
    // 16×16 workgroups over w×h; the kernel guards x≥w / y≥h.
    pass.dispatchWorkgroups(Math.ceil(w / 16), Math.ceil(h / 16));
    pass.end();
    if (this.hasTimestamp) {
      enc.resolveQuerySet(this.querySet, 0, 2, this.queryResolve, 0);
      enc.copyBufferToBuffer(this.queryResolve, 0, this.queryStaging, 0, 16);
    }
    enc.copyBufferToBuffer(this.outPixBuf, 0, this.stagingBuf, 0, pixels * U32);
    dev.queue.submit([enc.finish()]);

    await dev.queue.onSubmittedWorkDone();
    const maps = [this.stagingBuf.mapAsync(MAP_READ)];
    if (this.hasTimestamp) maps.push(this.queryStaging.mapAsync(MAP_READ));
    await Promise.all(maps);
    const data = new Uint8ClampedArray(this.stagingBuf.getMappedRange().slice(0));
    let rasterGpuMs = 0;
    if (this.hasTimestamp) {
      const ts = new BigUint64Array(this.queryStaging.getMappedRange().slice(0));
      rasterGpuMs = Number(ts[1]! - ts[0]!) / 1e6; // timestamp ticks are nanoseconds
      this.queryStaging.unmap();
    }
    this.stagingBuf.unmap();
    const rasterWallMs = performance.now() - tRaster;

    return { data, w, h, rasterGpuMs, rasterWallMs };
  }
}
