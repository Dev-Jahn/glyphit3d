import { describe, it, expect } from 'vitest';
import { bandMatchOptions } from './band-opts.js';
import { COUPLING_DEFAULTS } from '../../src/core/coupling.js';

// feat/identity-web-wiring — the CPU worker-pool per-band MatchOptions assembly (worker.ts matchBand
// choke point), extracted pure so the ASCII-identity threading and the band-safety guard are testable
// off the Worker. FAIL vs HEAD: web/src/band-opts.ts does not exist on HEAD, so the import throws —
// neither the identity threading nor the banded-smooth rejection can be built on the unmodified tree.

describe('bandMatchOptions threads the ASCII-identity preset', () => {
  it('identity off (default) leaves the plain Q-opts untouched (byte-identical path)', () => {
    const o = bandMatchOptions({ quality: 3, space: 'gamma' });
    expect(o.identityLambda).toBe(0);
    expect(o.identityCoherence).toBeUndefined();
    expect(o.coupling).toBeUndefined();
    expect(o.identityColorDither).toBeUndefined();
  });

  it('identity on, colour dither on → selection prior + coherence + coupling + web floor', () => {
    const o = bandMatchOptions({
      quality: 2, space: 'gamma', contrastFloor: 0.06,
      identity: true, identityCoherence: 'pure-ramp', identityColorDither: true,
    });
    expect(o.identityLambda).toBe(5);
    expect(o.identityTau).toBeCloseTo(2.5e-4, 12);
    expect(o.identityCoherence).toBe('pure-ramp');
    expect(o.coupling).toEqual(COUPLING_DEFAULTS);
    // the web owns the floor via its slider (the preset does NOT set it); it threads through here.
    expect(o.contrastFloor).toBeCloseTo(0.06, 12);
  });

  it('identity on, colour dither off → monochrome (coupling unset, flag false)', () => {
    const o = bandMatchOptions({
      quality: 2, space: 'gamma',
      identity: true, identityCoherence: 'ramp-bias', identityColorDither: false,
    });
    expect(o.identityColorDither).toBe(false);
    expect(o.coupling).toBeUndefined();
    expect(o.identityCoherence).toBe('ramp-bias');
  });

  it('identity on but a knob missing throws (no silent fallback)', () => {
    expect(() => bandMatchOptions({ quality: 2, space: 'gamma', identity: true })).toThrow(/missing/);
  });
});

describe('bandMatchOptions band-safety guard', () => {
  it('rejects banded smooth coherence (cross-cell top-neighbor pass seams in the row-band pool)', () => {
    expect(() => bandMatchOptions({
      quality: 2, space: 'gamma', identity: true, identityCoherence: 'smooth', identityColorDither: true,
    })).toThrow(/smooth/);
  });

  it('allows the band-safe coherence modes (none/ramp-bias/pure-ramp)', () => {
    for (const c of ['none', 'ramp-bias', 'pure-ramp'] as const) {
      expect(() => bandMatchOptions({
        quality: 2, space: 'gamma', identity: true, identityCoherence: c, identityColorDither: true,
      })).not.toThrow();
    }
  });
});
