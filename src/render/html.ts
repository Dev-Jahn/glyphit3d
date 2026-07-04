import type { Grid, GridCell } from '../core/types.js';

function eqRgb(a: [number, number, number] | null, b: [number, number, number] | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const DEFAULT: GridCell = { ch: ' ', fg: null, bg: null };

function renderRun(text: string, fg: [number, number, number] | null,
                   bg: [number, number, number] | null, cellH: number): string {
  const t = esc(text);
  if (!fg && !bg) return t;
  let style = '';
  if (fg) style += `color:rgb(${fg[0]},${fg[1]},${fg[2]});`;
  // DESIGN §5.6 hazard: inline background only paints the content box, striping
  // the leading. Colored spans must be cell-sized inline-blocks instead.
  if (bg) {
    style += `background:rgb(${bg[0]},${bg[1]},${bg[2]});`;
    style += `display:inline-block;height:${cellH}px;vertical-align:top;`;
  }
  return `<span style="${style}">${t}</span>`;
}

export function toHtml(grid: Grid): string {
  const cellH = grid.cellH;
  const pre =
    `margin:0;font-family:"${grid.font}",monospace;font-size:${cellH}px;` +
    `line-height:${cellH}px;letter-spacing:0;white-space:pre;font-kerning:none;` +
    `font-variant-ligatures:none;font-synthesis:none;`;
  let html = `<pre style="${pre}">`;
  for (let r = 0; r < grid.rows; r++) {
    html += `<div style="height:${cellH}px">`;
    let c = 0;
    while (c < grid.cols) {
      const cell = grid.cells[r * grid.cols + c] ?? DEFAULT;
      const fg = cell.fg;
      const bg = cell.bg;
      let text = cell.ch;
      c++;
      while (c < grid.cols) {
        const nxt = grid.cells[r * grid.cols + c] ?? DEFAULT;
        if (!eqRgb(nxt.fg, fg) || !eqRgb(nxt.bg, bg)) break;
        text += nxt.ch;
        c++;
      }
      html += renderRun(text, fg, bg, cellH);
    }
    html += `</div>`;
  }
  html += `</pre>`;
  return html;
}
