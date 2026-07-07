import { describe, it, expect, beforeAll } from 'vitest';
import { buildAtlas } from '../src/atlas/atlas.js';
import { matchGrid } from '../src/core/match.js';
import { buildPalette, xterm256Srgb, bestPairRefine } from '../src/core/palette.js';
import { srgbToLinear, linearToSrgb } from '../src/core/color.js';
import type { Atlas, MatchOptions, LinearImage, FitStatsG } from '../src/core/types.js';

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';

function defaults(overrides: Partial<MatchOptions>): MatchOptions {
  return {
    quality: 3,
    edgeLambda: 0.35,
    gateTau: 2e-4,
    mdlLambda: 0.02,
    fixedBg: [0, 0, 0],
    fixedFg: [1, 1, 1],
    ...overrides,
  };
}

// mulberry32
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomImage(atlas: Atlas, cols: number, rows: number, rng: () => number): LinearImage {
  const { cellW, cellH } = atlas;
  const w = cols * cellW, h = rows * cellH;
  const data = new Float32Array(w * h * 3);
  for (let i = 0; i < data.length; i++) data[i] = rng();
  return { w, h, data };
}

// Per-pixel working-space target for a cell, replicating matchGrid's working-space transform.
function cellWorkTarget(img: LinearImage, atlas: Atlas, col: number, row: number, space: 'linear' | 'gamma'): number[] {
  const { cellW, cellH } = atlas;
  const out: number[] = []; // channel-major [c*P + i]
  for (let c = 0; c < 3; c++) {
    for (let ly = 0; ly < cellH; ly++) {
      for (let lx = 0; lx < cellW; lx++) {
        const gi = ((row * cellH + ly) * img.w + (col * cellW + lx)) * 3 + c;
        const lin = img.data[gi]!;
        out[c * cellW * cellH + ly * cellW + lx] = space === 'gamma' ? linearToSrgb(lin) / 255 : lin;
      }
    }
  }
  return out;
}

// GENUINELY INDEPENDENT brute force: per-pixel reconstruction SSE of a glyph α + a fixed
// (fg,bg) working-space color pair. No shared closed-form / sufficient-statistics machinery.
function reconSSE(alpha: Float32Array, workT: number[], P: number, Fw: number[], Bw: number[]): number {
  let sse = 0;
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < P; i++) {
      const a = alpha[i]!;
      const pred = a * Fw[c]! + (1 - a) * Bw[c]!;
      const d = workT[c * P + i]! - pred;
      sse += d * d;
    }
  }
  return sse;
}

describe('palette definitions (xterm-256 + theme16)', () => {
  it('xterm-256 has the standard system/cube/gray layout', () => {
    const p = xterm256Srgb();
    const at = (i: number): [number, number, number] => [p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!];
    expect(at(0)).toEqual([0, 0, 0]);          // system black
    expect(at(15)).toEqual([255, 255, 255]);   // system white
    expect(at(16)).toEqual([0, 0, 0]);         // cube (0,0,0)
    expect(at(231)).toEqual([255, 255, 255]);  // cube (5,5,5)
    expect(at(52)).toEqual([95, 0, 0]);        // cube (r=1,g=0,b=0): 16+36
    expect(at(232)).toEqual([8, 8, 8]);        // first gray
    expect(at(255)).toEqual([238, 238, 238]);  // last gray
  });

  it('theme16 equals the low 16 of xterm-256', () => {
    const t = buildPalette('theme16', 'linear');
    const x = xterm256Srgb();
    expect(t.n).toBe(16);
    for (let i = 0; i < 16 * 3; i++) expect(t.srgb[i]).toBe(x[i]);
  });

  it('palette entries convert to fit space with correct gamma pairing', () => {
    const g = buildPalette('theme16', 'gamma');
    const l = buildPalette('theme16', 'linear');
    // system red = sRGB u8 [128,0,0]
    const r = 9; // index of ff0000... check a known entry: index 7 = c0c0c0
    void r;
    expect(g.work[7 * 3]).toBeCloseTo(0xc0 / 255, 6);         // gamma: u8/255
    expect(l.work[7 * 3]).toBeCloseTo(srgbToLinear(0xc0), 6); // linear: srgbToLinear(u8)
  });
});

