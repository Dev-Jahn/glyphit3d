import { describe, it, expect, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildAtlas } from '../src/atlas/atlas.js';
import { matchGrid } from '../src/core/match.js';
import { toAnsi } from '../src/render/ansi.js';
import { defaultOptions } from '../src/core/options.js';
import { applyIdentity } from '../src/cli.js';
import { srgbToLinear, linearToSrgb } from '../src/core/color.js';
import { rampSet, precomputeIdentity } from '../src/core/identity.js';
import type { Atlas, MatchOptions, LinearImage, Grid } from '../src/core/types.js';

// feat/color-dither-toggle — two changes:
//   (1) CLI applyIdentity default identityCoherence flips to 'pure-ramp' (override preserved).
//   (2) MatchOptions.identityColorDither (default true=coupling; false=monochrome: fg=encode(ffg)
//       forced on every identity Q2 emit, bypassing coupling + the fg color fit).
// Proven to fail against HEAD (state per block); the byte-identity blocks are invariants (pass on both).

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = resolve(ROOT, 'docs/assets/demo.png');

function q2(o: Partial<MatchOptions> = {}): MatchOptions {
  return { ...defaultOptions(2), ...o };
}

// working-space (gamma) value of a u8 level, matching match.ts's work encode.
const work = (u8: number) => linearToSrgb(srgbToLinear(u8)) / 255;

// half-split cells (top/bottom two u8 levels) → real AC energy so every cell is an OBJECT cell that
// runs the full scan (the winner emit path). Brightness increases across columns.
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

// A single flat cell of one u8 level — exercises the GATED (contrast-gate) emit path.
function flatCell(atlas: Atlas, u8: number): LinearImage {
  const { cellW, cellH } = atlas;
  const data = new Float32Array(cellW * cellH * 3);
  const v = srgbToLinear(u8);
  for (let i = 0; i < cellW * cellH; i++) { data[i * 3] = v; data[i * 3 + 1] = v; data[i * 3 + 2] = v; }
  return { w: cellW, h: cellH, data };
}

// A single flat chromatic cell — gated path with a chromatic fg (coupling keeps it chromatic; mono
// forces it white).
function flatColorCell(atlas: Atlas, rgb: [number, number, number]): LinearImage {
  const { cellW, cellH } = atlas;
  const data = new Float32Array(cellW * cellH * 3);
  const v: [number, number, number] = [srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2])];
  for (let i = 0; i < cellW * cellH; i++) { data[i * 3] = v[0]; data[i * 3 + 1] = v[1]; data[i * 3 + 2] = v[2]; }
  return { w: cellW, h: cellH, data };
}

// Spearman rank correlation (ties → 0 denominator → 0).
function spearman(a: number[], b: number[]): number {
  const rank = (xs: number[]) => { const idx = xs.map((_, i) => i).sort((i, j) => xs[i]! - xs[j]!); const r = new Array(xs.length); idx.forEach((oi, k) => r[oi] = k); return r as number[]; };
  const ra = rank(a), rb = rank(b), n = a.length;
  const ma = ra.reduce((s, x) => s + x, 0) / n, mb = rb.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = ra[i]! - ma, y = rb[i]! - mb; num += x * y; da += x * x; db += y * y; }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
}

// ── Change 1: pure-ramp is the identity default coherence (applyIdentity unit) ──────────────────
// FAIL vs HEAD: HEAD's applyIdentity leaves identityCoherence undefined unless --identity-coherence
// is given, so `=== 'pure-ramp'` fails (undefined).
describe('applyIdentity default coherence is pure-ramp', () => {
  it('--identity alone sets identityCoherence pure-ramp and leaves coupling on (color dither default)', () => {
    const opts = defaultOptions(2);
    applyIdentity(opts, { identity: true });
    expect(opts.identityCoherence).toBe('pure-ramp');
    expect(opts.coupling).toBeDefined();               // default color dither = coupling on
    expect(opts.identityColorDither).toBeUndefined();  // = default true
  });
  it('an explicit --identity-coherence still overrides the pure-ramp default', () => {
    const opts = defaultOptions(2);
    applyIdentity(opts, { identity: true, 'identity-coherence': 'ramp-bias' });
    expect(opts.identityCoherence).toBe('ramp-bias');
  });
  it('--identity-color-dither off drops coupling and sets identityColorDither false', () => {
    const opts = defaultOptions(2);
    applyIdentity(opts, { identity: true, 'identity-color-dither': 'off' });
    expect(opts.identityColorDither).toBe(false);
    expect(opts.coupling).toBeUndefined();             // monochrome ⇒ no coupling pass
    expect(opts.identityCoherence).toBe('pure-ramp');  // still the default
  });
});

