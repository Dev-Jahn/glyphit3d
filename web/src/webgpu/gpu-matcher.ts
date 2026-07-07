import type { Atlas, GridCell, LinearImage } from '../../../src/core/types.js';
import { linearToSrgb } from '../../../src/core/color.js';
import { MATCHER_WGSL } from './matcher-wgsl.js';

// WebGPU compute matcher for the Q3 default web path (perf/webgpu-matcher, SPEC §1–§5).
// It reproduces matchGrid's Q3/gamma outcome (families=[], topK=0, orientKappa=0, no AOV,
// collapseThreshold=0). The heavy per-glyph inner product + closed-form fit run on the GPU
// (matcher-wgsl.ts); the per-cell target stats and the contrast gate run on the CPU here so
// the gate stays byte-identical to src/core/match.ts and the working-space transform + the
// output sRGB encode exactly mirror the CPU path. Everything else routes to the CPU pool.

// esbuild (vite/vitest) erases type annotations without resolving them, so the standard
// WebGPU type names document intent without needing @webgpu/types installed.
/* eslint-disable @typescript-eslint/no-explicit-any */
type GPUDevice = any;
type GPUBuffer = any;
type GPUComputePipeline = any;

const F32 = Float32Array.BYTES_PER_ELEMENT;

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
// gamma working value (already sRGB-encoded [0,1]) → u8 directly (match.ts gammaU8).
function gammaU8(v: number): number { return Math.round(clamp01(v) * 255); }
// linear working value → sRGB u8 (match.ts toU8).
function toU8(v: number): number { const s = Math.round(linearToSrgb(v)); return s < 0 ? 0 : s > 255 ? 255 : s; }

export interface GpuMatchOpts {
  quality: 3;                    // round 1: Q3 only (asserted by the caller's routing)
  space: 'linear' | 'gamma';
  gateTau: number;
  mdlLambda: number;
}

export interface GpuMatchResult {
  cells: GridCell[];
  matchMs: number;    // GPU dispatch → readback wall-clock (SPEC §5 timings.match / §7.1)
  gpuMs: number;      // pure GPU compute-pass time from timestamp-query (0 if unsupported)
  readbackMs: number; // wall-clock from GPU-work-done to mapped read (map latency, SPEC §7.4)
  prepMs: number;     // CPU working-space transform + per-cell stats + gate + upload prep
  gatedCount: number;
}

// matcher-wgsl.ts declares the per-cell workgroup scratch as `array<f32, WG_SCRATCH_F32>`
// (= 3·256); main() writes sT[idx] for idx < 3·P, so P must satisfy 3·P ≤ WG_SCRATCH_F32
// (P ≤ 256) or every dispatch OOBs the workgroup array. All bundled DejaVu profiles are
// P = 190, but DESIGN §5.4 browser TTF profiling yields P = cellW·cellH from an arbitrary
// font/size, which can exceed 256 — so match() enforces this bound before touching the GPU
// and throws a catchable error that pipeline.ts routes to the CPU pool.
export const WG_SCRATCH_F32 = 768;

export function pExceedsScratch(P: number): boolean {
  return 3 * P > WG_SCRATCH_F32;
}

export function assertPWithinScratch(P: number): void {
  if (pExceedsScratch(P)) {
    throw new Error(`gpu-matcher: P=${P} exceeds workgroup scratch (3P must be <= ${WG_SCRATCH_F32}); use CPU pool`);
  }
}

// Cell-buffer reuse decision. targetBuf is sized numCells·3·P·F32, so a change in EITHER
// numCells or P (a new atlas with the same cols·rows footprint but a larger glyph cell)
// must recreate the P-sized buffer — reusing a too-small targetBuf drops the writeBuffer
// (offset+size > buffer.size) and silently produces wrong output. `prev` is null before the
// first allocation.
export function needsCellBufferRealloc(
  prev: { numCells: number; P: number } | null,
  numCells: number,
  P: number,
): boolean {
  return prev === null || prev.numCells !== numCells || prev.P !== P;
}

export class GpuMatcher {
  private readonly device: GPUDevice;
  private readonly pipeline: GPUComputePipeline;
  private readonly hasTimestamp: boolean;
  private querySet: any = null;
  private queryResolve: GPUBuffer | null = null;
  private queryStaging: GPUBuffer | null = null;
  private lost = false;

  // atlas-scoped (re-uploaded only on charset change).
  private atlasRef: Atlas | null = null;
  private G = 0;
  private P = 0;
  private alphaBuf: GPUBuffer | null = null;
  private gscalBuf: GPUBuffer | null = null;

