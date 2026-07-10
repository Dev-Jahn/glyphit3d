import type { Atlas, GridCell, LinearImage } from '../../../src/core/types.js';
import { linearToSrgb } from '../../../src/core/color.js';
import { applyContrastFloor } from './contrast-floor-post.js';
import { MATCHER_WGSL } from './matcher-wgsl.js';
import { scanCells } from './prep.js';
import type { Prepped } from './prep.js';

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
  contrastFloor?: number;        // Round A ASCII-identity floor (0/absent = off). Applied as a host
                                 // per-cell post-pass on the GPU winner grid (contrast-floor-post.ts).
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

  // Upload + dispatch + readback + assemble for an already-prepped cell block. `prepped` carries
  // the working-space target patches (targetHost, numCells·3·P), the per-cell stat/gate block
  // (cstatHost, numCells·16) and the CPU-decided gated cells — produced either by the relocated
  // worker prep (prep.ts prepQ3) or by match()'s inline prep below. Everything upstream of here
  // is byte-identical to src/core/match.ts (SPEC §4.3/§5.1); this method touches only the GPU.
  // prepMs here is the main-thread upload residue (ensureAtlas + ensureCellBuffers + writeBuffer);
  // the CPU prep cost is added by the caller. The output encode matches the fit space:
  // gamma→gammaU8, linear→toU8 (gated cells were already encoded per space in prep).
  async matchPrepped(
    prepped: Prepped, atlas: Atlas, opts: GpuMatchOpts, cols: number, rows: number,
  ): Promise<GpuMatchResult> {
    if (this.lost) throw new Error('gpu-matcher: device lost');
    const P = atlas.P;
    assertPWithinScratch(P); // P > 256 OOBs the workgroup scratch — throw so pipeline routes this atlas to the CPU pool.
    const G = atlas.glyphs.length;
    const numCells = cols * rows;
    const { targetHost, cstatHost, gated, gatedCount } = prepped;
    // Buffer-size contract: the GPU buffers are sized numCells·3·P / numCells·16 by ensureCellBuffers,
    // so a mis-sized prepped block (e.g. a stale ping-pong buffer) would drop the tail write silently
    // on a real device. Assert loudly instead.
    if (targetHost.length !== numCells * 3 * P) throw new Error('gpu-matcher: targetHost length != numCells·3·P');
    if (cstatHost.length !== numCells * 16) throw new Error('gpu-matcher: cstatHost length != numCells·16');
    const encode = opts.space === 'gamma' ? gammaU8 : toU8;

    const tPrep = performance.now();
    this.ensureAtlas(atlas);
    this.ensureCellBuffers(numCells, P);

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

    // Contrast-floor post-pass (feat/contrast-floor-fill, MAJOR fix): apply the SAME per-cell
    // floor the CPU path applies, host-side on the GPU winner grid, so the floored default demo
    // path KEEPS the GPU matcher (no CPU-pool detour). Re-derives the winner-glyph sums from the
    // working-space targetHost (byte-identical to the CPU fit's T) → byte-identical to matchGrid's
    // floored emit on every cell it touches. No-op when opts.contrastFloor is 0/absent (the parity
    // path), so the CPU-vs-GPU parity contract is untouched.
    applyContrastFloor(cells, glyphOut, gated, targetHost, atlas, cols, rows, opts.space, opts.contrastFloor ?? 0);

    return { cells, matchMs, gpuMs, readbackMs, prepMs, gatedCount };
  }

  // Run the Q3 match from the grid-footprint linear reference. Thin wrapper kept for
  // parity-page.ts (and the F2R-1 cstat unit test): it builds the working-space image and runs
  // the per-cell prep on the main thread — via prep.ts scanCells, byte-identical to the
  // relocated worker path — then delegates the GPU work to matchPrepped. The production web path
  // relocates prep to a worker (SPEC §4.5) and calls matchPrepped directly. `lin` is the
  // grid-footprint linear reference (w == cols*cellW, h == rows*cellH).
  async match(lin: LinearImage, atlas: Atlas, opts: GpuMatchOpts, cols: number, rows: number): Promise<GpuMatchResult> {
    if (this.lost) throw new Error('gpu-matcher: device lost');
    const { cellW, cellH } = atlas;
    const P = atlas.P;
    assertPWithinScratch(P); // P > 256 OOBs the workgroup scratch — throw so pipeline routes this atlas to the CPU pool.
    const numCells = cols * rows;
    const w = lin.w, h = lin.h;
    if (w !== cols * cellW || h !== rows * cellH) throw new Error('gpu-matcher: image does not match grid footprint');

    const tCpu = performance.now();
    // Working space applied to T BEFORE the scan (mirrors match.ts / prep.ts). gamma (default):
    // linearToSrgb(v)/255; linear: identity. Reuses this.work to avoid per-run reallocation.
    const gamma = opts.space === 'gamma';
    const n3 = w * h * 3;
    if (!this.work || this.work.length !== n3) { this.work = new Float32Array(n3); }
    const work = this.work;
    if (gamma) { for (let i = 0; i < n3; i++) work[i] = linearToSrgb(lin.data[i]!) / 255; }
    else { work.set(lin.data); }

    // Per-cell prep via the shared scan. F2R-1: pass this.targetHost/this.cstatHost as scratch —
    // scanCells reallocs each on its OWN dimension — and store the returned arrays back so the
    // reuse (and the independent-realloc semantics) persist across calls exactly as before the split.
    const prepped = scanCells(
      work, w,
      { cols, rows, cellW, cellH, P, space: opts.space, gateTau: opts.gateTau },
      { targetHost: this.targetHost ?? undefined, cstatHost: this.cstatHost ?? undefined },
    );
    this.targetHost = prepped.targetHost;
    this.cstatHost = prepped.cstatHost;
    const cpuPrepMs = performance.now() - tCpu;

    const res = await this.matchPrepped(prepped, atlas, opts, cols, rows);
    return { ...res, prepMs: res.prepMs + cpuPrepMs };
  }
}
