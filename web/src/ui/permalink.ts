import { app } from './bridge.js';
import { el, panel } from './dom.js';

// Permalink device (M2-SPEC §3): settings-only fragment (model, cols, quality,
// charset, space, camera yaw/pitch), kept live in the URL so a reload restores the
// view (main.ts reads it on load). Custom dropped models are not encoded.

function fragment(): string {
  const p = app().getState().params;
  const q = new URLSearchParams({
    model: 'torusknot',
    cols: String(p.cols),
    quality: String(p.quality),
    charset: p.charset,
    space: p.space,
    yaw: p.yaw.toFixed(1),
    pitch: p.pitch.toFixed(1),
  });
  return q.toString();
}

export class Permalink {
  readonly element: HTMLElement;

  constructor() {
    const copy = el('button', {
      class: 'export-btn', type: 'button', text: 'copy permalink',
      click: () => {
        void navigator.clipboard.writeText(location.href).then(() => {
          copy.textContent = 'copied';
          setTimeout(() => { copy.textContent = 'copy permalink'; }, 1500);
        });
      },
    });
    this.element = panel('permalink', [
      copy,
      el('p', { class: 'note', text: 'Encodes settings + camera only. Dropped .glb models are not encoded.' }),
    ]);
  }

  // Keep the fragment current without reloading (main.ts reads it only on load).
  refresh(): void {
    history.replaceState(null, '', `#${fragment()}`);
  }
}
