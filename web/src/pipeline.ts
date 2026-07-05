import type { Atlas, Grid } from '../../src/core/types.js';
import { gridRows } from '../../src/core/options.js';
import { imageDataToLinear } from './browser-image.js';
import type { Scene } from './scene.js';
import type { MatchRequest, MatchResult, SetAtlasRequest, Timings } from './worker.js';

// 3D scenes have no intrinsic pixel aspect; render a near-square footprint and let
// the matcher pick rows from it (gridRows corrects for the non-square glyph cell).
const SCENE_ASPECT = 1;

export interface PipelineParams {
  cols: number;
  quality: 0 | 1 | 2 | 3 | 4;
  space: 'linear' | 'gamma';
  charset: string;
}

export interface PipelineOutput {
  grid: Grid;
  raster: { w: number; h: number; data: Uint8ClampedArray };
  ssim: number;
  timings: Timings & { render: number };
}

export class Pipeline {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, (r: MatchResult) => void>();

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<MatchResult>) => {
      const r = e.data;
      const resolve = this.pending.get(r.id);
      if (resolve) { this.pending.delete(r.id); resolve(r); }
    };
  }

  setAtlas(charset: string, atlas: Atlas): void {
    this.worker.postMessage({ type: 'setAtlas', charset, atlas } satisfies SetAtlasRequest);
  }

  // Render the scene to the grid footprint, linearize, and run the worker match.
  async run(scene: Scene, atlas: Atlas, params: PipelineParams): Promise<PipelineOutput> {
    const gridW = params.cols * atlas.cellW;
    const rows = gridRows(params.cols, SCENE_ASPECT, 1, atlas.cellW, atlas.cellH);
    const gridH = rows * atlas.cellH;

    const tR = performance.now();
    const imgData = scene.renderToImageData(gridW, gridH);
    const render = performance.now() - tR;

    const lin = imageDataToLinear(imgData);
    const id = this.nextId++;
    const req: MatchRequest = {
      type: 'match', id, charset: params.charset,
      img: { w: lin.w, h: lin.h, data: lin.data },
      cols: params.cols, quality: params.quality, space: params.space,
    };
    const result = await new Promise<MatchResult>((resolve) => {
      this.pending.set(id, resolve);
      this.worker.postMessage(req, [lin.data.buffer]);
    });
    return {
      grid: result.grid,
      raster: result.raster,
      ssim: result.ssim,
      timings: { render, ...result.timings },
    };
  }
}
