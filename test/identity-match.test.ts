import { describe, it, expect, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { buildAtlas } from '../src/atlas/atlas.js';
import { loadLinear } from '../src/image/image-io.js';
import { resampleArea } from '../src/image/image.js';
import { matchGrid, contourPostPass } from '../src/core/match.js';
import { toAnsi } from '../src/render/ansi.js';
import { defaultOptions, gridRows } from '../src/core/options.js';
import { srgbToLinear } from '../src/core/color.js';
import type { Atlas, MatchOptions, LinearImage, Grid } from '../src/core/types.js';

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
const ROOT = resolve(__dirname, '..');

function q2(o: Partial<MatchOptions> = {}): MatchOptions {
  return { ...defaultOptions(2), ...o };
}

// ── V1: default-off byte identity (spec §7 V1) ────────────────────────────────────────────────
// Golden sha256 of the Q2/blocks ANSI for the 6 bench images, captured from the pre-identity tree
// (HEAD = contrast-floor lane, all new options at their off defaults). Because every identity /
// coupling code path is guarded by identityLambda>0 / opts.coupling, running defaultOptions(2) must
// reproduce these hashes byte-for-byte — the M1/M3 guarded-prior invariant.
const GOLDEN_Q2_BLOCKS: Record<string, string> = {
  sphere: 'fdde55b285a62b6189883885867f143c7ecb6f701f9dbd70f63ecce2f0a1cc69',
  torus: '6a537d54bfecca52d13d2aee02f63eabac86625fbabd465064c4dc254e89c903',
  spheres: 'af2ef199606999617666c6b583bbd64f7f863242b549abc1984974fe7eaf974d',
  DamagedHelmet: '89e9585e4b1a309b3573603cead5ee28869d3ca1396f9a980a4dfd716451969d',
  FlightHelmet: '4cc733a84cea30a350229a18c942a3d198b740e6f9a127fc5d28e50c60a1395d',
  BoomBox: 'a5d1dec86065a5574cbd05b73eef3ee1a13856129f0d57f76369e39f2d35e19a',
};

describe('V1 default-off byte identity (Q2/blocks, 6 bench images)', () => {
  let atlas: Atlas;
  beforeAll(async () => { atlas = await buildAtlas(FONT, 16, 'blocks'); });
  for (const name of Object.keys(GOLDEN_Q2_BLOCKS)) {
    it(`${name} Q2 ANSI sha256 unchanged by the identity wiring (defaults off)`, async () => {
      const img = await loadLinear(resolve(ROOT, 'bench', 'images', `${name}.png`));
      const rows = gridRows(120, img.w, img.h, atlas.cellW, atlas.cellH);
      const ref = resampleArea(img, 120 * atlas.cellW, rows * atlas.cellH);
      const grid = matchGrid(ref, atlas, defaultOptions(2));
      const hash = createHash('sha256').update(toAnsi(grid)).digest('hex');
      expect(hash).toBe(GOLDEN_Q2_BLOCKS[name]);
    });
  }
});

// A flat cell of a single sRGB u8 level — exercises the gated (contrast-gate) path.
function flatCell(atlas: Atlas, u8: number): LinearImage {
  const { cellW, cellH } = atlas;
  const data = new Float32Array(cellW * cellH * 3);
  const v = srgbToLinear(u8);
  for (let i = 0; i < cellW * cellH; i++) { data[i * 3] = v; data[i * 3 + 1] = v; data[i * 3 + 2] = v; }
  return { w: cellW, h: cellH, data };
}

// ── V3: gated-path identity prior (spec §3.3) ─────────────────────────────────────────────────
describe('V3 gated flat bright cell picks a ramp glyph, not U+2588', () => {
  let atlas: Atlas;
  beforeAll(async () => { atlas = await buildAtlas(FONT, 16, 'blocks'); });
  it('λ=0 emits U+2588 (gate contract); λ=5 emits a ramp glyph', () => {
    const img = flatCell(atlas, 200); // ρ*≈0.78 < 1−1/(2λ)=0.9 ⇒ full block loses
    const g0 = matchGrid(img, atlas, q2());
    expect(g0.cells[0]!.ch).toBe('█');
    const g5 = matchGrid(img, atlas, q2({ identityLambda: 5, identityTau: 2.5e-4 }));
    expect(g5.cells[0]!.ch).not.toBe('█');
    expect(g5.cells[0]!.ch).not.toBe(' ');
  });
});

// A flat chromatic cell of a single sRGB u8 color — exercises the gated Q2 coupling emit with a
// chromatic fg (so the illumination-driven desaturation is observable).
function flatColorCell(atlas: Atlas, rgb: [number, number, number]): LinearImage {
  const { cellW, cellH } = atlas;
  const data = new Float32Array(cellW * cellH * 3);
  const v: [number, number, number] = [srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2])];
  for (let i = 0; i < cellW * cellH; i++) { data[i * 3] = v[0]; data[i * 3 + 1] = v[1]; data[i * 3 + 2] = v[2]; }
  return { w: cellW, h: cellH, data };
}

