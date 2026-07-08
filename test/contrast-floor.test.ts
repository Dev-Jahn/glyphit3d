import { describe, it, expect, beforeAll } from 'vitest';
import { buildAtlas } from '../src/atlas/atlas.js';
import { matchGrid } from '../src/core/match.js';
import { contrastFloorFit } from '../src/core/fit.js';
import { applyContrastFloor } from '../web/src/webgpu/contrast-floor-post.js';
import { srgbToLinear, luma, linearToSrgb } from '../src/core/color.js';
import type { Atlas, MatchOptions, LinearImage, FitStatsG, GridCell } from '../src/core/types.js';

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';

function opts(o: Partial<MatchOptions>): MatchOptions {
  return { quality: 3, space: 'gamma', edgeLambda: 0.35, gateTau: 2e-5, mdlLambda: 0.02,
    fixedBg: [0, 0, 0], fixedFg: [1, 1, 1], ...o };
}

// A structured-but-faint dark scene: each cell is a vertical half-split of two near-black
// u8 levels (top/bot), so the free two-color fit legitimately picks a half-block glyph with a
// TINY fg/bg separation — the "black hole" the contrast floor targets. cols distinct pairs so
// several cells survive the contrast gate. Image is LINEAR (matchGrid works in gamma by default).
function faintDarkScene(atlas: Atlas): LinearImage {
  const { cellW, cellH } = atlas;
  const pairs: [number, number][] = [[6, 16], [8, 20], [10, 24], [12, 28], [4, 14], [14, 30]];
  const cols = pairs.length;
  const w = cols * cellW, h = cellH;
  const data = new Float32Array(w * h * 3);
  const half = Math.floor(cellH / 2);
  for (let col = 0; col < cols; col++) {
    const [top, bot] = pairs[col]!;
    for (let ly = 0; ly < cellH; ly++) {
      const v = srgbToLinear(ly < half ? top : bot);
      for (let lx = 0; lx < cellW; lx++) {
        const gi = (ly * w + col * cellW + lx) * 3;
        data[gi] = v; data[gi + 1] = v; data[gi + 2] = v;
      }
    }
  }
  return { w, h, data };
}

// The finding's scene: one shade DARKER than faintDarkScene, at the shipped demo floor 0.06 — the
// regime where the mean-preserving DC goes negative and the pre-fix encode clamp silently emits
// sub-floor cells. Pairs chosen so several cells survive the gate yet all bind the gamut box.
function darkerScene(atlas: Atlas): LinearImage {
  const { cellW, cellH } = atlas;
  const pairs: [number, number][] = [[0, 10], [1, 11], [2, 12], [0, 12], [1, 13], [2, 14]];
  const cols = pairs.length;
  const w = cols * cellW, h = cellH;
  const data = new Float32Array(w * h * 3);
  const half = Math.floor(cellH / 2);
  for (let col = 0; col < cols; col++) {
    const [top, bot] = pairs[col]!;
    for (let ly = 0; ly < cellH; ly++) {
      const v = srgbToLinear(ly < half ? top : bot);
      for (let lx = 0; lx < cellW; lx++) {
        const gi = (ly * w + col * cellW + lx) * 3;
        data[gi] = v; data[gi + 1] = v; data[gi + 2] = v;
      }
    }
  }
  return { w, h, data };
}

// A mid-range faint scene authored in DIRECT linear values (not srgb→linear): half-split cells
// whose linear luma separation (~0.07) sits below the floor while the DC (~0.35) clears the gate,
// so the two-color fit picks a half-block glyph the floor must boost — the linear-space analogue of
// faintDarkScene (whose near-black linear values would instead gate out entirely under space=linear).
function linearFaintScene(atlas: Atlas): LinearImage {
  const { cellW, cellH } = atlas;
  const pairs: [number, number][] = [[0.30, 0.37], [0.32, 0.40], [0.34, 0.42], [0.28, 0.35], [0.36, 0.44], [0.31, 0.39]];
  const cols = pairs.length;
  const w = cols * cellW, h = cellH;
  const data = new Float32Array(w * h * 3);
  const half = Math.floor(cellH / 2);
  for (let col = 0; col < cols; col++) {
    const [top, bot] = pairs[col]!;
    for (let ly = 0; ly < cellH; ly++) {
      const v = ly < half ? top : bot;
      for (let lx = 0; lx < cellW; lx++) {
        const gi = (ly * w + col * cellW + lx) * 3;
        data[gi] = v; data[gi + 1] = v; data[gi + 2] = v;
      }
    }
  }
  return { w, h, data };
}

