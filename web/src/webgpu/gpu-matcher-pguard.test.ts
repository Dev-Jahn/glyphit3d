import { describe, it, expect } from 'vitest';
import {
  WG_SCRATCH_F32,
  pExceedsScratch,
  assertPWithinScratch,
  needsCellBufferRealloc,
} from './gpu-matcher.js';

// fix/gpu-matcher-p-guard (F2). vitest runs in node with NO WebGPU device, so these unit
// tests exercise the guard LOGIC as pure functions — no kernel dispatch. Real-device
// coverage (an actual P > 256 atlas driven end-to-end to CPU-pool fallback) belongs in the
// parity harness; see the task's risks note.

describe('P-bound guard (workgroup scratch is array<f32, WG_SCRATCH_F32>, so 3·P ≤ WG_SCRATCH_F32)', () => {
  it('the enforced bound matches the shader constant (768 = 3·256)', () => {
    expect(WG_SCRATCH_F32).toBe(768);
  });

  it('accepts the bundled DejaVu profile P = 190', () => {
    expect(pExceedsScratch(190)).toBe(false);
    expect(() => assertPWithinScratch(190)).not.toThrow();
  });

  it('accepts exactly P = 256 (3·256 = 768, not > 768)', () => {
    expect(pExceedsScratch(256)).toBe(false);
    expect(() => assertPWithinScratch(256)).not.toThrow();
  });

  it('rejects P = 257 (first value past the bound)', () => {
    expect(pExceedsScratch(257)).toBe(true);
    expect(() => assertPWithinScratch(257)).toThrow(/exceeds workgroup scratch/);
  });

  it('rejects a large TTF-profiled P and names P in the error', () => {
    expect(pExceedsScratch(1024)).toBe(true);
    expect(() => assertPWithinScratch(1024)).toThrow(/P=1024/);
  });
});

describe('cell-buffer reuse decision (targetBuf is sized numCells·3·P·F32)', () => {
  it('reallocates on the first run (no prior buffers)', () => {
    expect(needsCellBufferRealloc(null, 5000, 190)).toBe(true);
  });

  it('reuses when numCells and P are both unchanged', () => {
    expect(needsCellBufferRealloc({ numCells: 5000, P: 190 }, 5000, 190)).toBe(false);
  });

  it('reallocates on a LARGER P at the SAME numCells (the F2 defect: too-small targetBuf)', () => {
    expect(needsCellBufferRealloc({ numCells: 5000, P: 190 }, 5000, 300)).toBe(true);
  });

  it('reallocates on a smaller P at the same numCells (buffer size still differs)', () => {
    expect(needsCellBufferRealloc({ numCells: 5000, P: 190 }, 5000, 100)).toBe(true);
  });

  it('reallocates when only numCells changes', () => {
    expect(needsCellBufferRealloc({ numCells: 5000, P: 190 }, 6000, 190)).toBe(true);
  });
});
