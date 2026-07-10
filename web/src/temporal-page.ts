// Temporal-coherence harness — in-page half (feat/temporal-animation, DESIGN §4.9). Served by the
// vite dev server (web/temporal.html) so it runs on a secure-context localhost origin where WebGPU
// is available. It drives canonical deterministic FAST/SLOW orbits, renders each frame ONCE, and
// exercises the temporal rematch path against a same-frame full-rematch reference to prove the
// central invariant and to measure the DESIGN §4.9 hysteresis hypothesis. The node driver
// (test-e2e/temporal.spec.ts) calls the window.__temporal* entry points and asserts the contract.
//
// STATUS (Agent C, wave-2 chain A): the temporal rematch API is being landed CONCURRENTLY by the
// algorithm agents (A/B). This page compiles and LOADS today with zero dependency on that API: the
// CPU-truth substrate (src/core/match.ts matchGrid — frozen) and the whole comparison machinery run
// now via window.__temporalSelfCheck. The temporal invariant/hysteresis entry points resolve the
// not-yet-landed temporal module through ONE documented seam (getTemporalRunner); until it lands
// they throw an explicit, honest "not landed" error (never a silent skip). Assemble wires the real
// signature in getTemporalRunner ONLY.

import type { Atlas, Grid, GridCell, LinearImage } from '../../src/core/types.js';
import { matchGrid } from '../../src/core/match.js';
import { defaultOptions, gridRows } from '../../src/core/options.js';
import { loadProfile } from './profile.js';
import { imageDataToLinear } from './browser-image.js';
import { Scene } from './scene.js';
import {
  SENTINEL_NOT_LANDED, SENTINEL_SHAPE_MISMATCH, SENTINEL_NO_WEBGPU,
  emptyHysteresisStats, accumulateHysteresis, type HysteresisCellInput,
  isKeyframe, driftDivergenceFrac,
  invariantPlan, type Charset, type Space,
} from './temporal-logic.js';

// ── Canonical deterministic orbits (shared with the node driver's frame plan) ─────────────────
// 61 frames each; frame f ∈ [0,60]. SLOW: 1°/frame yaw sweep (small per-frame motion — the regime
// temporal reuse targets). FAST: 6°/frame full 360° sweep (large per-frame motion — the ghosting
// stress). Pitch is fixed so the frame plan is a pure function of (mode, f) and identical in both
// halves of the harness. These match test-e2e/temporal.spec.ts EXACTLY.
export type OrbitMode = 'fast' | 'slow';
export const FRAMES = 61;
export function orbitPose(mode: OrbitMode, f: number): { yaw: number; pitch: number } {
  const pitch = -15;
  const yaw = mode === 'slow' ? f : f * 6; // SLOW 0→60°, FAST 0→360°
  return { yaw, pitch };
}

interface TemporalCfg {
  mode: OrbitMode;
  charset: Charset;
  cols: number;
  space: Space;
  label: string;
}

const atlasCache = new Map<string, Atlas>();
async function getAtlas(charset: string): Promise<Atlas> {
  let a = atlasCache.get(charset);
  if (!a) {
    a = await loadProfile(new URL(`profiles/dejavu-16-${charset}.json`, document.baseURI).href);
    atlasCache.set(charset, a);
  }
  return a;
}

let scene: Scene | null = null;
function renderFrame(cols: number, atlas: Atlas): { lin: LinearImage; rows: number } {
  const { cellW, cellH } = atlas;
  const rows = gridRows(cols, 1, 1, cellW, cellH);
  const gridW = cols * cellW, gridH = rows * cellH;
  if (!scene) scene = new Scene(document.getElementById('scene') as HTMLCanvasElement);
  const { yaw, pitch } = poseForCurrentFrame;
  scene.setOrbit(yaw, pitch);
  const img = scene.renderToImageData(gridW, gridH);
  return { lin: imageDataToLinear(img), rows };
}
const copyLin = (l: LinearImage): LinearImage => ({ w: l.w, h: l.h, data: l.data.slice(0) });
// Set by the frame loop immediately before renderFrame so the pose is a pure function of the plan.
let poseForCurrentFrame: { yaw: number; pitch: number } = { yaw: 30, pitch: -15 };

