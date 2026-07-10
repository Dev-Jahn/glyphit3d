import { describe, it, expect } from 'vitest';
import { cellChanged, coalesceRuns, sigChanged, type TemporalSig } from './gpu-matcher.js';

// feat/temporal-animation §3.1 — the PURE change detector + reset signature (no GPU, no browser).
//
// EXACTNESS COVERAGE (spec §9): the per-cell temporal result depends on EVERY input to the fit —
//   (a) the cell's working-space patch T (⇒ ST/STT/min/max ⇒ the contrast gate ⇒ the winner glyph
//       ⇒ its fitted F/B ⇒ the contrast-floor decision), and
//   (b) the atlas identity, the fit params (space, gateTau, mdlLambda) and the contrast FLOOR, none
//       of which are observable from T alone.
// The detector covers (a) with cellChanged (a bit-exact patch compare at ε=0) and (b) with
// sigChanged (a keyframe-forcing reset signature). A skipped cell reuses its prior emit, which is
// correct IFF neither (a) nor (b) changed — so both halves are tested here.

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
}

const P = 190;
const CELL = 3 * P;

describe('cellChanged — reference-frame patch detector', () => {
  it('ε=0: a bit-identical patch is UNCHANGED; ANY single-bit difference is CHANGED (exactness)', () => {
    const rng = makeRng(1);
    const ref = new Float32Array(CELL * 4);
    for (let i = 0; i < ref.length; i++) ref[i] = rng();
    const curr = ref.slice(0);
    // identical everywhere ⇒ every cell unchanged
    for (let cell = 0; cell < 4; cell++) expect(cellChanged(curr, ref, cell * CELL, CELL, 0)).toBe(false);
    // flip ONE value in cell 2 (any pixel/channel) ⇒ that cell — and only it — is changed
    curr[2 * CELL + 137] = ref[2 * CELL + 137]! + 1e-7;
    expect(cellChanged(curr, ref, 0 * CELL, CELL, 0)).toBe(false);
    expect(cellChanged(curr, ref, 1 * CELL, CELL, 0)).toBe(false);
    expect(cellChanged(curr, ref, 2 * CELL, CELL, 0)).toBe(true);
    expect(cellChanged(curr, ref, 3 * CELL, CELL, 0)).toBe(false);
  });

  it('ε=0 exact-skip property: UNCHANGED ⇒ the two slices are bit-identical (recompute would tie)', () => {
    // The §3.2 lemma made testable: if the detector skips a cell, its patch equals the reference
    // BIT-FOR-BIT, so recomputing the winner/colours/floor on it reproduces the reference emit
    // exactly. We assert the antecedent the lemma needs: unchanged ⇒ byte-equal slice.
    const rng = makeRng(2);
    for (let t = 0; t < 2000; t++) {
      const ref = new Float32Array(CELL);
      for (let i = 0; i < CELL; i++) ref[i] = rng();
      const curr = ref.slice(0);
      // randomly perturb ~half the cells' worth of pixels
      if (rng() < 0.5) curr[Math.floor(rng() * CELL)] = rng();
      const changed = cellChanged(curr, ref, 0, CELL, 0);
      let bitEqual = true;
      for (let i = 0; i < CELL; i++) if (curr[i] !== ref[i]) { bitEqual = false; break; }
      expect(changed).toBe(!bitEqual);
    }
  });

  it('ε semantics: a per-pixel diff exactly AT ε is unchanged (strict >), above ε is changed', () => {
    const ref = new Float32Array(CELL); ref.fill(0.5);
    const eps = 1 / 255;
    const atEps = ref.slice(0); atEps[10] = 0.5 + eps;         // |Δ| == ε ⇒ NOT > ε ⇒ unchanged
    expect(cellChanged(atEps, ref, 0, CELL, eps)).toBe(false);
    const overEps = ref.slice(0); overEps[10] = 0.5 + eps * 1.0001; // just over ε ⇒ changed
    expect(cellChanged(overEps, ref, 0, CELL, eps)).toBe(true);
    // sign-agnostic: a negative excursion beyond ε also triggers
    const under = ref.slice(0); under[10] = 0.5 - eps * 2;
    expect(cellChanged(under, ref, 0, CELL, eps)).toBe(true);
  });

  it('reference-frame (NOT previous-frame) drift: a 0.4ε/frame ramp MUST eventually trigger', () => {
    // §3.1 drift rule. Reference stays fixed at frame 0; the cell drifts 0.4ε per frame. Against the
    // FIXED reference the cumulative |Δ| crosses ε at frame 3 (1.2ε) and the cell recomputes.
    const eps = 1 / 255;
    const ref = new Float32Array(CELL); ref.fill(0.5);
    const step = 0.4 * eps;
    const triggered: number[] = [];
    let curr = ref.slice(0);
    for (let f = 1; f <= 6; f++) {
      curr = curr.slice(0);
      for (let i = 0; i < CELL; i++) curr[i] = 0.5 + step * f; // cumulative drift from the fixed ref
      if (cellChanged(curr, ref, 0, CELL, eps)) triggered.push(f);
    }
    // frames 1 (0.4ε) and 2 (0.8ε) stay under ε; frame 3 (1.2ε) and beyond trigger.
    expect(triggered).toEqual([3, 4, 5, 6]);

    // CONTRAST: previous-frame semantics (compare against the LAST frame, 0.4ε away) never trigger —
    // the forbidden unbounded-drift mode. Simulated by comparing each frame to its predecessor.
    let prev = ref.slice(0);
    let everTriggered = false;
    for (let f = 1; f <= 100; f++) {
      const nxt = new Float32Array(CELL);
      for (let i = 0; i < CELL; i++) nxt[i] = 0.5 + step * f;
      if (cellChanged(nxt, prev, 0, CELL, eps)) everTriggered = true;
      prev = nxt;
    }
    expect(everTriggered).toBe(false); // 0.4ε per-frame delta < ε forever — why reference-frame is mandatory
  });

  it('early-exit is a pure function of the max-abs deviation (order-independent)', () => {
    const ref = new Float32Array(CELL); ref.fill(0.3);
    const a = ref.slice(0); a[0] = 0.9;            // first pixel violates
    const b = ref.slice(0); b[CELL - 1] = 0.9;     // last pixel violates
    expect(cellChanged(a, ref, 0, CELL, 0.01)).toBe(true);
    expect(cellChanged(b, ref, 0, CELL, 0.01)).toBe(true);
  });
});

