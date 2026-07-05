// Synthesized ideal-mask families + exact region solver (M3-SPEC §2, DESIGN §3.6/§5.6).
//
// A family is k disjoint fractional regions R_1..R_k (α_i ∈ [0,1]^P) plus implicit
// background, built by partitioning an 8× supersample of the cell. A pattern S ⊆
// {0..k-1} selects coverage α_S = Σ_{i∈S} α_i; the family enumerates all 2^k patterns.
//
// Landing braille + exact-geometry blocks is INDEPENDENT of font coverage: terminals
// synthesize these ranges themselves and bake mode rasterizes our own masks, so the
// mask model here is self-consistent in both (DESIGN §5.6).
//
// The per-cell solve reuses the EXISTING fit machinery verbatim (fitFree/fitFgOnly/
// fitBox/sseAt from core/fit) — the thin channel wrapper below is a byte-for-byte copy
// of match.ts's channelSse/channelFB and MUST stay in sync with it.

import type { FitStatsG } from '../core/types.js';
import { sseAt, fitFree, fitFgOnly, fitBox } from '../core/fit.js';

export type FamilyName = 'quadrant' | 'sextant' | 'braille';

export interface Family {
  name: FamilyName;
  k: number;
  P: number;
  regions: Float32Array[]; // k masks, each length P (fractional coverage)
  bg: Float32Array;        // 1 − Σ regions, length P
  dxR: Float32Array[];     // per-region central-difference gradients (Q4)
  dyR: Float32Array[];
  // per-pattern precomputed tables (length 2^k). sumAA/gradAA are EXACT (include the
  // region–region cross terms that appear at odd-split internal boundaries — see below).
  sumA: Float32Array;
  sumAA: Float32Array;
  gradAA: Float32Array;
  rawInk: Float32Array;    // Σ(|dxA_S|+|dyA_S|) per pattern, un-normalized
  ink: Float32Array;       // rawInk normalized to [0,1] (MDL complexity proxy)
  ch: string[];            // codepoint char per pattern (empty pattern → ' ')
}

const SS = 8; // supersample factor (M3-SPEC §2.1)

// ---- codepoint maps ----------------------------------------------------------

// quadrant region index = row*2+col over the 2×2 lattice: 0=TL,1=TR,2=BL,3=BR.
// pattern value = Σ_{i∈S} 2^i. All 16 block chars exist (DESIGN §3.6).
const QUADRANT_CH = [
  ' ',      // 0
  '▘', // 1  TL           ▘
  '▝', // 2  TR           ▝
  '▀', // 3  TL+TR        ▀ upper half
  '▖', // 4  BL           ▖
  '▌', // 5  TL+BL        ▌ left half
  '▞', // 6  TR+BL        ▞
  '▛', // 7  TL+TR+BL     ▛
  '▗', // 8  BR           ▗
  '▚', // 9  TL+BR        ▚
  '▐', // 10 TR+BR        ▐ right half
  '▜', // 11 TL+TR+BR     ▜
  '▄', // 12 BL+BR        ▄ lower half
  '▙', // 13 TL+BL+BR     ▙
  '▟', // 14 TR+BL+BR     ▟
  '█', // 15 all          █ full
];

// sextant region index = row*2+col over the 2×3 lattice (bit p = 2^p):
// p0=TL p1=TR p2=ML p3=MR p4=BL p5=BR. Left col {0,2,4}=21 → ▌, right {1,3,5}=42 → ▐.
// Others map to U+1FB00 (Symbols for Legacy Computing) minus the 3 skipped codepoints
// (0/space, 21/▌, 42/▐, 63/█ are all pre-existing elsewhere).
function sextantChar(v: number): string {
  if (v === 0) return ' ';
  if (v === 63) return '█';
  if (v === 21) return '▌';
  if (v === 42) return '▐';
  let off = v - 1;
  if (v > 21) off -= 1;
  if (v > 42) off -= 1;
  return String.fromCodePoint(0x1fb00 + off);
}

