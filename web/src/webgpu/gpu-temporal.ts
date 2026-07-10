import type { Atlas, Grid, GridCell, LinearImage } from '../../../src/core/types.js';
import { linearToSrgb } from '../../../src/core/color.js';
import { defaultOptions } from '../../../src/core/options.js';
import { applyContrastFloor } from './contrast-floor-post.js';
import {
  GpuMatcher, cellChanged, sigChanged, type GpuMatchOpts, type TemporalSig, type TemporalMatchResult,
} from './gpu-matcher.js';

// Temporal delta-frame + glyph-hysteresis runner for the Q3 GPU web path (feat/temporal-animation,
// DESIGN §4.9). This is the module web/src/temporal-page.ts dynamic-imports (GpuTemporal.create) and
// the API the harness contract (temporal-page.ts EXPECTED CONTRACT + test-e2e/temporal.spec.ts)
// enforces. It wraps ONE GpuMatcher:
//   • runFull            → a full same-frame rematch through the GPU matcher (the byte-exact REF).
//   • runTemporal        → change-detected delta frame + §4.1 glyph hysteresis. At ε=0 AND δ=0 it is
//                          byte-identical to runFull (the §3.2 exactness lemma, asserted per frame).
//   • runTemporalScored  → same, plus the per-cell scores the harness's TRUE δ-margin oracle needs.
//
// STATE MODEL (the crux of the same-runner contract). The harness calls runFull and runTemporal on
// the SAME instance every frame, so runFull MUST NOT touch temporal state. Therefore the reference
// lives HOST-side here — refPatch (the last-recompute working-space patches) + refCells (the last
// emitted grid) — never in the GpuMatcher's GPU scratch (which runFull overwrites). The compacted
// kernel only ever reads the changed cells it is handed, so the shared GPU scratch needs no
// persistence; reference-frame change detection (§3.1) is a pure host compare of the current prep
// against refPatch. refPatch is a COPY (slice) so runFull's full-frame prep cannot corrupt it.
//
// KEYFRAME / RESET (§4.4): first frame, any TemporalSig change (atlas/charset, cols/rows, space,
// gateTau, mdlLambda, contrast-floor), an explicit keyframe flag, or a prev whose dims no longer
// match ⇒ a full recompute + fresh reference (byte-identical to runFull). ANY thrown error in a
// temporal path invalidates the state so the NEXT run keyframes (device-lost / OOM safety).
//
// MOTION-VECTOR NOTE (spec §2, recorded as an ssotConflict): the current pipeline exposes no
// velocity/depth AOV, so v1 reprojection is IDENTITY — the predecessor of cell i is cell i. srcIdx
// is therefore always the same cell index; motion-vector reprojection is a registered follow-up.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Space = 'linear' | 'gamma';
interface TemporalParams { epsilon: number; delta: number; keyframe?: boolean }
interface TemporalCellStat { srcIdx: number; retainedScore: number; bestScore: number; bestCh: string }
interface ScoredGrid { grid: Grid; stats: TemporalCellStat[] }

// Temporal-state reset decision (§4.4 keyframe matrix), pure so the reset axes are unit-testable
// (gpu-temporal-reset.test.ts) — precedent: temporal-route.ts keyframeNeeded, gpu-matcher.ts
// sigChanged. A reset means a full recompute + a fresh reference; a MISSED reset pairs a stale
// reference emit with a new decision regime and silently corrupts output.
//
// The retained reference (refPatch + refCells) is only reusable UNDER THE SAME temporal params it
// was built with. sigChanged covers the config axes (atlas/space/cols/rows/P/gateTau/mdlLambda/
// floor); refInvalid covers a missing/mis-sized reference or a prev whose dims no longer match. But
// ε and δ are NOT config — they are per-call knobs — and a reference built at δ>0 can hold a STICKY
// (hysteresis-retained) glyph whose argmin differs. If a later call switches to δ=0 on an unchanged
// config with a bit-unchanged cell, the cell is detected UNCHANGED and its sticky emit is reused
// verbatim — violating the unconditional ε=0∧δ=0 byte-identity contract (temporal-page.ts EXPECTED
// CONTRACT). ε is symmetric (a reference skipped under a coarser ε carries a coarser decision). So
// ANY change in ε or δ vs the reference's own (refEpsilon/refDelta) forces a keyframe reset.
export function temporalResetNeeded(i: {
  keyframe: boolean;
  sigDiffers: boolean;       // sigChanged(prev config sig, this run's sig)
  refInvalid: boolean;       // no reference / length mismatch / prev-grid dims changed
  refEpsilon: number;        // ε the current reference was built with (NaN when none ⇒ always resets)
  refDelta: number;          // δ the current reference was built with
  epsilon: number;           // this call's ε
  delta: number;             // this call's δ
}): boolean {
  return i.keyframe || i.sigDiffers || i.refInvalid
    || i.refEpsilon !== i.epsilon || i.refDelta !== i.delta;
}

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
function gammaU8(v: number): number { return Math.round(clamp01(v) * 255); }
function toU8(v: number): number { const s = Math.round(linearToSrgb(v)); return s < 0 ? 0 : s > 255 ? 255 : s; }