describe('theme16 EXACT vs independent brute force', () => {
  let atlas: Atlas;
  beforeAll(async () => { atlas = await buildAtlas(FONT, 16, 'ascii'); }, 60000);

  for (const space of ['linear', 'gamma'] as const) {
    for (const quality of [3, 4] as const) {
      it(`matchGrid theme16 reaches the global (glyph,pair) argmin (${space}, Q${quality})`, () => {
        const rng = mulberry32(0xC0FFEE + quality + (space === 'gamma' ? 1 : 0));
        const cols = 3, rows = 2, P = atlas.P;
        const img = randomImage(atlas, cols, rows, rng);
        // gateTau 0 → no gating (full scan); mdlLambda 0 → pure reconstruction SSE argmin.
        const grid = matchGrid(img, atlas, defaults({ quality, space, palette: 'theme16', gateTau: 0, mdlLambda: 0 }));
        const pal = buildPalette('theme16', space);
        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) {
            const workT = cellWorkTarget(img, atlas, col, row, space);
            // NOTE: Q4 adds edge channels to the objective, which this brute force does NOT model,
            // so for Q4 we only check that the emitted colors are palette entries + a self-consistent
            // pick; the exactness comparison is the plain-L2 Q3 case.
            const cell = grid.cells[row * cols + col]!;
            const gEmit = atlas.glyphs.find((gl) => gl.ch === cell.ch)!;
            const toW = (u: [number, number, number]): number[] =>
              [0, 1, 2].map((c) => (space === 'gamma' ? u[c]! / 255 : srgbToLinear(u[c]!)));
            const Fw = toW(cell.fg!), Bw = toW(cell.bg!);
            const emitSSE = reconSSE(gEmit.alpha, workT, P, Fw, Bw);
            if (quality === 3) {
              // independent global minimum over all glyphs × 16×16 pairs
              let best = Infinity;
              for (const gl of atlas.glyphs) {
                for (let f = 0; f < 16; f++) {
                  const F = [pal.work[f * 3]!, pal.work[f * 3 + 1]!, pal.work[f * 3 + 2]!];
                  for (let b = 0; b < 16; b++) {
                    const B = [pal.work[b * 3]!, pal.work[b * 3 + 1]!, pal.work[b * 3 + 2]!];
                    const s = reconSSE(gl.alpha, workT, P, F, B);
                    if (s < best) best = s;
                  }
                }
              }
              expect(emitSSE).toBeLessThanOrEqual(best + 1e-3); // reached the global optimum
              expect(emitSSE).toBeGreaterThanOrEqual(best - 1e-3);
            }
            // emitted colors must be genuine palette entries
            for (const u of [cell.fg!, cell.bg!]) {
              let found = false;
              for (let i = 0; i < 16; i++) if (pal.srgb[i * 3] === u[0] && pal.srgb[i * 3 + 1] === u[1] && pal.srgb[i * 3 + 2] === u[2]) found = true;
              expect(found).toBe(true);
            }
          }
        }
      });
    }
  }
});

