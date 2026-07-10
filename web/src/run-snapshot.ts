import type { Atlas } from '../../src/core/types.js';

// fix/torn-runparams-snapshot. A rematch reads the live UI params, then `await`s an atlas load
// (ensureAtlas can span a profile fetch on a charset change), then runs the pipeline. If the run
// params were re-read AFTER that await, a params mutation that lands during the await (a
// setParams call, an orbit event, a drag-drop) could pair an OLD-charset atlas with NEW run
// params in ONE commit — the exported grid/font/quality would disagree with the atlas the cells
// were actually fit against.
//
// The fix: main.ts snapshots the live params ONCE, before any await, and threads that snapshot
// through the whole run. resolveRunContext derives BOTH the atlas (loaded for snap.charset) and
// the run params from the SAME snapshot, so they can never tear. If params changed mid-run, the
// coalescer schedules a dirty-drain re-run with a fresh snapshot and main.ts's seq guard drops
// this (now-stale) commit.

// Fields captured before any await. Generic-friendly via structural typing so the caller's
// concrete literal types (charset union, quality union) survive the snapshot.
export type RunParams<S extends RunParamsInput> = Pick<S, 'cols' | 'quality' | 'space' | 'charset'>;

interface RunParamsInput {
  cols: number;
  quality: number;
  space: string;
  charset: string;
}

// Invariant: the returned atlas is the one ensureAtlas loaded for `snap.charset`, and runParams
// is derived from that SAME snapshot — so `atlas ⟷ runParams.charset` always agree.
export async function resolveRunContext<S extends RunParamsInput>(
  snap: S,
  ensureAtlas: (charset: S['charset']) => Promise<Atlas>,
): Promise<{ atlas: Atlas; runParams: RunParams<S> }> {
  const atlas = await ensureAtlas(snap.charset);
  const runParams = { cols: snap.cols, quality: snap.quality, space: snap.space, charset: snap.charset };
  return { atlas, runParams };
}
