export interface LinearImage { w: number; h: number; data: Float32Array } // w*h*3, linear RGB, row-major

export interface FitStatsG { Saa: number; Sa1: number; S11: number } // glyph-side Gram entries (generalized)

export interface Glyph {
  ch: string; cp: number;
  alpha: Float32Array;                    // P = cellW*cellH, coverage [0,1]
  dxA: Float32Array; dyA: Float32Array;   // central-difference gradients of alpha, zero-padded at cell borders
  sumA: number;                            // Σα
  sumAA: number;                           // Σα²
  gradAA: number;                          // Σ(dxA²) + Σ(dyA²)
  ink: number;                             // Σ(|dxA|+|dyA|), then min-max normalized to [0,1] across atlas
}

export interface Atlas {
  cellW: number; cellH: number; P: number;
  fontPath: string; fontSize: number; ascent: number; // px at fontSize, from canvas TextMetrics
  glyphs: Glyph[];                          // glyphs[0] MUST be space (ch=' ')
}

export interface GridCell { ch: string; fg: [number, number, number] | null; bg: [number, number, number] | null } // sRGB 0..255 ints
export interface Grid { cols: number; rows: number; cells: GridCell[]; cellW: number; cellH: number; font: string }

export type ColorMode = 'mono' | 'fg' | 'fg-bg'
export interface MatchOptions {
  quality: 0 | 1 | 2 | 3 | 4;   // Q0..Q4 (DESIGN §6). quality implies colorMode: Q1=mono, Q2=fg, Q3/Q4=fg-bg
  space?: 'linear' | 'gamma';  // working space for fit/selection (DESIGN §3.1). default 'gamma' (predict-terminal); 'linear' = bake (opt-in)
  edgeLambda: number;          // λ_e, only used at Q4. default 0.35
  gateTau: number;             // contrast gate threshold on E_AC per pixel (linear luma). default 2e-4
  mdlLambda: number;           // ink complexity penalty weight. default 0.02
  fixedBg: [number, number, number]; // linear RGB, for mono/fg modes and Q0. default [0,0,0]
  fixedFg: [number, number, number]; // linear RGB, for mono mode. default [1,1,1]
}
