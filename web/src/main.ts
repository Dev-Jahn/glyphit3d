import { Scene } from './scene.js';
import { Pipeline, type PipelineOutput } from './pipeline.js';
import { loadProfile } from './profile.js';
import { renderPerf } from './perf.js';
import { createCoalescer } from './coalescer.js';
import { resolveRunContext } from './run-snapshot.js';
import { keyframeNeeded, type TemporalKey } from './temporal-route.js';
import { makeModel, isModelName, type ModelName } from './models.js';
import type { Atlas } from '../../src/core/types.js';
import './ui/index.js';

type Charset = 'ascii' | 'blocks' | 'braille' | 'full';

interface Params {
  cols: number;
  quality: 0 | 1 | 2 | 3 | 4;
  charset: Charset;
  space: 'linear' | 'gamma';
  yaw: number;
  pitch: number;
  floor: number;
  // feat/identity-web-wiring: the ASCII-identity aesthetic knobs. identity OFF by default → the pipeline
  // params carry identity:false and output is byte-identical to HEAD. The coherence union EXCLUDES
  // 'smooth' (band-unsafe in the row-band worker pool — see band-opts.ts); the dropdown offers the other
  // three. identityColorDither default true (colour); false = monochrome.
  identity: boolean;
  identityCoherence: 'none' | 'ramp-bias' | 'pure-ramp';
  identityColorDither: boolean;
  // feat/web-model-picker: the current procedural model (permalink-encoded). Default 'torusknot' keeps
  // first-load identical to the scene's built-in default.
  model: ModelName;
}

// Defaults (M2-SPEC §2). Fragment settings (written by the UI permalink) override
// on load — §3 "applied on load".
// `floor` = Round A ASCII-identity contrast floor (feat/contrast-floor-fill). The demo scene is a
// model on a near-black background, the exact "black holes" regime, so the dark path ships a
// MEASURED default of 0.06 (working-space luma; ≈15/255): it drops DamagedHelmet's invisible-
// over-black cells 642→0 while lifting the rest to a legible contrast. It is an aesthetic
// constraint that trades reconstruction (chafa-gate mean −0.0033 post-gamut-fix — ours 0.9802 vs
// 0.9835 off, gate PASS→FAIL; repro: npx tsx bench/chafa-gate.ts --floor 0.06) for legibility, so
// it stays OFF in every bench/gate (defaultOptions keeps 0) and is applied here only. BOTH matchers
// apply it — the WebGPU Q3 matcher as a host per-cell post-pass, the CPU pool inside matchGrid — so
// the floored default path still reports matcher 'gpu'. #floor=0 in the permalink turns it off.
const params: Params = { cols: 100, quality: 3, charset: 'blocks', space: 'gamma', yaw: 30, pitch: -15, floor: 0.06, identity: false, identityCoherence: 'pure-ramp', identityColorDither: true, model: 'torusknot' };
applyFragment(params);

const sceneCanvas = document.getElementById('scene') as HTMLCanvasElement;
const rasterCanvas = document.getElementById('raster') as HTMLCanvasElement;
const perfEl = document.getElementById('perf') as HTMLElement;
const ssimEl = document.getElementById('ssim') as HTMLElement;

const scene = new Scene(sceneCanvas);
// feat/web-model-picker: the Scene constructor primes the built-in torus knot; a permalink `model=…`
// swaps it in before the first render. Default (torusknot / no fragment) is a no-op, so first load is
// unchanged.
if (params.model !== 'torusknot') scene.setModel(makeModel(params.model));
const pipeline = new Pipeline();

let atlas: Atlas | null = null;
let currentCharset = '';
let last: PipelineOutput | null = null;
// P1: interactive runs skip SSIM (out.ssim === null). Keep the last COMPUTED ssim so the
// badge/state can hold it across ssim-less interactive frames.
let lastSsim: number | null = null;
// Per-run active counter for busy: rematch() holds one across its own body. The coalescer
// (below) holds `busy` true across the WHOLE drain loop, so getState().busy ORs both and never
// blips false between iterations. busy = busyCount>0 || coalescer.busy.
let busyCount = 0;
// F1 single-flight: monotonic run id. Every rematch() captures one before its first await;
// a resolved run commits ONLY if it is still the latest (mySeq === rematchSeq), so a slow
// older run (e.g. a Q3 GPU match) can never overwrite a faster newer one (e.g. a Q1 pool
// match) that started after it and already committed.
let rematchSeq = 0;
// Params snapshot of the run that produced `last` — read by exports so the grid, its
// colour-channel count (quality) and font hash (charset) always come from ONE run, never a
// stale grid paired with the current (already-changed) params.
let lastParams: Pick<Params, 'cols' | 'quality' | 'charset' | 'space' | 'floor'> | null = null;