// working-space (gamma u8) fg/bg luma separation of an emitted cell, normalized to [0,1].
function sepU8(fg: [number, number, number] | null, bg: [number, number, number] | null): number {
  if (!fg || !bg) return NaN;
  return Math.abs(luma(fg[0], fg[1], fg[2]) - luma(bg[0], bg[1], bg[2])) / 255;
}

describe('contrast-floor: pure fit.contrastFloorFit', () => {
  // glyph = 2-of-4 half mask: α=[1,1,0,0] → Σα=2, Σα²=2, P=4. Gray channels (all equal), so
  // ΔL(F,B) = |F−B| and every channel is identical.
  const g: FitStatsG = { Saa: 2, Sa1: 2, S11: 4 };
  const P = 4;
  // free fit of T=[t,t,0,0] against this mask gives F=t, B=0 (verified in the derivation): here
  // ΔL=0.10. ST=Σt=0.20, STT=0.02, SaT=α·T=0.20 (all 3 channels identical).
  const F: [number, number, number] = [0.10, 0.10, 0.10];
  const B: [number, number, number] = [0, 0, 0];
  const ST: [number, number, number] = [0.20, 0.20, 0.20];
  const STT: [number, number, number] = [0.02, 0.02, 0.02];
  const SaT: [number, number, number] = [0.20, 0.20, 0.20];

  it('returns null (keep verbatim) when ΔL already clears the floor', () => {
    expect(contrastFloorFit(g, F, B, ST, STT, SaT, P, 0.10, false)).toBeNull(); // ΔL == floor
    expect(contrastFloorFit(g, F, B, ST, STT, SaT, P, 0.05, false)).toBeNull(); // ΔL > floor
  });

  it('pins the fg/bg separation to exactly the floor and preserves the mean when gamut allows', () => {
    // A LIFTED (mid-gray) cell, not the near-black one above: top pixels 0.50, bottom 0.44
    // (half mask), so free F=0.50,B=0.44, ΔL=0.06. floor 0.10 boosts the AC to 0.10 while the
    // mean-preserving DC b*=mean−floor·ρ=0.47−0.05=0.42 stays inside [0,1] → the mean IS preserved.
    // (For the near-black cell above, mean preservation is impossible in gamut — see the next test.)
    const hi = 0.50, lo = 0.44;
    const gL: FitStatsG = { Saa: 2, Sa1: 2, S11: 4 };
    const Fl: [number, number, number] = [hi, hi, hi];
    const Bl: [number, number, number] = [lo, lo, lo];
    const STl: [number, number, number] = [2 * hi + 2 * lo, 2 * hi + 2 * lo, 2 * hi + 2 * lo];
    const STTl: [number, number, number] = [2 * hi * hi + 2 * lo * lo, 2 * hi * hi + 2 * lo * lo, 2 * hi * hi + 2 * lo * lo];
    const SaTl: [number, number, number] = [2 * hi, 2 * hi, 2 * hi];
    const r = contrastFloorFit(gL, Fl, Bl, STl, STTl, SaTl, P, 0.10, false)!;
    expect(r).not.toBeNull();
    expect(r.space).toBe(false); // modest floor → boost still beats flat-fill
    expect(luma(r.F[0] - r.B[0], r.F[1] - r.B[1], r.F[2] - r.B[2])).toBeCloseTo(0.10, 12);
    // colors stay in the emit gamut [0,1] (the fit is now re-solved UNDER the box, not clamped after)
    for (let c = 0; c < 3; c++) { expect(r.F[c]).toBeGreaterThanOrEqual(0); expect(r.F[c]).toBeLessThanOrEqual(1); expect(r.B[c]).toBeGreaterThanOrEqual(0); expect(r.B[c]).toBeLessThanOrEqual(1); }
    const dc = gL.Sa1 * r.F[0] + (P - gL.Sa1) * r.B[0];
    expect(dc).toBeCloseTo(STl[0], 12); // DC (cell mean) preserved — gamut did not bind
  });

  it('near-black boost meets the floor IN GAMUT (does not emit B<0); mean shifts up minimally', () => {
    // Regression for feat/contrast-floor-fill major finding: for the near-black cell (F=0.10,B=0,
    // mean=0.05) any boost forces the mean-preserving DC b*=mean−floor·ρ<0. The pre-fix code kept
    // that unphysical b*=−0.025 and relied on the encode-time clamp, which SILENTLY dropped the
    // emitted luma separation below the floor. The fix re-solves b under the [0,1] box: B'=0,
    // F'=floor, so luma(F'−B')==floor with BOTH colors in gamut and the mean lifts minimally.
    const floor = 0.15;
    const r = contrastFloorFit(g, F, B, ST, STT, SaT, P, floor, false)!;
    expect(r.space).toBe(false);
    expect(luma(r.F[0] - r.B[0], r.F[1] - r.B[1], r.F[2] - r.B[2])).toBeCloseTo(floor, 12); // floor met exactly
    for (let c = 0; c < 3; c++) {
      expect(r.B[c]).toBeGreaterThanOrEqual(0); // pre-fix emitted B'=−0.025 (out of gamut)
      expect(r.B[c]).toBeLessThanOrEqual(1);
      expect(r.F[c]).toBeGreaterThanOrEqual(0);
      expect(r.F[c]).toBeLessThanOrEqual(1);
    }
    expect(r.B[0]).toBeCloseTo(0, 12);      // DC clamped to the gamut floor
    expect(r.F[0]).toBeCloseTo(floor, 12);  // F' = B' + a' = floor
  });

  it('bright-side kept boost meets the floor after the u8 emit (does not clamp F>1 into sub-floor)', () => {
    // Regression for the finding's bright-side clamp (DamagedHelmet fg=255 bg=243, sep<floor): a
    // near-white cell, top 1.0 / bottom 0.955 (mean 0.9775), ΔL 0.045, floor 0.06. The boost keeps
    // the glyph (space=false). Pre-fix, b*=mean−floor·ρ=0.9475 gave F'=1.0075; the encode clamp
    // pinned fg=255 but left bg=242 → emitted u8 separation 13/255≈0.051 < floor (sub-floor emit).
    // Fixed: b* clamps to hi=1−floor=0.94, so F'=1.0 (in gamut), bg=240, sep 15/255≈0.059 ≥ floor.
    const hi = 1.0, lo = 0.955;
    const gB: FitStatsG = { Saa: 2, Sa1: 2, S11: 4 };
    const Fb: [number, number, number] = [hi, hi, hi];
    const Bb: [number, number, number] = [lo, lo, lo];
    const STb: [number, number, number] = [2 * hi + 2 * lo, 2 * hi + 2 * lo, 2 * hi + 2 * lo];
    const STTb: [number, number, number] = [2 * hi * hi + 2 * lo * lo, 2 * hi * hi + 2 * lo * lo, 2 * hi * hi + 2 * lo * lo];
    const SaTb: [number, number, number] = [2 * hi, 2 * hi, 2 * hi];
    const floor = 0.06;
    const r = contrastFloorFit(gB, Fb, Bb, STb, STTb, SaTb, P, floor, false)!;
    expect(r.space).toBe(false); // this boost is kept, not demoted
    // the ACTUAL emitted colors go through the gammaU8 clamp+round — the emitted separation, not
    // the pre-encode float, is what must clear the floor.
    const gU8 = (v: number): number => Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 255);
    const fg: [number, number, number] = [gU8(r.F[0]), gU8(r.F[1]), gU8(r.F[2])];
    const bg: [number, number, number] = [gU8(r.B[0]), gU8(r.B[1]), gU8(r.B[2])];
    expect(sepU8(fg, bg)).toBeGreaterThanOrEqual(floor - 1.01 / 255); // pre-fix emitted ≈0.051 here
  });

  it('Q2 (fixed bg): demotes to space when the pinned fg leaves gamut (no silent F clamp)', () => {
    // Q2 pins B=fixedBg=0, so the only lever is F'=a'. With ΔL 0.10 and floor 0.9, a'=0.9<1 stays
    // in gamut → kept; but with an even larger floor a'>1 would leave gamut. Use floor 1.2: a'=1.2>1
    // ⇒ F' out of [0,1], unmeetable in gamut ⇒ space (pre-fix would clamp F'→1, sep<floor).
    const r = contrastFloorFit(g, F, B, ST, STT, SaT, P, 1.2, true)!;
    expect(r.space).toBe(true);
    expect(r.mean[0]).toBeCloseTo(ST[0] / P, 12);
  });

  it('demotes to space when the floor forces a boost worse than a flat cell', () => {
    // floor 0.4 ≫ ΔL 0.10 → the pinned residual overshoots past E_AC → flat-fill wins.
    const r = contrastFloorFit(g, F, B, ST, STT, SaT, P, 0.4, false)!;
    expect(r.space).toBe(true);
    expect(r.mean[0]).toBeCloseTo(ST[0] / P, 12); // solid fill = cell mean
  });
});

