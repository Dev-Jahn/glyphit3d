// Measurement for feat/contrast-floor-fill (Round A ASCII-identity): invisible-cell counts —
// fitted glyph cells sitting on a near-black bg with a fg/bg separation below a floor (the
// "black hole" regime) — before/after the contrast floor, on the demo scenes. Reconstruction
// cost (chafa gate) is measured separately via `npx tsx bench/chafa-gate.ts --floor <f>`.
//   repro:  npx tsx bench/floor-invisible.ts
import { buildAtlas } from '../src/atlas/atlas.js';
import { resampleArea } from '../src/image/image.js';
import { loadLinear } from '../src/image/image-io.js';
import { matchGrid } from '../src/core/match.js';
import { luma } from '../src/core/color.js';
import { defaultOptions } from '../src/core/options.js';
import type { Atlas, GridCell, LinearImage } from '../src/core/types.js';

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
const COLS = 120;
const IMAGES = ['sphere', 'DamagedHelmet'];
const NEARBLACK = 32;                    // near-black bg = working-space (gamma u8) bg luma < this
const REF_U8 = Math.round(0.06 * 255);   // fixed reference separation the invisibility count uses
const FLOORS = [0, 0.04, 0.06, 0.08, 0.10];

function gridFoot(src: LinearImage, atlas: Atlas): LinearImage {
  const { cellW, cellH } = atlas;
  const rows = Math.round(COLS * (src.h / src.w) * (cellW / cellH));
  return resampleArea(src, COLS * cellW, rows * cellH);
}

// fitted glyph cell (ch≠' ') whose bg is near-black AND whose fg/bg max-channel u8 separation is
// below refU8 — an (almost) invisible glyph over a black hole.
function countInvisible(cells: GridCell[], refU8: number): { n: number; fitted: number } {
  let n = 0, fitted = 0;
  for (const c of cells) {
    if (c.ch === ' ' || !c.fg || !c.bg) continue;
    fitted++;
    if (luma(c.bg[0], c.bg[1], c.bg[2]) >= NEARBLACK) continue;
    const sep = Math.max(Math.abs(c.fg[0] - c.bg[0]), Math.abs(c.fg[1] - c.bg[1]), Math.abs(c.fg[2] - c.bg[2]));
    if (sep < refU8) n++;
  }
  return { n, fitted };
}

async function main(): Promise<void> {
  const atlas = await buildAtlas(FONT, 16, 'blocks');
  for (const name of IMAGES) {
    const src = await loadLinear(new URL(`./images/${name}.png`, import.meta.url).pathname);
    const img = gridFoot(src, atlas);
    console.log(`\n=== ${name} (grid ${COLS}×${Math.round(img.h / atlas.cellH)}, Q3 gamma, blocks) ===`);
    console.log(`invisible = fitted glyph cell, bg luma < ${NEARBLACK}/255, max|F−B| < ${REF_U8}/255 (ref floor 0.06)`);
    console.log(`| floor (luma) | floorU8 | fitted (non-space) | invisible-over-black | space cells |`);
    console.log(`|---|---|---|---|---|`);
    for (const floor of FLOORS) {
      const opts = defaultOptions(3);
      opts.contrastFloor = floor;
      const grid = matchGrid(img, atlas, opts);
      const spaces = grid.cells.filter((c) => c.ch === ' ').length;
      const { n, fitted } = countInvisible(grid.cells, REF_U8);
      console.log(`| ${floor.toFixed(2)} | ${Math.round(floor * 255)} | ${fitted} | ${n} | ${spaces} |`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
