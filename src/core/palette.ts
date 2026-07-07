// Palette-constrained two-color modes (DESIGN §6: color depth axis theme16/ansi256).
//
// Both modes reuse the SAME per-glyph sufficient statistics and the SAME arbitrary-(a,b)
// scorer as the unconstrained fit (fit.ts sseAt, DESIGN §3.2 (2)) — the ONLY difference is
// that the fit no longer solves for a continuous (F,B); it argmins over a DISCRETE grid of
// palette (fg,bg) color pairs. For a FIXED (F,B) pair the reconstruction error separates
// across channels, so the pair score is Σ_c sseAt(g, F_c−B_c, B_c, …) — exactly formula (2),
// never the OLS regression identity (which is only valid at the unconstrained optimum).
//
// - theme16 (16 colors): EXACT. n×n = 256 pairs enumerated per glyph → global argmin over
//   the pair grid. No approximation.
// - palette-256: exact would be 256×256 = 65536 pairs per glyph — too big. We APPROXIMATE
//   via project-then-refine: solve the unconstrained (F*,B*), take the top-k nearest palette
//   entries (fit-space Euclidean) to F* and to B* independently, then EXACT-evaluate the k×k
//   candidate pairs. This is suboptimal — the true best discrete pair need not have either
//   endpoint among the k nearest to the continuous optimum (coverage-weighting couples the
//   endpoints), so a better pair can be missed. It is however never worse than naive
//   nearest-projection (k=1), since that pair is always inside the k×k candidate set.
//
// Palette entries are defined in sRGB u8 (the terminal's palette) and converted into the
// active FIT/WORKING space (DESIGN §3.1): gamma → u8/255, linear → srgbToLinear(u8). Scoring
// and nearest-neighbor distances happen in that working space; the emitted GridCell colors are
// the exact sRGB u8 palette entries (no round-trip).

import type { FitStatsG } from './types.js';
import { sseAt, fitFree } from './fit.js';
import { srgbToLinear } from './color.js';

export type PaletteName = 'theme16' | 'palette256';

export interface Palette {
  name: PaletteName;
  srgb: Uint8Array;   // n*3, sRGB u8 (emitted colors)
  work: Float32Array; // n*3, working-space floats (fit/scoring/distance)
  n: number;
}

// xterm/VGA default 16-color system palette (the canonical ANSI theme; identical to entries
// 0..15 of xterm-256). Documented choice: the terminal-default system colors, so theme16 and
// palette-256 share their low 16 exactly.
const SYS16: readonly number[] = [
  0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0x80, 0x00, 0x80, 0x80, 0x00,
  0x00, 0x00, 0x80, 0x80, 0x00, 0x80, 0x00, 0x80, 0x80, 0xc0, 0xc0, 0xc0,
  0x80, 0x80, 0x80, 0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0xff, 0xff, 0x00,
  0x00, 0x00, 0xff, 0xff, 0x00, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff,
];

// Standard xterm-256: 16 system + 6×6×6 color cube (16..231) + 24 grays (232..255).
export function xterm256Srgb(): Uint8Array {
  const out = new Uint8Array(256 * 3);
  for (let i = 0; i < 16 * 3; i++) out[i] = SYS16[i]!;
  const level = (v: number): number => (v === 0 ? 0 : 55 + v * 40); // 0,95,135,175,215,255
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        const idx = 16 + 36 * r + 6 * g + b;
        out[idx * 3] = level(r);
        out[idx * 3 + 1] = level(g);
        out[idx * 3 + 2] = level(b);
      }
    }
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10; // 8..238
    const idx = 232 + i;
    out[idx * 3] = v;
    out[idx * 3 + 1] = v;
    out[idx * 3 + 2] = v;
  }
  return out;
}

function toWork(srgb: Uint8Array, space: 'linear' | 'gamma'): Float32Array {
  const out = new Float32Array(srgb.length);
  for (let i = 0; i < srgb.length; i++) out[i] = space === 'gamma' ? srgb[i]! / 255 : srgbToLinear(srgb[i]!);
  return out;
}

export function buildPalette(name: PaletteName, space: 'linear' | 'gamma'): Palette {
  const srgb = name === 'theme16' ? Uint8Array.from(SYS16) : xterm256Srgb();
  return { name, srgb, work: toWork(srgb, space), n: srgb.length / 3 };
}

