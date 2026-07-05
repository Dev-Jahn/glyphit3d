import { Scene } from './scene.js';
import { Pipeline, type PipelineOutput } from './pipeline.js';
import { loadProfile } from './profile.js';
import { renderPerf } from './perf.js';
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
}

// Defaults (M2-SPEC §2). Fragment settings (written by the UI permalink) override
// on load — §3 "applied on load".
const params: Params = { cols: 100, quality: 3, charset: 'blocks', space: 'gamma', yaw: 30, pitch: -15 };
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
let busy = false;

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

async function rematch(): Promise<void> {
  busy = true;
  try {
    const a = await ensureAtlas(params.charset);
    scene.setOrbit(params.yaw, params.pitch);
    const out = await pipeline.run(scene, a, { cols: params.cols, quality: params.quality, space: params.space, charset: params.charset });
    last = out;

    rasterCanvas.width = out.raster.w;
    rasterCanvas.height = out.raster.h;
    const ctx = rasterCanvas.getContext('2d')!;
    ctx.putImageData(new ImageData(out.raster.data, out.raster.w, out.raster.h), 0, 0);

    ssimEl.textContent = out.ssim.toFixed(4);
    renderPerf(perfEl, out.timings);
  } finally {
    busy = false;
  }
}

scene.onOrbitEnd = () => {
  params.yaw = scene.yawDeg;
  params.pitch = scene.pitchDeg;
  void rematch();
};

// Drag & drop a .glb/.gltf to replace the model.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file || !/\.(glb|gltf)$/i.test(file.name)) return;
  const url = URL.createObjectURL(file);
  void scene.loadGLB(url).then(() => { params.yaw = scene.yawDeg; params.pitch = scene.pitchDeg; return rematch(); });
});

// Playwright / UI control surface.
declare global {
  interface Window {
    __app: {
      rematch: () => Promise<void>;
      setParams: (p: Partial<Params>) => void;
      getState: () => { params: Params; ssim: number | null; busy: boolean };
      getOutput: () => PipelineOutput | null;
      scene: Scene;
    };
    __ready: boolean;
  }
}

window.__app = {
  rematch,
  setParams: (p) => { Object.assign(params, p); },
  getState: () => ({ params: { ...params }, ssim: last ? last.ssim : null, busy }),
  getOutput: () => last,
  scene,
};

// Surface a fatal load error in the page (not just the console). Attached to
// <html> — the UI module replaces <body>, so an overlay parented on body would be
// wiped when the demo layout mounts.
function showError(msg: string): void {
  console.error(msg);
  const id = 'ascii3d-error';
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
void rematch()
  .catch((e) => { showError(`ascii-3d: initial render failed — ${e instanceof Error ? e.message : String(e)}`); })
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
  if (quality !== undefined) p.quality = clamp(Math.round(quality), 0, 4) as Params['quality'];
  const yaw = n('yaw');
  if (yaw !== undefined) p.yaw = clamp(yaw, -360, 360);
  const pitch = n('pitch');
  if (pitch !== undefined) p.pitch = clamp(pitch, -89, 89); // scene clamps pitch to ±89
  const cs = q.get('charset');
  if (cs === 'ascii' || cs === 'blocks' || cs === 'braille' || cs === 'full') p.charset = cs;
  const sp = q.get('space');
  if (sp === 'linear' || sp === 'gamma') p.space = sp;
}