  // run-scoped (re-created when the cell count OR the glyph-cell P changes — targetBuf is
  // sized by both).
  private numCells = 0;
  private cellP = 0;
  private targetBuf: GPUBuffer | null = null;
  private cstatBuf: GPUBuffer | null = null;
  private outGlyphBuf: GPUBuffer | null = null;
  private outFBBuf: GPUBuffer | null = null;
  private stagingGlyph: GPUBuffer | null = null;
  private stagingFB: GPUBuffer | null = null;
  private paramsBuf: GPUBuffer;

  // reused CPU scratch (avoid per-run reallocation of the big host arrays).
  private work: Float32Array | null = null;   // working-space image (w*h*3)
  private targetHost: Float32Array | null = null; // cells*3*P
  private cstatHost: Float32Array | null = null;  // cells*16

  private constructor(device: GPUDevice, hasTimestamp: boolean) {
    this.device = device;
    this.hasTimestamp = hasTimestamp;
    const module = device.createShaderModule({ code: MATCHER_WGSL });
    this.pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    this.paramsBuf = device.createBuffer({ size: 16, usage: 0x40 /* UNIFORM */ | 0x8 /* COPY_DST */ });
    if (hasTimestamp) {
      this.querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
      this.queryResolve = device.createBuffer({ size: 16, usage: 0x200 /* QUERY_RESOLVE */ | 0x4 /* COPY_SRC */ });
      this.queryStaging = device.createBuffer({ size: 16, usage: 0x1 /* MAP_READ */ | 0x8 });
    }
    device.lost.then((info: any) => { this.lost = true; void info; });
  }

