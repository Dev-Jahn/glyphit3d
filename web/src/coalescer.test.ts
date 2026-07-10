import { describe, it, expect } from 'vitest';
import { createCoalescer } from './coalescer.js';

// F1R-1. The coalescer is the single serialization point for every rematch entry point, so
// its semantics are the load-bearing invariant: exactly one run() in flight (single-flight),
// mid-run requests fold into ONE drain run (coalescing / latest-wins), and the drain carries
// the strictest interactive requirement. These are pure-logic tests — no DOM, no GPU.

// A run() whose completion the test controls: each call records its `interactive` arg and
// returns a promise resolved on demand (deferreds[i] settles the i-th run() invocation).
function makeRun(): { calls: boolean[]; deferreds: Array<() => void>; run: (i: boolean) => Promise<void> } {
  const calls: boolean[] = [];
  const deferreds: Array<() => void> = [];
  const run = (interactive: boolean): Promise<void> => {
    calls.push(interactive);
    return new Promise<void>((resolve) => { deferreds.push(resolve); });
  };
  return { calls, deferreds, run };
}

// Drain the microtask + macrotask queue so an awaited run() continuation can advance the loop.
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('single-flight coalescer (F1R-1)', () => {
  it('runs immediately when idle and reports busy across the run', async () => {
    const { calls, deferreds, run } = makeRun();
    const c = createCoalescer(run);
    expect(c.busy).toBe(false);
    const p = c.request(false);
    expect(calls).toEqual([false]);
    expect(c.busy).toBe(true);
    deferreds[0]!();
    await p;
    expect(c.busy).toBe(false);
  });

  it('does not re-enter run() while one is in flight (single-flight)', async () => {
    const { calls, deferreds, run } = makeRun();
    const c = createCoalescer(run);
    const first = c.request(false);
    expect(calls).toEqual([false]);
    // Three requests arrive mid-run — none may start a second run().
    void c.request(true);
    void c.request(true);
    void c.request(true);
    expect(calls).toEqual([false]);
    expect(c.busy).toBe(true);
    // Finishing run #1 drains the coalesced work in EXACTLY one more run (not three).
    deferreds[0]!();
    await flush();
    expect(calls).toEqual([false, true]);
    expect(c.busy).toBe(true);
    // That drain run absorbed all three requests; finishing it settles the loop.
    deferreds[1]!();
    await first;
    expect(calls).toEqual([false, true]);
    expect(c.busy).toBe(false);
  });

  it('latest-wins: a fresh request after the queue drained starts a new run', async () => {
    const { calls, deferreds, run } = makeRun();
    const c = createCoalescer(run);
    const first = c.request(false);
    deferreds[0]!();
    await first;
    expect(c.busy).toBe(false);
    const second = c.request(false);
    expect(calls).toEqual([false, false]);
    deferreds[1]!();
    await second;
  });

  it('carries the strictest requirement: a non-interactive coalesced request forces SSIM on the drain', async () => {
    const { calls, deferreds, run } = makeRun();
    const c = createCoalescer(run);
    const first = c.request(true);   // interactive start (skip SSIM)
    expect(calls).toEqual([true]);
    void c.request(false);           // a settled-pose request queues → drain must compute SSIM
    deferreds[0]!();
    await flush();
    expect(calls).toEqual([true, false]); // drain ran non-interactive
    deferreds[1]!();
    await first;
  });

  it('all-interactive coalesced requests keep the drain interactive', async () => {
    const { calls, deferreds, run } = makeRun();
    const c = createCoalescer(run);
    const first = c.request(true);
    void c.request(true);
    void c.request(true);
    deferreds[0]!();
    await flush();
    expect(calls).toEqual([true, true]); // no non-interactive request ⇒ drain stays interactive
    deferreds[1]!();
    await first;
  });

  // fix/rematch-promise-completion. request() must resolve only when the run() that COVERS it
  // completes — so `await coalescer.request(...)` (e.g. `await __app.rematch()`) means the work
  // is actually done, not merely queued.
  describe('request resolves on completion of the drain covering it (fix/rematch-promise-completion)', () => {
    it('a coalesced request stays pending until its drain run completes', async () => {
      const { calls, deferreds, run } = makeRun();
      const c = createCoalescer(run);
      const first = c.request(false); // starts run #1
      let secondDone = false;
      const second = c.request(true).then(() => { secondDone = true; }); // coalesced → covered by the drain
      expect(calls).toEqual([false]);
      // Finish run #1: the starter resolves and the drain (run #2) starts — but `second` is
      // covered by run #2, which is still in flight, so it must NOT have resolved yet.
      deferreds[0]!();
      await flush();
      expect(calls).toEqual([false, true]);
      expect(secondDone).toBe(false);
      // Complete the drain run → now the coalesced request's work is done and it resolves.
      deferreds[1]!();
      await second;
      expect(secondDone).toBe(true);
      expect(c.busy).toBe(false);
    });

    it('all requests coalesced onto one drain resolve together when that drain completes', async () => {
      const { calls, deferreds, run } = makeRun();
      const c = createCoalescer(run);
      void c.request(false); // starts run #1
      const flags = [false, false, false];
      const a = c.request(true).then(() => { flags[0] = true; });
      const b = c.request(true).then(() => { flags[1] = true; });
      const d = c.request(true).then(() => { flags[2] = true; });
      deferreds[0]!(); // finish run #1 → single drain (run #2) absorbs a, b, d
      await flush();
      expect(calls).toEqual([false, true]);
      expect(flags).toEqual([false, false, false]); // drain not done ⇒ none resolved
      deferreds[1]!(); // finish the drain
      await Promise.all([a, b, d]);
      expect(flags).toEqual([true, true, true]); // all three settle together
    });

    it('the initiating request resolves when its OWN run completes, before any follow-up drain settles', async () => {
      const { calls, deferreds, run } = makeRun();
      const c = createCoalescer(run);
      let firstDone = false;
      const first = c.request(false).then(() => { firstDone = true; });
      void c.request(true); // queue a drain so run #1 is not the last iteration
      deferreds[0]!();      // finish run #1 (the starter's covering run)
      await first;
      expect(firstDone).toBe(true);
      expect(calls).toEqual([false, true]); // the drain (run #2) is already running…
      expect(c.busy).toBe(true);            // …so the loop is still busy
      deferreds[1]!();
      await flush();
      expect(c.busy).toBe(false);
    });

    it('a run() rejection rejects the batch it covered (and any coalesced drain), never resolving them', async () => {
      const err = new Error('run failed');
      const calls: boolean[] = [];
      const deferreds: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
      const run = (interactive: boolean): Promise<void> => {
        calls.push(interactive);
        return new Promise<void>((resolve, reject) => { deferreds.push({ resolve, reject }); });
      };
      const c = createCoalescer(run);
      const first = c.request(false);
      const coalesced = c.request(true); // coalesced onto the drain that will never run
      // Attach handlers up front so the rejections are observed (never unhandled).
      const firstResult = first.then(() => 'ok', (e) => e);
      const coalescedResult = coalesced.then(() => 'ok', (e) => e);
      deferreds[0]!.reject(err); // run #1 fails
      expect(await firstResult).toBe(err);       // the covering run's batch rejects
      expect(await coalescedResult).toBe(err);    // the never-run drain's batch rejects too (no leak)
      expect(c.busy).toBe(false);
      // The loop aborted on error; a fresh request starts a brand-new run.
      const revived = c.request(false);
      expect(calls).toEqual([false, false]);
      deferreds[1]!.resolve();
      await revived;
    });
  });
});
