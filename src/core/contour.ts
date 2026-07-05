// Contour post-pass (M3-SPEC §3.4), STANDALONE. Polyline extraction (marching
// squares on a per-cell coverage grid) + Viterbi over per-cell top-K candidates
// with the spec's stroke-continuity pairwise cost. This module does NOT import
// the matcher: it consumes a generic per-cell candidate list (Candidate below,
// the §3.4 topK shape) that phase-2 wiring (match.ts) will produce and feed in.

import type { BorderProfile } from '../atlas/orientation.js';

// The §3.4 topK candidate emitted per cell: a glyph choice with its selection
// score (lower = better, SSE-based) and resolved fg/bg colors. The Viterbi keeps
// one of these per contour cell.
export interface Candidate {
  glyphIdx: number;
  score: number;
  F: [number, number, number];
  B: [number, number, number];
  // Carried through the Viterbi verbatim (never read here) so the consumer can reconstruct
  // non-text winners: `ch` names a family/collapse/gated glyph directly (glyphIdx may not
  // resolve it), `fgNull` records the emitted cell's fg=null. Mirror core/types.ts Candidate.
  ch?: string;
  fgNull?: boolean;
}

// Extract ordered boundary-cell polylines from a per-cell coverage grid
// (cols*rows, row-major). A cell is INSIDE when coverage ≥ threshold; a boundary
// cell is an inside cell with at least one in-grid orthogonal neighbour outside
// (off-grid neighbours are ignored, so a silhouette running along the frame is
// not spuriously traced). Boundary cells are walked into ordered chains: 4-conn
// neighbours (shared side) are preferred over diagonal so straight/axis contours
// come out as clean single-width chains; each returned array is a sequence of
// cell indices, consecutive entries orthogonally adjacent wherever the contour
// is not diagonal. Deterministic (row-major seeding, fixed neighbour order).
export function extractPolylines(
  coverage: ArrayLike<number>, cols: number, rows: number, threshold = 0.5,
): number[][] {
  const N = cols * rows;
  const inside = new Uint8Array(N);
  for (let i = 0; i < N; i++) inside[i] = coverage[i]! >= threshold ? 1 : 0;

  const isB = new Uint8Array(N);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!inside[i]) continue;
      const up = r > 0 && !inside[i - cols];
      const dn = r < rows - 1 && !inside[i + cols];
      const lf = c > 0 && !inside[i - 1];
      const rt = c < cols - 1 && !inside[i + 1];
      if (up || dn || lf || rt) isB[i] = 1;
    }
  }

  // 8-connected neighbours of a boundary cell, 4-conn first (deterministic).
  const neighbours = (i: number): number[] => {
    const r = (i / cols) | 0, c = i % cols;
    const out: number[] = [];
    const push = (rr: number, cc: number) => {
      if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) return;
      const j = rr * cols + cc;
      if (isB[j]) out.push(j);
    };
    push(r - 1, c); push(r + 1, c); push(r, c - 1); push(r, c + 1); // orthogonal
    push(r - 1, c - 1); push(r - 1, c + 1); push(r + 1, c - 1); push(r + 1, c + 1); // diagonal
    return out;
  };

  const degree = new Int32Array(N);
  for (let i = 0; i < N; i++) if (isB[i]) degree[i] = neighbours(i).length;

  const visited = new Uint8Array(N);
  const polylines: number[][] = [];

  const walk = (start: number): number[] => {
    const chain: number[] = [];
    let cur = start;
    while (cur >= 0 && !visited[cur]) {
      visited[cur] = 1;
      chain.push(cur);
      let next = -1;
      for (const nb of neighbours(cur)) {           // 4-conn already ordered first
        if (!visited[nb]) { next = nb; break; }
      }
      cur = next;
    }
    return chain;
  };

  // seed at endpoints (degree ≤ 1) first so open contours are walked end-to-end,
  // then remaining unvisited cells (closed loops) in row-major order.
  for (let i = 0; i < N; i++) if (isB[i] && !visited[i] && degree[i]! <= 1) polylines.push(walk(i));
  for (let i = 0; i < N; i++) if (isB[i] && !visited[i]) polylines.push(walk(i));

  return polylines.filter((p) => p.length > 1);
}