// feat/temporal-animation (DESIGN §4.9, SPEC §4.4). Temporal reuse is OFF by default so the shipping
// path is byte-for-byte today's full rematch (parity/e2e untouched). HONEST STATUS: __app.setTemporal
// and this router only ARM the keyframe decision — the Pipeline does NOT consume params.temporal yet
// (pipeline.ts runGpu ignores it), so even with reuse "enabled" every frame is currently a full
// rematch. Wiring the interactive delta+hyst path end-to-end is the registered follow-up
// feat/temporal-interactive-wiring (see honestReport); the routing below is the state scaffold it
// will use. Intended routing (once wired): mid-drag interactive runs with an unchanged config request
// delta+hyst; every non-interactive run and every config change / model drop / device-lost keyframes
// (full recompute + state reset), so exports and the SSIM badge always come from a parity-exact full
// frame. `lastTemporalKey` is the last committed run's reset-matrix key; `forceKeyframe` is armed by
// first run / model drop / device-lost / (re)enable.
let temporalCfg: { enabled: boolean; delta: number } = { enabled: false, delta: 0 };
let lastTemporalKey: TemporalKey | null = null;
let forceKeyframe = true;

function profileUrl(charset: Charset): string {
  return new URL(`profiles/dejavu-16-${charset}.json`, document.baseURI).href;
}

async function ensureAtlas(charset: Charset): Promise<Atlas> {
  if (charset !== currentCharset || !atlas) {
    atlas = await loadProfile(profileUrl(charset));
    pipeline.setAtlas(charset, atlas);
    currentCharset = charset;
  }
  return atlas;
}

async function rematch(interactive = false): Promise<void> {
  const mySeq = ++rematchSeq;
  busyCount++;
  try {
    // fix/torn-runparams-snapshot: snapshot the live params ONCE, before any await, so the atlas,
    // the run params, and the pose all come from ONE coherent read. Re-reading params after the
    // `await` in resolveRunContext (which can span a profile fetch on a charset change) would let
    // a mid-run params mutation (setParams / orbit / drag-drop) pair an OLD-charset atlas with NEW
    // run params in a single commit. resolveRunContext derives both the atlas and runParams from
    // this snapshot, so they cannot tear; if params changed mid-run the coalescer's dirty-drain
    // re-runs with a fresh snapshot and the seq guard below drops this now-stale commit. `floor`
    // rides the SAME snapshot so the contrast floor can never tear from the grid it produced.
    const snap = { cols: params.cols, quality: params.quality, space: params.space, charset: params.charset, yaw: params.yaw, pitch: params.pitch, floor: params.floor, identity: params.identity, identityCoherence: params.identityCoherence, identityColorDither: params.identityColorDither };
    const { atlas: a, runParams } = await resolveRunContext(snap, ensureAtlas);
    scene.setOrbit(snap.yaw, snap.pitch);
    // Output-snapshot for exports/getOutputParams (F1: from the SAME pre-await snapshot, so it pairs
    // the committed grid with the params that produced it, never the current — possibly changed — ones).
    const snapshot = { cols: snap.cols, quality: snap.quality, charset: snap.charset, space: snap.space, floor: snap.floor };
    // The contrast floor rides the run params to BOTH pipeline paths (GPU host post-pass / CPU pool),
    // threaded from the same snapshot as everything else.
    // Temporal routing (SPEC §4.4): compute this run's reset-matrix key from the SAME snapshot, then
    // decide keyframe-vs-delta. Only when temporal reuse is enabled do we thread a temporal block;
    // otherwise it stays undefined and the pipeline runs exactly today's full rematch. The key rides
    // the snapshot so a config change can never tear from the keyframe decision it drives.
    // LATENT HAZARD (feat/identity-web-wiring): TemporalKey below does NOT yet carry the identity
    // knobs (identity / identityCoherence / identityColorDither). Harmless TODAY — temporal reuse is a
    // no-op end-to-end (temporalCfg.enabled defaults false; pipeline.ts runGpu does not consume
    // params.temporal), so no reference frame is ever retained across an identity change. When
    // feat/temporal-interactive-wiring lands, the 3 identity fields MUST join this key (a change ⇒
    // keyframe reset), else a retained non-identity frame would be reused under identity ON.
    const nextTemporalKey: TemporalKey = { charset: snap.charset, cols: snap.cols, space: snap.space, quality: snap.quality, floor: snap.floor };
    const temporal = temporalCfg.enabled
      ? { epsilon: 0, delta: temporalCfg.delta, keyframe: keyframeNeeded({ interactive, prevKey: lastTemporalKey, nextKey: nextTemporalKey, forcedReset: forceKeyframe }) }
      : undefined;
    const out = await pipeline.run(scene, a, { ...runParams, contrastFloor: snap.floor, temporal, identity: snap.identity, identityCoherence: snap.identityCoherence, identityColorDither: snap.identityColorDither }, interactive);
    // Stale-run guard (F1): a newer rematch started while this one was awaiting — drop it
    // whole. No mutation of screen, `last`, #ssim, perf, or the onOutput trigger, so a slow
    // older run cannot overwrite the current frame/state/exports with mismatched params.
    if (mySeq !== rematchSeq) return;
    last = out;
    lastParams = snapshot;
    if (out.ssim != null) lastSsim = out.ssim;
    // Temporal state commit (SPEC §4.4): remember this run's key so the NEXT run's reset-matrix diff
    // is against what actually committed; a pool fallback (device-lost / WebGPU-absent) carries no
    // GPU temporal state, so the next run must keyframe. Untouched when temporal reuse is disabled.
    if (temporalCfg.enabled) {
      lastTemporalKey = nextTemporalKey;
      forceKeyframe = out.matcher === 'pool';
    }

    rasterCanvas.width = out.raster.w;
    rasterCanvas.height = out.raster.h;
    const ctx = rasterCanvas.getContext('2d')!;
    ctx.putImageData(new ImageData(out.raster.data, out.raster.w, out.raster.h), 0, 0);

    // P1: rewrite #ssim with the last COMPUTED value on EVERY run (incl. interactive
    // ones where out.ssim is null) — reassigning textContent fires the #ssim
    // MutationObserver (the UI's new-output signal) even when the string is unchanged,
    // so the scrubber composite refreshes while a drag holds the pose still.
    ssimEl.textContent = lastSsim == null ? '—' : lastSsim.toFixed(4);
    // temporalStats is undefined on a full frame → the readout is today's string (SPEC §6.2).
    renderPerf(perfEl, out.timings, out.temporalStats);
  } finally {
    busyCount--;
  }
}