// CPU truth: full rematch of one frame (matchGrid consumes lin.data — pass a copy).
function cpuFullRematch(lin: LinearImage, atlas: Atlas, space: 'linear' | 'gamma'): Grid {
  const opts = defaultOptions(3);
  opts.space = space;
  return matchGrid({ w: lin.w, h: lin.h, data: lin.data.slice(0) }, atlas, opts);
}

// ── Byte-identity comparator ──────────────────────────────────────────────────────────────────
// The temporal invariant is a per-cell IDENTITY claim on the emitted GridCell (ch + fg + bg, the
// exact three fields that define what a cell paints). Returns the number of differing cells and the
// first differing cell (for a legible failure message). Any difference is a contract violation.
function triEq(a: [number, number, number] | null, b: [number, number, number] | null): boolean {
  if (a === null || b === null) return a === b;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}
function cellEq(a: GridCell, b: GridCell): boolean {
  return a.ch === b.ch && triEq(a.fg, b.fg) && triEq(a.bg, b.bg);
}
function diffGrids(ref: Grid, got: Grid): { mismatchCells: number; firstIdx: number; detail: string } {
  const n = ref.cells.length;
  if (got.cells.length !== n) {
    return { mismatchCells: n, firstIdx: 0, detail: `cell count ${got.cells.length} != ${n}` };
  }
  let mismatchCells = 0, firstIdx = -1, detail = '';
  for (let i = 0; i < n; i++) {
    if (!cellEq(ref.cells[i]!, got.cells[i]!)) {
      mismatchCells++;
      if (firstIdx < 0) {
        firstIdx = i;
        const r = ref.cells[i]!, g = got.cells[i]!;
        detail = `cell ${i} (col ${i % ref.cols}, row ${(i / ref.cols) | 0}): ref {ch=${JSON.stringify(r.ch)} fg=${JSON.stringify(r.fg)} bg=${JSON.stringify(r.bg)}} got {ch=${JSON.stringify(g.ch)} fg=${JSON.stringify(g.fg)} bg=${JSON.stringify(g.bg)}}`;
      }
    }
  }
  return { mismatchCells, firstIdx, detail };
}

// ── Temporal runner seam (ASSEMBLE WIRES THIS) ─────────────────────────────────────────────────
// The temporal rematch API is landed concurrently by agents A/B. The whole page depends on it
// through ONLY the interface + single dynamic import below, mirroring how web/src/webgpu/
// parity-page.ts consumed the not-yet-landed gpu-raster.js via GpuRasterLike + a dynamic import.
//
// EXPECTED CONTRACT (derived from DESIGN §4.9 + the feat/temporal-animation task brief; adjust the
// import path / method names in getTemporalRunner to A/B's landed signature — this is the ONE place
// assemble edits):
//   • runFull(lin, atlas, space, cols, rows): a full same-frame rematch through the temporal path
//     with NO reuse and NO hysteresis. This is the byte-exact REFERENCE. It MUST take the identical
//     matcher path as runTemporal so the invariant is a same-path identity (immune to CPU/GPU f32
//     divergence — the invariant is about the reuse/hysteresis LOGIC, not cross-path numerics).
//     Equivalently: runTemporal with prev=null and epsilon=delta=0.
//   • runTemporal(lin, atlas, space, cols, rows, prev, {epsilon, delta, keyframe}): reproject the
//     prev-frame selection through the pipeline's motion vectors (DESIGN §4.9) and reuse it where
//     the per-cell change is below `epsilon`; replace a retained glyph only when a fresh candidate
//     beats it by margin ≥ `delta` (hysteresis, DESIGN §4.9). At epsilon=0 AND delta=0 this MUST
//     reduce to runFull bit-for-bit — the central invariant. When `keyframe` is true the runner
//     MUST ignore prev and emit a full recompute (a video-codec I-frame; DESIGN §4.9 "delta 인코딩
//     (터미널 비디오 코덱)") — byte-identical to runFull regardless of epsilon/delta. The runner
//     MUST also treat a prev whose grid dimensions no longer match (cols/rows change) as a reset.
//   • runTemporalScored(...): SAME reproject+hysteresis as runTemporal, but also returns, PER CELL,
//     the reprojection source index and the two scores the DESIGN §4.9 δ-margin rule compares
//     (retained-predecessor rescored vs fresh full-rematch winner). The harness needs this to be a
//     TRUE oracle of the hysteresis rule — without per-cell scores the rule is unfalsifiable. If the
//     landed runner does not expose it, the hysteresis stage reports PENDING (SHAPE MISMATCH), never
//     a fabricated MET.
//   • runFull/runTemporal return a Grid whose cells carry the emitted ch/fg/bg. `matcher` names the
//     path taken. Scores are RESIDUALS (lower = better) in the same space as src/core/match.ts.
export interface TemporalParams { epsilon: number; delta: number; keyframe?: boolean }
// Per-cell provenance for the hysteresis oracle. srcIdx: reprojected predecessor index into prev
// (or -1 for a cold/disoccluded cell). retainedScore: score of prev's reprojected glyph rescored on
// this cell. bestScore/bestCh: the fresh full-rematch winner on this cell.
export interface TemporalCellStat { srcIdx: number; retainedScore: number; bestScore: number; bestCh: string }
export interface ScoredGrid { grid: Grid; stats: TemporalCellStat[] }
export interface TemporalRunner {
  matcher: 'gpu' | 'cpu';
  runFull(lin: LinearImage, atlas: Atlas, space: Space, cols: number, rows: number): Promise<Grid>;
  runTemporal(
    lin: LinearImage, atlas: Atlas, space: Space, cols: number, rows: number,
    prev: Grid, tp: TemporalParams,
  ): Promise<Grid>;
  runTemporalScored?(
    lin: LinearImage, atlas: Atlas, space: Space, cols: number, rows: number,
    prev: Grid, tp: TemporalParams,
  ): Promise<ScoredGrid>;
}