describe('palette-256 project-then-refine', () => {
  const P = 32;
  function randStats(rng: () => number): { g: FitStatsG; saT: number[]; ST: number[]; STT: number[] } {
    const alpha: number[] = [];
    for (let i = 0; i < P; i++) alpha.push(rng() < 0.3 ? (rng() < 0.5 ? 0 : 1) : rng());
    let Saa = 0, Sa1 = 0;
    for (const a of alpha) { Saa += a * a; Sa1 += a; }
    const saT = [0, 0, 0], ST = [0, 0, 0], STT = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < P; i++) {
        const t = rng();
        saT[c]! += alpha[i]! * t; ST[c]! += t; STT[c]! += t * t;
      }
    }
    return { g: { Saa, Sa1, S11: P }, saT, ST, STT };
  }

  it('refinement (k≥4) is never worse than naive nearest-projection (k=1)', () => {
    const rng = mulberry32(4242);
    for (const space of ['linear', 'gamma'] as const) {
      const pal = buildPalette('palette256', space);
      for (let trial = 0; trial < 400; trial++) {
        const { g, saT, ST, STT } = randStats(rng);
        const naive = bestPairRefine(g, saT, ST, STT, pal, 1);   // k=1 == snap each endpoint to its single nearest
        const refined = bestPairRefine(g, saT, ST, STT, pal, 8); // k=8 candidate set includes the naive pair
        expect(refined.score).toBeLessThanOrEqual(naive.score + 1e-9);
        expect(refined.fg).toBeGreaterThanOrEqual(0);
        expect(refined.fg).toBeLessThan(256);
        expect(refined.bg).toBeLessThan(256);
      }
    }
  });

  it('matchGrid palette256 emits only genuine xterm-256 entries', () => {
    // small standalone atlas build to keep the suite independent of the theme16 block
    return buildAtlas(FONT, 16, 'ascii').then((atlas) => {
      const rng = mulberry32(99);
      const img = randomImage(atlas, 4, 3, rng);
      const grid = matchGrid(img, atlas, defaults({ quality: 3, space: 'gamma', palette: 'palette256' }));
      const set = new Set<string>();
      const x = xterm256Srgb();
      for (let i = 0; i < 256; i++) set.add(`${x[i * 3]},${x[i * 3 + 1]},${x[i * 3 + 2]}`);
      for (const cell of grid.cells) {
        if (cell.fg) expect(set.has(`${cell.fg[0]},${cell.fg[1]},${cell.fg[2]}`)).toBe(true);
        if (cell.bg) expect(set.has(`${cell.bg[0]},${cell.bg[1]},${cell.bg[2]}`)).toBe(true);
      }
    });
  });
});