describe('coalesceRuns — changed-cell ranged-upload compaction', () => {
  it('merges consecutive indices into maximal [start,end] runs', () => {
    expect(coalesceRuns([])).toEqual([]);
    expect(coalesceRuns([5])).toEqual([[5, 5]]);
    expect(coalesceRuns([0, 1, 2, 3])).toEqual([[0, 3]]);
    expect(coalesceRuns([0, 1, 4, 5, 6, 9])).toEqual([[0, 1], [4, 6], [9, 9]]);
    expect(coalesceRuns([2, 4, 6])).toEqual([[2, 2], [4, 4], [6, 6]]);
    expect(coalesceRuns(Uint32Array.from([10, 11, 12, 20]))).toEqual([[10, 12], [20, 20]]);
  });
  it('covers exactly the input indices (no gaps swallowed, no index invented)', () => {
    const rng = makeRng(9);
    for (let t = 0; t < 500; t++) {
      const set = new Set<number>();
      const n = Math.floor(rng() * 40);
      for (let i = 0; i < n; i++) set.add(Math.floor(rng() * 60));
      const sorted = [...set].sort((x, y) => x - y);
      const runs = coalesceRuns(sorted);
      const flat: number[] = [];
      for (const [a, b] of runs) for (let c = a; c <= b; c++) flat.push(c);
      expect(flat).toEqual(sorted);
    }
  });
});

describe('sigChanged — keyframe/reset signature (atlas identity, params, floor)', () => {
  const atlasA = { id: 'A' } as unknown; // identity compare only
  const atlasB = { id: 'B' } as unknown;
  const base: TemporalSig = { atlas: atlasA, space: 'gamma', cols: 100, rows: 53, P, gateTau: 2e-5, mdlLambda: 0.02, contrastFloor: 0 };
  it('null previous (first frame) always resets', () => {
    expect(sigChanged(null, base)).toBe(true);
  });
  it('an identical signature does NOT reset', () => {
    expect(sigChanged({ ...base }, { ...base })).toBe(false);
  });
  it('a change in ANY covered axis resets — including atlas identity and the contrast floor', () => {
    expect(sigChanged(base, { ...base, atlas: atlasB })).toBe(true);      // charset/atlas swap
    expect(sigChanged(base, { ...base, space: 'linear' })).toBe(true);    // working space
    expect(sigChanged(base, { ...base, cols: 80 })).toBe(true);           // grid width
    expect(sigChanged(base, { ...base, rows: 40 })).toBe(true);           // grid height
    expect(sigChanged(base, { ...base, P: 200 })).toBe(true);             // glyph-cell footprint
    expect(sigChanged(base, { ...base, gateTau: 2e-4 })).toBe(true);      // gate threshold
    expect(sigChanged(base, { ...base, mdlLambda: 0.05 })).toBe(true);    // MDL weight
    expect(sigChanged(base, { ...base, contrastFloor: 0.1 })).toBe(true); // FLOOR ⇒ keyframe-forcing param
  });
});
