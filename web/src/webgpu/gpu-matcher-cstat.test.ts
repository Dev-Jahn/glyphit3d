import { describe, it, expect } from 'vitest';
import { GpuMatcher } from './gpu-matcher.js';
import type { Atlas, Glyph, LinearImage } from '../../../src/core/types.js';

// F2R-1 regression. The reused host-scratch arrays (targetHost = numCells·3·P, cstatHost =
// numCells·16) must each realloc on their OWN dimension. Before the fix cstatHost piggybacked
// on targetHost's `length !== numCells·3·P` check, so a switch that holds numCells·3·P constant
// while numCells GROWS (a collision pair) never reallocated cstatHost: the tail-cell stat
// writes fell past its end (silently dropped) and uploaded as zeros — a silent wrong result
// with no throw (P ≤ 256 ⇒ no CPU-pool fallback).
//
// vitest has no WebGPU device, so we drive match() against a faithful mock device that (a)
// enforces writeBuffer's out-of-range check (as the real API does) and (b) records the bytes
// uploaded to each buffer, letting us inspect the cstat upload directly. Everything the GPU
// would compute is irrelevant here — the defect is entirely on the host (CPU) prep side.

// --- mock GPU device ------------------------------------------------------------------------
interface MockBuffer { size: number; destroyed: boolean; write: { offset: number; copy: Float32Array } | null;
  destroy(): void; mapAsync(): Promise<void>; getMappedRange(): ArrayBuffer; unmap(): void; }

function makeDevice(): { device: any; buffers: MockBuffer[] } {
  const buffers: MockBuffer[] = [];
  const createBuffer = ({ size }: { size: number }): MockBuffer => {
    const buf: MockBuffer = {
      size, destroyed: false, write: null,
      destroy() { this.destroyed = true; },
      mapAsync: () => Promise.resolve(),
      getMappedRange: () => new ArrayBuffer(size),
      unmap() { /* noop */ },
    };
    buffers.push(buf);
    return buf;
  };
  const device: any = {
    createShaderModule: () => ({}),
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBuffer,
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({
      beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }),
      copyBufferToBuffer() {},
      finish: () => ({}),
    }),
    queue: {
      // This mock throws on OOB, which is deliberately STRICTER than real WebGPU. On a real
      // device an out-of-range writeBuffer never throws synchronously: it raises a
      // GPUValidationError delivered asynchronously through the device error scope and the write
      // is silently dropped. We turn that into a hard throw here so a host-side packing bug
      // (offset+byteLength past the buffer's end) fails the test loudly instead of vanishing as a
      // dropped write — precisely the silent-tail-drop defect (F2R-1) this test guards against.
      writeBuffer: (buffer: MockBuffer, offset: number, data: ArrayBufferView | ArrayBuffer) => {
        const byteLength = data.byteLength;
        if (offset + byteLength > buffer.size) {
          throw new RangeError(`writeBuffer OOB: ${offset}+${byteLength} > ${buffer.size}`);
        }
        buffer.write = { offset, copy: new Float32Array(data as ArrayBuffer) };
      },
      submit() {},
      onSubmittedWorkDone: () => Promise.resolve(),
    },
    lost: new Promise<void>(() => { /* never lost */ }),
  };
  return { device, buffers };
}

// --- minimal atlas / image builders ---------------------------------------------------------
function makeGlyph(ch: string, cp: number, P: number, fill: number): Glyph {
  const alpha = new Float32Array(P).fill(fill);
  let sumA = 0, sumAA = 0;
  for (const a of alpha) { sumA += a; sumAA += a * a; }
  return { ch, cp, alpha, dxA: new Float32Array(P), dyA: new Float32Array(P), sumA, sumAA, gradAA: 0, ink: fill };
}

function makeAtlas(cellW: number, cellH: number): Atlas {
  const P = cellW * cellH;
  return {
    cellW, cellH, P, fontPath: 'mock', fontSize: 16, ascent: 12,
    glyphs: [makeGlyph(' ', 32, P, 0), makeGlyph('#', 35, P, 0.5)],
    inkMin: 0, inkMax: 1,
  };
}

// Row-constant linear image: every pixel in grid-row r has channel value v(r), so each cell is
// internally flat (⇒ gated, so no GPU glyph is read) yet distinct across rows — a stale/zero
// tail cell is therefore unambiguously wrong.
function makeImage(w: number, h: number, cellH: number, v: (row: number) => number): LinearImage {
  const data = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const val = v(Math.floor(y / cellH));
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      data[i] = val; data[i + 1] = val; data[i + 2] = val;
    }
  }
  return { w, h, data };
}

const OPTS = { quality: 3 as const, space: 'linear' as const, gateTau: 0.01, mdlLambda: 0.02 };

describe('F2R-1 cstatHost owns its realloc condition (collision pair numCells·3·P equal, numCells differs)', () => {
  it('uploads correct tail-cell stats after a same-targetHost-length switch that grows numCells', async () => {
    const { device, buffers } = makeDevice();
    const matcher = new (GpuMatcher as any)(device, false) as GpuMatcher;

    // Config A: cellW=8,cellH=8 → P=64; cols=10,rows=10 → numCells=100; w=80,h=80.
    // Config B: cellW=8,cellH=4 → P=32; cols=10,rows=20 → numCells=200; w=80,h=80.
    // targetHost length collides: 100·3·64 == 200·3·32 == 19200. cstatHost must NOT: 100·16 vs 200·16.
    const nA = 100, PA = 64, nB = 200, PB = 32;
    expect(nA * 3 * PA).toBe(nB * 3 * PB); // targetHost length identical across the switch

    // Run A primes the reused scratch (targetHost len 19200, cstatHost len 1600).
    const atlasA = makeAtlas(8, 8);
    await matcher.match(makeImage(80, 80, 8, () => 0.2), atlasA, OPTS, 10, 10);

    // Run B: numCells 100→200 while numCells·3·P stays 19200. Pre-fix, cstatHost stayed length
    // 1600, so cell-100..199 stat writes were dropped and uploaded as zeros.
    const atlasB = makeAtlas(8, 4);
    const vTail = 0.1 + 19 * 0.02; // grid-row 19 = the last row of cells in config B
    const imgB = makeImage(80, 80, 4, (r) => 0.1 + r * 0.02);
    await matcher.match(imgB, atlasB, OPTS, 10, 20);

    // The live cstat buffer for run B is uniquely sized numCells·16·4 = 12800 bytes.
    const F32 = 4;
    const cstatBuf = buffers.find((b) => b.size === nB * 16 * F32 && b.write && !b.destroyed);
    expect(cstatBuf, 'cstat upload buffer for run B').toBeTruthy();
    const uploaded = cstatBuf!.write!.copy;

    // (1) The whole numCells·16 stat block must be uploaded — pre-fix this is only 1600 (nA·16).
    expect(uploaded.length).toBe(nB * 16);

    // (2) The tail cell's stats must be the real values, not stale zeros. cstat layout: st0 at
    //     offset cell·16, and eac at +3 (0 here because each cell is internally flat).
    const tail = (nB - 1) * 16;
    const fr = Math.fround;
    let expTailSt0 = 0;
    const vf = fr(vTail);
    for (let i = 0; i < PB; i++) expTailSt0 = fr(expTailSt0 + vf); // fround-accumulated, as gpu-matcher does
    expect(uploaded[tail]).toBeGreaterThan(0);
    expect(uploaded[tail]).toBeCloseTo(expTailSt0, 5);
  });
});
