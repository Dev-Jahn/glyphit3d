import { describe, it, expect, beforeAll } from 'vitest';
import { buildAtlas } from '../src/atlas/atlas.js';
import {
  structureTensor, glyphOrientation, borderProfile, orientationBonus,
} from '../src/atlas/orientation.js';
import { extractPolylines, viterbiContour, type Candidate } from '../src/core/contour.js';
import { edgeSSIM, type EdgeBand } from '../src/metric/edge-ssim.js';
import type { Atlas, Glyph, LinearImage } from '../src/core/types.js';
import type { BorderProfile } from '../src/atlas/orientation.js';

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';

// ============================================================================
// §3.1 orientation math — structure tensor angle + anisotropy, border profiles
// ============================================================================
describe('orientation precompute (M3-SPEC §3.1)', () => {
  let atlas: Atlas;
  const byCp = (cp: number): Glyph => atlas.glyphs.find((g) => g.cp === cp)!;
  beforeAll(async () => { atlas = await buildAtlas(FONT, 16, 'blocks'); }, 60000);

  it('structureTensor: pure axis-aligned gradient fields give θ=0 / θ=π/2, anisotropy 1', () => {
    const n = 100;
    const ones = new Float32Array(n).fill(1);
    const zeros = new Float32Array(n);
    const horiz = structureTensor(ones, zeros, n); // ∂/∂x only → dominant angle 0
    const vert = structureTensor(zeros, ones, n);  // ∂/∂y only → dominant angle π/2
    expect(Math.abs(horiz.theta)).toBeLessThan(1e-9);
    expect(horiz.anisotropy).toBeCloseTo(1, 6);
    expect(Math.abs(Math.abs(vert.theta) - Math.PI / 2)).toBeLessThan(1e-9);
    expect(vert.anisotropy).toBeCloseTo(1, 6);
    // isotropic field (equal x/y energy, zero cross-correlation) → anisotropy 0.
    const isoX = new Float32Array(n), isoY = new Float32Array(n);
    for (let i = 0; i < n; i++) { isoX[i] = i % 2; isoY[i] = 1 - (i % 2); } // Jxx=Jyy, Jxy=0
    expect(structureTensor(isoX, isoY, n).anisotropy).toBeLessThan(1e-9);
  });

  it('glyph dominant angles: │→0, ─→±90°, ╲ / ╱ diagonal with opposite sign', () => {
    const bar = glyphOrientation(byCp(0x2502));   // │
    const dash = glyphOrientation(byCp(0x2500));  // ─
    const back = glyphOrientation(byCp(0x2572));  // ╲
    const fwd = glyphOrientation(byCp(0x2571));   // ╱
    expect(Math.abs(bar.theta)).toBeLessThan(0.1);                          // ≈ 0
    expect(Math.abs(Math.abs(dash.theta) - Math.PI / 2)).toBeLessThan(0.1); // ≈ ±90°
    expect(back.theta).toBeLessThan(-0.3);                                  // ╲ negative
    expect(fwd.theta).toBeGreaterThan(0.3);                                 // ╱ positive
    // strongly oriented strokes are anisotropic; a round 'O' is not.
    expect(bar.anisotropy).toBeGreaterThan(0.8);
    expect(glyphOrientation(byCp(0x004f)).anisotropy).toBeLessThan(0.5);    // O
  });

  it('border profiles: half-blocks concentrate ink on their side; a centred bar exits mid-side', () => {
    const left = borderProfile(byCp(0x258c), atlas.cellW, atlas.cellH);  // ▌ left half
    expect(left.left.mass).toBeGreaterThan(0.9);
    expect(left.right.mass).toBeLessThan(0.05);
    const lower = borderProfile(byCp(0x2584), atlas.cellW, atlas.cellH); // ▄ lower half
    expect(lower.bottom.mass).toBeGreaterThan(0.5);
    expect(lower.top.mass).toBeLessThan(0.05);
    const bar = borderProfile(byCp(0x2502), atlas.cellW, atlas.cellH);   // │ vertical bar
    expect(bar.top.pos).toBeCloseTo(0.5, 1);
    expect(bar.bottom.pos).toBeCloseTo(0.5, 1);
  });

  // §3.3 orientation prior form: a diagonal edge cell flips a near-tie to the
  // aligned glyph when κ>0, and leaves it alone when κ=0. (The in-scan wiring is
  // phase 2; here we exercise the exact bonus form standalone.)
  it('orientation prior flips a near-tie diagonal cell to the aligned ╲, not when κ=0', () => {
    const { cellW: cw, cellH: ch } = atlas;
    // synthetic diagonal edge field L = f(x − y): its structure tensor aligns
    // with ╲ (θ_e ≈ −45°). Central-difference gradients over the cell.
    const L = new Float32Array(cw * ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      L[y * cw + x] = Math.max(0, Math.min(1, (x - y) / 8 + 0.3));
    }
    const gx = new Float32Array(cw * ch), gy = new Float32Array(cw * ch);
    for (let y = 1; y < ch - 1; y++) for (let x = 1; x < cw - 1; x++) {
      const i = y * cw + x;
      gx[i] = (L[i + 1]! - L[i - 1]!) / 2;
      gy[i] = (L[i + cw]! - L[i - cw]!) / 2;
    }
    const edge = structureTensor(gx, gy, cw * ch);

    const back = glyphOrientation(byCp(0x2572)); // ╲ aligned
    const fwd = glyphOrientation(byCp(0x2571));  // ╱ anti-aligned
    // near-tie unary with ╱ marginally preferred (lower score = better).
    const unaryBack = 1.05, unaryFwd = 1.00;
    const score = (o: typeof back, unary: number, kappa: number) =>
      unary - orientationBonus(o, edge.theta, edge.energy, 1, kappa);

    // κ=0: no bonus, ╱ (lower unary) wins.
    expect(score(back, unaryBack, 0)).toBeGreaterThan(score(fwd, unaryFwd, 0));
    // κ>0: the aligned ╲ receives the bonus (╱ gets max(0,cos2Δ)=0) and flips the tie.
    const k = 0.1;
    expect(score(back, unaryBack, k)).toBeLessThan(score(fwd, unaryFwd, k));
    expect(orientationBonus(fwd, edge.theta, edge.energy, 1, k)).toBeCloseTo(0, 9);
  });
});

