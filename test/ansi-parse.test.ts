import { describe, it, expect } from 'vitest';
import { parseAnsiToGrid } from '../bench/ansi-parse.js';
import type { GridCell } from '../src/core/types.js';

const ESC = '\x1b';
const CW = 10, CH = 19, FONT = 'DejaVuSansMono';

function parse(ansi: string) {
  return parseAnsiToGrid(ansi, CW, CH, FONT);
}
function cell(ch: string, fg: [number, number, number] | null, bg: [number, number, number] | null): GridCell {
  return { ch, fg, bg };
}

describe('parseAnsiToGrid', () => {
  it('parses a combined 38;2;R;G;B;48;2;R;G;B run and carries the grid geometry', () => {
    const g = parse(`${ESC}[38;2;255;10;20;48;2;30;40;50mAB${ESC}[0m\n`);
    expect(g.cols).toBe(2);
    expect(g.rows).toBe(1);
    expect(g.cellW).toBe(CW);
    expect(g.cellH).toBe(CH);
    expect(g.font).toBe(FONT);
    // one SGR sets BOTH fg and bg; it persists to the second cell.
    expect(g.cells[0]).toEqual(cell('A', [255, 10, 20], [30, 40, 50]));
    expect(g.cells[1]).toEqual(cell('B', [255, 10, 20], [30, 40, 50]));
  });

  it('persists SGR state across cells and applies a mid-row change only to later cells', () => {
    const g = parse(`${ESC}[38;2;1;2;3mXY${ESC}[38;2;9;8;7mZ\n`);
    expect(g.cols).toBe(3);
    expect(g.cells[0]).toEqual(cell('X', [1, 2, 3], null));
    expect(g.cells[1]).toEqual(cell('Y', [1, 2, 3], null)); // inherited, no new SGR
    expect(g.cells[2]).toEqual(cell('Z', [9, 8, 7], null)); // changed for this cell on
  });

  it('39 / 49 reset fg / bg to the terminal default (null)', () => {
    const g = parse(`${ESC}[38;2;10;20;30;48;2;40;50;60mP${ESC}[39;49mQ\n`);
    expect(g.cells[0]).toEqual(cell('P', [10, 20, 30], [40, 50, 60]));
    expect(g.cells[1]).toEqual(cell('Q', null, null));
  });

  it('0 (full reset) clears both fg and bg', () => {
    const g = parse(`${ESC}[38;2;5;5;5;48;2;6;6;6mA${ESC}[0mB\n`);
    expect(g.cells[0]).toEqual(cell('A', [5, 5, 5], [6, 6, 6]));
    expect(g.cells[1]).toEqual(cell('B', null, null));
  });

  it('resolves spot-checked xterm-256 palette entries via 38;5 / 48;5', () => {
    // fg via 38;5;n, bg fixed truecolor so we isolate the palette lookup.
    const table: Array<[number, [number, number, number]]> = [
      [16, [0, 0, 0]],        // start of the 6×6×6 cube = black
      [196, [255, 0, 0]],     // ff0000
      [231, [255, 255, 255]], // end of the cube = white
      [244, [128, 128, 128]], // grayscale ramp, gray50
    ];
    for (const [n, rgb] of table) {
      const g = parse(`${ESC}[38;5;${n};48;2;1;1;1mX\n`);
      expect(g.cells[0]).toEqual(cell('X', rgb, [1, 1, 1]));
    }
    // and a 48;5 background lookup for good measure
    const g = parse(`${ESC}[48;5;196mY\n`);
    expect(g.cells[0]).toEqual(cell('Y', null, [255, 0, 0]));
  });

  it('produces identical cells with and without a trailing newline', () => {
    const noNl = parse(`${ESC}[38;2;7;7;7mAB`);
    const withNl = parse(`${ESC}[38;2;7;7;7mAB\n`);
    expect(noNl.cols).toBe(2);
    expect(noNl.rows).toBe(1);
    expect(noNl.cells).toEqual(withNl.cells);
  });

  it('ignores cursor-hide bracketing (\\x1b[?25l … \\x1b[?25h) around the frame', () => {
    const g = parse(`${ESC}[?25l${ESC}[38;2;9;9;9mA${ESC}[0m${ESC}[?25h\n`);
    expect(g.cols).toBe(1);
    expect(g.rows).toBe(1);
    expect(g.cells[0]).toEqual(cell('A', [9, 9, 9], null));
  });

  it('lays out a multi-row frame with per-row reset', () => {
    const g = parse(`${ESC}[38;2;1;1;1mAB${ESC}[0m\n${ESC}[38;2;2;2;2mCD${ESC}[0m\n`);
    expect(g.cols).toBe(2);
    expect(g.rows).toBe(2);
    expect(g.cells[0]).toEqual(cell('A', [1, 1, 1], null));
    expect(g.cells[1]).toEqual(cell('B', [1, 1, 1], null));
    expect(g.cells[2]).toEqual(cell('C', [2, 2, 2], null));
    expect(g.cells[3]).toEqual(cell('D', [2, 2, 2], null));
  });
});
