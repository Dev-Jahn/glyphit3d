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
  const a = await ensureAtlas(params.charset);
  scene.setOrbit(params.yaw, params.pitch);
  const out = await pipeline.run(scene, a, { cols: params.cols, quality: params.quality, space: params.space });
  last = out;

  rasterCanvas.width = out.raster.w;
  rasterCanvas.height = out.raster.h;
  const ctx = rasterCanvas.getContext('2d')!;
  ctx.putImageData(new ImageData(out.raster.data, out.raster.w, out.raster.h), 0, 0);

  ssimEl.textContent = out.ssim.toFixed(4);
  renderPerf(perfEl, out.timings);
  busy = false;
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

void rematch().then(() => { window.__ready = true; });

// Minimal fragment reader (cols/quality/charset/space/yaw/pitch). The UI owns the
// permalink writer; this only applies settings present on load.
function applyFragment(p: Params): void {
  const frag = location.hash.replace(/^#/, '');
  if (!frag) return;
  const q = new URLSearchParams(frag);
  const n = (k: string): number | undefined => (q.has(k) ? Number(q.get(k)) : undefined);
  if (n('cols') !== undefined) p.cols = n('cols')!;
  if (n('quality') !== undefined) p.quality = Math.max(0, Math.min(4, n('quality')!)) as Params['quality'];
  if (n('yaw') !== undefined) p.yaw = n('yaw')!;
  if (n('pitch') !== undefined) p.pitch = n('pitch')!;
  const cs = q.get('charset');
  if (cs === 'ascii' || cs === 'blocks' || cs === 'braille' || cs === 'full') p.charset = cs;
  const sp = q.get('space');
  if (sp === 'linear' || sp === 'gamma') p.space = sp;
}