// ── Change 2: monochrome (identityColorDither:false) forces fg=encode(ffg) on both emit paths ────
// FAIL vs HEAD: HEAD ignores identityColorDither, so the fg is the fitted (channelFB) color — grey on
// object cells, chromatic on the colored gated cell — not white.
describe('identityColorDither:false emits monochrome fg=encode(fixedFg)', () => {
  let atlas: Atlas;
  beforeAll(async () => { atlas = await buildAtlas(FONT, 16, 'ascii'); });
  const WHITE: [number, number, number] = [255, 255, 255]; // encode(fixedFg=[1,1,1]) in gamma space

  it('every object-scan cell fg == encode(ffg) (fg colour variance zero) on a brightness gradient', () => {
    const pairs: [number, number][] = [[6, 20], [10, 34], [16, 48], [24, 60], [30, 76], [40, 90], [60, 120], [90, 170]];
    const g = matchGrid(halfSplitScene(atlas, pairs), atlas, q2({ identityLambda: 5, identityCoherence: 'pure-ramp', identityColorDither: false }));
    for (const c of g.cells) expect(c.fg).toEqual(WHITE);
  });

  it('every gated flat cell fg == encode(ffg) across a brightness sweep', () => {
    for (const u8 of [30, 90, 150, 200, 250]) {
      const g = matchGrid(flatCell(atlas, u8), atlas, q2({ identityLambda: 5, identityCoherence: 'pure-ramp', identityColorDither: false }));
      expect(g.cells[0]!.fg).toEqual(WHITE);
    }
  });

  it('a chromatic gated cell is white under mono but chromatic under the coupling default', () => {
    const img = flatColorCell(atlas, [230, 120, 40]); // bright orange
    const gMono = matchGrid(img, atlas, q2({ identityLambda: 5, identityCoherence: 'pure-ramp', identityColorDither: false }));
    const gDither = matchGrid(img, atlas, q2({ identityLambda: 5, identityCoherence: 'pure-ramp', coupling: {} }));
    expect(gMono.cells[0]!.fg).toEqual(WHITE);
    const f = gDither.cells[0]!.fg!;
    expect(Math.max(...f) - Math.min(...f)).toBeGreaterThan(20); // coupling keeps the orange chromaticity
  });

  it('glyph density still tracks cell luma (pure-ramp ramp, not a uniform fill)', () => {
    const idA = precomputeIdentity(atlas), R = new Set(rampSet(atlas).chars);
    const H = atlas.cellH, half = Math.floor(H / 2);
    const pairs: [number, number][] = [[6, 20], [10, 34], [16, 48], [24, 60], [30, 76], [40, 90], [60, 120], [90, 170]];
    const g = matchGrid(halfSplitScene(atlas, pairs), atlas, q2({ identityLambda: 5, identityCoherence: 'pure-ramp', identityColorDither: false }));
    const ybar = pairs.map(([t, b]) => (half * work(t) + (H - half) * work(b)) / H);
    const rhoOf = (ch: string) => idA.rho[atlas.glyphs.findIndex((gg) => gg.ch === ch)]!;
    const rhos = g.cells.map((c) => rhoOf(c.ch));
    for (const c of g.cells) expect(R.has(c.ch)).toBe(true); // ramp glyphs only
    expect(new Set(rhos).size).toBeGreaterThan(1);            // not a uniform fill
    expect(spearman(rhos, ybar)).toBeGreaterThan(0);          // density ↔ luma positive
  });
});

// ── Invariant: identityColorDither absent/true is inert (byte-identical to HEAD's identity path) ──
// Passes on BOTH HEAD and the change (an invariant, not a fail-first behavior test): the mono logic
// fires only for identityColorDither===false.
describe('identityColorDither true/absent leaves the identity path byte-identical', () => {
  let atlas: Atlas;
  beforeAll(async () => { atlas = await buildAtlas(FONT, 16, 'blocks'); });
  it('coherence none + dither true == dither omitted (ANSI sha256)', () => {
    const scene = halfSplitScene(atlas, [[6, 20], [30, 76], [90, 170], [40, 90]]);
    const gOmit = matchGrid(scene, atlas, q2({ identityLambda: 5 }));
    const gTrue = matchGrid(scene, atlas, q2({ identityLambda: 5, identityColorDither: true }));
    expect(createHash('sha256').update(toAnsi(gTrue)).digest('hex'))
      .toBe(createHash('sha256').update(toAnsi(gOmit)).digest('hex'));
  });
});

// ── CLI guards (subprocess, exit 2 idiom) ───────────────────────────────────────────────────────
// FAIL vs HEAD: HEAD's parseArgs does not know --identity-color-dither → "Unknown option" → exit 1
// (not the guarded exit 2), and the valid combination cannot run at all.
function runCli(extra: string[]): { status: number; stderr: string } {
  try {
    execFileSync('npx', ['tsx', 'src/cli.ts', 'image', DEMO, '--cols', '20', ...extra], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
    return { status: 0, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer };
    return { status: err.status ?? -1, stderr: err.stderr?.toString() ?? '' };
  }
}

describe('cli --identity-color-dither guards', () => {
  it('--identity-color-dither off without --identity exits 2', () => {
    const r = runCli(['--identity-color-dither', 'off']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/identity/);
  }, 60000);

  it('--identity --identity-color-dither bad (invalid value) exits 2', () => {
    const r = runCli(['--identity', '--identity-color-dither', 'bad']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/on\|off/);
  }, 60000);

  it('--identity --identity-color-dither off (valid) is accepted', () => {
    const r = runCli(['--identity', '--identity-color-dither', 'off', '-o', '/dev/null']);
    expect(r.status).toBe(0);
  }, 60000);

  // monochrome leaves coupling unset, so a coupling-override flag would be silently ignored — reject it
  // loudly (parallels --palette-k-without--palette). Without the guard this combo exits 0 (flag dropped).
  it('--identity --couple-strength N --identity-color-dither off exits 2 (coupling-override under mono)', () => {
    const r = runCli(['--identity', '--couple-strength', '2', '--identity-color-dither', 'off']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/couple-strength/);
  }, 60000);
});
