import { app } from './bridge.js';
import { el, panel } from './dom.js';

// Q-ladder device (M2-SPEC §3, DESIGN §6/§9). Q0–Q4 buttons re-match on switch;
// the large SSIM badge (the moved #ssim node, kept live by main.ts) rises rung by
// rung, and a one-line caption names what each rung adds. The ladder IS the
// ablation study.

const CAPTIONS: Record<number, string> = {
  0: 'Fixed-brightness ramp — baseline strawman, demo comparison only.',
  1: 'Shape match, monochrome — the classic ASCII aesthetic.',
  2: '+ foreground colour fit (fixed background) — the TUI-insertion default.',
  3: '+ two-colour fg/bg fit — highest fidelity.',
  4: '+ edge / multi-scale loss — contour preservation.',
};

export class Ladder {
  readonly element: HTMLElement;
  private readonly buttons: HTMLButtonElement[] = [];
  private readonly caption = el('p', { class: 'ladder-caption' });

  // `badge` is the existing #ssim node, reparented here so main.ts keeps writing it.
  constructor(badge: HTMLElement) {
    const row = el('div', { class: 'ladder-row' });
    for (let q = 0; q <= 4; q++) {
      const btn = el('button', {
        class: 'q-btn',
        type: 'button',
        text: `Q${q}`,
        click: () => { app().setParams({ quality: q as 0 | 1 | 2 | 3 | 4 }); void app().rematch(); },
      });
      this.buttons.push(btn);
      row.append(btn);
    }
    this.element = panel('quality ladder', [
      el('div', { class: 'badge-wrap' }, [
        badge,
        el('span', { class: 'badge-unit', text: 'SSIM' }),
      ]),
      row,
      this.caption,
    ]);
    this.refresh();
  }

  refresh(): void {
    const q = app().getState().params.quality;
    this.buttons.forEach((b, i) => b.classList.toggle('active', i === q));
    this.caption.textContent = CAPTIONS[q] ?? '';
  }
}