// The shared side between two orthogonally-adjacent cells, expressed as the exit
// side of `a` and the entry side of `b`. null when a,b are not 4-adjacent.
type Side = 'top' | 'bottom' | 'left' | 'right';
function sharedSide(a: number, b: number, cols: number): { exit: Side; entry: Side } | null {
  const d = b - a;
  if (d === 1) return { exit: 'right', entry: 'left' };
  if (d === -1) return { exit: 'left', entry: 'right' };
  if (d === cols) return { exit: 'bottom', entry: 'top' };
  if (d === -cols) return { exit: 'top', entry: 'bottom' };
  return null;
}

// §3.4 pairwise stroke-continuity cost between consecutive contour cells a→b that
// pick glyphs g1,g2. Zero when the cells are not 4-adjacent (no shared side).
//   κ_c · ( |p_exit − p_entry| + 0.5·|m_exit − m_entry| )
// masses are already normalised to [0,1] in BorderProfile, so the spec's ·norm
// is folded in and the two terms are commensurate.
function pairwise(
  a: number, b: number, cols: number,
  g1: number, g2: number, profiles: BorderProfile[], kappaC: number,
): number {
  const s = sharedSide(a, b, cols);
  if (!s) return 0;
  const e = profiles[g1]![s.exit];
  const n = profiles[g2]![s.entry];
  return kappaC * (Math.abs(e.pos - n.pos) + 0.5 * Math.abs(e.mass - n.mass));
}

// Viterbi over one polyline: states = each cell's candidate list, unary = the
// candidate score, pairwise = stroke continuity (above). Returns the chosen
// candidate per cell index. O(len·K²), deterministic (strict-improvement argmin
// ⇒ ties keep the lower candidate index). Direction-agnostic: reversing the
// polyline yields the same per-cell choices (total path cost is symmetric).
export function viterbiContour(
  polyline: number[],
  candsByCell: Candidate[][],
  profiles: BorderProfile[],
  cols: number,
  kappaC: number,
): Map<number, Candidate> {
  const result = new Map<number, Candidate>();
  const L = polyline.length;
  if (L === 0) return result;

  const dp: number[][] = [];
  const bp: number[][] = [];
  const cand0 = candsByCell[polyline[0]!]!;
  dp.push(cand0.map((c) => c.score));
  bp.push(cand0.map(() => -1));

  for (let t = 1; t < L; t++) {
    const prevCell = polyline[t - 1]!, curCell = polyline[t]!;
    const prev = candsByCell[prevCell]!, cur = candsByCell[curCell]!;
    const prevDp = dp[t - 1]!;
    const row: number[] = new Array(cur.length);
    const back: number[] = new Array(cur.length);
    for (let j = 0; j < cur.length; j++) {
      let best = Infinity, bi = 0;
      for (let i = 0; i < prev.length; i++) {
        const cost = prevDp[i]! + pairwise(prevCell, curCell, cols, prev[i]!.glyphIdx, cur[j]!.glyphIdx, profiles, kappaC);
        if (cost < best) { best = cost; bi = i; }
      }
      row[j] = best + cur[j]!.score;
      back[j] = bi;
    }
    dp.push(row);
    bp.push(back);
  }

  // traceback from the best terminal state.
  const last = dp[L - 1]!;
  let bestJ = 0, bestV = Infinity;
  for (let j = 0; j < last.length; j++) if (last[j]! < bestV) { bestV = last[j]!; bestJ = j; }
  const choice: number[] = new Array(L);
  for (let t = L - 1; t >= 0; t--) { choice[t] = bestJ; bestJ = bp[t]![bestJ]!; }
  for (let t = 0; t < L; t++) result.set(polyline[t]!, candsByCell[polyline[t]!]![choice[t]!]!);
  return result;
}
