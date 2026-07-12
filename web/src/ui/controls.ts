import { app, type Charset } from './bridge.js';
import { el, panel } from './dom.js';
import type { Ladder } from './ladder.js';
import { MODELS } from '../models.js';

// Controls device (M2-SPEC §3): model picker, charset (loads the matching profile), cols slider
// (60–160), working-space toggle (gamma/linear), and the ASCII-identity block. Each edit re-matches;
// the slider echoes its value live and re-matches on release to avoid thrashing the worker.

// Only ascii and blocks are offered: DejaVu Sans Mono carries zero braille glyphs,
// so the 'braille'/'full' presets are byte-identical placebos with this font (see
// caption below and DESIGN §15.7 note). The profile JSONs/atlas presets are kept
// node-side for the charset-gate experiment.
const CHARSETS: { value: Charset; label: string }[] = [
  { value: 'ascii', label: 'ascii' },
  { value: 'blocks', label: '+ blocks' },
];

// feat/identity-web-wiring: charset-coherence modes offered in the demo. 'smooth' is EXCLUDED — it is a
// cross-cell (top-neighbor) pass that seams under the row-band worker pool (band-opts.ts guards it too).
const COHERENCE: Params['identityCoherence'][] = ['none', 'ramp-bias', 'pure-ramp'];

type Params = ReturnType<ReturnType<typeof app>['getState']>['params'];

export class Controls {
  readonly element: HTMLElement;

  // feat/identity-web-wiring: the ladder is pinned to Q2 and disabled while ASCII-identity is on, so
  // Controls takes it to toggle its enabled state.
  constructor(ladder: Ladder) {
    const p = app().getState().params;

    // feat/web-model-picker: swap the procedural model. setModel commits on its own (scene reframe +
    // forceKeyframe + coalescer), so no explicit rematch here. Class 'field-select' (styled like
    // 'field-input') so the charset select stays the SOLE `select.field-input` the e2e targets.
    const model = el('select', {
      class: 'field-select',
      change: () => { app().setModel(model.value); },
    });
    for (const m of MODELS) {
      model.append(el('option', { value: m, text: m, selected: m === p.model }));
    }

    const charset = el('select', {
      class: 'field-input',
      change: () => { app().setParams({ charset: charset.value as Charset }); void app().rematch(); },
    });
    for (const c of CHARSETS) {
      charset.append(el('option', { value: c.value, text: c.label, selected: c.value === p.charset }));
    }

    const colsOut = el('output', { class: 'field-value', text: String(p.cols) });
    const cols = el('input', {
      class: 'field-slider', type: 'range', min: 60, max: 160, step: 1, value: p.cols,
      input: () => { colsOut.textContent = cols.value; },
      change: () => { app().setParams({ cols: Number(cols.value) }); void app().rematch(); },
    });

    // Contrast floor (Round A ASCII-identity, feat/contrast-floor-fill): lifts faint dark-region
    // glyphs to a legible fg/bg separation (or flat-fills them). 0 = off; default 0.06 for the
    // dark demo scene. Working-space luma units, so the slider tops out well below the [0,0.5]
    // fragment range. Re-matches on release like the columns slider.
    const fmtFloor = (v: number): string => (v === 0 ? 'off' : v.toFixed(2));
    const floorOut = el('output', { class: 'field-value', text: fmtFloor(p.floor) });
    const floor = el('input', {
      class: 'field-slider', type: 'range', min: 0, max: 0.2, step: 0.01, value: p.floor,
      input: () => { floorOut.textContent = fmtFloor(Number(floor.value)); },
      change: () => { app().setParams({ floor: Number(floor.value) }); void app().rematch(); },
    });

    const spaceRow = el('div', { class: 'seg' });
    const spaces: ('gamma' | 'linear')[] = ['gamma', 'linear'];
    const spaceBtns = spaces.map((s) =>
      el('button', {
        class: 'seg-btn' + (s === p.space ? ' active' : ''), type: 'button', text: s,
        click: () => {
          spaceBtns.forEach((b, i) => b.classList.toggle('active', spaces[i] === s));
          app().setParams({ space: s });
          void app().rematch();
        },
      }),
    );
    spaceBtns.forEach((b) => spaceRow.append(b));

    const charsetNote = el('p', {
      class: 'note',
      text: 'braille/full presets need a font with coverage — planned with font profiles',
    });

    // feat/identity-web-wiring: the ASCII-identity block. The coherence dropdown + colour-dither
    // checkbox are sub-controls, enabled only while identity is on.
    const coherence = el('select', {
      class: 'field-select', // styled like 'field-input'; keeps charset the sole `select.field-input` (e2e)
      change: () => { app().setParams({ identityCoherence: coherence.value as Params['identityCoherence'] }); void app().rematch(); },
    });
    for (const c of COHERENCE) coherence.append(el('option', { value: c, text: c, selected: c === p.identityCoherence }));

    const colorDither = el('input', {
      type: 'checkbox', checked: p.identityColorDither,
      change: () => { app().setParams({ identityColorDither: colorDither.checked }); void app().rematch(); },
    });

    const setIdentitySubEnabled = (on: boolean): void => { coherence.disabled = !on; colorDither.disabled = !on; };
    setIdentitySubEnabled(p.identity);

    // ON → pin quality 2 + disable the ladder + enable the sub-controls; OFF → re-enable the ladder.
    const identity = el('input', {
      type: 'checkbox', checked: p.identity,
      change: () => {
        const on = identity.checked;
        if (on) app().setParams({ identity: true, quality: 2 });
        else app().setParams({ identity: false });
        ladder.setEnabled(!on);
        setIdentitySubEnabled(on);
        void app().rematch();
      },
    });

    this.element = panel('controls', [
      field('model', model),
      field('charset', charset),
      charsetNote,
      field('columns', el('div', { class: 'field-slider-wrap' }, [cols, colsOut])),
      field('contrast floor', el('div', { class: 'field-slider-wrap' }, [floor, floorOut])),
      field('working space', spaceRow),
      field('ASCII-identity', identity),
      field('coherence', coherence),
      field('colour dither', colorDither),
    ]);
  }
}

function field(label: string, control: Node): HTMLElement {
  return el('label', { class: 'field' }, [el('span', { class: 'field-label', text: label }), control]);
}
