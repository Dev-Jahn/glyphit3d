import type { MatchOptions } from '../../src/core/types.js';
import { defaultOptions } from '../../src/core/options.js';
import { applyIdentityPreset, type IdentityCoherence } from '../../src/core/identity-preset.js';

// Assemble the per-band MatchOptions for the CPU worker pool (worker.ts matchBand choke point). Pure
// and node-importable (no Worker/`self` context), so the worker-opts threading and the band-safety
// guard are unit-testable off the Worker (web/src/band-opts.test.ts). worker.ts calls this verbatim.
//
// contrastFloor and the ASCII-identity preset are threaded from the demo's params (contrast-floor
// precedent): the floor is applied here on BOTH the plain and the identity path (the web owns the
// floor via its slider, so the identity preset — which does NOT set the floor — leaves it to us),
// and identity turns on the shared selection prior + coherence + coupling via applyIdentityPreset.
export interface BandMatchInput {
  quality: 0 | 1 | 2 | 3 | 4;
  space: 'linear' | 'gamma';
  contrastFloor?: number;
  identity?: boolean;
  identityCoherence?: IdentityCoherence;
  identityColorDither?: boolean;
}

export function bandMatchOptions(msg: BandMatchInput): MatchOptions {
  const opts = defaultOptions(msg.quality);
  opts.space = msg.space;
  // Round A contrast floor (feat/contrast-floor-fill): per-cell (uses only that cell's stats, like
  // the gate/collapse), so it is exact per band — no cross-cell coupling to guard against.
  if (msg.contrastFloor) opts.contrastFloor = msg.contrastFloor;
  // ASCII-identity (feat/identity-web-wiring): identity IS Q2, so no routing change — matchGrid throws
  // if identityLambda>0 && quality!==2 (the UI forces quality 2 with the toggle). The three interactive
  // knobs arrive together with the flag; a missing one is a wiring bug, so fail loud (no fallback).
  if (msg.identity) {
    if (msg.identityCoherence === undefined || msg.identityColorDither === undefined)
      throw new Error('identity band request missing identityCoherence/identityColorDither');
    applyIdentityPreset(opts, { coherence: msg.identityCoherence, colorDither: msg.identityColorDither });
  }
  // P2 banding assumption, kept VISIBLE: families/contour/topK/orientation are cross-cell passes that
  // break per-band independence — never silently single-thread them. Q4's edge loss is ALSO cross-cell
  // (matchGrid reads the full-image vertical gradient, which zero-pads at the band slice's top/bottom
  // rows — a FALSE interior boundary at every band seam). 'smooth' charset coherence is cross-cell too:
  // its neighbor-consistency penalty reads the already-decided TOP neighbor, which the top row of every
  // band has lost (it lives in the previous band), so a banded smooth raster seams silently. Reject all
  // of them LOUDLY rather than emit seam-corrupt output. (The web coherence dropdown also excludes
  // smooth; this is the core-side defense.)
  if (opts.families?.length || opts.topK || opts.orientKappa || (opts.quality === 4 && opts.edgeLambda > 0) || opts.identityCoherence === 'smooth')
    throw new Error('web band path does not support cross-cell passes (families/contour/Q4 edge loss/smooth coherence)');

  return opts;
}
