// F1R-1 single-flight coalescing runner. Guarantees at most ONE run() is ever in flight,
// so EVERY rematch entry point (UI controls, quality ladder, orbit drag, drag-drop, the
// initial render, the Playwright __app.rematch surface) shares one serialized queue and can
// never re-enter run() concurrently. Concurrent re-entry on the GPU path would race the one
// shared GpuMatcher's staging-buffer host map-state (mapAsync / getMappedRange), producing a
// wrong latest frame or a noisy CPU fallback — the monotonic seq guard in main.ts only blocks
// a STALE commit, it cannot stop two gpu.match() calls overlapping. This queue does.
//
// A request that arrives mid-run does NOT start a second run: it marks the work dirty, and the
// running loop drains it once more when it settles — so the LATEST request always wins
// (latest-wins coalescing). The strictest pending flag propagates: if ANY coalesced request
// was non-interactive, the drain run is non-interactive (interactive === false ⇒ compute SSIM).

export interface Coalescer {
  request(interactive: boolean): Promise<void>;
  readonly busy: boolean;
}

export function createCoalescer(run: (interactive: boolean) => Promise<void>): Coalescer {
  let looping = false;
  let dirty = false;
  let pendingNonInteractive = false;

  async function request(interactive: boolean): Promise<void> {
    if (looping) {
      // A run is in flight: coalesce. Mark dirty so the running loop drains once more, and
      // carry the strictest requirement — a queued non-interactive request forces SSIM.
      dirty = true;
      if (!interactive) pendingNonInteractive = true;
      return;
    }
    looping = true;
    let runInteractive = interactive;
    try {
      do {
        dirty = false;
        pendingNonInteractive = false;
        await run(runInteractive);
        runInteractive = !pendingNonInteractive; // a queued non-interactive request forces SSIM
      } while (dirty);
    } finally {
      looping = false;
    }
  }

  return {
    request,
    // `busy` stays true across the whole coalescing loop (incl. the gap between iterations),
    // so consumers polling idleness never see it blip false mid-drain.
    get busy(): boolean { return looping; },
  };
}
