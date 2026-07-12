import { describe, it, expect } from 'vitest';
import { bakeAovGate } from '../src/cli.js';

// fix/bake-identity-aov-wiring (ADR-0003 §2). The bake AOV gate decides (1) whether shading.png is
// loaded into aov.shadingLuma and (2) whether opts.aov is attached to the fit. ADR-0003 §2 binds the
// bake-path coupling illumination ℓ to the cell-mean shadingLuma AOV ("bake 경로는 셀 평균
// shadingLuma, 아니면 Ȳ"); therefore shape-color coupling (identity color-dither ON — the --identity
// default) MUST load shading.png. Before the fix the gate keyed only off split/antibleed/style-albedo/
// orient — never coupling — so `bake --identity` (coupling on, no other AOV feature) silently shipped
// match.ts's ℓ=Ȳ 2D fallback (couplingShading undefined), violating the ADR ℓ contract.

const off = { split: 0, antibleed: 0, styleAlbedo: false, orientKappa: 0, coupling: false };

describe('bakeAovGate: coupling wires the shading AOV (ADR-0003 §2)', () => {
  // THE FIX: coupling present (identity color-dither default) ⇒ shading loaded AND aov attached, even
  // with no other AOV feature. This is the case the pre-fix gate missed.
  it('coupling on with no other AOV feature loads shading.png and attaches opts.aov', () => {
    const g = bakeAovGate({ ...off, coupling: true });
    expect(g.shading).toBe(true); // shading.png → aov.shadingLuma (ℓ = cell-mean shadingLuma)
    expect(g.attach).toBe(true);  // opts.aov must reach matchGrid so couplingShading is defined
  });

  // split already required shading; coupling being added must not regress the split path.
  it('split on loads shading and attaches (unchanged)', () => {
    const g = bakeAovGate({ ...off, split: 0.5 });
    expect(g.shading).toBe(true);
    expect(g.attach).toBe(true);
  });

  // INVARIANT (the monochrome case the task calls out): identity color-dither OFF bypasses coupling
  // (opts.coupling undefined ⇒ coupling:false), so with no split the gate loads NOTHING — mono has no
  // color-modulation pass, ℓ is never consumed. Same as a plain non-identity bake with no AOV feature.
  it('coupling off + no AOV feature loads nothing and attaches nothing (mono identity / plain bake)', () => {
    const g = bakeAovGate(off);
    expect(g.shading).toBe(false);
    expect(g.attach).toBe(false);
  });

  // INVARIANT: a non-shading AOV feature attaches opts.aov but does NOT pull in shading.png.
  it('antibleed only attaches aov but does not load shading', () => {
    expect(bakeAovGate({ ...off, antibleed: 2 })).toEqual({ shading: false, attach: true });
  });

  it('style-albedo / orient only attach without shading', () => {
    expect(bakeAovGate({ ...off, styleAlbedo: true })).toEqual({ shading: false, attach: true });
    expect(bakeAovGate({ ...off, orientKappa: 0.3 })).toEqual({ shading: false, attach: true });
  });
});
