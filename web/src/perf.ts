// Live timing readout (M2-SPEC §2). Pure formatting over the per-stage millisecond
// numbers the scene (render) and worker (resample/match/raster/ssim) produce.

export interface PerfTimings {
  render: number;
  resample: number;
  match: number;
  raster: number;
  ssim: number;
}

// feat/temporal-animation (SPEC §6.2): OPTIONAL changed/total cell readout for the temporal
// delta path. The PerfTimings shape is UNCHANGED (the four stage fields the scene/worker produce);
// this is a purely additive display argument, absent on every non-temporal (full-rematch) run so
// the readout is byte-for-byte today's string when no temporal stats are supplied.
export interface TemporalCells { changed: number; total: number }

export function formatPerf(t: PerfTimings, temporal?: TemporalCells): string {
  const ms = (x: number): string => x.toFixed(1) + 'ms';
  const interactive = t.match + t.raster; // the §5 "< 500ms" interactive budget
  const base =
    `render ${ms(t.render)}  resample ${ms(t.resample)}  ` +
    `match ${ms(t.match)}  raster ${ms(t.raster)}  ssim ${ms(t.ssim)}  ` +
    `→ interactive ${ms(interactive)}`;
  if (!temporal) return base;
  const pct = temporal.total > 0 ? (100 * temporal.changed) / temporal.total : 0;
  return `${base}  temporal ${temporal.changed}/${temporal.total} cells (${pct.toFixed(1)}%)`;
}

export function renderPerf(el: HTMLElement, t: PerfTimings, temporal?: TemporalCells): void {
  el.textContent = formatPerf(t, temporal);
}
