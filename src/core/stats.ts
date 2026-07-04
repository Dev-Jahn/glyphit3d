import type { LinearImage } from './types.js';
import { luma } from './color.js';

// Per-cell target statistics, channel-separated (index c*P + i for channel c,
// pixel i). Cropped from the resampled full image and its full-image gradients
// (DESIGN §3.5 boundary convention: target uses full support, hence gradients
// are taken over the whole image and merely sliced here).
export interface CellStats {
  T: Float32Array;      // 3*P
  dxT: Float32Array;    // 3*P
  dyT: Float32Array;    // 3*P
  ST: Float32Array;     // 3  (ΣT per channel)
  STT: Float32Array;    // 3  (ΣT² per channel)
  minT: Float32Array;   // 3
  maxT: Float32Array;   // 3
  gradTT: Float32Array; // 3  (Σdx²+Σdy² per channel)
  EacLuma: number;      // Σ(Y−Ȳ)², Y = per-pixel linear luma
}

export function cellStats(
  img: LinearImage,
  dx: Float32Array,
  dy: Float32Array,
  cellW: number,
  cellH: number,
  col: number,
  row: number,
): CellStats {
  const P = cellW * cellH;
  const w = img.w;
  const data = img.data;
  const T = new Float32Array(3 * P);
  const dxT = new Float32Array(3 * P);
  const dyT = new Float32Array(3 * P);
  const ST = new Float32Array(3);
  const STT = new Float32Array(3);
  const minT = new Float32Array(3);
  const maxT = new Float32Array(3);
  const gradTT = new Float32Array(3);
  for (let c = 0; c < 3; c++) { minT[c] = Infinity; maxT[c] = -Infinity; }

  const x0 = col * cellW;
  const y0 = row * cellH;
  let sumY = 0;
  let sumYY = 0;
  for (let ly = 0; ly < cellH; ly++) {
    const gy = y0 + ly;
    for (let lx = 0; lx < cellW; lx++) {
      const gx = x0 + lx;
      const gidx = (gy * w + gx) * 3;
      const li = ly * cellW + lx;
      for (let c = 0; c < 3; c++) {
        const v = data[gidx + c]!;
        const gx2 = dx[gidx + c]!;
        const gy2 = dy[gidx + c]!;
        T[c * P + li] = v;
        dxT[c * P + li] = gx2;
        dyT[c * P + li] = gy2;
        ST[c] = ST[c]! + v;
        STT[c] = STT[c]! + v * v;
        if (v < minT[c]!) minT[c] = v;
        if (v > maxT[c]!) maxT[c] = v;
        gradTT[c] = gradTT[c]! + gx2 * gx2 + gy2 * gy2;
      }
      const Y = luma(data[gidx]!, data[gidx + 1]!, data[gidx + 2]!);
      sumY += Y;
      sumYY += Y * Y;
    }
  }
  const EacLuma = sumYY - (sumY * sumY) / P;
  return { T, dxT, dyT, ST, STT, minT, maxT, gradTT, EacLuma };
}
