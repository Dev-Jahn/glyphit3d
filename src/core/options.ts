import type { MatchOptions } from './types.js';

// Pure match-option defaults and grid geometry, split out of cli.ts so the browser
// worker/app can import them without pulling node-only CLI IO.

export function defaultOptions(quality: 0 | 1 | 2 | 3 | 4): MatchOptions {
  return {
    quality,
    space: 'gamma',
    edgeLambda: 0.35,
    // M3-SPEC §1: the gate is a COMPUTE-SAVER, not a quality device — the exhaustive scan
    // always contains the flat candidate (space's unconstrained fit is b=mean, SSE=E_AC),
    // so lowering τ can only match-or-improve per-cell SSE. Default 2e-4 → 2e-5 skips only
    // near-exactly-flat cells and recovers the smooth-interior deficit (see bench/out/gate-sweep.md).
    gateTau: 2e-5,
    mdlLambda: 0.02,
    fixedBg: [0, 0, 0],
    fixedFg: [1, 1, 1],
  };
}

// rows = round(cols · (imgH/imgW) · cellW/cellH) — corrects for non-square cells.
export function gridRows(cols: number, imgW: number, imgH: number, cellW: number, cellH: number): number {
  return Math.max(1, Math.round((cols * (imgH / imgW) * cellW) / cellH));
}