  // Availability probe (SPEC §1). Returns null when WebGPU is absent / adapter or device
  // request fails (non-secure origin, unsupported browser) → the caller uses the CPU pool.
  static async create(): Promise<GpuMatcher | null> {
    const gpu = (navigator as any).gpu;
    if (!gpu) return null;
    try {
      const adapter = await gpu.requestAdapter();
      if (!adapter) return null;
      const hasTimestamp = !!adapter.features?.has?.('timestamp-query');
      const device = await adapter.requestDevice(hasTimestamp ? { requiredFeatures: ['timestamp-query'] } : {});
      if (!device) return null;
      return new GpuMatcher(device, hasTimestamp);
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
    const gscal = new Float32Array(G * 4);
    for (let g = 0; g < G; g++) {
      const gl = atlas.glyphs[g]!;
      alpha.set(gl.alpha, g * P);
      gscal[g * 4] = gl.sumA;
      gscal[g * 4 + 1] = gl.sumAA;                        // STORED sumAA (matchGrid's objective)
      gscal[g * 4 + 2] = gl.ink;
      gscal[g * 4 + 3] = gl.sumAA - (gl.sumA * gl.sumA) / P; // Saa_c = sumAA − sumA²/P (centered)
    }
    const dev = this.device;
    this.alphaBuf?.destroy();
    this.gscalBuf?.destroy();
    this.alphaBuf = dev.createBuffer({ size: alpha.byteLength, usage: 0x80 /* STORAGE */ | 0x8 });
    this.gscalBuf = dev.createBuffer({ size: gscal.byteLength, usage: 0x80 | 0x8 });
    dev.queue.writeBuffer(this.alphaBuf, 0, alpha);
    dev.queue.writeBuffer(this.gscalBuf, 0, gscal);
    this.atlasRef = atlas;
    this.G = G;
    this.P = P;
  }

  private ensureCellBuffers(numCells: number, P: number): void {
    const prev = this.targetBuf ? { numCells: this.numCells, P: this.cellP } : null;
    if (!needsCellBufferRealloc(prev, numCells, P)) return;
    const dev = this.device;
    for (const b of [this.targetBuf, this.cstatBuf, this.outGlyphBuf, this.outFBBuf, this.stagingGlyph, this.stagingFB]) b?.destroy();
    this.targetBuf = dev.createBuffer({ size: numCells * 3 * P * F32, usage: 0x80 | 0x8 });
    this.cstatBuf = dev.createBuffer({ size: numCells * 16 * F32, usage: 0x80 | 0x8 });
    this.outGlyphBuf = dev.createBuffer({ size: numCells * 4, usage: 0x80 | 0x4 /* COPY_SRC */ });
    this.outFBBuf = dev.createBuffer({ size: numCells * 6 * F32, usage: 0x80 | 0x4 });
    this.stagingGlyph = dev.createBuffer({ size: numCells * 4, usage: 0x1 /* MAP_READ */ | 0x8 });
    this.stagingFB = dev.createBuffer({ size: numCells * 6 * F32, usage: 0x1 | 0x8 });
    this.numCells = numCells;
    this.cellP = P;
  }

  // Run the Q3 match. `lin` is the grid-footprint linear reference (w == cols*cellW,
  // h == rows*cellH). Returns assembled GridCell[] plus timings.
  async match(lin: LinearImage, atlas: Atlas, opts: GpuMatchOpts, cols: number, rows: number): Promise<GpuMatchResult> {
    if (this.lost) throw new Error('gpu-matcher: device lost');
    const { cellW, cellH } = atlas;
    const P = atlas.P;
    assertPWithinScratch(P); // P > 256 OOBs the workgroup scratch — throw so pipeline routes this atlas to the CPU pool.
    const G = atlas.glyphs.length;
    const numCells = cols * rows;
    const w = lin.w, h = lin.h;
    if (w !== cols * cellW || h !== rows * cellH) throw new Error('gpu-matcher: image does not match grid footprint');

    const tPrep = performance.now();
    this.ensureAtlas(atlas);
    this.ensureCellBuffers(numCells, P);

    // Working space applied to T BEFORE the scan (mirrors match.ts). gamma (default):
    // linearToSrgb(v)/255; linear: identity. The output encode matches: gamma→gammaU8,
    // linear→toU8.
    const gamma = opts.space === 'gamma';
    const n3 = w * h * 3;
    if (!this.work || this.work.length !== n3) { this.work = new Float32Array(n3); }
    const work = this.work;
    if (gamma) { for (let i = 0; i < n3; i++) work[i] = linearToSrgb(lin.data[i]!) / 255; }
    else { work.set(lin.data); }
    const encode = gamma ? gammaU8 : toU8;

    // Per-cell stats. Lean inline pass that packs the target patch straight into the upload
    // buffer and accumulates ST/STT/minT/maxT in cellStats' EXACT (ly,lx,c) order — so the
    // uploaded T and the gate scalar are byte-identical to src/core/match.ts (Q3 needs none of
    // cellStats' gradient/luma work, and this avoids 5300 per-cell array allocations). eacScale
    // + gate + gated-cell emit stay on the CPU (byte-identical to matchGrid).
    if (!this.targetHost || this.targetHost.length !== numCells * 3 * P) {
      this.targetHost = new Float32Array(numCells * 3 * P);
      this.cstatHost = new Float32Array(numCells * 16);
    }
    const targetHost = this.targetHost;
    const cstatHost = this.cstatHost!;
    const gated: (GridCell | undefined)[] = new Array(numCells);
    let gatedCount = 0;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const cell = row * cols + col;
        const tBase = cell * 3 * P;
        const x0 = col * cellW, y0 = row * cellH;
        // ST/STT accumulate in f32 via Math.fround — cellStats stores them in Float32Array,
        // so each += rounds to f32; matching that keeps eacScale (hence the gate) byte-identical.
        const fr = Math.fround;
        let st0 = 0, st1 = 0, st2 = 0, stt0 = 0, stt1 = 0, stt2 = 0;
        let mn0 = Infinity, mn1 = Infinity, mn2 = Infinity, mx0 = -Infinity, mx1 = -Infinity, mx2 = -Infinity;
        for (let ly = 0; ly < cellH; ly++) {
          const gy = y0 + ly;
          for (let lx = 0; lx < cellW; lx++) {
            const gidx = (gy * w + (x0 + lx)) * 3;
            const li = ly * cellW + lx;
            const v0 = work[gidx]!, v1 = work[gidx + 1]!, v2 = work[gidx + 2]!;
            targetHost[tBase + li] = v0;
            targetHost[tBase + P + li] = v1;
            targetHost[tBase + 2 * P + li] = v2;
            st0 = fr(st0 + v0); st1 = fr(st1 + v1); st2 = fr(st2 + v2);
            stt0 = fr(stt0 + v0 * v0); stt1 = fr(stt1 + v1 * v1); stt2 = fr(stt2 + v2 * v2);
            if (v0 < mn0) mn0 = v0; if (v0 > mx0) mx0 = v0;
            if (v1 < mn1) mn1 = v1; if (v1 > mx1) mx1 = v1;
            if (v2 < mn2) mn2 = v2; if (v2 > mx2) mx2 = v2;
          }
        }
        // Centered per-channel AC energy STT_c = STT − ST²/P; eacScale = Σ_c STT_c (f64, exact).
        const sttc0 = stt0 - (st0 * st0) / P;
        const sttc1 = stt1 - (st1 * st1) / P;
        const sttc2 = stt2 - (st2 * st2) / P;
        const eac = sttc0 + sttc1 + sttc2;
        const o = cell * 16;
        cstatHost[o] = st0; cstatHost[o + 1] = st1; cstatHost[o + 2] = st2; cstatHost[o + 3] = eac;
        cstatHost[o + 4] = sttc0; cstatHost[o + 5] = sttc1; cstatHost[o + 6] = sttc2;
        cstatHost[o + 8] = mn0; cstatHost[o + 9] = mn1; cstatHost[o + 10] = mn2;
        cstatHost[o + 12] = mx0; cstatHost[o + 13] = mx1; cstatHost[o + 14] = mx2;
        if (eac / (3 * P) < opts.gateTau) {
          gated[cell] = { ch: ' ', fg: null, bg: [encode(st0 / P), encode(st1 / P), encode(st2 / P)] };
          gatedCount++;
        }
      }
    }

