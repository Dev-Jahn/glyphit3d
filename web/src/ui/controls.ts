import { app, type Charset } from './bridge.js';
import { el, panel } from './dom.js';

// Controls device (M2-SPEC §3): charset (loads the matching profile), cols slider
// (60–160), working-space toggle (gamma/linear). Each edit re-matches; the slider
// echoes its value live and re-matches on release to avoid thrashing the worker.

// Only ascii and blocks are offered: DejaVu Sans Mono carries zero braille glyphs,
// so the 'braille'/'full' presets are byte-identical placebos with this font (see
// caption below and DESIGN §15.7 note). The profile JSONs/atlas presets are kept
// node-side for the charset-gate experiment.
const CHARSETS: { value: Charset; label: string }[] = [
  { value: 'ascii', label: 'ascii' },
  { value: 'blocks', label: '+ blocks' },
];

export class Controls {
  readonly element: HTMLElement;

  constructor() {
    const p = app().getState().params;

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

    this.element = panel('controls', [
      field('charset', charset),
      charsetNote,
      field('columns', el('div', { class: 'field-slider-wrap' }, [cols, colsOut])),
      field('contrast floor', el('div', { class: 'field-slider-wrap' }, [floor, floorOut])),
      field('working space', spaceRow),
    ]);
  }
}

function field(label: string, control: Node): HTMLElement {
  return el('label', { class: 'field' }, [el('span', { class: 'field-label', text: label }), control]);
}
