import { describe, it, expect, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { buildAtlas } from '../src/atlas/atlas.js';
import { loadLinear } from '../src/image/image-io.js';
import { resampleArea } from '../src/image/image.js';
import { matchGrid } from '../src/core/match.js';
import { toAnsi } from '../src/render/ansi.js';
import { defaultOptions, gridRows } from '../src/core/options.js';
import { srgbToLinear, linearToSrgb } from '../src/core/color.js';
import { rampSet, precomputeIdentity, rhoStar } from '../src/core/identity.js';
import type { Atlas, MatchOptions, LinearImage, Grid } from '../src/core/types.js';

// feat/identity-ascii-charset-coherence — tests for the identityCoherence modes (none|ramp-bias|
// pure-ramp|smooth). Each non-'none' assertion was PROVEN to fail against the unmodified selection
// path (which ignores identityCoherence): with the option omitted the plain identity prior leaks
// non-R glyphs (ramp-bias), picks dense non-argmin glyphs (pure-ramp) and gives equal transition
// counts (smooth); the guards do not throw (identityLambda=0 → unmodified runs normally).

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
const ROOT = resolve(__dirname, '..');

function q2(o: Partial<MatchOptions> = {}): MatchOptions {
  return { ...defaultOptions(2), ...o };
}

// half-split cell scene: each cell top/bottom two u8 levels → real AC energy so every cell passes
// the contrast gate and runs the OBJECT-cell scan (the path the coherence modes act on).
function halfSplitScene(atlas: Atlas, pairs: [number, number][]): LinearImage {
  const { cellW, cellH } = atlas;
  const cols = pairs.length, w = cols * cellW, h = cellH;
  const data = new Float32Array(w * h * 3);
  const half = Math.floor(cellH / 2);
  for (let col = 0; col < cols; col++) {
    const [top, bot] = pairs[col]!;
    for (let ly = 0; ly < cellH; ly++) {
      const v = srgbToLinear(ly < half ? top : bot);
      for (let lx = 0; lx < cellW; lx++) { const gi = (ly * w + col * cellW + lx) * 3; data[gi] = v; data[gi + 1] = v; data[gi + 2] = v; }
    }
  }
  return { w, h, data };
}

// faint half-split (delta u8 around a per-column base): AC just above the gate so the cell is an
// OBJECT cell but nearly uniform → the ρ* prior, not shape, drives the glyph → coverage tracks base.
function faintSplitRow(atlas: Atlas, bases: number[], delta: number): LinearImage {
  const { cellW, cellH } = atlas;
  const N = bases.length, w = N * cellW, h = cellH;
  const data = new Float32Array(w * h * 3);
  const half = Math.floor(cellH / 2);
  for (let col = 0; col < N; col++) for (let ly = 0; ly < cellH; ly++) for (let lx = 0; lx < cellW; lx++) {
    const u8 = bases[col]! + (ly < half ? delta : -delta);
    const v = srgbToLinear(u8); const gi = (ly * w + col * cellW + lx) * 3; data[gi] = v; data[gi + 1] = v; data[gi + 2] = v;
  }
  return { w, h, data };
}

// working-space (gamma) value of a u8 level, matching match.ts's work encode (linearToSrgb∘srgbToLinear).
const work = (u8: number) => linearToSrgb(srgbToLinear(u8)) / 255;
function transitions(g: Grid): number {
  let t = 0;
  for (let i = 1; i < g.cells.length; i++) if (g.cells[i]!.ch !== g.cells[i - 1]!.ch) t++;
  return t;
}
function mulberry32(a: number) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
// Spearman rank correlation (spec: chosen-ρ vs Ȳ 순위상관). Ties → 0 denominator → 0.
function spearman(a: number[], b: number[]): number {
  const rank = (xs: number[]) => { const idx = xs.map((_, i) => i).sort((i, j) => xs[i]! - xs[j]!); const r = new Array(xs.length); idx.forEach((oi, k) => r[oi] = k); return r as number[]; };
  const ra = rank(a), rb = rank(b), n = a.length;
  const ma = ra.reduce((s, x) => s + x, 0) / n, mb = rb.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = ra[i]! - ma, y = rb[i]! - mb; num += x * y; da += x * x; db += y * y; }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
}

