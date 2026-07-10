import { describe, it, expect } from 'vitest';
import { keyframeNeeded, temporalKeyDiffers, type TemporalKey } from './temporal-route.js';

// feat/temporal-animation (SPEC §4.4 / RISKS "unit-test the reset matrix"). A missed keyframe pairs
// a stale reference frame with new geometry and silently corrupts output, so every reset axis is
// pinned here.
const BASE: TemporalKey = { charset: 'blocks', cols: 100, space: 'gamma', quality: 3, floor: 0.06 };
const clone = (o: Partial<TemporalKey>): TemporalKey => ({ ...BASE, ...o });

describe('temporalKeyDiffers — reset axes', () => {
  it('null prev (first frame) always differs', () => {
    expect(temporalKeyDiffers(null, BASE)).toBe(true);
  });
  it('identical key does not differ', () => {
    expect(temporalKeyDiffers(BASE, clone({}))).toBe(false);
  });
  for (const axis of ['charset', 'cols', 'space', 'quality', 'floor'] as const) {
    it(`a ${axis} change resets`, () => {
      const changed: Partial<TemporalKey> =
        axis === 'charset' ? { charset: 'ascii' }
        : axis === 'cols' ? { cols: 80 }
        : axis === 'space' ? { space: 'linear' }
        : axis === 'quality' ? { quality: 2 }
        : { floor: 0 };
      expect(temporalKeyDiffers(BASE, clone(changed))).toBe(true);
    });
  }
});

describe('keyframeNeeded — routing matrix', () => {
  it('a mid-drag interactive run with unchanged key and no forced reset is a delta frame', () => {
    expect(keyframeNeeded({ interactive: true, prevKey: BASE, nextKey: clone({}), forcedReset: false })).toBe(false);
  });
  it('every non-interactive run keyframes (exports/SSIM must be parity-exact)', () => {
    expect(keyframeNeeded({ interactive: false, prevKey: BASE, nextKey: clone({}), forcedReset: false })).toBe(true);
  });
  it('a forced reset (model drop / device-lost / first run) keyframes even when interactive', () => {
    expect(keyframeNeeded({ interactive: true, prevKey: BASE, nextKey: clone({}), forcedReset: true })).toBe(true);
  });
  it('a config change keyframes even on an interactive run', () => {
    expect(keyframeNeeded({ interactive: true, prevKey: BASE, nextKey: clone({ cols: 80 }), forcedReset: false })).toBe(true);
  });
  it('first interactive run (null prev) keyframes', () => {
    expect(keyframeNeeded({ interactive: true, prevKey: null, nextKey: BASE, forcedReset: false })).toBe(true);
  });
});