// F1R-1: EVERY rematch entry point (orbit drag, UI controls, quality ladder, drag-drop, the
// initial render, and the Playwright __app.rematch surface) is funnelled through ONE
// single-flight coalescing queue so at most one pipeline.run()/gpu.match() is ever in flight —
// concurrent re-entry would race the shared GpuMatcher's staging-buffer host map-state. A
// request during an in-flight run only marks the work dirty; the running loop re-matches once
// more when it drains (so the final request always wins). `coalescer.busy` stays true across
// the loop, so busy never blips false between iterations. The loop carries the STRICTEST
// pending requirement — if any request queued during a run was non-interactive, the drain run
// computes SSIM (interactive = false). The seq guard inside rematch() stays as belt-and-
// suspenders against a stale commit.
const coalescer = createCoalescer(rematch);

scene.onOrbitMove = () => {
  params.yaw = scene.yawDeg;
  params.pitch = scene.pitchDeg;
  void coalescer.request(true); // mid-drag frames skip SSIM
};

scene.onOrbitEnd = () => {
  params.yaw = scene.yawDeg;
  params.pitch = scene.pitchDeg;
  void coalescer.request(false); // the settled pose computes SSIM
};

// Drag & drop a .glb/.gltf to replace the model.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file || !/\.(glb|gltf)$/i.test(file.name)) return;
  const url = URL.createObjectURL(file);
  // A model drop invalidates any retained temporal reference frame (SPEC §4.4 reset matrix) → the
  // next run must keyframe.
  forceKeyframe = true;
  void scene.loadGLB(url)
    .then(() => { params.yaw = scene.yawDeg; params.pitch = scene.pitchDeg; return coalescer.request(false); })
    .finally(() => URL.revokeObjectURL(url));
});

// Playwright / UI control surface.
declare global {
  interface Window {
    __app: {
      rematch: () => Promise<void>;
      setParams: (p: Partial<Params>) => void;
      // feat/web-model-picker: swap the procedural model. Same commit path as a dropped GLB
      // (scene.setModel bounds-reframes + relights, forceKeyframe, coalescer.request). Throws on an
      // unknown name (no fallback). Records params.model so the permalink round-trips it.
      setModel: (name: string) => void;
      // feat/temporal-animation: arm interactive temporal reuse and set the hysteresis margin δ
      // (eacScale units). Off by default. Toggling always arms a keyframe so the next run rebuilds a
      // clean reference frame. NOTE: currently a no-op end-to-end — the Pipeline does not consume
      // params.temporal yet (feat/temporal-interactive-wiring, see honestReport), so this only sets
      // the router flags; every run is still a full rematch until that path is wired.
      setTemporal: (cfg: { enabled?: boolean; delta?: number }) => void;
      getState: () => { params: Params; ssim: number | null; busy: boolean };
      getOutput: () => PipelineOutput | null;
      getOutputParams: () => Pick<Params, 'cols' | 'quality' | 'charset' | 'space' | 'floor'> | null;
      scene: Scene;
    };
    __ready: boolean;
  }
}