// ============================================================================
// §3.4 polyline extraction + contour Viterbi (standalone, no matcher)
// ============================================================================
describe('contour DP (M3-SPEC §3.4)', () => {
  const cols = 5, rows = 5;

  it('extractPolylines: a straight coverage step yields one ordered 5-cell chain', () => {
    const cov = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cov[r * cols + c] = c < 2 ? 1 : 0;
    const pls = extractPolylines(cov, cols, rows);
    expect(pls.length).toBe(1);
    // boundary = the inside column adjacent to the outside (col 1), top→bottom.
    expect(pls[0]).toEqual([1, 6, 11, 16, 21]);
  });

  // Engineered near-ties along a straight 5-cell contour. Two synthetic border
  // profiles: `straight` (ink exits mid-side both ends → continuous stack) and
  // `broken` (ink jumps side to side → a discontinuous stack). Per cell the
  // `broken` glyph has the marginally better UNARY score, so greedy picks it
  // everywhere; the Viterbi pairwise continuity cost makes the `straight` chain
  // win globally. Asserted in BOTH traversal directions (forward + reversed).
  const straight: BorderProfile = { top: { mass: 1, pos: 0.5 }, bottom: { mass: 1, pos: 0.5 }, left: { mass: 0, pos: 0.5 }, right: { mass: 0, pos: 0.5 } };
  const broken: BorderProfile = { top: { mass: 1, pos: 0.0 }, bottom: { mass: 1, pos: 1.0 }, left: { mass: 0, pos: 0.5 }, right: { mass: 0, pos: 0.5 } };
  const profiles = [straight, broken]; // glyphIdx 0 = straight, 1 = broken
  const mk = (gi: number, score: number): Candidate => ({ glyphIdx: gi, score, F: [0, 0, 0], B: [0, 0, 0] });

  function scenario() {
    const cov = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cov[r * cols + c] = c < 2 ? 1 : 0;
    const chain = extractPolylines(cov, cols, rows)[0]!;
    const candsByCell: Candidate[][] = [];
    for (const idx of chain) candsByCell[idx] = [mk(1, 1.00), mk(0, 1.05)]; // broken better unary
    return { chain, candsByCell };
  }
  const greedy = (cands: Candidate[]) => cands.reduce((a, b) => (b.score < a.score ? b : a)).glyphIdx;

  it('greedy picks the broken chain, Viterbi picks the continuous one', () => {
    const { chain, candsByCell } = scenario();
    for (const idx of chain) expect(greedy(candsByCell[idx]!)).toBe(1); // greedy: all broken
    const chosen = viterbiContour(chain, candsByCell, profiles, cols, 0.15);
    for (const idx of chain) expect(chosen.get(idx)!.glyphIdx).toBe(0);  // Viterbi: all straight
  });

  it('Viterbi is direction-agnostic: reversing the polyline gives the same choices', () => {
    const { chain, candsByCell } = scenario();
    const fwd = viterbiContour(chain, candsByCell, profiles, cols, 0.15);
    const rev = viterbiContour([...chain].reverse(), candsByCell, profiles, cols, 0.15);
    for (const idx of chain) {
      expect(rev.get(idx)!.glyphIdx).toBe(0);
      expect(rev.get(idx)!.glyphIdx).toBe(fwd.get(idx)!.glyphIdx);
    }
  });

  it('κ_c=0 leaves the greedy per-cell argmin untouched', () => {
    const { chain, candsByCell } = scenario();
    const chosen = viterbiContour(chain, candsByCell, profiles, cols, 0);
    for (const idx of chain) expect(chosen.get(idx)!.glyphIdx).toBe(greedy(candsByCell[idx]!));
  });
});

