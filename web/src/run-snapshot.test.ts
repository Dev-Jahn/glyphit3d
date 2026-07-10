import { describe, it, expect } from 'vitest';
import { resolveRunContext } from './run-snapshot.js';
import type { Atlas } from '../../src/core/types.js';

// fix/torn-runparams-snapshot. Proves the atlas and the run params always come from ONE coherent
// snapshot, even when the live params mutate during the (async) atlas load. A fake atlas is
// tagged with the charset it was loaded for so the test can assert atlas ⟷ runParams agreement.
const tagAtlas = (charset: string): Atlas => ({ charset } as unknown as Atlas);

describe('resolveRunContext (fix/torn-runparams-snapshot)', () => {
  it('derives runParams from the pre-await snapshot, immune to a mid-await params mutation', async () => {
    // Live params a concurrent event mutates DURING the ensureAtlas await.
    const live = { cols: 100, quality: 3 as const, space: 'gamma' as const, charset: 'blocks' as const, yaw: 30, pitch: -15 };
    // The snapshot rematch takes before any await (a plain copy of the run-relevant fields).
    const snap = { cols: live.cols, quality: live.quality, space: live.space, charset: live.charset };
    const loadedFor: string[] = [];
    const ensureAtlas = async (charset: string): Promise<Atlas> => {
      await Promise.resolve();          // the async gap a real profile fetch would occupy
      // A user switches charset / cols WHILE the atlas is loading. If runParams were re-read from
      // `live` after the await, this would TEAR the commit.
      (live as { charset: string }).charset = 'ascii';
      (live as { cols: number }).cols = 140;
      loadedFor.push(charset);
      return tagAtlas(charset);
    };

    const { atlas, runParams } = await resolveRunContext(snap, ensureAtlas);

    // Atlas was loaded for the SNAPSHOT charset…
    expect(loadedFor).toEqual(['blocks']);
    expect((atlas as unknown as { charset: string }).charset).toBe('blocks');
    // …and runParams matches that same snapshot, NOT the mutated live params.
    expect(runParams).toEqual({ cols: 100, quality: 3, space: 'gamma', charset: 'blocks' });
  });

  it('the resolved atlas always corresponds to runParams.charset', async () => {
    const ensureAtlas = async (charset: string): Promise<Atlas> => tagAtlas(charset);
    for (const cs of ['ascii', 'blocks', 'braille', 'full'] as const) {
      const snap = { cols: 120, quality: 3 as const, space: 'linear' as const, charset: cs };
      const { atlas, runParams } = await resolveRunContext(snap, ensureAtlas);
      expect((atlas as unknown as { charset: string }).charset).toBe(runParams.charset);
      expect(runParams.charset).toBe(cs);
    }
  });
});