// The module path A/B are expected to land the temporal runner factory at. Kept as a runtime string
// (not a static import specifier) so this page compiles and loads BEFORE the module exists; a
// literal import of an absent module would break the whole page. Assemble: point this at the real
// module and adapt buildRunner to its exported factory.
const TEMPORAL_MODULE_PATH = './webgpu/gpu-temporal.js';
let runnerCache: TemporalRunner | null = null;
async function getTemporalRunner(): Promise<TemporalRunner> {
  if (runnerCache) return runnerCache;
  let mod: unknown;
  try {
    mod = await import(/* @vite-ignore */ TEMPORAL_MODULE_PATH);
  } catch (e) {
    throw new Error(
      `${SENTINEL_NOT_LANDED}: dynamic import of "${TEMPORAL_MODULE_PATH}" failed (${(e as Error).message.split('\n')[0]}). ` +
      `The temporal rematch path (agents A/B) is not present yet. Assemble must wire getTemporalRunner ` +
      `to the landed module (see the EXPECTED CONTRACT comment in temporal-page.ts).`,
    );
  }
  const factory = (mod as { GpuTemporal?: { create?: () => Promise<TemporalRunner | null> } }).GpuTemporal;
  if (!factory || typeof factory.create !== 'function') {
    throw new Error(
      `${SENTINEL_SHAPE_MISMATCH}: "${TEMPORAL_MODULE_PATH}" loaded but does not export GpuTemporal.create(). ` +
      `Assemble: adapt getTemporalRunner to the landed factory (EXPECTED CONTRACT in temporal-page.ts).`,
    );
  }
  const r = await factory.create();
  if (!r) throw new Error(`${SENTINEL_NO_WEBGPU}: temporal runner factory returned null (WebGPU unavailable in this context).`);
  runnerCache = r;
  return r;
}

// ── Entry points ───────────────────────────────────────────────────────────────────────────────