describe('contrast-floor: matchGrid integration', () => {
  let atlas: Atlas;
  beforeAll(async () => { atlas = await buildAtlas(FONT, 16, 'blocks'); }, 60000);

  it('contrastFloor=0 is byte-identical to omitting the option (off = current behavior)', () => {
    const img = faintDarkScene(atlas);
    for (const q of [2, 3] as const) {
      const base = matchGrid(img, atlas, opts({ quality: q }));
      const zero = matchGrid(img, atlas, opts({ quality: q, contrastFloor: 0 }));
      expect(zero.cells).toEqual(base.cells);
    }
  });

  it('with the floor ON, every fitted cell clears the floor or is demoted to space', () => {
    const img = faintDarkScene(atlas);
    const floor = 0.10;
    const off = matchGrid(img, atlas, opts({ contrastFloor: 0 }));
    const on = matchGrid(img, atlas, opts({ contrastFloor: floor }));

    // Precondition: with the floor OFF the scene really does contain near-invisible cells
    // (a fitted glyph whose fg/bg luma separation is below the floor) — else the test is vacuous.
    const invisibleOff = off.cells.filter((c) => c.ch !== ' ' && sepU8(c.fg, c.bg) < floor).length;
    expect(invisibleOff).toBeGreaterThan(0);

    // Postcondition: no fitted (glyph) cell survives below the floor — it was boosted or demoted.
    // Allow 1/255 of rounding slack from the u8 emit encode.
    for (const c of on.cells) {
      if (c.ch === ' ') continue; // demoted / gated flat cell — legible by construction
      expect(sepU8(c.fg, c.bg)).toBeGreaterThanOrEqual(floor - 1.01 / 255);
    }
    // and the floor actually did work: fewer invisible fitted cells than OFF.
    const invisibleOn = on.cells.filter((c) => c.ch !== ' ' && sepU8(c.fg, c.bg) < floor).length;
    expect(invisibleOn).toBeLessThan(invisibleOff);
  });

  it('near-black scene at demo floor 0.06: NO fitted cell emits below the floor (gamut-safe)', () => {
    // Regression for the major finding: on a scene one shade darker than the one above, the pre-fix
    // encode-time clamp emitted fitted cells whose u8 luma separation sat BELOW the floor (invisible
    // ink over black). Assert the invariant directly at the shipped demo default floor, over the
    // ACTUAL emitted (u8-encoded) colors, for both Q2 and Q3.
    const img = darkerScene(atlas);
    const floor = 0.06;
    for (const q of [2, 3] as const) {
      const off = matchGrid(img, atlas, opts({ quality: q, contrastFloor: 0 }));
      const on = matchGrid(img, atlas, opts({ quality: q, contrastFloor: floor }));
      // precondition: OFF really contains sub-floor fitted cells (else vacuous)
      const invisibleOff = off.cells.filter((c) => c.ch !== ' ' && sepU8(c.fg, c.bg) < floor).length;
      expect(invisibleOff).toBeGreaterThan(0);
      // postcondition: every kept glyph clears the floor (1/255 u8-rounding slack); rest are spaces.
      for (const c of on.cells) {
        if (c.ch === ' ') continue;
        expect(sepU8(c.fg, c.bg)).toBeGreaterThanOrEqual(floor - 1.01 / 255);
      }
    }
  });

  it('Q1 (mono, fixed colors) is exempt — floor is a no-op', () => {
    const img = faintDarkScene(atlas);
    const off = matchGrid(img, atlas, opts({ quality: 1, contrastFloor: 0 }));
    const on = matchGrid(img, atlas, opts({ quality: 1, contrastFloor: 0.2 }));
    expect(on.cells).toEqual(off.cells);
  });
});

