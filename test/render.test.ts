import { describe, it, expect } from 'vitest';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Atlas, Glyph, Grid } from '../src/core/types.js';
import { rasterizeGrid, savePng } from '../src/render/raster.js';
import { toAnsi } from '../src/render/ansi.js';
import { toHtml } from '../src/render/html.js';
import { cellDiffHeatmap } from '../src/metric/heatmap.js';

function makeGlyph(ch: string, cp: number, cellW: number, cellH: number, fill: number): Glyph {
  const P = cellW * cellH;
  const alpha = new Float32Array(P).fill(fill);
  return {
    ch, cp, alpha,
    dxA: new Float32Array(P), dyA: new Float32Array(P),
    sumA: fill * P, sumAA: fill * fill * P, gradAA: 0, ink: 0,
  };
}

const CW = 2, CH = 2;
const atlas: Atlas = {
  cellW: CW, cellH: CH, P: CW * CH,
  fontPath: 'x', fontSize: 8, ascent: 6,
  glyphs: [makeGlyph(' ', 0x20, CW, CH, 0), makeGlyph('#', 0x23, CW, CH, 1)],
};

describe('rasterizeGrid', () => {
  it('bakes α·F + (1−α)·B in linear RGB', () => {
    const grid: Grid = {
      cols: 2, rows: 1, cellW: CW, cellH: CH, font: 'Mono',
      cells: [
        { ch: '#', fg: [255, 0, 0], bg: [0, 0, 0] }, // fully inked → linear red
        { ch: ' ', fg: null, bg: [0, 255, 0] },       // zero ink → bg green
      ],
    };
    const img = rasterizeGrid(grid, atlas);
    expect(img.w).toBe(4);
    expect(img.h).toBe(2);
    // cell0 pixel (0,0): red
    expect(img.data[0]).toBeCloseTo(1, 6);
    expect(img.data[1]).toBeCloseTo(0, 6);
    expect(img.data[2]).toBeCloseTo(0, 6);
    // cell1 pixel (2,0): green from bg
    const c1 = (0 * 4 + 2) * 3;
    expect(img.data[c1]).toBeCloseTo(0, 6);
    expect(img.data[c1 + 1]).toBeCloseTo(1, 6);
    expect(img.data[c1 + 2]).toBeCloseTo(0, 6);
  });

  it('savePng writes a valid PNG file', async () => {
    const grid: Grid = {
      cols: 1, rows: 1, cellW: CW, cellH: CH, font: 'Mono',
      cells: [{ ch: '#', fg: [200, 100, 50], bg: [0, 0, 0] }],
    };
    const img = rasterizeGrid(grid, atlas);
    const path = join(tmpdir(), `ascii3d-test-${process.pid}.png`);
    await savePng(img, path);
    const buf = await readFile(path);
    // PNG magic bytes
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
    expect(buf[2]).toBe(0x4e);
    expect(buf[3]).toBe(0x47);
    await unlink(path);
  });
});

describe('toAnsi', () => {
  it('reuses SGR state and terminates rows with ESC[0m + CRLF', () => {
    const grid: Grid = {
      cols: 2, rows: 1, cellW: CW, cellH: CH, font: 'Mono',
      cells: [
        { ch: 'a', fg: [10, 20, 30], bg: null },
        { ch: 'b', fg: [10, 20, 30], bg: null }, // identical style → no re-emit
      ],
    };
    const out = toAnsi(grid);
    expect(out).toBe('\x1b[38;2;10;20;30mab\x1b[0m\r\n');
  });

  it('emits SGR 39/49 when returning to default fg/bg', () => {
    const grid: Grid = {
      cols: 2, rows: 1, cellW: CW, cellH: CH, font: 'Mono',
      cells: [
        { ch: 'x', fg: [1, 2, 3], bg: [4, 5, 6] },
        { ch: 'y', fg: null, bg: null },
      ],
    };
    const out = toAnsi(grid);
    expect(out).toContain('\x1b[38;2;1;2;3;48;2;4;5;6mx');
    expect(out).toContain('\x1b[39;49my');
  });
});

describe('toHtml', () => {
  it('escapes entities and uses cell-sized inline-block for colored backgrounds', () => {
    const grid: Grid = {
      cols: 2, rows: 1, cellW: CW, cellH: CH, font: 'JetBrains Mono',
      cells: [
        { ch: '<', fg: [255, 255, 255], bg: [10, 10, 10] },
        { ch: '&', fg: null, bg: null },
      ],
    };
    const html = toHtml(grid);
    expect(html).toContain('font-family:"JetBrains Mono",monospace');
    expect(html).toContain(`line-height:${CH}px`);
    expect(html).toContain('&lt;');
    expect(html).toContain('&amp;');
    // background span must be a cell-sized inline-block (no background stripe)
    expect(html).toMatch(/background:rgb\(10,10,10\);display:inline-block;height:2px;vertical-align:top;/);
  });

  it('merges adjacent same-style cells into one span', () => {
    const grid: Grid = {
      cols: 3, rows: 1, cellW: CW, cellH: CH, font: 'Mono',
      cells: [
        { ch: 'a', fg: [1, 2, 3], bg: null },
        { ch: 'b', fg: [1, 2, 3], bg: null },
        { ch: 'c', fg: [1, 2, 3], bg: null },
      ],
    };
    const html = toHtml(grid);
    expect(html).toContain('>abc<');
    expect((html.match(/<span/g) ?? []).length).toBe(1);
  });
});

describe('cellDiffHeatmap', () => {
  it('is fully green where ref and out match', () => {
    const grid: Grid = {
      cols: 2, rows: 1, cellW: CW, cellH: CH, font: 'Mono',
      cells: [
        { ch: '#', fg: [255, 255, 255], bg: [0, 0, 0] },
        { ch: ' ', fg: null, bg: [0, 0, 0] },
      ],
    };
    const img = rasterizeGrid(grid, atlas);
    const heat = cellDiffHeatmap(img, img, grid);
    expect(heat.data[0]).toBeCloseTo(0, 6); // red
    expect(heat.data[1]).toBeCloseTo(1, 6); // green
    expect(heat.data[2]).toBeCloseTo(0, 6);
  });
});