// Plumbing self-check (RUNNABLE NOW — no temporal API). Proves the substrate the whole invariant
// stands on: (1) the deterministic orbit renders reproducibly, and (2) matchGrid on the identical
// frame is byte-identical to itself. If this ever reports a mismatch, render or match is
// non-deterministic and the invariant harness would be measuring noise. This is NOT the temporal
// contract — it is the harness's own integrity check.
async function selfCheck(cfg: TemporalCfg): Promise<Record<string, number | string | boolean>> {
  const atlas = await getAtlas(cfg.charset);
  let mismatchFrames = 0, mismatchCellsTotal = 0, firstDetail = '';
  for (let f = 0; f < FRAMES; f++) {
    poseForCurrentFrame = orbitPose(cfg.mode, f);
    const a = renderFrame(cfg.cols, atlas);
    const gridA = cpuFullRematch(a.lin, atlas, cfg.space);
    poseForCurrentFrame = orbitPose(cfg.mode, f); // re-render the SAME pose
    const b = renderFrame(cfg.cols, atlas);
    const gridB = cpuFullRematch(b.lin, atlas, cfg.space);
    const d = diffGrids(gridA, gridB);
    if (d.mismatchCells > 0) { mismatchFrames++; mismatchCellsTotal += d.mismatchCells; if (!firstDetail) firstDetail = `frame ${f}: ${d.detail}`; }
  }
  return {
    label: cfg.label, mode: cfg.mode, charset: cfg.charset, cols: cfg.cols, space: cfg.space,
    frames: FRAMES, mismatchFrames, mismatchCellsTotal, firstDetail, matcher: 'cpu',
  };
}

// The CENTRAL INVARIANT + STATE-INVALIDATION (hard-fail contract). One canonical orbit, 61 frames,
// each rendered ONCE: per frame, runFull (reference) and runTemporal(ε=0, δ=0, prev=last temporal
// grid). The two MUST be byte-identical on every cell of every frame. prev is threaded from the
// previous frame's temporal output so the reuse machinery is genuinely exercised (and must still be
// suppressed at ε=0/δ=0). Frame 0 uses prev=null (cold).
//
// Crucially the CONFIG is NOT frozen: invariantPlan() flips space, then cols, then charset at fixed
// points (DESIGN §4.9 state-invalidation coverage). Because prev is threaded ACROSS those flips, a
// detector that fails to invalidate on a config change — or fails to reset when the threaded prev's
// dimensions no longer match (the cols flip) — serves a stale glyph and breaks byte-identity → the
// exact stale-state bug class prior rounds caught while single-config gates stayed green.
async function invariant(mode: OrbitMode): Promise<Record<string, number | string | boolean>> {
  const runner = await getTemporalRunner();
  const plan = invariantPlan();
  let mismatchFrames = 0, mismatchCellsTotal = 0, firstDetail = '';
  const transitions = new Set<string>();
  let prev: Grid | null = null;
  for (const step of plan) {
    const atlas = await getAtlas(step.cfg.charset);
    poseForCurrentFrame = orbitPose(mode, step.frame);
    const { lin, rows } = renderFrame(step.cfg.cols, atlas);
    // ONE render shared: full reference + temporal on the identical LinearImage under THIS cfg.
    const ref = await runner.runFull(copyLin(lin), atlas, step.cfg.space, step.cfg.cols, rows);
    const tmp = await runner.runTemporal(
      copyLin(lin), atlas, step.cfg.space, step.cfg.cols, rows,
      prev ?? ref, { epsilon: 0, delta: 0 },
    );
    const d = diffGrids(ref, tmp);
    if (d.mismatchCells > 0) {
      mismatchFrames++; mismatchCellsTotal += d.mismatchCells;
      if (!firstDetail) firstDetail = `frame ${step.frame} (cfg ${step.cfg.charset}/c${step.cfg.cols}/${step.cfg.space}${step.transition !== 'none' ? ` — just changed ${step.transition}` : ''}): ${d.detail}`;
    }
    if (step.transition !== 'none') transitions.add(step.transition);
    prev = tmp;
  }
  return {
    label: `inv:${mode}`, mode, charset: 'mixed', cols: 0, space: 'mixed',
    frames: plan.length, mismatchFrames, mismatchCellsTotal, firstDetail,
    transitions: [...transitions].sort().join(','), matcher: runner.matcher,
  };
}