// ── 'none' is a no-op over the plain identity prior (byte-identical grid) ──────────────────────
describe("identityCoherence 'none' does not perturb the identity-prior path", () => {
  let atlas: Atlas;
  beforeAll(async () => { atlas = await buildAtlas(FONT, 16, 'blocks'); });
  it('sphere Q2 identity-prior ANSI is byte-identical with coherence none vs the option omitted', async () => {
    const img = await loadLinear(resolve(ROOT, 'bench', 'images', 'sphere.png'));
    const rows = gridRows(120, img.w, img.h, atlas.cellW, atlas.cellH);
    const ref = resampleArea(img, 120 * atlas.cellW, rows * atlas.cellH);
    const gOff = matchGrid(ref, atlas, q2({ identityLambda: 5 }));
    const gNone = matchGrid(ref, atlas, q2({ identityLambda: 5, identityCoherence: 'none' }));
    expect(createHash('sha256').update(toAnsi(gNone)).digest('hex'))
      .toBe(createHash('sha256').update(toAnsi(gOff)).digest('hex'));
  });
  // The above only proves 'none' ≡ option-omitted — both traverse the new code with coherence='none',
  // so it is blind to any drift of the identity-ON (coherence-unset) selection path (idW/uCell refit,
  // ramp restriction leakage into the plain prior, etc). Pin that path's bytes to the pre-change tree
  // (captured from HEAD's λ=5 output — the fixes here do not touch the coherence-unset path, verified).
  it('sphere Q2 identity-prior ANSI (λ=5, coherence unset) matches the pinned pre-change baseline', async () => {
    const img = await loadLinear(resolve(ROOT, 'bench', 'images', 'sphere.png'));
    const rows = gridRows(120, img.w, img.h, atlas.cellW, atlas.cellH);
    const ref = resampleArea(img, 120 * atlas.cellW, rows * atlas.cellH);
    const g = matchGrid(ref, atlas, q2({ identityLambda: 5 }));
    expect(createHash('sha256').update(toAnsi(g)).digest('hex'))
      .toBe('0d528c2d74f9abc8974949d0827faac1640b6ec3e7dc71422d16f5fbaf2ed07e');
  });
});

// ── pure-ramp: object cell == argmin_{g∈R}(ρ_g−ρ*)² ───────────────────────────────────────────
describe("identityCoherence 'pure-ramp' picks the coverage-argmin over R", () => {
  let atlas: Atlas;
  beforeAll(async () => { atlas = await buildAtlas(FONT, 16, 'blocks'); });
  it('every object cell glyph is argmin_{g∈R}|ρ_g − ρ*| on a synthetic brightness gradient', () => {
    const R = rampSet(atlas), idA = precomputeIdentity(atlas);
    const H = atlas.cellH, half = Math.floor(H / 2);
    const pairs: [number, number][] = [[6, 20], [10, 34], [16, 48], [24, 60], [30, 76], [40, 90], [20, 50], [12, 40]];
    const g = matchGrid(halfSplitScene(atlas, pairs), atlas, q2({ identityLambda: 5, identityCoherence: 'pure-ramp' }));
    for (let i = 0; i < pairs.length; i++) {
      const [t, b] = pairs[i]!;
      const mean = (half * work(t) + (H - half) * work(b)) / H; // exact cell mean (9/10 row split)
      const rs = rhoStar(mean, 0, 1);
      let bestd = Infinity, bestch = '';
      for (const gi of R.idx) { const d = Math.abs(idA.rho[gi]! - rs); if (d < bestd) { bestd = d; bestch = atlas.glyphs[gi]!.ch; } }
      expect(g.cells[i]!.ch).toBe(bestch);
    }
  });
});

// ── ramp-bias: winners ⊂ R (no punctuation/digit leak) + higher ρ↔Ȳ rank correlation than none ──
describe("identityCoherence 'ramp-bias' restricts winners to R and raises coverage↔luma order", () => {
  let atlas: Atlas;
  beforeAll(async () => { atlas = await buildAtlas(FONT, 16, 'blocks'); });
  it('all object-cell glyphs ∈ R and rank-corr(ρ,Ȳ) > the none path', () => {
    const R = rampSet(atlas), idA = precomputeIdentity(atlas);
    const rmem = new Set(R.chars);
    const H = atlas.cellH, half = Math.floor(H / 2);
    const pairs: [number, number][] = [[6, 20], [10, 34], [16, 48], [24, 60], [30, 76], [40, 90], [20, 50], [12, 40]];
    const scene = halfSplitScene(atlas, pairs);
    const gNone = matchGrid(scene, atlas, q2({ identityLambda: 5 }));
    const gBias = matchGrid(scene, atlas, q2({ identityLambda: 5, identityCoherence: 'ramp-bias' }));
    // no leakage: every object-cell winner is a ramp glyph
    for (let i = 0; i < pairs.length; i++) expect(rmem.has(gBias.cells[i]!.ch)).toBe(true);
    // rank correlation of chosen coverage vs cell luma is higher than the plain prior
    const ybar = pairs.map(([t, b]) => (half * work(t) + (H - half) * work(b)) / H);
    const rhoOf = (ch: string) => idA.rho[atlas.glyphs.findIndex((gg) => gg.ch === ch)]!;
    const corr = (g: Grid) => spearman(pairs.map((_, i) => rhoOf(g.cells[i]!.ch)), ybar);
    expect(corr(gBias)).toBeGreaterThan(corr(gNone));
  });
});