window.__app = {
  // F1R-1: the public rematch surface routes through the coalescer too, so a Playwright/UI
  // rematch can never overlap an in-flight orbit/GPU match on the shared GpuMatcher.
  rematch: () => coalescer.request(false),
  setParams: (p) => { Object.assign(params, p); },
  setModel: (name) => {
    if (!isModelName(name)) throw new Error(`unknown model '${name}'`);
    params.model = name;
    // fix/model-drop-latest-wins: bump the model generation BEFORE the commit so this pick
    // supersedes any in-flight loadGLB — its late resolution sees a newer generation and drops.
    scene.nextModelGeneration();
    scene.setModel(makeModel(name));
    // A model swap invalidates any retained temporal reference frame (SPEC §4.4 reset matrix) → the
    // next run must keyframe — same as the GLB drop handler.
    forceKeyframe = true;
    void coalescer.request(false);
  },
  setTemporal: (cfg) => {
    temporalCfg = {
      enabled: cfg.enabled ?? temporalCfg.enabled,
      delta: cfg.delta ?? temporalCfg.delta,
    };
    forceKeyframe = true; // rebuild a clean reference frame on the next run
  },
  getState: () => ({ params: { ...params }, ssim: lastSsim, busy: busyCount > 0 || coalescer.busy }),
  getOutput: () => last,
  getOutputParams: () => lastParams,
  scene,
};

// Surface a fatal load error in the page (not just the console). Attached to
// <html> — the UI module replaces <body>, so an overlay parented on body would be
// wiped when the demo layout mounts.
function showError(msg: string): void {
  console.error(msg);
  const id = 'glyphit3d-error';
  let note = document.getElementById(id);
  if (!note) {
    note = document.createElement('div');
    note.id = id;
    note.setAttribute('style', 'position:fixed;top:0;left:0;right:0;z-index:99999;padding:8px 14px;background:#5a1620;color:#ffd7dd;font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap;');
    document.documentElement.appendChild(note);
  }
  note.textContent = msg;
}

// The first rematch can throw (a fragment value that survives clamping, or a
// profile that fails hash verification). Surface it visibly, but still flip
// __ready so the UI boots with defaults instead of a permanently blank page.
void coalescer.request(false)
  .catch((e) => { showError(`glyphit3d: initial render failed — ${e instanceof Error ? e.message : String(e)}`); })
  .finally(() => { window.__ready = true; });

// Minimal fragment reader (cols/quality/charset/space/yaw/pitch). The UI owns the
// permalink writer; this only applies settings present on load. Every numeric value
// is bounded to its control range: an out-of-range or non-finite fragment (e.g.
// `#cols=abc` or `#cols=100000`) must never brick the page (a bad gridW makes
// drawImage/getImageData throw), so garbage is ignored and defaults stand.
function applyFragment(p: Params): void {
  const frag = location.hash.replace(/^#/, '');
  if (!frag) return;
  const q = new URLSearchParams(frag);
  // Finite-only numeric reader: returns undefined for missing or NaN/Infinity.
  const n = (k: string): number | undefined => {
    if (!q.has(k)) return undefined;
    const v = Number(q.get(k));
    return Number.isFinite(v) ? v : undefined;
  };
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
  const cols = n('cols');
  if (cols !== undefined) p.cols = clamp(Math.round(cols), 60, 160); // matches the columns slider range
  const quality = n('quality');
  // Web tops out at Q3: Q4's edge loss is a cross-cell pass the band matcher can't run
  // (see ui/ladder.ts), so a #quality=4 fragment is clamped down rather than left to throw.
  if (quality !== undefined) p.quality = clamp(Math.round(quality), 0, 3) as Params['quality'];
  const yaw = n('yaw');
  if (yaw !== undefined) p.yaw = clamp(yaw, -360, 360);
  const pitch = n('pitch');
  if (pitch !== undefined) p.pitch = clamp(pitch, -89, 89); // scene clamps pitch to ±89
  const cs = q.get('charset');
  if (cs === 'ascii' || cs === 'blocks' || cs === 'braille' || cs === 'full') p.charset = cs;
  const sp = q.get('space');
  if (sp === 'linear' || sp === 'gamma') p.space = sp;
  // Round A contrast floor (working-space luma units). A finite value in [0, 0.5] applies;
  // #floor=0 disables the dark-path default. Out-of-range/garbage keeps the measured default.
  const floor = n('floor');
  if (floor !== undefined) p.floor = clamp(floor, 0, 0.5);
  // feat/web-model-picker: a known model name applies; garbage keeps the default torus knot. Identity
  // knobs are intentionally NOT read from the fragment (identity stays OFF on load → byte-identical).
  const model = q.get('model');
  if (model !== null && isModelName(model)) p.model = model;
}
