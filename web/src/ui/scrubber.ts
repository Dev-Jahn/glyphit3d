import type { Grid } from '../../../src/core/types.js';
import { el } from './dom.js';
import { heatmapCanvas } from './heatmap.js';

// Un-blur reveal scrubber (M2-SPEC §3, DESIGN §9) — the hero device. One canvas
// composites the native render (left of a draggable divider) and the glyph raster
// (right); both sources are already at the grid footprint so the split is 1:1.
// "Squint" applies an identical CSS blur to the whole canvas — the moment both
// halves become indistinguishable is the proof. The divider handle is a separate,
// un-blurred DOM element so the grab target stays crisp under squint.

export class Scrubber {
  readonly element: HTMLElement;
  private readonly canvas = el('canvas', { class: 'scrub-canvas' });
  private readonly handle = el('div', { class: 'scrub-handle' });
  private readonly rlabel = el('span', { class: 'scrub-tag scrub-tag-r', text: 'glyphs' });
  private readonly ctx = this.canvas.getContext('2d')!;
  private frac = 0.5;
  private squint = false;
  private heatmapOn = false;
  private heat: HTMLCanvasElement | null = null;

  constructor(
    private readonly scene: HTMLCanvasElement,
    private readonly raster: HTMLCanvasElement,
    private readonly getGrid: () => Grid | null,
  ) {
    const stage = el('div', { class: 'scrub-stage' }, [
      this.canvas,
      el('span', { class: 'scrub-tag scrub-tag-l', text: '3D render' }),
      this.rlabel,
      this.handle,
    ]);
    this.element = stage;
    const setFromEvent = (clientX: number): void => {
      const rect = stage.getBoundingClientRect();
      this.frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      this.layout();
    };
    let dragging = false;
    stage.addEventListener('pointerdown', (e) => {
      dragging = true;
      stage.setPointerCapture(e.pointerId);
      setFromEvent(e.clientX);
    });
    stage.addEventListener('pointermove', (e) => { if (dragging) setFromEvent(e.clientX); });
    const end = (e: PointerEvent): void => { dragging = false; stage.releasePointerCapture(e.pointerId); };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
  }

  setSquint(on: boolean): void {
    this.squint = on;
    this.canvas.style.filter = on ? 'blur(6px)' : '';
  }

  setHeatmap(on: boolean): void {
    this.heatmapOn = on;
    this.rlabel.textContent = on ? 'diff heatmap' : 'glyphs';
    this.refresh();
  }

  refresh(): void {
    const w = this.raster.width;
    const h = this.raster.height;
    if (!w || !h) return;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const grid = this.getGrid();
    this.heat = this.heatmapOn && grid ? heatmapCanvas(this.scene, this.raster, grid) : null;
    this.draw();
  }

  private draw(): void {
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.handle.style.left = `${this.frac * 100}%`;
    if (!w || !h) return;
    const divX = Math.round(this.frac * w);
    this.ctx.clearRect(0, 0, w, h);
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(0, 0, divX, h);
    this.ctx.clip();
    this.ctx.drawImage(this.scene, 0, 0, w, h);
    this.ctx.restore();
    const right = this.heat ?? this.raster;
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(divX, 0, w - divX, h);
    this.ctx.clip();
    this.ctx.drawImage(right, 0, 0, w, h);
    this.ctx.restore();
  }

  // Reposition the divider and repaint after `frac` changes (drag / auto-sweep).
  private layout(): void {
    this.draw();
  }

  // 2s intro sweep (DESIGN §9): wipe fully across to reveal the glyph side, then
  // settle back to centre.
  autoSweep(): void {
    const t0 = performance.now();
    const dur = 2000;
    const step = (now: number): void => {
      const p = Math.min(1, (now - t0) / dur);
      // 0→1 over the first 60% of the timeline, then 1→0.5 over the last 40%.
      this.frac = p < 0.6 ? p / 0.6 : 1 - ((p - 0.6) / 0.4) * 0.5;
      this.layout();
      if (p < 1) requestAnimationFrame(step);
      else { this.frac = 0.5; this.layout(); }
    };
    requestAnimationFrame(step);
  }
}