export class GpuTemporal {
  readonly matcher = 'gpu' as const;
  private readonly m: GpuMatcher;

  // Host-side temporal reference (the reuse machinery's ground truth).
  private refPatch: Float32Array | null = null; // numCells·3·P, the last-recompute working-space patches
  private refCells: GridCell[] | null = null;   // the last emitted grid (skipped cells reuse this verbatim)
  private sig: TemporalSig | null = null;
  // The (ε, δ) the current reference was built with — a change vs these forces a keyframe (see
  // temporalResetNeeded). NaN before any reference exists (so the first call always resets).
  private refEpsilon = NaN;
  private refDelta = NaN;
  private atlasChMap: { atlas: Atlas; map: Map<string, number> } | null = null;

  private constructor(m: GpuMatcher) { this.m = m; }

  static async create(): Promise<GpuTemporal | null> {
    const m = await GpuMatcher.create();
    if (!m) return null;
    return new GpuTemporal(m);
  }

  // Q3 web-path options the matcher must use to match matchGrid (SSOT defaults). The contrast floor
  // is threaded (0 by default → the parity-exact path) and is a keyframe-forcing param (sigChanged).
  private opts(space: Space): GpuMatchOpts {
    const d = defaultOptions(3);
    return { quality: 3, space, gateTau: d.gateTau, mdlLambda: d.mdlLambda, contrastFloor: d.contrastFloor ?? 0 };
  }

  private toGrid(cells: GridCell[], atlas: Atlas, cols: number, rows: number): Grid {
    return { cols, rows, cells, cellW: atlas.cellW, cellH: atlas.cellH, font: atlas.fontPath };
  }

  // ch → glyph index (cached per atlas). glyphs[0] is space by atlas contract, so ' ' maps to it.
  private chMap(atlas: Atlas): Map<string, number> {
    if (this.atlasChMap && this.atlasChMap.atlas === atlas) return this.atlasChMap.map;
    const map = new Map<string, number>();
    for (let gi = 0; gi < atlas.glyphs.length; gi++) {
      const ch = atlas.glyphs[gi]!.ch;
      if (!map.has(ch)) map.set(ch, gi);
    }
    this.atlasChMap = { atlas, map };
    return map;
  }

  private invalidate(): void { this.refPatch = null; this.refCells = null; this.sig = null; this.refEpsilon = NaN; this.refDelta = NaN; }

  async runFull(lin: LinearImage, atlas: Atlas, space: Space, cols: number, rows: number): Promise<Grid> {
    const res = await this.m.match(lin, atlas, this.opts(space), cols, rows);
    return this.toGrid(res.cells, atlas, cols, rows);
  }

  async runTemporal(
    lin: LinearImage, atlas: Atlas, space: Space, cols: number, rows: number, prev: Grid, tp: TemporalParams,
  ): Promise<Grid> {
    return (await this.temporalCore(lin, atlas, space, cols, rows, prev, tp, false)).grid;
  }

  async runTemporalScored(
    lin: LinearImage, atlas: Atlas, space: Space, cols: number, rows: number, prev: Grid, tp: TemporalParams,
  ): Promise<ScoredGrid> {
    const r = await this.temporalCore(lin, atlas, space, cols, rows, prev, tp, true);
    return { grid: r.grid, stats: r.stats! };
  }