// Regression for the P0 gate-contract violation on the PALETTE path (adversarial review,
// major). The contrast gate is a compute-saver ONLY: on a flat cell the gated emit must be
// the full (glyph × pair) argmin under the palette constraint. Pre-fix the palette gated cell
// snapped to space + the single nearest palette entry — but unlike truecolor, a palette pair
// cannot reach the mean exactly, so a partial-coverage glyph mixing two entries can beat the
// snap (flat orange → '@' fg=red bg=yellow at SSE ~32.9 vs space+olive at ~47.1, a 1.43x error).
describe('palette gate contract — default-gated flat cell reaches the global (glyph×pair) argmin', () => {
  let atlas: Atlas;
  beforeAll(async () => { atlas = await buildAtlas(FONT, 16, 'ascii'); }, 60000);

  function flatCell(atlas: Atlas, lin: [number, number, number]): LinearImage {
    const { cellW, cellH } = atlas;
    const data = new Float32Array(cellW * cellH * 3);
    for (let i = 0; i < cellW * cellH; i++) { data[i * 3] = lin[0]; data[i * 3 + 1] = lin[1]; data[i * 3 + 2] = lin[2]; }
    return { w: cellW, h: cellH, data };
  }

  // Flat orange: its cell mean falls BETWEEN palette entries, so the mixing pair strictly
  // beats the nearest-entry snap — the exact failure the pre-fix gated path produced.
  const ORANGE: [number, number, number] = [srgbToLinear(255), srgbToLinear(128), srgbToLinear(0)];

  for (const space of ['gamma', 'linear'] as const) {
    for (const quality of [3, 4] as const) {
      it(`theme16 (${space}, Q${quality}): gated flat orange emits the exhaustive argmin, not a nearest-entry snap`, () => {
        const img = flatCell(atlas, ORANGE);
        const P = atlas.P;
        // default gateTau (2e-4) → the flat cell IS gated; mdlLambda 0 → pure reconstruction SSE
        // argmin so the brute force (which carries no MDL term) is the exact reference.
        const grid = matchGrid(img, atlas, defaults({ quality, space, palette: 'theme16', mdlLambda: 0 }));
        const cell = grid.cells[0]!;
        const pal = buildPalette('theme16', space);
        const workT = cellWorkTarget(img, atlas, 0, 0, space);
        // independent global minimum over all glyphs × 16×16 pairs (flat cell → Q4 edge energy
        // is 0, so plain reconstruction SSE is the full objective at Q3 and Q4 alike).
        let best = Infinity;
        for (const gl of atlas.glyphs) {
          for (let f = 0; f < 16; f++) {
            const F = [pal.work[f * 3]!, pal.work[f * 3 + 1]!, pal.work[f * 3 + 2]!];
            for (let b = 0; b < 16; b++) {
              const B = [pal.work[b * 3]!, pal.work[b * 3 + 1]!, pal.work[b * 3 + 2]!];
              const s = reconSSE(gl.alpha, workT, P, F, B);
              if (s < best) best = s;
            }
          }
        }
        const gEmit = atlas.glyphs.find((gl) => gl.ch === cell.ch)!;
        const toW = (u: [number, number, number]): number[] =>
          [0, 1, 2].map((c) => (space === 'gamma' ? u[c]! / 255 : srgbToLinear(u[c]!)));
        const emitSSE = reconSSE(gEmit.alpha, workT, P, toW(cell.fg ?? cell.bg!), toW(cell.bg!));
        // the gated emit IS the exhaustive argmin. In gamma the mean sits between entries so the
        // mixing pair strictly beats the nearest-entry snap — pre-fix emitted space+olive at ~1.43x
        // this bound and FAILS here; in linear the snap happens to already be the argmin (bound
        // still holds). This SSE bound, not the emitted glyph identity, is the gate contract.
        expect(emitSSE).toBeLessThanOrEqual(best + 1e-3);
        // emitted colors are genuine theme16 entries.
        for (const u of [cell.fg!, cell.bg!]) {
          let found = false;
          for (let i = 0; i < 16; i++) if (pal.srgb[i * 3] === u[0] && pal.srgb[i * 3 + 1] === u[1] && pal.srgb[i * 3 + 2] === u[2]) found = true;
          expect(found).toBe(true);
        }
      });
    }
  }
});

describe('palette mode guards + off-mode bit-identity', () => {
  let atlas: Atlas;
  beforeAll(async () => { atlas = await buildAtlas(FONT, 16, 'ascii'); }, 60000);

  it('truecolor output is byte-identical whether palette is absent or explicitly undefined', () => {
    const rng = mulberry32(7);
    const img = randomImage(atlas, 4, 3, rng);
    for (const space of ['gamma', 'linear'] as const) {
      for (const quality of [3, 4] as const) {
        const absent = matchGrid(img, atlas, defaults({ quality, space }));
        const explicit = matchGrid(img, atlas, defaults({ quality, space, palette: undefined }));
        expect(explicit.cells).toEqual(absent.cells);
      }
    }
  });

  it('rejects palette on quality < 3', () => {
    const img = randomImage(atlas, 1, 1, mulberry32(1));
    expect(() => matchGrid(img, atlas, defaults({ quality: 2, palette: 'theme16' }))).toThrow(/quality 3 or 4/);
  });

  it('rejects palette combined with the M1/M3 priors', () => {
    const img = randomImage(atlas, 1, 1, mulberry32(2));
    expect(() => matchGrid(img, atlas, defaults({ quality: 3, palette: 'theme16', topK: 8 }))).toThrow(/incompatible/);
    expect(() => matchGrid(img, atlas, defaults({ quality: 3, palette: 'theme16', collapseThreshold: 16 }))).toThrow(/incompatible/);
    expect(() => matchGrid(img, atlas, defaults({ quality: 3, palette: 'theme16', families: ['braille'] }))).toThrow(/incompatible/);
  });
});
