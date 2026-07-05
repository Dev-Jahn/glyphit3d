import type { Grid } from '../../../src/core/types.js';
import { toAnsi } from '../../../src/render/ansi.js';
import { app, profileMeta, type Charset, type ProfileMeta } from './bridge.js';
import { downloadBlob, el, panel } from './dom.js';

// Exports device (M2-SPEC §3, DESIGN §8). ANSI reuses the existing toAnsi; PNG bakes
// the raster canvas; the grid .json is the canonical v1 sprite-grid serializer.

type Rgb = [number, number, number] | null;
interface GridJson {
  version: 1;
  cols: number;
  rows: number;
  cell: { width: number; height: number; aspect: number };
  font: { family: string; size: number; profileHash: string };
  color: { channels: 'mono' | 'fg' | 'fg-bg'; depth: 'truecolor' };
  cells: ({ ch: string; fg: Rgb; bg: Rgb } | null)[];
}

// quality → colour channels (DESIGN §6): Q0/Q1 mono, Q2 fg, Q3/Q4 fg-bg.
function channels(quality: number): 'mono' | 'fg' | 'fg-bg' {
  if (quality <= 1) return 'mono';
  if (quality === 2) return 'fg';
  return 'fg-bg';
}

export function serializeGrid(grid: Grid, meta: ProfileMeta, quality: number): GridJson {
  return {
    version: 1,
    cols: grid.cols,
    rows: grid.rows,
    cell: { width: grid.cellW, height: grid.cellH, aspect: grid.cellW / grid.cellH },
    font: { family: grid.font, size: meta.size, profileHash: meta.profileHash },
    color: { channels: channels(quality), depth: 'truecolor' },
    // bg:null is the terminal-default contract (§8); a null cell is a skip cell.
    cells: grid.cells.map((c) => (c ? { ch: c.ch, fg: c.fg, bg: c.bg } : null)),
  };
}

export class Exports {
  readonly element: HTMLElement;
  private readonly status = el('span', { class: 'export-status' });

  constructor(private readonly raster: HTMLCanvasElement) {
    const btn = (label: string, onClick: () => void | Promise<void>): HTMLButtonElement =>
      el('button', {
        class: 'export-btn', type: 'button', text: label,
        click: () => { void Promise.resolve(onClick()).catch((e) => this.flash(String(e))); },
      });

    const row = el('div', { class: 'export-row' }, [
      btn('.ans', () => this.saveAnsi()),
      btn('copy', () => this.copyAnsi()),
      btn('.png', () => this.savePng()),
      btn('.json', () => this.saveJson()),
    ]);
    this.element = panel('export', [row, this.status]);
  }

  private grid(): Grid {
    const out = app().getOutput();
    if (!out) throw new Error('no output yet');
    return out.grid;
  }

  private flash(msg: string): void {
    this.status.textContent = msg;
    setTimeout(() => { this.status.textContent = ''; }, 2400);
  }

  private saveAnsi(): void {
    downloadBlob(new Blob([toAnsi(this.grid())], { type: 'text/plain' }), 'ascii3d.ans');
    this.flash('saved ascii3d.ans');
  }

  private async copyAnsi(): Promise<void> {
    await navigator.clipboard.writeText(toAnsi(this.grid()));
    this.flash('copied ANSI to clipboard');
  }

  private savePng(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.raster.toBlob((blob) => {
        if (!blob) { reject(new Error('png encode failed')); return; }
        downloadBlob(blob, 'ascii3d.png');
        this.flash('saved ascii3d.png');
        resolve();
      }, 'image/png');
    });
  }

  private async saveJson(): Promise<void> {
    const charset = app().getState().params.charset as Charset;
    const quality = app().getState().params.quality;
    const meta = await profileMeta(charset);
    const json = serializeGrid(this.grid(), meta, quality);
    downloadBlob(new Blob([JSON.stringify(json)], { type: 'application/json' }), 'ascii3d.json');
    this.flash('saved ascii3d.json');
  }
}