// REFERENCE-FRAME DRIFT / KEYFRAME (DESIGN §4.9 "delta 인코딩 (터미널 비디오 코덱)"). Drives the
// SLOW orbit — the drift-accumulation regime — at a small ε>0/δ>0, threading prev, with keyframe=
// true at DRIFT_KEYFRAMES. HARD contract: at every keyframe the temporal output MUST be byte-
// identical to the same-frame full rematch (a full recompute snaps any accumulated drift back to
// ground truth); a keyframe that differs is a reference-frame-drift bug and fails the run (exit 1).
// Between keyframes it MEASURES the max divergence fraction from ground truth (reported DATA, not a
// pass threshold) so unbounded drift is visible even when the exit code is green.
async function driftKeyframe(cfg: TemporalCfg, epsilon: number, delta: number): Promise<Record<string, number | string | boolean>> {
  const atlas = await getAtlas(cfg.charset);
  const runner = await getTemporalRunner();
  let keyframeViolations = 0, keyframeMismatchCells = 0, firstDetail = '';
  let maxNonKfFrac = 0, nonKfFramesMeasured = 0, totalCells = 0;
  let prev: Grid | null = null;
  for (let f = 0; f < FRAMES; f++) {
    poseForCurrentFrame = orbitPose(cfg.mode, f);
    const { lin, rows } = renderFrame(cfg.cols, atlas);
    const full = await runner.runFull(copyLin(lin), atlas, cfg.space, cfg.cols, rows);
    const kf = isKeyframe(f);
    const tmp = await runner.runTemporal(copyLin(lin), atlas, cfg.space, cfg.cols, rows, prev ?? full, { epsilon, delta, keyframe: kf });
    const d = diffGrids(full, tmp);
    totalCells = full.cells.length;
    if (kf) {
      if (d.mismatchCells > 0) { keyframeViolations++; keyframeMismatchCells += d.mismatchCells; if (!firstDetail) firstDetail = `keyframe ${f}: ${d.detail}`; }
    } else {
      const frac = driftDivergenceFrac(d.mismatchCells, full.cells.length);
      if (frac > maxNonKfFrac) maxNonKfFrac = frac;
      nonKfFramesMeasured++;
    }
    prev = tmp;
  }
  return {
    label: cfg.label, mode: cfg.mode, charset: cfg.charset, cols: cfg.cols, space: cfg.space,
    epsilon, delta, keyframeViolations, keyframeMismatchCells, firstDetail,
    maxNonKfFrac, nonKfFramesMeasured, totalCells, matcher: runner.matcher,
  };
}

// Hysteresis oracle (DESIGN §4.9). On sampled frames with δ>0, check the temporal path's per-cell
// REPLACE/RETAIN decision against a TRUE oracle of the §4.9 δ-margin rule, computed from the per-
// cell scores the runner exposes via runTemporalScored: replace the retained glyph ONLY when the
// fresh full-rematch winner beats it by margin ≥ δ (retainedScore − bestScore ≥ δ). The oracle is
// REPROJECTION-AWARE — it compares against the predecessor the runner reprojected FROM (stat.srcIdx
// into prev), not the index-aligned prev cell — so under motion the accounting is not misattributed.
// It counts ghosting violations (kept despite a decisive margin — §4.9 "과도하면 끈적임") and sparkle
// violations (swapped on a near-tie — §4.9 "부족하면 sparkle"); either FALSIFIES the prediction.
// This is a LOGIC check (δ>0), NOT the byte-identity contract, and never fails the run.
async function hysteresis(cfg: TemporalCfg, delta: number, sampleFrames: number[]): Promise<Record<string, number | string | boolean>> {
  const atlas = await getAtlas(cfg.charset);
  const runner = await getTemporalRunner();
  if (typeof runner.runTemporalScored !== 'function') {
    throw new Error(
      `${SENTINEL_SHAPE_MISMATCH}: the landed runner exposes no runTemporalScored(); per-cell scores ` +
      `are required to falsify the DESIGN §4.9 δ-margin rule. Assemble: expose it (EXPECTED CONTRACT).`,
    );
  }
  const agg = emptyHysteresisStats();
  let prev: Grid | null = null;
  // Warm prev with a full rematch of frame 0 so the first sampled frame has a real predecessor.
  for (let f = 0; f <= Math.max(...sampleFrames); f++) {
    poseForCurrentFrame = orbitPose(cfg.mode, f);
    const { lin, rows } = renderFrame(cfg.cols, atlas);
    const full = await runner.runFull(copyLin(lin), atlas, cfg.space, cfg.cols, rows);
    if (prev && sampleFrames.includes(f)) {
      const { grid, stats } = await runner.runTemporalScored(
        copyLin(lin), atlas, cfg.space, cfg.cols, rows, prev, { epsilon: 0, delta },
      );
      const cells: HysteresisCellInput[] = [];
      for (let i = 0; i < grid.cells.length; i++) {
        const s = stats[i]!;
        const prevCh = s.srcIdx >= 0 && s.srcIdx < prev.cells.length ? prev.cells[s.srcIdx]!.ch : null;
        cells.push({ srcIdx: s.srcIdx, prevCh, emittedCh: grid.cells[i]!.ch, bestCh: s.bestCh, retainedScore: s.retainedScore, bestScore: s.bestScore });
      }
      accumulateHysteresis(agg, cells, delta);
      prev = grid;
    } else {
      prev = full;
    }
  }
  return {
    label: cfg.label, mode: cfg.mode, charset: cfg.charset, cols: cfg.cols, space: cfg.space, delta,
    sampledFrames: sampleFrames.length, cellsWithPrev: agg.cellsWithPrev,
    expectRetain: agg.expectRetain, expectReplace: agg.expectReplace, sticky: agg.sticky,
    ghostingViolations: agg.ghostingViolations, sparkleViolations: agg.sparkleViolations, strayEmissions: agg.strayEmissions,
    stickyFrac: agg.cellsWithPrev ? agg.sticky / agg.cellsWithPrev : 0, matcher: runner.matcher,
  };
}

