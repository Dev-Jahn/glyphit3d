import type { PipelineOutput } from '../pipeline.js';

// APP↔UI contract surface. main.ts owns the Scene + Pipeline and publishes the
// latest run on `window.__app` (labelled there "UI control surface"); this module
// is the typed, lazy accessor. Nothing is captured at import time because the UI
// module may evaluate before main.ts has assigned `__app` — always read it live.

export type Charset = 'ascii' | 'blocks' | 'braille' | 'full';

export interface Params {
  cols: number;
  quality: 0 | 1 | 2 | 3 | 4;
  charset: Charset;
  space: 'linear' | 'gamma';
  yaw: number;
  pitch: number;
  floor: number; // Round A ASCII-identity contrast floor (working-space luma; 0 = off). Default 0.06 (dark-scene demo).
}

export interface AppApi {
  rematch: () => Promise<void>;
  setParams: (p: Partial<Params>) => void;
  getState: () => { params: Params; ssim: number | null; busy: boolean };
  getOutput: () => PipelineOutput | null;
  // Params snapshot of the run that produced the current getOutput() grid — lets exports
  // read grid + quality + charset from one consistent run (see main.ts `lastParams`).
  getOutputParams: () => Pick<Params, 'cols' | 'quality' | 'charset' | 'space' | 'floor'> | null;
  scene: unknown;
}

export function app(): AppApi {
  return (window as unknown as { __app: AppApi }).__app;
}

// Resolves once main.ts has run its first rematch (window.__ready) — at which point
// __app is fully populated and a first PipelineOutput exists.
export function whenReady(): Promise<void> {
  return new Promise((resolve) => {
    const tick = (): void => {
      if ((window as unknown as { __ready?: boolean }).__ready) resolve();
      else requestAnimationFrame(tick);
    };
    tick();
  });
}

// main.ts writes each fresh run's SSIM into #ssim; observing that node is a cheap,
// decoupled "new output" signal that fires for BOTH UI-driven and orbit-driven
// re-matches, without the UI having to intercept the worker or await every path.
export function onOutput(cb: () => void): void {
  const ssim = document.getElementById('ssim');
  if (!ssim) return;
  new MutationObserver(() => cb()).observe(ssim, {
    childList: true,
    characterData: true,
    subtree: true,
  });
}

export interface ProfileMeta { profileHash: string; size: number; family: string }

const metaCache = new Map<Charset, ProfileMeta>();

// The grid .json export needs the profileHash + font size, which the decoded Atlas
// drops. Re-read them from the profile artifact (browser-HTTP-cached, so cheap).
export async function profileMeta(charset: Charset): Promise<ProfileMeta> {
  const hit = metaCache.get(charset);
  if (hit) return hit;
  const url = new URL(`profiles/dejavu-16-${charset}.json`, document.baseURI).href;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`profile fetch ${url} failed: ${res.status}`);
  const p = (await res.json()) as { profileHash: string; font: { family: string; size: number } };
  const meta: ProfileMeta = { profileHash: p.profileHash, size: p.font.size, family: p.font.family };
  metaCache.set(charset, meta);
  return meta;
}