// braille region index = row*2+col over the 2×4 lattice. Unicode dot bit per region:
// left col (dots 1,2,3,7) → bits 0,1,2,6; right col (dots 4,5,6,8) → bits 3,4,5,7.
const BRAILLE_UNIBIT = [0, 3, 1, 4, 2, 5, 6, 7]; // region idx (row*2+col) → U+2800 bit
function brailleChar(v: number): string {
  if (v === 0) return ' ';
  let bits = 0;
  for (let i = 0; i < 8; i++) if ((v >> i) & 1) bits |= 1 << BRAILLE_UNIBIT[i]!;
  return String.fromCodePoint(0x2800 + bits);
}

// ---- geometry ----------------------------------------------------------------

// Assign a supersample point at pixel-space (x,y) to a region index, or −1 for
// background. Partitioning at the supersample level guarantees disjointness there;
// at cell resolution the disk families stay cross-term-free (disks are separated by
// background), while quadrant/sextant develop small region–region cross terms on the
// one pixel row/col straddling an odd split — those are carried EXACTLY by the
// precomputed sumAA/gradAA tables, so the solver is exact regardless (proven by the
// brute-force exactness test).
function regionAssigner(name: FamilyName, cellW: number, cellH: number): (x: number, y: number) => number {
  if (name === 'quadrant') {
    return (x, y) => {
      const col = x < cellW / 2 ? 0 : 1;
      const row = y < cellH / 2 ? 0 : 1;
      return row * 2 + col;
    };
  }
  if (name === 'sextant') {
    return (x, y) => {
      const col = x < cellW / 2 ? 0 : 1;
      const row = y < cellH / 3 ? 0 : y < (2 * cellH) / 3 ? 1 : 2;
      return row * 2 + col;
    };
  }
  // braille: 2×4 disks, diameter d = 0.42·cellW, centers on the 2×4 lattice.
  const r = 0.21 * cellW;
  const r2 = r * r;
  const cx = [0.25 * cellW, 0.75 * cellW];
  const cy = [0.125 * cellH, 0.375 * cellH, 0.625 * cellH, 0.875 * cellH];
  return (x, y) => {
    for (let row = 0; row < 4; row++) {
      const dy = y - cy[row]!;
      for (let col = 0; col < 2; col++) {
        const dx = x - cx[col]!;
        if (dx * dx + dy * dy <= r2) return row * 2 + col;
      }
    }
    return -1;
  };
}

function familyK(name: FamilyName): number {
  return name === 'quadrant' ? 4 : name === 'sextant' ? 6 : 8;
}

function patternChar(name: FamilyName, v: number): string {
  return name === 'quadrant' ? QUADRANT_CH[v]! : name === 'sextant' ? sextantChar(v) : brailleChar(v);
}