// ── smooth: fewer neighbor glyph changes than none on a noisy-brightness object region ─────────
describe("identityCoherence 'smooth' reduces neighbor glyph transitions", () => {
  let atlas: Atlas;
  beforeAll(async () => { atlas = await buildAtlas(FONT, 16, 'ascii'); });
  it('a noisy-brightness gradient yields fewer glyph transitions than none', () => {
    const rnd = mulberry32(3);
    const bases: number[] = [];
    for (let i = 0; i < 28; i++) bases.push(Math.round(15 + rnd() * 25)); // noisy base ∈ ~[15,40]
    const scene = faintSplitRow(atlas, bases, 3);
    // λ=20 so the ρ* prior (not the fixed-bg shape term) drives selection → object cells carry real
    // coverage variety for the neighbor penalty to smooth (at the λ=5 preset synthetic flat cells
    // stay dense-dominated with no ρ variety; real 3D object cells do carry it).
    const gNone = matchGrid(scene, atlas, q2({ identityLambda: 20 }));
    const gSmooth = matchGrid(scene, atlas, q2({ identityLambda: 20, identityCoherence: 'smooth' }));
    expect(transitions(gSmooth)).toBeLessThan(transitions(gNone));
  });
});

// ── smooth: a contrast-floor-demoted (space) cell seeds neighbors with ρ=0, not the phantom winner ─
describe("identityCoherence 'smooth' does not seed neighbors from a floor-demoted cell", () => {
  let atlas: Atlas;
  beforeAll(async () => { atlas = await buildAtlas(FONT, 16, 'ascii'); });
  it("a demoted cell's right neighbor tracks its own ρ*, not the demoted scan-winner's coverage", () => {
    const idA = precomputeIdentity(atlas);
    const rhoOf = (ch: string) => idA.rho[atlas.glyphs.findIndex((gg) => gg.ch === ch)]!;
    // col0: bright near-uniform → passes the gate, but its dense scan-winner's fitted fg≈bg falls
    // below the contrast floor and is DEMOTED to space (coverage 0). col1: a dark faint cell whose
    // own ρ*≈0.077 wants a SPARSE glyph. With the bug, col0 seeds its phantom dense-glyph ρ (≈0.28)
    // into the smooth neighbor penalty and drags col1 up to a dense glyph ('M', ρ≈0.28); correct
    // behavior seeds ρ=0 (the emitted space) so col1 stays sparse ('*', ρ≈0.10). --identity turns the
    // contrast floor (24/255) ON, so real smooth runs hit exactly this.
    const scene = faintSplitRow(atlas, [250, 20], 6);
    const g = matchGrid(scene, atlas, q2({ identityLambda: 5, contrastFloor: 24 / 255, identityCoherence: 'smooth' }));
    expect(g.cells[0]!.ch).toBe(' '); // precondition: col0 really was demoted to space (else vacuous)
    // col1 tracks its own low ρ*≈0.077, NOT the demoted neighbor's dense phantom (pre-fix gave ρ≈0.28)
    expect(rhoOf(g.cells[1]!.ch)).toBeLessThan(0.20);
  });
});

// ── no-fallback: ramp modes reject an empty ramp set R instead of silently emitting glyphs[0] ─────
describe('identityCoherence ramp modes reject an empty ramp set R', () => {
  let atlas: Atlas;
  beforeAll(async () => { atlas = await buildAtlas(FONT, 16, 'ascii'); });
  const RAMP = new Set([' ', '.', '-', ':', '*', '+', '=', 'c', 's', 'o', 'e', 'w', '%', 'a', 'm', '#', '@']);
  it('pure-ramp / ramp-bias throw when the atlas contains none of the ramp glyphs (no glyphs[0] fallback)', () => {
    // Strip every ramp glyph so R is empty; the restricted scan would otherwise skip every glyph and
    // silently emit glyphs[0] (a fallback). CLI-unreachable (all shipped charsets ⊇ ASCII) but
    // matchGrid is a public API accepting arbitrary atlases.
    const bad: Atlas = { ...atlas, glyphs: atlas.glyphs.filter((g) => !RAMP.has(g.ch)) };
    expect(rampSet(bad).idx.length).toBe(0);
    const scene = halfSplitScene(atlas, [[60, 140], [80, 160]]);
    expect(() => matchGrid(scene, bad, q2({ identityLambda: 5, identityCoherence: 'pure-ramp' }))).toThrow(/ramp set R/);
    expect(() => matchGrid(scene, bad, q2({ identityLambda: 5, identityCoherence: 'ramp-bias' }))).toThrow(/ramp set R/);
  });
});

// ── guards (fail fast, no fallback) ───────────────────────────────────────────────────────────
describe('identityCoherence guards throw', () => {
  let atlas: Atlas;
  beforeAll(async () => { atlas = await buildAtlas(FONT, 16, 'blocks'); });
  const flat = () => halfSplitScene(atlas, [[40, 80]]);
  it('coherence≠none with quality≠2 throws', () => {
    expect(() => matchGrid(flat(), atlas, { ...defaultOptions(3), identityCoherence: 'ramp-bias' })).toThrow(/quality 2/);
  });
  it('coherence≠none with identityLambda=0 throws', () => {
    expect(() => matchGrid(flat(), atlas, q2({ identityCoherence: 'pure-ramp' })).cells).toThrow(/identity prior/);
  });
});