  // Shared delta-frame core. wantScored additionally emits the per-cell hysteresis oracle stats.
  private async temporalCore(
    lin: LinearImage, atlas: Atlas, space: Space, cols: number, rows: number, prev: Grid, tp: TemporalParams,
    wantScored: boolean,
  ): Promise<{ grid: Grid; stats?: TemporalCellStat[] }> {
    const opts = this.opts(space);
    const P = atlas.P;
    const numCells = cols * rows;
    const cellLen = 3 * P;
    const nextSig: TemporalSig = {
      atlas, space, cols, rows, P, gateTau: opts.gateTau, mdlLambda: opts.mdlLambda, contrastFloor: opts.contrastFloor ?? 0,
    };
    try {
      const prepped = this.m.prepFromLinear(lin, atlas, opts, cols, rows);
      const { targetHost, cstatHost, gated } = prepped;

      const refInvalid =
        this.refPatch === null || this.refPatch.length !== numCells * cellLen
        || this.refCells === null || this.refCells.length !== numCells
        || prev.cells.length !== numCells;
      const reset = temporalResetNeeded({
        keyframe: tp.keyframe === true,
        sigDiffers: sigChanged(this.sig, nextSig),
        refInvalid,
        refEpsilon: this.refEpsilon, refDelta: this.refDelta,
        epsilon: tp.epsilon, delta: tp.delta,
      });

      // ── Keyframe / reset: full recompute (byte-identical to runFull) + fresh reference. ──
      if (reset) {
        const res = await this.m.matchPrepped(prepped, atlas, opts, cols, rows);
        this.refPatch = targetHost.slice(0);
        this.refCells = res.cells.slice();
        this.sig = nextSig;
        this.refEpsilon = tp.epsilon;
        this.refDelta = tp.delta;
        const grid = this.toGrid(res.cells, atlas, cols, rows);
        if (!wantScored) return { grid };
        // A reset has no reprojected predecessor to decide against → srcIdx=-1 (oracle skips).
        const stats: TemporalCellStat[] = res.cells.map((c) => ({ srcIdx: -1, retainedScore: 0, bestScore: 0, bestCh: c.ch }));
        return { grid, stats };
      }

      // ── Delta frame: detect changed cells against the retained reference (§3.1). ──
      const ref = this.refPatch!;
      const refCells = this.refCells!;
      const chMap = this.chMap(atlas);
      const changed = new Uint8Array(numCells);
      const changedList: number[] = [];
      const prevGiList: number[] = [];
      for (let cell = 0; cell < numCells; cell++) {
        if (!cellChanged(targetHost, ref, cell * cellLen, cellLen, tp.epsilon)) continue;
        changed[cell] = 1;
        if (!gated[cell]) {
          changedList.push(cell);
          const pch = prev.cells[cell]?.ch ?? ' ';
          prevGiList.push(chMap.get(pch) ?? 0);
        }
      }

      // Recompute only the changed, non-gated cells on the GPU (compacted dispatch + hysteresis).
      let tres: TemporalMatchResult | null = null;
      if (changedList.length > 0) {
        tres = await this.m.matchPreppedTemporal(
          prepped, atlas, opts, cols, rows,
          Uint32Array.from(changedList), Uint32Array.from(prevGiList), tp.delta,
        );
      }

      // Assemble: changed non-gated ← GPU; changed gated ← CPU flat; unchanged ← reuse verbatim.
      const encode = space === 'gamma' ? gammaU8 : toU8;
      const cells: GridCell[] = new Array(numCells);
      const winners = new Uint32Array(numCells);
      const floorSkip: (GridCell | undefined)[] = new Array(numCells);
      for (let cell = 0; cell < numCells; cell++) {
        if (!changed[cell]) {
          cells[cell] = refCells[cell]!;   // §3.2: identical patch ⇒ identical emit — reuse verbatim
          floorSkip[cell] = refCells[cell]; // already floored when last recomputed → skip re-floor
          continue;
        }
        const gc = gated[cell];
        if (gc) { cells[cell] = gc; floorSkip[cell] = gc; continue; } // gated flat cell (floor-exempt)
        const gi = tres!.glyphChosen[cell]!;
        const b = cell * 6;
        cells[cell] = {
          ch: atlas.glyphs[gi]!.ch,
          fg: [encode(tres!.fb[b]!), encode(tres!.fb[b + 1]!), encode(tres!.fb[b + 2]!)],
          bg: [encode(tres!.fb[b + 3]!), encode(tres!.fb[b + 4]!), encode(tres!.fb[b + 5]!)],
        };
        winners[cell] = gi;
        floorSkip[cell] = undefined; // apply the floor here (fresh non-gated winner)
      }
      // Contrast floor on the FRESH non-gated cells only (reused/gated are skipped via floorSkip);
      // strict no-op at floor=0 (the harness path). targetHost carries the current patch per cell.
      applyContrastFloor(cells, winners, floorSkip, targetHost, atlas, cols, rows, space, opts.contrastFloor ?? 0);

      // Advance the reference for changed cells ONLY (unchanged cells ARE the reference — §3.1).
      for (let cell = 0; cell < numCells; cell++) {
        if (!changed[cell]) continue;
        ref.set(targetHost.subarray(cell * cellLen, cell * cellLen + cellLen), cell * cellLen);
        refCells[cell] = cells[cell]!;
      }
      this.sig = nextSig;

      const grid = this.toGrid(cells, atlas, cols, rows);
      if (!wantScored) return { grid };

      // Per-cell oracle stats. Scores are NORMALIZED by E_AC so the harness's raw `margin >= delta`
      // check reproduces the kernel's δ·E_AC decision (temporal-logic.ts self-consistency).
      const stats: TemporalCellStat[] = new Array(numCells);
      for (let cell = 0; cell < numCells; cell++) {
        if (changed[cell] && !gated[cell]) {
          const eac = cstatHost[cell * 16 + 3]!; // E_AC(t) = cstat.st.w
          const norm = eac > 0 ? eac : 1;
          stats[cell] = {
            srcIdx: cell, // identity reprojection (v1) — the predecessor of cell i is cell i
            retainedScore: tres!.retainedScore[cell]! / norm,
            bestScore: tres!.bestScore[cell]! / norm,
            bestCh: atlas.glyphs[tres!.glyphBest[cell]!]!.ch,
          };
        } else {
          stats[cell] = { srcIdx: -1, retainedScore: 0, bestScore: 0, bestCh: cells[cell]!.ch };
        }
      }
      return { grid, stats };
    } catch (e) {
      this.invalidate(); // §4.4: any thrown error invalidates temporal state → next run keyframes
      throw e;
    }
  }
}