export function buildFamily(name: FamilyName, cellW: number, cellH: number): Family {
  const P = cellW * cellH;
  const k = familyK(name);
  const assign = regionAssigner(name, cellW, cellH);

  const regions = Array.from({ length: k }, () => new Float32Array(P));
  const inv = 1 / (SS * SS);
  for (let py = 0; py < cellH; py++) {
    for (let px = 0; px < cellW; px++) {
      const p = py * cellW + px;
      for (let sy = 0; sy < SS; sy++) {
        const y = py + (sy + 0.5) / SS;
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          const ri = assign(x, y);
          if (ri >= 0) { const rr = regions[ri]!; rr[p] = rr[p]! + inv; }
        }
      }
    }
  }

  // background = 1 − Σ regions
  const bg = new Float32Array(P);
  for (let p = 0; p < P; p++) {
    let s = 0;
    for (let i = 0; i < k; i++) s += regions[i]![p]!;
    bg[p] = 1 - s;
  }

  // per-region central-difference gradients, zero-padded at cell borders (matches atlas.ts)
  const dxR = Array.from({ length: k }, () => new Float32Array(P));
  const dyR = Array.from({ length: k }, () => new Float32Array(P));
  for (let i = 0; i < k; i++) {
    const a = regions[i]!;
    const dx = dxR[i]!;
    const dy = dyR[i]!;
    for (let py = 0; py < cellH; py++) {
      for (let px = 0; px < cellW; px++) {
        const idx = py * cellW + px;
        if (px > 0 && px < cellW - 1) dx[idx] = (a[idx + 1]! - a[idx - 1]!) / 2;
        if (py > 0 && py < cellH - 1) dy[idx] = (a[idx + cellW]! - a[idx - cellW]!) / 2;
      }
    }
  }

  // per-region scalars + region Gram (exact cross terms)
  const s = new Float32Array(k);                 // Σ α_i
  const G = Array.from({ length: k }, () => new Float32Array(k));     // Σ α_i·α_j
  const Ggrad = Array.from({ length: k }, () => new Float32Array(k)); // Σ dxα_i·dxα_j + dyα_i·dyα_j
  for (let i = 0; i < k; i++) {
    const ai = regions[i]!;
    let si = 0;
    for (let p = 0; p < P; p++) si += ai[p]!;
    s[i] = si;
    for (let j = i; j < k; j++) {
      const aj = regions[j]!;
      const dxi = dxR[i]!, dyi = dyR[i]!, dxj = dxR[j]!, dyj = dyR[j]!;
      let g = 0, gg = 0;
      for (let p = 0; p < P; p++) {
        g += ai[p]! * aj[p]!;
        gg += dxi[p]! * dxj[p]! + dyi[p]! * dyj[p]!;
      }
      G[i]![j] = g; G[j]![i] = g;
      Ggrad[i]![j] = gg; Ggrad[j]![i] = gg;
    }
  }

  // per-pattern tables. sumAA(S)=Σ_{i,j∈S}G_ij and gradAA(S)=Σ_{i,j∈S}Ggrad_ij are
  // EXACT (cross terms included). rawInk needs |Σ_{i∈S} dxα_i| so it is computed from
  // the actually-summed pattern gradient (per pattern, one-time).
  const N = 1 << k;
  const sumA = new Float32Array(N);
  const sumAA = new Float32Array(N);
  const gradAA = new Float32Array(N);
  const rawInk = new Float32Array(N);
  const ch: string[] = new Array(N);
  for (let S = 0; S < N; S++) {
    let a = 0, aa = 0, gg = 0;
    for (let i = 0; i < k; i++) {
      if (!((S >> i) & 1)) continue;
      a += s[i]!;
      for (let j = 0; j < k; j++) {
        if (!((S >> j) & 1)) continue;
        aa += G[i]![j]!;
        gg += Ggrad[i]![j]!;
      }
    }
    sumA[S] = a; sumAA[S] = aa; gradAA[S] = gg;
    // rawInk from the summed pattern gradient
    let ink = 0;
    for (let p = 0; p < P; p++) {
      let gx = 0, gy = 0;
      for (let i = 0; i < k; i++) {
        if (!((S >> i) & 1)) continue;
        gx += dxR[i]![p]!;
        gy += dyR[i]![p]!;
      }
      ink += Math.abs(gx) + Math.abs(gy);
    }
    rawInk[S] = ink;
    ch[S] = patternChar(name, S);
  }

  // default normalization by this family's own max (buildFamilies re-normalizes by the
  // global max across the requested families so MDL is comparable between them).
  let maxInk = 0;
  for (let S = 0; S < N; S++) if (rawInk[S]! > maxInk) maxInk = rawInk[S]!;
  const ink = new Float32Array(N);
  if (maxInk > 0) for (let S = 0; S < N; S++) ink[S] = rawInk[S]! / maxInk;

  return { name, k, P, regions, bg, dxR, dyR, sumA, sumAA, gradAA, rawInk, ink, ch };
}

