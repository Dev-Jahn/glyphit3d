import { app, onOutput, whenReady } from './bridge.js';
import type { Scene } from '../scene.js';
import { el } from './dom.js';
import { injectStyles } from './styles.js';
import { Scrubber } from './scrubber.js';
import { Ladder } from './ladder.js';
import { Controls } from './controls.js';
import { Exports } from './exports.js';
import { Permalink } from './permalink.js';

// UI entry (M2-SPEC §3). main.ts owns the Scene/Pipeline and the #scene/#raster/#ssim
// /#perf nodes; this module waits for its first output, then rebuilds the page into
// the demo layout around those nodes and wires the four proof devices. Imported by
// main.ts; robust to import order because it awaits window.__ready first.

async function boot(): Promise<void> {
  await whenReady();
  injectStyles();

  const scene = document.getElementById('scene') as HTMLCanvasElement;
  const raster = document.getElementById('raster') as HTMLCanvasElement;
  const ssim = document.getElementById('ssim') as HTMLElement;
  const perf = document.getElementById('perf') as HTMLElement;

  const scrubber = new Scrubber(scene, raster, () => app().getOutput()?.grid ?? null);
  // The scrubber stage doubles as an orbit surface (the divider only moves via its own
  // handle now). Same-element pointermove listeners fire in registration order, so the
  // scene has already re-rendered when the redraw below copies it into the left pane.
  (app().scene as Scene).attachOrbit(scrubber.element);
  scrubber.element.addEventListener('pointermove', (e) => { if (e.buttons & 1) scrubber.redraw(); });
  const ladder = new Ladder(ssim);
  const controls = new Controls();
  const exports = new Exports(raster);
  const permalink = new Permalink();

  const matchPct = el('span', { class: 'pct', text: '—' });

  const squint = el('input', { type: 'checkbox', change: (e) => scrubber.setSquint((e.target as HTMLInputElement).checked) });
  const heat = el('input', { type: 'checkbox', change: (e) => scrubber.setHeatmap((e.target as HTMLInputElement).checked) });
  const toolbar = el('div', { class: 'toolbar' }, [
    el('label', { class: 'toggle' }, [squint, 'squint']),
    el('label', { class: 'toggle' }, [heat, 'diff heatmap']),
  ]);

  const viewport = el('div', { class: 'viewport' }, [
    el('figure', {}, [scene, el('figcaption', { text: 'drag to orbit · drop a .glb / .gltf to swap the model' })]),
  ]);

  const root = el('div', { id: 'ui-root' }, [
    el('header', { class: 'top' }, [
      el('div', { class: 'brand' }, [
        el('b', {}, [document.createTextNode('glyphit'), el('span', { text: '·' }), document.createTextNode('3d')]),
        el('span', { class: 'tag', text: 'a glyph-constrained 3D renderer — the demo is the proof' }),
      ]),
      el('div', { class: 'match' }, [matchPct, el('span', { class: 'lbl', text: 'perceptual match' })]),
    ]),
    el('div', { class: 'grid' }, [
      el('div', { class: 'stage-col' }, [scrubber.element, toolbar, viewport]),
      el('div', { class: 'rack' }, [ladder.element, controls.element, exports.element, permalink.element]),
    ]),
    el('div', { class: 'hidden-buf' }, [raster]),
    perf,
  ]);
  perf.className = 'perf';

  document.body.replaceChildren(root);

  const refresh = (): void => {
    scrubber.refresh();
    ladder.refresh();
    permalink.refresh();
    const s = app().getOutput()?.ssim;
    matchPct.textContent = s == null ? '—' : `${(s * 100).toFixed(1)}%`;
  };
  onOutput(refresh);
  refresh();
  scrubber.autoSweep();

  // Playwright hook: expose the devices so the E2E spec can drive them directly.
  (window as unknown as { __ui: unknown }).__ui = { scrubber, ladder, controls, exports, permalink };
}

void boot();
