// feat/temporal-animation (DESIGN §4.9, SPEC §4.4). Pure keyframe-router for the interactive
// temporal path, extracted from main.ts so the RESET MATRIX is unit-testable without a browser/
// DOM/WebGPU context. A keyframe is a full recompute + temporal-state reset; getting the matrix
// wrong pairs a stale reference frame with new geometry and silently corrupts output (SPEC RISKS),
// so every reset axis is enumerated here and pinned by temporal-route.test.ts.

// The config axes whose change MUST reset temporal state. A change on ANY of these invalidates the
// retained reference frame / prevGlyph buffers (different atlas, footprint, working space, channel
// count, or floored emit), so the next run must keyframe.
export interface TemporalKey {
  charset: string;
  cols: number;
  space: string;
  quality: number;
  floor: number;
}

export function temporalKeyDiffers(prev: TemporalKey | null, next: TemporalKey): boolean {
  return prev === null
    || prev.charset !== next.charset
    || prev.cols !== next.cols
    || prev.space !== next.space
    || prev.quality !== next.quality
    || prev.floor !== next.floor;
}

export interface KeyframeInputs {
  interactive: boolean;       // non-interactive runs (onOrbitEnd/__app.rematch/exports) ALWAYS keyframe
  prevKey: TemporalKey | null; // the last committed run's key (null before the first run)
  nextKey: TemporalKey;        // this run's key
  forcedReset: boolean;        // model drop / device-lost-fallback / first run / temporal just enabled
}

// Returns true iff this run must be a keyframe (full recompute, temporal-state reset). The reset
// matrix (SPEC §4.4): first frame (prevKey null → temporalKeyDiffers), charset/cols/space/quality/
// floor change (temporalKeyDiffers), model drop / device-lost (forcedReset), AND every
// non-interactive run (!interactive). Only a mid-drag interactive run with an unchanged key and no
// forced reset is a delta/hysteresis frame.
export function keyframeNeeded(i: KeyframeInputs): boolean {
  return !i.interactive || i.forcedReset || temporalKeyDiffers(i.prevKey, i.nextKey);
}
