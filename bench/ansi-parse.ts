import type { Grid, GridCell } from '../src/core/types.js';

// Parse a terminal ANSI stream (as produced by chafa -f symbols) into a Grid.
// Handles the SGR subset chafa emits under --colors full/256: 0 (reset),
// 38;2;r;g;b / 48;2;r;g;b (truecolor), 38;5;n / 48;5;n (256-palette),
// 39 (default fg), 49 (default bg). Colours are stored as sRGB 0..255 ints —
// terminal colours are sRGB, matching GridCell's contract. Non-SGR CSI
// sequences (e.g. the cursor-hide \x1b[?25l chafa brackets the frame with) and
// C0 controls other than newline are skipped. Each printable code point (incl.
// multi-byte UTF-8, which JS strings already decode) becomes one cell.

type RGB = [number, number, number];

// xterm 256-colour palette → sRGB, for the 38;5 / 48;5 fallback.
function xterm256(n: number): RGB {
  if (n < 16) {
    const base = [
      [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
      [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
      [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
      [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
    ];
    return base[n] as RGB;
  }
  if (n < 232) {
    const c = n - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    return [steps[Math.floor(c / 36) % 6]!, steps[Math.floor(c / 6) % 6]!, steps[c % 6]!];
  }
  const v = 8 + (n - 232) * 10;
  return [v, v, v];
}

// Apply one SGR parameter list, mutating current fg/bg. Consumes r;g;b or index
// operands inline for the extended-colour introducers (38/48).
function applySgr(params: number[], state: { fg: RGB | null; bg: RGB | null }): void {
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    if (p === 0) {
      state.fg = null;
      state.bg = null;
    } else if (p === 39) {
      state.fg = null;
    } else if (p === 49) {
      state.bg = null;
    } else if (p === 38 || p === 48) {
      const mode = params[i + 1];
      let col: RGB | null = null;
      if (mode === 2) {
        col = [params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0];
        i += 4;
      } else if (mode === 5) {
        col = xterm256(params[i + 2] ?? 0);
        i += 2;
      } else {
        i += 1;
      }
      if (p === 38) state.fg = col; else state.bg = col;
    }
    // other SGR (bold, etc.) irrelevant to re-rasterization → ignored
  }
}

export function parseAnsiToGrid(
  ansi: string,
  cellW: number,
  cellH: number,
  font: string,
): Grid {
  const state: { fg: RGB | null; bg: RGB | null } = { fg: null, bg: null };
  const rowsCells: GridCell[][] = [];
  let cur: GridCell[] = [];

  const chars = Array.from(ansi); // code-point iteration (UTF-8 safe)
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (ch === '\x1b') {
      const next = chars[i + 1];
      if (next === '[') {
        // CSI: consume until a final byte in @..~ (0x40..0x7E)
        let j = i + 2;
        let raw = '';
        while (j < chars.length) {
          const cc = chars[j]!;
          const code = cc.codePointAt(0)!;
          if (code >= 0x40 && code <= 0x7e) break;
          raw += cc;
          j++;
        }
        const final = chars[j];
        if (final === 'm') {
          const params = raw === '' ? [0] : raw.split(';').map((s) => (s === '' ? 0 : parseInt(s, 10)));
          applySgr(params, state);
        }
        i = j; // skip the whole CSI incl. final byte
      } else {
        // other escapes (rare in chafa output) — skip the introducer only
      }
      continue;
    }
    if (ch === '\n') {
      if (cur.length > 0 || rowsCells.length > 0) rowsCells.push(cur);
      cur = [];
      continue;
    }
    if (ch === '\r') continue;
    const code = ch.codePointAt(0)!;
    if (code < 0x20) continue; // other C0 controls
    cur.push({
      ch,
      fg: state.fg ? [...state.fg] as RGB : null,
      bg: state.bg ? [...state.bg] as RGB : null,
    });
  }
  if (cur.length > 0) rowsCells.push(cur);

  // Drop trailing empty rows; pad ragged rows to the max width with blank cells.
  while (rowsCells.length > 0 && rowsCells[rowsCells.length - 1]!.length === 0) rowsCells.pop();
  const cols = rowsCells.reduce((m, r) => Math.max(m, r.length), 0);
  const rows = rowsCells.length;
  const cells: GridCell[] = new Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const src = rowsCells[r]!;
    for (let c = 0; c < cols; c++) {
      cells[r * cols + c] = src[c] ?? { ch: ' ', fg: null, bg: null };
    }
  }
  return { cols, rows, cells, cellW, cellH, font };
}