// ── V4: coupling illumination AOV path (spec §4.1) ────────────────────────────────────────────
// Regression (review chain B, finding 3): the coupling illumination branch (match.ts couplingShading
// / cellIllum AOV path) shipped fully unexercised — the AOV bakes only changed the reference/mask, so
// coupling always fell back to ℓ = Ȳ. This drives the branch: on a BRIGHT chromatic cell (Ȳ above the
// sat knee ⇒ fallback σ=1, no desaturation) a DIM shadingLuma AOV (ℓ ≪ knee) must desaturate the
// coupled fg — a strictly different, greyer color than the ℓ=Ȳ fallback.
describe('V4 coupling illumination AOV path desaturates vs the Ȳ fallback (spec §4.1)', () => {
  let atlas: Atlas;
  beforeAll(async () => { atlas = await buildAtlas(FONT, 16, 'blocks'); });
  const sat = (fg: [number, number, number]) => (Math.max(...fg) - Math.min(...fg)) / Math.max(1, Math.max(...fg));
  it('a dim shadingLuma AOV yields a greyer coupled fg than ℓ=Ȳ', () => {
    const img = flatColorCell(atlas, [230, 120, 40]); // bright orange: Ȳ > satKnee ⇒ fallback σ=1
    const dim = new Float32Array(img.w * img.h).fill(0.05); // ℓ ≪ satKnee everywhere ⇒ desaturate
    const gFallback = matchGrid(img, atlas, q2({ coupling: {} }));
    const gAov = matchGrid(img, atlas, q2({ coupling: {}, aov: { shadingLuma: dim } }));
    const fFallback = gFallback.cells[0]!.fg!, fAov = gAov.cells[0]!.fg!;
    expect(fFallback).not.toEqual(null);
    expect(fAov).not.toEqual(fFallback);                     // AOV path took effect
    expect(sat(fAov)).toBeLessThan(sat(fFallback));          // and it desaturated (dim illumination)
  });
});

