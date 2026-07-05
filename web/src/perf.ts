// Live timing readout (M2-SPEC §2). Pure formatting over the per-stage millisecond
// numbers the scene (render) and worker (resample/match/raster/ssim) produce.

export interface PerfTimings {
  render: number;
  resample: number;
  match: number;
  raster: number;
  ssim: number;
}

export function formatPerf(t: PerfTimings): string {
  const ms = (x: number): string => x.toFixed(1) + 'ms';
  const interactive = t.match + t.raster; // the §5 "< 500ms" interactive budget
  return (
    `render ${ms(t.render)}  resample ${ms(t.resample)}  ` +
    `match ${ms(t.match)}  raster ${ms(t.raster)}  ssim ${ms(t.ssim)}  ` +
    `→ interactive ${ms(interactive)}`
  );
}

export function renderPerf(el: HTMLElement, t: PerfTimings): void {
  el.textContent = formatPerf(t);
}
