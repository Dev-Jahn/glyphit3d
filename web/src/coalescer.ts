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
//
// fix/rematch-promise-completion: request() resolves when the run() that COVERS that request
// completes — not before. A request is covered by the first run() that begins at or after it:
// the request that starts the loop is covered by run #1; a request that arrives while run #K is
// in flight is covered by the drain run #K+1. Every request coalesced onto one run forms a batch
// and all members of that batch settle together when their covering run() settles. So awaiting
// request() (e.g. `await __app.rematch()`) means the work covering that call is actually done,
// not merely scheduled. (Previously a coalesced caller's promise resolved immediately, before
// the drain covering it had run.)

export interface Coalescer {
  request(interactive: boolean): Promise<void>;
  readonly busy: boolean;
}

type Waiter = { resolve: () => void; reject: (e: unknown) => void };

export function createCoalescer(run: (interactive: boolean) => Promise<void>): Coalescer {
  let looping = false;
  let dirty = false;
  let pendingNonInteractive = false;
  // Requests waiting for their covering run(). New requests always join `batch`; the drive loop
  // hands the current `batch` to the run it is about to start (that run covers exactly those
  // requests) and installs a fresh empty `batch` for whatever arrives during that run.
  let batch: Waiter[] = [];

  async function drive(firstInteractive: boolean): Promise<void> {
    let runInteractive = firstInteractive;
    // The run about to start covers whoever is queued right now; later arrivals join the NEXT
    // batch. Captured synchronously (before the first await) so the starter lands in run #1.
    let settling = batch;
    batch = [];
    try {
      for (;;) {
        dirty = false;
        pendingNonInteractive = false;
        await run(runInteractive);
        for (const w of settling) w.resolve(); // this run's batch is now covered — release it
        settling = [];
        if (!dirty) break;
        runInteractive = !pendingNonInteractive; // a queued non-interactive request forces SSIM
        settling = batch; // the next drain covers everything that arrived during this run
        batch = [];
      }
    } catch (e) {
      // The in-flight run failed: reject the batch it was covering, and any requests that
      // coalesced onto the drain that will now never run (the loop aborts on error, as before —
      // a fresh request starts a new loop). No promise is left dangling.
      for (const w of settling) w.reject(e);
      for (const w of batch) w.reject(e);
      batch = [];
    } finally {
      looping = false;
    }
  }

  function request(interactive: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      batch.push({ resolve, reject });
      if (looping) {
        // A run is in flight: coalesce. Mark dirty so the running loop drains once more, and
        // carry the strictest requirement — a queued non-interactive request forces SSIM.
        dirty = true;
        if (!interactive) pendingNonInteractive = true;
        return;
      }
      looping = true;
      void drive(interactive);
    });
  }

  return {
    request,
    // `busy` stays true across the whole coalescing loop (incl. the gap between iterations),
    // so consumers polling idleness never see it blip false mid-drain.
    get busy(): boolean { return looping; },
  };
}