// ============================================================================
// §3.5 edge metric — SSIM on Sobel magnitude, restricted to the boundary band
// ============================================================================
describe('edgeSSIM (M3-SPEC §3.5)', () => {
  const cw = 11, ch = 11, gc = 5, gr = 5;
  const w = gc * cw, h = gr * ch;
  const edgeImg = (shift: number): LinearImage => {
    const data = new Float32Array(w * h * 3);
    const mid = Math.floor(w / 2) + shift;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = x < mid ? 0 : 1;
      const i = (y * w + x) * 3;
      data[i] = v; data[i + 1] = v; data[i + 2] = v;
    }
    return { w, h, data };
  };
  const band: EdgeBand = (() => {
    const bcells = new Uint8Array(gc * gr);
    bcells[2 * gc + 2] = 1; // centre cell is the boundary cell
    return { boundaryCells: bcells, cols: gc, rows: gr, cellW: cw, cellH: ch };
  })();

  it('identical output vs reference scores exactly 1', () => {
    const ref = edgeImg(0);
    expect(edgeSSIM(ref, ref, band)).toBeCloseTo(1, 10);
  });

  it('a shifted edge scores strictly lower than identical', () => {
    const ref = edgeImg(0);
    const shifted = edgeImg(3);
    const s = edgeSSIM(shifted, ref, band);
    expect(s).toBeLessThan(1);
    expect(s).toBeLessThan(edgeSSIM(ref, ref, band));
  });

  it('throws when the boundary band has no window centre', () => {
    const ref = edgeImg(0);
    const empty: EdgeBand = { boundaryCells: new Uint8Array(gc * gr), cols: gc, rows: gr, cellW: cw, cellH: ch };
    expect(() => edgeSSIM(ref, ref, empty)).toThrow();
  });
});