// A mid-tone vertical half-split scene: each cell passes the gate (real AC energy), so the full
// scan + topK path runs. Used for the cand[0]==emit invariant and the floor-legibility check.
function halfSplitScene(atlas: Atlas, pairs: [number, number][]): LinearImage {
  const { cellW, cellH } = atlas;
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

function preset(o: Partial<MatchOptions> = {}): MatchOptions {
  return q2({ identityLambda: 5, identityTau: 2.5e-4, coupling: {}, contrastFloor: 24 / 255, ...o });
}

// ── V5: pipeline order + invariants (spec §7 V5) ──────────────────────────────────────────────
describe('V5 cand[0]==emit invariant under coupling (spec §4.3)', () => {
  let atlas: Atlas;
  beforeAll(async () => { atlas = await buildAtlas(FONT, 16, 'blocks'); });
  it('contourPostPass(kappaC=0) reproduces every cell byte-for-byte with identity preset + topK', () => {
    const img = halfSplitScene(atlas, [[60, 140], [80, 160], [100, 180], [50, 130], [90, 170], [70, 150]]);
    const grid = matchGrid(img, atlas, preset({ topK: 8 }));
    const snapshot: Grid['cells'] = grid.cells.map((c) => ({ ch: c.ch, fg: c.fg ? [...c.fg] as [number, number, number] : null, bg: c.bg ? [...c.bg] as [number, number, number] : null }));
    // coverage field that crosses 0.5 across columns so marching-squares produces polylines and
    // the Viterbi actually rewrites cells from their cand[0] (kappaC=0 ⇒ greedy argmin per cell).
    const cov = new Float32Array(grid.cols * grid.rows);
    for (let r = 0; r < grid.rows; r++) for (let cc = 0; cc < grid.cols; cc++) cov[r * grid.cols + cc] = grid.cols > 1 ? cc / (grid.cols - 1) : 0;
    contourPostPass(grid, atlas, cov, 0);
    for (let i = 0; i < grid.cells.length; i++) {
      expect(grid.cells[i]).toEqual(snapshot[i]);
    }
  });
});

describe('V5 contrast floor after coupling keeps non-space cells legible (spec §4.3)', () => {
  let atlas: Atlas;
  beforeAll(async () => { atlas = await buildAtlas(FONT, 16, 'blocks'); });
  it('every emitted non-space cell meets the floor (or was demoted to space)', () => {
    // A faint dark scene where coupling can push a dense glyph below the floor; the floor must lift
    // or demote. Working space = gamma ⇒ working luma = u8/255; floor sep checked with a rounding tol.
    const img = halfSplitScene(atlas, [[6, 16], [8, 20], [10, 24], [12, 28], [4, 14], [14, 30]]);
    const grid = matchGrid(img, atlas, preset());
    const floor = 24 / 255;
    const lumaU8 = (rgb: [number, number, number]) => (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    let checked = 0;
    for (const c of grid.cells) {
      if (c.ch === ' ' || !c.fg || !c.bg) continue;
      checked++;
      const sep = Math.abs(lumaU8(c.fg) - lumaU8(c.bg));
      expect(sep).toBeGreaterThanOrEqual(floor - 3 / 255); // u8 rounding tolerance
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('V5 option-combination guards throw (fail fast, spec §3.4/§4.2)', () => {
  let atlas: Atlas;
  beforeAll(async () => { atlas = await buildAtlas(FONT, 16, 'blocks'); });
  const img = () => flatCell(atlas, 128);
  it('identity prior with quality≠2 throws', () => {
    expect(() => matchGrid(img(), atlas, { ...defaultOptions(3), identityLambda: 5 })).toThrow(/quality 2/);
  });
  it('identity prior with families throws in v1', () => {
    expect(() => matchGrid(img(), atlas, q2({ identityLambda: 5, families: ['quadrant'] }))).toThrow(/families/);
  });
  it('identity prior with L_F−L_B < 0.5 throws', () => {
    expect(() => matchGrid(img(), atlas, q2({ identityLambda: 5, fixedFg: [0.1, 0.1, 0.1] }))).toThrow(/L_F/);
  });
  it('coupling with quality≠2 throws', () => {
    expect(() => matchGrid(img(), atlas, { ...defaultOptions(3), coupling: {} })).toThrow(/quality 2/);
  });
  it('coupling with styleAlbedoColors throws', () => {
    expect(() => matchGrid(img(), atlas, q2({ coupling: {}, styleAlbedoColors: true }))).toThrow(/styleAlbedo/);
  });
  // Regression (review chain B, finding 1): coupling+families at Q2 must throw. Before the guard,
  // a family winner emitted via emitWinner bypassed the coupling transform (uncoupled fg) while
  // text/gated cells were coupled — two inconsistent color pipelines (spec §4.3 forbids this state).
  it('coupling with families throws in v1', () => {
    expect(() => matchGrid(img(), atlas, q2({ coupling: {}, families: ['quadrant'] }))).toThrow(/families/);
  });
});