export function paletteSrgb(pal: Palette, idx: number): [number, number, number] {
  return [pal.srgb[idx * 3]!, pal.srgb[idx * 3 + 1]!, pal.srgb[idx * 3 + 2]!];
}

export interface PairResult { score: number; fg: number; bg: number }

// Σ_c sseAt for a fixed (fg,bg) working-color pair. g/saT/ST/STT already carry the Q4
// edge augmentation when applicable (S1T stays the plain ST since the gradient rows'
// constant basis is 0), so this scores Q3 and Q4 identically to the unconstrained path.
function pairSse(
  g: FitStatsG, saT: ArrayLike<number>, ST: ArrayLike<number>, STT: ArrayLike<number>,
  work: Float32Array, fg: number, bg: number,
): number {
  let s = 0;
  for (let c = 0; c < 3; c++) {
    const F = work[fg * 3 + c]!;
    const B = work[bg * 3 + c]!;
    s += sseAt(g, F - B, B, saT[c]!, ST[c]!, STT[c]!);
  }
  return s;
}

// theme16 (and any small palette): EXACT argmin over the full n×n (fg,bg) pair grid.
export function bestPairExact(
  g: FitStatsG, saT: ArrayLike<number>, ST: ArrayLike<number>, STT: ArrayLike<number>, pal: Palette,
): PairResult {
  const { work, n } = pal;
  let score = Infinity, fg = 0, bg = 0;
  for (let f = 0; f < n; f++) {
    for (let b = 0; b < n; b++) {
      const s = pairSse(g, saT, ST, STT, work, f, b);
      if (s < score) { score = s; fg = f; bg = b; }
    }
  }
  return { score, fg, bg };
}

// top-k nearest palette indices to a working-space RGB target, by squared fit-space
// Euclidean distance. k small (≥1); simple insertion into a sorted k-buffer.
function topKNearest(pal: Palette, tr: number, tg: number, tb: number, k: number, out: number[]): number {
  const { work, n } = pal;
  const dist: number[] = [];
  out.length = 0;
  for (let i = 0; i < n; i++) {
    const dr = work[i * 3]! - tr, dg = work[i * 3 + 1]! - tg, db = work[i * 3 + 2]! - tb;
    const d = dr * dr + dg * dg + db * db;
    // insert (i,d) keeping out[] sorted by ascending d, capped at k
    let pos = out.length;
    while (pos > 0 && dist[pos - 1]! > d) pos--;
    if (pos < k) {
      out.splice(pos, 0, i);
      dist.splice(pos, 0, d);
      if (out.length > k) { out.pop(); dist.pop(); }
    }
  }
  return out.length;
}

const _fgBuf: number[] = [];
const _bgBuf: number[] = [];

// palette-256: project-then-refine (APPROXIMATE — see file header). Solve the unconstrained
// per-channel (F*,B*), gather the k nearest palette entries to each, exact-score the k×k pairs.
export function bestPairRefine(
  g: FitStatsG, saT: ArrayLike<number>, ST: ArrayLike<number>, STT: ArrayLike<number>, pal: Palette, k: number,
): PairResult {
  const fF = fitFree(g, saT[0]!, ST[0]!, STT[0]!);
  const fG = fitFree(g, saT[1]!, ST[1]!, STT[1]!);
  const fB = fitFree(g, saT[2]!, ST[2]!, STT[2]!);
  const nf = topKNearest(pal, fF.a + fF.b, fG.a + fG.b, fB.a + fB.b, k, _fgBuf);
  const nb = topKNearest(pal, fF.b, fG.b, fB.b, k, _bgBuf);
  let score = Infinity, fg = _fgBuf[0]!, bg = _bgBuf[0]!;
  for (let fi = 0; fi < nf; fi++) {
    for (let bi = 0; bi < nb; bi++) {
      const s = pairSse(g, saT, ST, STT, pal.work, _fgBuf[fi]!, _bgBuf[bi]!);
      if (s < score) { score = s; fg = _fgBuf[fi]!; bg = _bgBuf[bi]!; }
    }
  }
  return { score, fg, bg };
}

// Dispatch: theme16 → exact grid; palette256 → project-then-refine.
export function bestPair(
  g: FitStatsG, saT: ArrayLike<number>, ST: ArrayLike<number>, STT: ArrayLike<number>, pal: Palette, refineK: number,
): PairResult {
  return pal.name === 'theme16' ? bestPairExact(g, saT, ST, STT, pal) : bestPairRefine(g, saT, ST, STT, pal, refineK);
}