// GPU post-pass parity (feat/contrast-floor-fill, MAJOR fix). The WebGPU Q3 matcher returns a
// per-cell winner glyph + F/B; the floored default demo path applies the contrast floor as a host
// per-cell post-pass on that grid (web/src/webgpu/contrast-floor-post.ts) instead of routing to the
// CPU pool. The result contract is byte-for-byte equality with matchGrid's CPU floored path. These
// tests PROVE it by driving applyContrastFloor with the CPU matcher's own winners (argmin, which is
// byte-identical to the GPU winner by the parity contract) over the SAME working-space target, and
// asserting cell-for-cell equality vs matchGrid-with-floor — AND that WITHOUT the post-pass the grid
// does NOT equal the floored reference (so the post-pass is load-bearing, not vacuously passing).
describe('contrast-floor: WebGPU post-pass equals the CPU floored path', () => {
  let atlas: Atlas;
  beforeAll(async () => { atlas = await buildAtlas(FONT, 16, 'blocks'); }, 60000);

  // Working-space target packed cell-major [cell*3*P + c*P + li], byte-identical to the gpu-matcher
  // prep AND to cellStats' per-cell T (same gamma transform, same (ly,lx,c) pixel order). This is
  // the exact array the GPU post-pass re-derives the winner sums from.
  function buildTargetHost(img: LinearImage, cols: number, rows: number, space: 'linear' | 'gamma'): Float32Array {
    const { cellW, cellH, P } = atlas;
    const w = img.w;
    const n3 = img.data.length;
    const work = new Float32Array(n3);
    if (space === 'gamma') { for (let i = 0; i < n3; i++) work[i] = linearToSrgb(img.data[i]!) / 255; }
    else { work.set(img.data); }
    const th = new Float32Array(cols * rows * 3 * P);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const tBase = (row * cols + col) * 3 * P;
        const x0 = col * cellW, y0 = row * cellH;
        for (let ly = 0; ly < cellH; ly++) {
          const gy = y0 + ly;
          for (let lx = 0; lx < cellW; lx++) {
            const gidx = (gy * w + (x0 + lx)) * 3;
            const li = ly * cellW + lx;
            th[tBase + li] = work[gidx]!;
            th[tBase + P + li] = work[gidx + 1]!;
            th[tBase + 2 * P + li] = work[gidx + 2]!;
          }
        }
      }
    }
    return th;
  }

  // Drive the post-pass exactly as gpu-matcher.match would, but with the CPU matcher's winners and
  // unfloored grid as the "GPU output" (byte-identical by the parity contract). Returns the
  // post-passed grid, the un-post-passed grid, and the CPU floored reference.
  function driveEquality(img: LinearImage, floor: number, space: 'linear' | 'gamma'):
    { got: GridCell[]; unfloored: GridCell[]; reference: GridCell[]; changed: number } {
    const cols = Math.floor(img.w / atlas.cellW);
    const rows = Math.floor(img.h / atlas.cellH);
    const numCells = cols * rows;

    // Unfloored CPU grid + winners (topK=1 → cand[0].glyphIdx is the argmin = the GPU winner).
    const off = matchGrid(img, atlas, opts({ quality: 3, space, contrastFloor: 0, topK: 1 }));
    const unfloored = off.cells;
    const cands = off.cands!;
    const winners = new Uint32Array(numCells);
    for (let i = 0; i < numCells; i++) winners[i] = cands[i]![0]!.glyphIdx;

    // Gated cells (skipped by the post-pass): the only null-fg cells in an unfloored Q3 grid are the
    // gate's flat fills (collapseThreshold=0 → no collapse; a fitted space-glyph winner carries a
    // non-null fg), so this identifies exactly what the gpu-matcher prep marks gated.
    const gated = new Array<GridCell | undefined>(numCells);
    for (let i = 0; i < numCells; i++) {
      const c = unfloored[i]!;
      gated[i] = (c.ch === ' ' && c.fg === null) ? c : undefined;
    }

    const targetHost = buildTargetHost(img, cols, rows, space);
    const got = unfloored.slice(); // fresh array; applyContrastFloor replaces floored entries in place
    applyContrastFloor(got, winners, gated, targetHost, atlas, cols, rows, space, floor);

    const reference = matchGrid(img, atlas, opts({ quality: 3, space, contrastFloor: floor })).cells;
    let changed = 0;
    for (let i = 0; i < numCells; i++) if (JSON.stringify(reference[i]) !== JSON.stringify(unfloored[i])) changed++;
    return { got, unfloored, reference, changed };
  }

  for (const [name, make] of [['faint dark', faintDarkScene], ['near-black (gamut-binding)', darkerScene]] as const) {
    for (const floor of [0.06, 0.10, 0.15]) {
      it(`${name} @ floor ${floor}: post-pass == matchGrid floored, cell-for-cell (gamma)`, () => {
        const img = make(atlas);
        const { got, unfloored, reference, changed } = driveEquality(img, floor, 'gamma');
        // Non-vacuous: the floor really changes some cells (else the disabled-proof below is empty).
        expect(changed).toBeGreaterThan(0);
        // Contract: the post-pass reproduces the CPU floored path exactly.
        expect(got).toEqual(reference);
        // Disabled-post-pass proof: WITHOUT the post-pass the grid is NOT the floored reference,
        // so the equality assertion above genuinely depends on the post-pass running.
        expect(unfloored).not.toEqual(reference);
      });
    }
  }

  it('mid-range faint scene @ floor 0.10 also matches in LINEAR working space', () => {
    const img = linearFaintScene(atlas);
    const { got, unfloored, reference, changed } = driveEquality(img, 0.10, 'linear');
    expect(changed).toBeGreaterThan(0);
    expect(got).toEqual(reference);
    expect(unfloored).not.toEqual(reference);
  });
});
