import { describe, it, expect } from 'vitest';
import { defaultOptions } from '../src/core/options.js';
import { applyIdentityPreset } from '../src/core/identity-preset.js';
import { applyIdentity } from '../src/cli.js';
import { COUPLING_DEFAULTS } from '../src/core/coupling.js';

// feat/identity-web-wiring — applyIdentityPreset is the ASCII-identity preset shared by BOTH the CLI
// (cli.ts applyIdentity) and the web worker (web/src/band-opts.ts). These lock the preset contract and
// prove the CLI has NO drift after the extraction. FAIL vs HEAD: src/core/identity-preset.ts does not
// exist on HEAD → the import throws. (Full byte-identity of the CLI identity output is ALSO covered by
// the unmodified identity-match / color-dither / identity-coherence golden suites, and was verified
// with a direct sha256 byte probe over the demo image across coherence/dither/override variants.)

describe('applyIdentityPreset (shared CLI/web preset)', () => {
  it('sets the selection prior + coherence + coupling, leaves the floor to the caller (colour dither on)', () => {
    const o = defaultOptions(2);
    applyIdentityPreset(o, { coherence: 'pure-ramp', colorDither: true });
    expect(o.identityLambda).toBe(5);
    expect(o.identityTau).toBeCloseTo(2.5e-4, 12);
    expect(o.identityCoherence).toBe('pure-ramp');
    expect(o.coupling).toEqual(COUPLING_DEFAULTS);
    expect(o.identityColorDither).toBeUndefined(); // default true = coupling on
    expect(o.contrastFloor).toBe(0);               // helper does NOT touch the floor
  });

  it('monochrome (colour dither off) leaves coupling unset + flags identityColorDither false', () => {
    const o = defaultOptions(2);
    applyIdentityPreset(o, { coherence: 'none', colorDither: false });
    expect(o.identityColorDither).toBe(false);
    expect(o.coupling).toBeUndefined();
    expect(o.identityCoherence).toBe('none');
  });
});

describe('CLI applyIdentity has no drift after the preset extraction', () => {
  it('--identity defaults == preset(pure-ramp, colour) + the CLI contrast floor 24/255', () => {
    const o = defaultOptions(2);
    applyIdentity(o, { identity: true });
    expect(o.identityLambda).toBe(5);
    expect(o.identityTau).toBeCloseTo(2.5e-4, 12);
    expect(o.identityCoherence).toBe('pure-ramp');
    expect(o.coupling).toEqual(COUPLING_DEFAULTS);
    expect(o.contrastFloor).toBeCloseTo(24 / 255, 12);
  });
});
