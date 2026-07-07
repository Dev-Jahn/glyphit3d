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
});
