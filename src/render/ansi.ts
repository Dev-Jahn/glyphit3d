import type { Grid } from '../core/types.js';

function eqRgb(a: [number, number, number] | null, b: [number, number, number] | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

// Truecolor SGR with per-row state reuse (DESIGN §5.6). Row end = ESC[0m + \r\n
// (reset per row, no auto-wrap reliance). bg:null → SGR 49, fg:null → SGR 39.
export function toAnsi(grid: Grid): string {
  const parts: string[] = [];
  for (let r = 0; r < grid.rows; r++) {
    // ESC[0m at each row end resets state, so each row starts at terminal default.
    let curFg: [number, number, number] | null = null;
    let curBg: [number, number, number] | null = null;
    let row = '';
    for (let c = 0; c < grid.cols; c++) {
      const cell = grid.cells[r * grid.cols + c];
      if (!cell) continue;
      const sgr: string[] = [];
      if (!eqRgb(cell.fg, curFg)) {
        sgr.push(cell.fg ? `38;2;${cell.fg[0]};${cell.fg[1]};${cell.fg[2]}` : '39');
        curFg = cell.fg;
      }
      if (!eqRgb(cell.bg, curBg)) {
        sgr.push(cell.bg ? `48;2;${cell.bg[0]};${cell.bg[1]};${cell.bg[2]}` : '49');
        curBg = cell.bg;
      }
      if (sgr.length) row += `\x1b[${sgr.join(';')}m`;
      row += cell.ch;
    }
    parts.push(row + '\x1b[0m\r\n');
  }
  return parts.join('');
}
