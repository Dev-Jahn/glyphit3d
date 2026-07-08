import { Scene } from './scene.js';
import { Pipeline, type PipelineOutput } from './pipeline.js';
import { loadProfile } from './profile.js';
import { renderPerf } from './perf.js';
import { createCoalescer } from './coalescer.js';
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
const params: Params = { cols: 100, quality: 3, charset: 'blocks', space: 'gamma', yaw: 30, pitch: -15, floor: 0.06 };
applyFragment(params);

const sceneCanvas = document.getElementById('scene') as HTMLCanvasElement;
const rasterCanvas = document.getElementById('raster') as HTMLCanvasElement;
const perfEl = document.getElementById('perf') as HTMLElement;
const ssimEl = document.getElementById('ssim') as HTMLElement;

const scene = new Scene(sceneCanvas);
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
    const a = await ensureAtlas(params.charset);
    scene.setOrbit(params.yaw, params.pitch);
    const runParams = { cols: params.cols, quality: params.quality, space: params.space, charset: params.charset, contrastFloor: params.floor };
    // Output-snapshot for exports/getOutputParams (F1: captured BEFORE the await, so it pairs the
    // committed grid with the params that produced it, never the current — possibly changed — ones).
    const snapshot = { cols: params.cols, quality: params.quality, charset: params.charset, space: params.space, floor: params.floor };
    const out = await pipeline.run(scene, a, runParams, interactive);
    // Stale-run guard (F1): a newer rematch started while this one was awaiting — drop it
    // whole. No mutation of screen, `last`, #ssim, perf, or the onOutput trigger, so a slow
    // older run cannot overwrite the current frame/state/exports with mismatched params.
    if (mySeq !== rematchSeq) return;
    last = out;
    lastParams = snapshot;
    if (out.ssim != null) lastSsim = out.ssim;

    rasterCanvas.width = out.raster.w;
    rasterCanvas.height = out.raster.h;
    const ctx = rasterCanvas.getContext('2d')!;
    ctx.putImageData(new ImageData(out.raster.data, out.raster.w, out.raster.h), 0, 0);

    // P1: rewrite #ssim with the last COMPUTED value on EVERY run (incl. interactive
    // ones where out.ssim is null) — reassigning textContent fires the #ssim
    // MutationObserver (the UI's new-output signal) even when the string is unchanged,
    // so the scrubber composite refreshes while a drag holds the pose still.
    ssimEl.textContent = lastSsim == null ? '—' : lastSsim.toFixed(4);
    renderPerf(perfEl, out.timings);
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
  void scene.loadGLB(url).then(() => { params.yaw = scene.yawDeg; params.pitch = scene.pitchDeg; return coalescer.request(false); });
});

// Playwright / UI control surface.
declare global {
  interface Window {
    __app: {
      rematch: () => Promise<void>;
      setParams: (p: Partial<Params>) => void;
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
}