// Build several families and normalize their ink onto ONE [0,1] scale (global max
// across all patterns) so the MDL complexity penalty is comparable across families in
// meta-selection (braille's dense patterns pay more than a quadrant half-block).
export function buildFamilies(names: FamilyName[], cellW: number, cellH: number): Family[] {
  const fams = names.map((n) => buildFamily(n, cellW, cellH));
  let maxInk = 0;
  for (const f of fams) for (let S = 0; S < f.rawInk.length; S++) if (f.rawInk[S]! > maxInk) maxInk = f.rawInk[S]!;
  if (maxInk > 0) {
    for (const f of fams) {
      const ink = new Float32Array(f.rawInk.length);
      for (let S = 0; S < ink.length; S++) ink[S] = f.rawInk[S]! / maxInk;
      (f as { ink: Float32Array }).ink = ink;
    }
  }
  return fams;
}

// ---- per-cell solver ---------------------------------------------------------

// Cell target stats needed by the family solve. These are exactly the fields matchGrid
// already has from cellStats, forwarded so the solve reuses the same targets.
export interface CellFitCtx {
  P: number;
  T: Float32Array;      // 3*P target
  ST: Float32Array;     // 3
  STT: Float32Array;    // 3
  minT: Float32Array;   // 3
  maxT: Float32Array;   // 3
  dxT: Float32Array;    // 3*P
  dyT: Float32Array;    // 3*P
  gradTT: Float32Array; // 3
  quality: number;
  isQ4: boolean;
  lam2: number;
  ffg: [number, number, number]; // working-space fixed fg
  fbg: [number, number, number]; // working-space fixed bg
  mdlLambda: number;
  eacScale: number;
}

// Byte-for-byte copy of match.ts channelSse (must stay in sync). Scores a candidate at
// the current fit mode using the shared fit primitives (never the regression identity
// off the OLS optimum).
function channelSse(
  g: FitStatsG, SaT: number, S1T: number, STT: number,
  quality: number, minTc: number, maxTc: number, ffg: number, fbg: number,
): number {
  const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
  if (quality === 1) return sseAt(g, ffg - fbg, fbg, SaT, S1T, STT);
  if (quality === 2) {
    const r = fitFgOnly(g, SaT, S1T, STT, fbg);
    const F = clamp01(r.a + fbg);
    return sseAt(g, F - fbg, fbg, SaT, S1T, STT);
  }
  const free = fitFree(g, SaT, S1T, STT);
  const F = free.a + free.b;
  const B = free.b;
  if (F >= minTc && F <= maxTc && B >= minTc && B <= maxTc) return free.sse;
  return fitBox(g, SaT, S1T, STT, minTc, maxTc, minTc, maxTc).sse;
}

// Byte-for-byte copy of match.ts channelFB (must stay in sync).
function channelFB(
  g: FitStatsG, SaT: number, S1T: number, STT: number,
  quality: number, minTc: number, maxTc: number, ffg: number, fbg: number,
): [number, number] {
  const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
  if (quality === 1) return [ffg, fbg];
  if (quality === 2) {
    const r = fitFgOnly(g, SaT, S1T, STT, fbg);
    return [clamp01(r.a + fbg), fbg];
  }
  const free = fitFree(g, SaT, S1T, STT);
  const F = free.a + free.b;
  const B = free.b;
  if (F >= minTc && F <= maxTc && B >= minTc && B <= maxTc) return [F, B];
  const box = fitBox(g, SaT, S1T, STT, minTc, maxTc, minTc, maxTc);
  return [box.F, box.B];
}

export interface FamilySolve {
  pattern: number;
  sse: number;   // Σ_c channelSse only (no MDL) — the reconstruction residual
  score: number; // sse + mdlLambda·ink·eacScale — the meta-selection score
  F: [number, number, number];
  B: [number, number, number];
  ch: string;
}

