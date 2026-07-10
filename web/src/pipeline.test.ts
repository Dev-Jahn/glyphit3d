import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Atlas } from '../../src/core/types.js';
import type { Scene } from './scene.js';
import type { PipelineParams } from './pipeline.js';

// gate/gpu-fallback-verify (SPEC §8.4 verify-criteria item 5). The whole-run pool fallback is a
// CORRECTNESS boundary, not a perf nicety: when WebGPU is unavailable, or when the GPU raster/
// matcher throws mid-run (device-lost), Pipeline.run() must still produce a NON-BLANK raster via
// the CPU pool and report matcher:'pool'. The mid-run path is subtle — the prepQ3 worker hop
// TRANSFERS (detaches) imgData.data, so the catch MUST re-render the scene before runPool; reusing
// the detached buffer yields an all-zero linear image and a blank raster. These two suites pin
// both branches so the gate (npm run test) fails if the fallback ever regresses. The real browser
// (navigator.gpu === undefined) equivalent of the first suite was empirically confirmed
// (matcher:'pool', SSIM 0.9715) by the round review probe.

// The GPU classes are replaced wholesale so no WebGPU runtime is needed; create() is driven per
// test. vi.hoisted lets the (hoisted) vi.mock factories reference these spies.
const { matcherCreate, rasterCreate } = vi.hoisted(() => ({
  matcherCreate: vi.fn(),
  rasterCreate: vi.fn(),
}));
vi.mock('./webgpu/gpu-matcher.js', () => ({ GpuMatcher: { create: matcherCreate } }));
vi.mock('./webgpu/gpu-raster.js', () => ({ GpuRaster: { create: rasterCreate } }));

// A worker stub that answers the pool + prep protocol in-process. It FAITHFULLY detaches every
// transferred ArrayBuffer (exactly as a real Worker.postMessage does), so the detach-then-reuse
// hazard in the run() catch path is actually reproduced. The matchBand reply's raster luma is
// derived from whether the band pixels it received are non-zero — so "non-blank raster" is true
// iff runPool was fed real (re-rendered), not detached-and-zeroed, pixels.
class MockWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  postMessage(msg: { type: string; id: number; band?: number; cols?: number; img?: { w: number; h: number; data: Float32Array } }, transfer?: Transferable[]): void {
    // A real Worker snapshots the message into the worker realm, THEN detaches the transferred
    // buffers for the sender. Compute the reply from the still-live message first, then detach.
    const reply = this.compute(msg);
    if (transfer && transfer.length) {
      // Detach the transferred buffers, mirroring real structured-clone transfer semantics.
      try { structuredClone(null, { transfer: transfer as unknown as ArrayBuffer[] }); } catch { /* ignore */ }
    }
    if (reply !== null) queueMicrotask(() => this.onmessage?.({ data: reply }));
  }
  private compute(msg: { type: string; id: number; band?: number; cols?: number; img?: { w: number; h: number; data: Float32Array } }): unknown {
    switch (msg.type) {
      case 'setAtlas': return null;
      case 'prepQ3':
        return { type: 'prep', id: msg.id, targetHost: new Float32Array(1), cstatHost: new Float32Array(1), gated: [], gatedCount: 0, lin: null };
      case 'matchBand': {
        const { w, h, data } = msg.img!;
        let nonZero = false;
        for (let i = 0; i < data.length; i++) { if (data[i] !== 0) { nonZero = true; break; } }
        const raster = new Uint8ClampedArray(w * h * 4);
        if (nonZero) raster.fill(200); // real pixels → visible raster; zeroed pixels → blank
        return {
          type: 'band', id: msg.id, band: msg.band, cols: msg.cols, rows: 0,
          cells: [], raster, rasterLin: new Float32Array(w * h * 3), timings: { match: 1, raster: 1 },
        };
      }
      case 'ssim':
      case 'rasterSsim':
        return { type: 'ssim', id: msg.id, ssim: 0.9 };
      default: return null;
    }
  }
}

