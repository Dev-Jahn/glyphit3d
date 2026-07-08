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
    // Post-selection invisibility collapse (types.ts). Default OFF (0). The collapse zeroes
    // the invisible-ink proxy deterministically (at threshold 24 every proxy-counted cell,
    // |F−B|<24, is exactly the set collapsed to space → 0.00% on all 6 images), but the
    // predicted "zero SSIM cost" was FALSIFIED by measurement (bench/out/gate-sweep.md,
    // collapse section): the faint glyphs on real gradient interiors carry sub-cell structure
    // SSIM rewards, so collapsing them costs overall+object SSIM > 0.0005 at every threshold on
    // every image. Per the decision rule (largest threshold with cost ≤ 0.0005 everywhere), no
    // threshold qualifies → ship OFF. Available opt-in for washout-dominated inputs where the
    // faint glyphs are genuinely structureless (there the cost is ~0.001).
    collapseThreshold: 0,
    // Perceptual contrast floor (Round A ASCII-identity, feat/contrast-floor-fill). Default OFF
    // (0) → byte-identical output; this is the SSOT default, so every bench/gate/parity path that
    // sources defaultOptions() keeps the floor off. A GLOBAL floor hurts reconstruction (DESIGN
    // §3.4 M3 correction), so a nonzero value is wired only into the web demo dark path (main.ts),
    // never here. See MatchOptions.contrastFloor (types.ts) for the constrained-LS semantics.
    contrastFloor: 0,
  };
}

// rows = round(cols · (imgH/imgW) · cellW/cellH) — corrects for non-square cells.
export function gridRows(cols: number, imgW: number, imgH: number, cellW: number, cellH: number): number {
  return Math.max(1, Math.round((cols * (imgH / imgW) * cellW) / cellH));
}
