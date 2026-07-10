// GPU output-raster kernel (perf/gpu-rasterizer, SPEC §4.1, §5.1). Reproduces
// toRGBA(rasterizeGrid(grid, atlas, space)) for the Q3 GPU-path display raster: one
// invocation per output pixel, blending the two-colour endpoints under the assembled
// Grid's glyph coverage, encoding to sRGB u8, and packing to little-endian RGBA8.
//
// The kernel is a PURE FUNCTION OF THE EXPORTED Grid (endpoints pre-transformed on the
// CPU per fit space in gpu-raster.ts): so the display raster equals the .json/.ans export
// colours, never a second independent encode of the matcher's GPU output (SPEC §4.1).
//
// Numerics (SPEC §4.1, §5.1, RISKS):
//  - Endpoints are pre-transformed on the CPU per space. gamma: u8-as-f32 (0..255); the CPU
//    chain srgbToLinear(clampU8(blend)) → linearToSrgb → round is the IDENTITY on u8
//    (verified 256/256), so NO transfer function runs here in the default space — the encode
//    is just round+clamp of the integer-scale blend. linear: f32(srgbToLinear(u8)), and this
//    kernel applies a verbatim port of src/core/color.ts linearToSrgb.
//  - Rounding is floor(x + 0.5), NEVER WGSL round() (which is round-half-even while JS
//    Math.round is half-toward-+∞; the blend is always ≥ 0 so floor(x+0.5) == Math.round(x)).
//  - Packing is MANUAL: r | (g<<8) | (b<<16) | 0xff000000, matching ImageData's little-endian
//    RGBA byte order. pack4x8unorm is forbidden — its ÷255 pre-scale adds two f32 roundings.
//  - A missing/unknown glyph is the sentinel index 0xffffffff → coverage α ≡ 0 (mirrors
//    rasterizeGrid's `map.get(cell.ch)?.alpha ?? 0`); a null cell additionally has fg=bg=0.

export const RASTER_SENTINEL = 0xffffffff;

// mode uniform encoding (must match gpu-raster.ts spaceToMode).
export const RASTER_MODE_GAMMA = 0;
export const RASTER_MODE_LINEAR = 1;

export const RASTER_WGSL = /* wgsl */ `
struct Params {
  w      : u32,
  h      : u32,
  cols   : u32,
  cellW  : u32,
  cellH  : u32,
  P      : u32,
  mode   : u32,
};

@group(0) @binding(0) var<storage, read>       alpha    : array<f32>;  // G*P, glyph-major coverage
@group(0) @binding(1) var<storage, read>       glyphIdx : array<u32>;  // cells: glyph index or SENTINEL
@group(0) @binding(2) var<storage, read>       fgbg     : array<f32>;  // cells*6: F0 F1 F2 B0 B1 B2 (pre-transformed)
@group(0) @binding(3) var<storage, read_write> outPix   : array<u32>;  // w*h packed RGBA8
@group(0) @binding(4) var<uniform>             params   : Params;

const SENTINEL : u32 = 0xffffffffu;
const MODE_GAMMA : u32 = 0u;

// Verbatim port of src/core/color.ts linearToSrgb: clamp to [0,1], 12.92 linear segment,
// else 1.055·pow(c,1/2.4) − 0.055, scaled to [0,255]. WGSL pow accuracy is implementation-
// defined (SPEC §5.1: linear-mode |Δ| ≤ 1 only).
fn linearToSrgb(f : f32) -> f32 {
  let c = select(select(f, 1.0, f >= 1.0), 0.0, f <= 0.0);
  let s = select(1.055 * pow(c, 1.0 / 2.4) - 0.055, c * 12.92, c <= 0.0031308);
  return s * 255.0;
}

// JS Math.round for x ≥ 0, then clamp to the u8 range (mirrors clampU8 / Uint8ClampedArray).
fn encodeU8(t : f32) -> u32 {
  return u32(clamp(floor(t + 0.5), 0.0, 255.0));
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let x = gid.x;
  let y = gid.y;
  if (x >= params.w || y >= params.h) { return; }

  let col  = x / params.cellW;
  let row  = y / params.cellH;
  let cell = row * params.cols + col;
  let gi   = glyphIdx[cell];

  var a : f32 = 0.0;
  if (gi != SENTINEL) {
    let li = (y % params.cellH) * params.cellW + (x % params.cellW);
    a = alpha[gi * params.P + li];
  }
  let ia = 1.0 - a;

  let o  = cell * 6u;
  let fr = fgbg[o];      let fg = fgbg[o + 1u]; let fb = fgbg[o + 2u];
  let br = fgbg[o + 3u]; let bg = fgbg[o + 4u]; let bb = fgbg[o + 5u];

  var tr = a * fr + ia * br;
  var tg = a * fg + ia * bg;
  var tb = a * fb + ia * bb;

  if (params.mode != MODE_GAMMA) {
    tr = linearToSrgb(tr);
    tg = linearToSrgb(tg);
    tb = linearToSrgb(tb);
  }

  let ur = encodeU8(tr);
  let ug = encodeU8(tg);
  let ub = encodeU8(tb);

  outPix[y * params.w + x] = ur | (ug << 8u) | (ub << 16u) | 0xff000000u;
}
`;