// Exact region solve over all 2^k patterns for one cell. Region↔target dot products
// are computed once (O(k·P) per channel); each pattern then assembles the six fit
// stats in O(k) from those dots and the precomputed pattern tables, and is scored with
// the shared fit machinery. Returns the argmin pattern with its colors.
export function solveFamily(f: Family, ctx: CellFitCtx): FamilySolve {
  const { P, T, ST, STT, minT, maxT, dxT, dyT, gradTT, quality, isQ4, lam2, ffg, fbg, mdlLambda, eacScale } = ctx;
  const k = f.k;

  // per-region per-channel dot products d[i*3+c] = Σ_p α_i·T_c  (+ Q4 gradient dots)
  const dRegion = new Float64Array(k * 3);
  const gRegion = isQ4 ? new Float64Array(k * 3) : null;
  for (let i = 0; i < k; i++) {
    const a = f.regions[i]!;
    const dxa = f.dxR[i]!, dya = f.dyR[i]!;
    for (let c = 0; c < 3; c++) {
      const base = c * P;
      let d = 0;
      for (let p = 0; p < P; p++) d += a[p]! * T[base + p]!;
      dRegion[i * 3 + c] = d;
      if (gRegion) {
        let gd = 0;
        for (let p = 0; p < P; p++) gd += dxa[p]! * dxT[base + p]! + dya[p]! * dyT[base + p]!;
        gRegion[i * 3 + c] = gd;
      }
    }
  }

  const gStats: FitStatsG = { Saa: 0, Sa1: 0, S11: P };
  const N = 1 << k;
  let bestScore = Infinity, bestSse = Infinity, bestPat = 0;
  for (let S = 0; S < N; S++) {
    gStats.Sa1 = f.sumA[S]!;
    gStats.S11 = P;
    gStats.Saa = isQ4 ? f.sumAA[S]! + lam2 * f.gradAA[S]! : f.sumAA[S]!;
    let sse = 0;
    for (let c = 0; c < 3; c++) {
      let saT = 0;
      for (let i = 0; i < k; i++) if ((S >> i) & 1) saT += dRegion[i * 3 + c]!;
      let stt = STT[c]!;
      if (isQ4) {
        let gd = 0;
        for (let i = 0; i < k; i++) if ((S >> i) & 1) gd += gRegion![i * 3 + c]!;
        saT += lam2 * gd;
        stt += lam2 * gradTT[c]!;
      }
      sse += channelSse(gStats, saT, ST[c]!, stt, quality, minT[c]!, maxT[c]!, ffg[c]!, fbg[c]!);
    }
    const score = sse + mdlLambda * f.ink[S]! * eacScale;
    if (score < bestScore) { bestScore = score; bestSse = sse; bestPat = S; }
  }

  // recompute the winner's colors (once) with the same stats
  gStats.Sa1 = f.sumA[bestPat]!;
  gStats.S11 = P;
  gStats.Saa = isQ4 ? f.sumAA[bestPat]! + lam2 * f.gradAA[bestPat]! : f.sumAA[bestPat]!;
  const F: [number, number, number] = [0, 0, 0];
  const B: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let saT = 0;
    for (let i = 0; i < k; i++) if ((bestPat >> i) & 1) saT += dRegion[i * 3 + c]!;
    let stt = STT[c]!;
    if (isQ4) {
      let gd = 0;
      for (let i = 0; i < k; i++) if ((bestPat >> i) & 1) gd += gRegion![i * 3 + c]!;
      saT += lam2 * gd;
      stt += lam2 * gradTT[c]!;
    }
    const fb = channelFB(gStats, saT, ST[c]!, stt, quality, minT[c]!, maxT[c]!, ffg[c]!, fbg[c]!);
    F[c] = fb[0];
    B[c] = fb[1];
  }

  return { pattern: bestPat, sse: bestSse, score: bestScore, F, B, ch: f.ch[bestPat]! };
}