// Minimal atlas: gridRows(cols=4, aspect 1, cellW=2, cellH=2) → 4 rows, an 8×8 footprint.
const ATLAS = { cellW: 2, cellH: 2, P: 4, glyphs: [], fontPath: 'x' } as unknown as Atlas;
const PARAMS: PipelineParams = { cols: 4, quality: 3, space: 'gamma', charset: 'ascii' };

// A scene whose render is a non-zero image; every call returns a FRESH buffer (a real re-render),
// so a detached first buffer cannot masquerade as the re-rendered one.
function makeScene(): Scene & { renders: number } {
  const scene = {
    renders: 0,
    renderToImageData(w: number, h: number) {
      scene.renders++;
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(180) };
    },
  };
  return scene as unknown as Scene & { renders: number };
}

const maxLuma = (raster: { data: Uint8ClampedArray }): number => {
  let m = 0;
  for (let i = 0; i < raster.data.length; i += 4) if (raster.data[i]! > m) m = raster.data[i]!;
  return m;
};

let origWorker: unknown;
beforeEach(() => {
  origWorker = (globalThis as { Worker?: unknown }).Worker;
  (globalThis as { Worker?: unknown }).Worker = MockWorker as unknown;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  (globalThis as { Worker?: unknown }).Worker = origWorker;
  vi.restoreAllMocks();
  matcherCreate.mockReset();
  rasterCreate.mockReset();
});

async function makePipeline() {
  const { Pipeline } = await import('./pipeline.js');
  return new Pipeline();
}

describe('gate/gpu-fallback-verify: WebGPU-absent route (SPEC §8.4 item 5a)', () => {
  it('routes a Q3 run to the CPU pool with a non-blank raster when WebGPU is unavailable', async () => {
    matcherCreate.mockResolvedValue(null); // GpuMatcher.create() → null (no secure ctx / navigator.gpu)
    rasterCreate.mockResolvedValue(null);
    const pipeline = await makePipeline();
    const scene = makeScene();

    const out = await pipeline.run(scene, ATLAS, PARAMS, true);

    expect(out.matcher).toBe('pool');
    expect(maxLuma(out.raster)).toBeGreaterThan(0); // non-blank
    expect(scene.renders).toBe(1); // no GPU attempt, so no re-render
  });
});

describe('gate/gpu-fallback-verify: mid-run GPU failure route (SPEC §8.4 item 5b)', () => {
  it('falls the whole run back to the pool with a non-blank raster when the GPU raster throws (device-lost)', async () => {
    // GPU is "available" so the Q3 path is entered; the raster then throws mid-run.
    matcherCreate.mockResolvedValue({ available: true, matchPrepped: async () => ({ cells: [], matchMs: 1 }) });
    rasterCreate.mockResolvedValue({ available: true, render: async () => { throw new Error('gpu-raster: device lost'); } });
    const pipeline = await makePipeline();
    const scene = makeScene();

    const out = await pipeline.run(scene, ATLAS, PARAMS, true);

    expect(out.matcher).toBe('pool');
    expect(maxLuma(out.raster)).toBeGreaterThan(0); // non-blank: the catch RE-RENDERED before runPool
    expect(scene.renders).toBe(2); // one GPU attempt (prep detached its buffer) + one fallback re-render
  });

  it('falls back to the pool when the GPU matcher throws (device-lost) before raster', async () => {
    matcherCreate.mockResolvedValue({ available: true, matchPrepped: async () => { throw new Error('gpu-matcher: device lost'); } });
    rasterCreate.mockResolvedValue({ available: true, render: async () => { throw new Error('unreached'); } });
    const pipeline = await makePipeline();
    const scene = makeScene();

    const out = await pipeline.run(scene, ATLAS, PARAMS, true);

    expect(out.matcher).toBe('pool');
    expect(maxLuma(out.raster)).toBeGreaterThan(0);
    expect(scene.renders).toBe(2);
  });
});