// Reuse-speedup probe (DESIGN §4.9 "변경 셀만 delta 인코딩" performance hypothesis). Warm median of
// full vs temporal (small ε>0/δ>0) wall time on the SLOW orbit's near-static frames — the regime
// reuse is meant to accelerate. Reports both so the node driver can render MET/PARTIAL/FALSIFIED.
// A falsified speedup is a publishable result, not a failure.
async function perfProbe(cfg: TemporalCfg, epsilon: number, delta: number, n: number): Promise<{ fullMs: number; temporalMs: number }> {
  const atlas = await getAtlas(cfg.charset);
  const runner = await getTemporalRunner();
  poseForCurrentFrame = orbitPose(cfg.mode, 0);
  const first = renderFrame(cfg.cols, atlas);
  let prev = await runner.runFull(copyLin(first.lin), atlas, cfg.space, cfg.cols, first.rows);
  const fulls: number[] = [], temps: number[] = [];
  for (let i = 1; i <= n; i++) {
    poseForCurrentFrame = orbitPose(cfg.mode, i);
    const { lin, rows } = renderFrame(cfg.cols, atlas);
    const t0 = performance.now();
    await runner.runFull(copyLin(lin), atlas, cfg.space, cfg.cols, rows);
    fulls.push(performance.now() - t0);
    const t1 = performance.now();
    const tmp = await runner.runTemporal(copyLin(lin), atlas, cfg.space, cfg.cols, rows, prev, { epsilon, delta });
    temps.push(performance.now() - t1);
    prev = tmp;
  }
  const med = (a: number[]): number => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]!; };
  return { fullMs: med(fulls), temporalMs: med(temps) };
}

declare global {
  interface Window {
    __temporalSelfCheck: (cfg: TemporalCfg) => Promise<Record<string, number | string | boolean>>;
    __temporalInvariant: (mode: OrbitMode) => Promise<Record<string, number | string | boolean>>;
    __temporalHysteresis: (cfg: TemporalCfg, delta: number, sampleFrames: number[]) => Promise<Record<string, number | string | boolean>>;
    __temporalDrift: (cfg: TemporalCfg, epsilon: number, delta: number) => Promise<Record<string, number | string | boolean>>;
    __temporalPerf: (cfg: TemporalCfg, epsilon: number, delta: number, n: number) => Promise<{ fullMs: number; temporalMs: number }>;
    __temporalGpuInfo: () => Promise<Record<string, unknown>>;
    __temporalReady: boolean;
  }
}

window.__temporalSelfCheck = selfCheck;
window.__temporalInvariant = invariant;
window.__temporalHysteresis = hysteresis;
window.__temporalDrift = driftKeyframe;
window.__temporalPerf = perfProbe;
window.__temporalGpuInfo = async () => {
  const g = (navigator as unknown as { gpu?: { requestAdapter: () => Promise<{ info?: unknown } | null> } }).gpu;
  if (!g) return { hasGpu: false };
  const a = await g.requestAdapter();
  return { hasGpu: true, adapter: a ? (a.info ?? {}) : null };
};
window.__temporalReady = true;