    const dev = this.device;
    dev.queue.writeBuffer(this.targetBuf, 0, targetHost);
    dev.queue.writeBuffer(this.cstatBuf, 0, cstatHost);
    const pbuf = new ArrayBuffer(16);
    const pv = new DataView(pbuf);
    pv.setFloat32(0, opts.mdlLambda, true);
    pv.setUint32(4, G, true);
    pv.setUint32(8, P, true);
    pv.setUint32(12, numCells, true);
    dev.queue.writeBuffer(this.paramsBuf, 0, pbuf);

    const bind = dev.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.alphaBuf } },
        { binding: 1, resource: { buffer: this.gscalBuf } },
        { binding: 2, resource: { buffer: this.targetBuf } },
        { binding: 3, resource: { buffer: this.cstatBuf } },
        { binding: 4, resource: { buffer: this.outGlyphBuf } },
        { binding: 5, resource: { buffer: this.outFBBuf } },
        { binding: 6, resource: { buffer: this.paramsBuf } },
      ],
    });
    const prepMs = performance.now() - tPrep;

    // Dispatch → readback (the number SPEC §7.1 predicts < 15ms; timings.match).
    const tMatch = performance.now();
    const enc = dev.createCommandEncoder();
    const passDesc = this.hasTimestamp
      ? { timestampWrites: { querySet: this.querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } }
      : {};
    const pass = enc.beginComputePass(passDesc);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(numCells); // one workgroup (64 threads) per cell
    pass.end();
    if (this.hasTimestamp) {
      enc.resolveQuerySet(this.querySet, 0, 2, this.queryResolve, 0);
      enc.copyBufferToBuffer(this.queryResolve, 0, this.queryStaging, 0, 16);
    }
    enc.copyBufferToBuffer(this.outGlyphBuf, 0, this.stagingGlyph, 0, numCells * 4);
    enc.copyBufferToBuffer(this.outFBBuf, 0, this.stagingFB, 0, numCells * 6 * F32);
    dev.queue.submit([enc.finish()]);

    // Separate GPU-work-done from map latency: onSubmittedWorkDone resolves once the GPU has
    // finished, then mapAsync exposes the results. The headless-Dawn map callback dominates
    // the wall-clock, so timestamp-query gives the true GPU compute time.
    await dev.queue.onSubmittedWorkDone();
    const tReadback = performance.now();
    const maps = [this.stagingGlyph.mapAsync(0x1 /* READ */), this.stagingFB.mapAsync(0x1)];
    if (this.hasTimestamp) maps.push(this.queryStaging.mapAsync(0x1));
    await Promise.all(maps);
    const glyphOut = new Uint32Array(this.stagingGlyph.getMappedRange().slice(0));
    const fbOut = new Float32Array(this.stagingFB.getMappedRange().slice(0));
    let gpuMs = 0;
    if (this.hasTimestamp) {
      const ts = new BigUint64Array(this.queryStaging.getMappedRange().slice(0));
      gpuMs = Number(ts[1]! - ts[0]!) / 1e6; // timestamp ticks are nanoseconds
      this.queryStaging.unmap();
    }
    this.stagingGlyph.unmap();
    this.stagingFB.unmap();
    const readbackMs = performance.now() - tReadback;
    const matchMs = performance.now() - tMatch;

    // Assemble: gated cells from the CPU gate; the rest from the GPU winner + colours.
    const glyphs = atlas.glyphs;
    const cells: GridCell[] = new Array(numCells);
    for (let cell = 0; cell < numCells; cell++) {
      const gc = gated[cell];
      if (gc) { cells[cell] = gc; continue; }
      const gi = glyphOut[cell]!;
      const b = cell * 6;
      cells[cell] = {
        ch: glyphs[gi]!.ch,
        fg: [encode(fbOut[b]!), encode(fbOut[b + 1]!), encode(fbOut[b + 2]!)],
        bg: [encode(fbOut[b + 3]!), encode(fbOut[b + 4]!), encode(fbOut[b + 5]!)],
      };
    }

    return { cells, matchMs, gpuMs, readbackMs, prepMs, gatedCount };
  }
}
