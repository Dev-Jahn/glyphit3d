import type { Grid, Atlas, Glyph, LinearImage } from '../core/types.js';
import { srgbToLinear } from '../core/color.js';

// Node-only PNG IO (savePng) lives in ./raster-io.ts so this module stays pure —
// rasterizeGrid is imported by the browser worker.

// null fg/bg → black [0,0,0] linear (the fixedBg convention at M0).
function toLinear(c: [number, number, number] | null): [number, number, number] {
  if (!c) return [0, 0, 0];
  return [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])];
}

// null fg/bg → sRGB u8 black [0,0,0].
function toU8(c: [number, number, number] | null): [number, number, number] {
  return c ?? [0, 0, 0];
}

function clampU8(v: number): number {
  const r = Math.round(v);
  return r < 0 ? 0 : r > 255 ? 255 : r;
}

// feat/temporal-animation (DESIGN §4.9, SPEC §3.4). Partial-raster driver: the same dirty set the
// temporal change-detector produces drives an incremental re-composite. `prev` is the retained
// buffer (the previous frame's raster, w·h·3 floats); `indices` are the raster-dirty cell indices
// (a cell whose emitted ch/fg/bg triple changed — ⊆ the stat-changed set). Cells NOT in `indices`
// keep their previous pixels verbatim, so the incremental result equals a full raster whenever
// `indices` covers exactly the cells that changed vs the grid `prev` was baked from.
export interface RasterDirty { indices: Iterable<number>; prev: LinearImage }

// Composite ONE cell (index i) into `data` (w·h·3), fully overwriting its cellW·cellH pixel rect.
// A null cell zeros the rect (matches the full raster, which leaves null-cell pixels at the
// Float32Array 0 default); a present cell with an unknown ch has α ≡ 0 → the rect is its bg. The
// arithmetic is the SINGLE source shared by the full and partial paths, so partial output cannot
// drift from full output.
function writeCell(
  data: Float32Array, w: number, cellW: number, cellH: number, cols: number,
  grid: Grid, glyphMap: Map<string, Glyph>, mode: 'linear' | 'gamma', i: number,
): void {
  const r = (i / cols) | 0;
  const c = i - r * cols;
  const cell = grid.cells[i];
  if (!cell) {
    for (let py = 0; py < cellH; py++) {
      for (let px = 0; px < cellW; px++) {
        const idx = ((r * cellH + py) * w + (c * cellW + px)) * 3;
        data[idx] = 0; data[idx + 1] = 0; data[idx + 2] = 0;
      }
    }
    return;
  }
  const alpha = glyphMap.get(cell.ch)?.alpha;
  if (mode === 'gamma') {
    const [fr, fg, fb] = toU8(cell.fg);
    const [br, bg, bb] = toU8(cell.bg);
    for (let py = 0; py < cellH; py++) {
      for (let px = 0; px < cellW; px++) {
        const a = alpha ? alpha[py * cellW + px]! : 0;
        const ia = 1 - a;
        const idx = ((r * cellH + py) * w + (c * cellW + px)) * 3;
        data[idx] = srgbToLinear(clampU8(a * fr + ia * br));
        data[idx + 1] = srgbToLinear(clampU8(a * fg + ia * bg));
        data[idx + 2] = srgbToLinear(clampU8(a * fb + ia * bb));
      }
    }
    return;
  }
  const [fr, fg, fb] = toLinear(cell.fg);
  const [br, bg, bb] = toLinear(cell.bg);
  for (let py = 0; py < cellH; py++) {
    for (let px = 0; px < cellW; px++) {
      const a = alpha ? alpha[py * cellW + px]! : 0;
      const ia = 1 - a;
      const idx = ((r * cellH + py) * w + (c * cellW + px)) * 3;
      data[idx] = a * fr + ia * br;
      data[idx + 1] = a * fg + ia * bg;
      data[idx + 2] = a * fb + ia * bb;
    }
  }
}

// Bake a grid to a LinearImage container. `mode`:
//  - 'linear' (default, DESIGN §10 golden metric): pred = α·F + (1−α)·B composited
//    in linear light (colors decoded sRGB→linear first).
//  - 'gamma' (predict-terminal, §3.1): composite in the ENCODED sRGB space the way a
//    terminal blends glyph AA, quantize to the 8-bit framebuffer, then decode back to
//    linear so the container stays consistent (ssim() encodes internally — no double-encode).
//
// `dirty` (feat/temporal-animation, SPEC §3.4) is OPTIONAL and DEFAULT-ABSENT. When absent the
// function is byte-identical to before: a fresh w·h·3 buffer, every cell composited (null cells
// left at 0). When present it re-composites ONLY `dirty.indices` in-place over the retained buffer
// `dirty.prev.data` (which must already match the w·h footprint) and returns a container over that
// same buffer — the incremental update the temporal path uses to avoid re-rasterizing the whole
// grid. A prev whose footprint no longer matches is a stale-retained-buffer bug (a config change
// must keyframe the temporal state), so it throws rather than silently paint garbage.
export function rasterizeGrid(
  grid: Grid, atlas: Atlas, mode: 'linear' | 'gamma' = 'linear', dirty?: RasterDirty,
): LinearImage {
  const cellW = atlas.cellW;
  const cellH = atlas.cellH;
  const w = grid.cols * cellW;
  const h = grid.rows * cellH;
  const cols = grid.cols;

  const map = new Map<string, Glyph>();
  for (const g of atlas.glyphs) map.set(g.ch, g);

  if (dirty) {
    if (dirty.prev.w !== w || dirty.prev.h !== h || dirty.prev.data.length !== w * h * 3) {
      throw new Error(`rasterizeGrid: retained buffer ${dirty.prev.w}x${dirty.prev.h} does not match grid footprint ${w}x${h} (keyframe the temporal state on a footprint change)`);
    }
    const data = dirty.prev.data; // re-composite dirty cells in place over the retained buffer
    const numCells = cols * grid.rows;
    for (const i of dirty.indices) {
      if (i < 0 || i >= numCells) throw new Error(`rasterizeGrid: dirty index ${i} out of range [0, ${numCells})`);
      writeCell(data, w, cellW, cellH, cols, grid, map, mode, i);
    }
    return { w, h, data };
  }

  const data = new Float32Array(w * h * 3);
  const numCells = cols * grid.rows;
  for (let i = 0; i < numCells; i++) writeCell(data, w, cellW, cellH, cols, grid, map, mode, i);
  return { w, h, data };
}
