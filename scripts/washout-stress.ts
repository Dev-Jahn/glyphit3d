import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LinearImage } from '../src/core/types.js';
import { srgbToLinear } from '../src/core/color.js';
import { savePng } from '../src/render/raster-io.js';

// M3-SPEC §1.1 — the washout stress image. A washout-prone frame is one that is
// almost everywhere near-flat: large smooth gradients (so per-cell AC energy is tiny)
// with a low-amplitude per-pixel noise floor (σ ≈ 1.5/255 in gamma). Such cells sit in
// the band E_AC/(3P) ∈ [~noise², 2e-4) — below the OLD gate (τ=2e-4, forced space) but
// scanned by the NEW gate (τ=2e-5). It is the adversarial case for the MDL washout
// defense: if λ_mdl is too weak, the scan will paint faint (invisible-ink) glyphs into
// these flat cells. The generator is deterministic (seeded) so the sweep is reproducible.
const N = 512;

// mulberry32 — small deterministic PRNG (uniform in [0,1)).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Box–Muller standard normal from a uniform source.
function gauss(rnd: () => number): number {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }

// Smooth low-frequency gamma field per channel: a bilinear diagonal ramp plus one gentle
// sinusoid, kept low-frequency so within any 10×19 cell the deterministic variation is
// far below the noise floor — the cells are washout-prone by construction.
function baseGamma(x: number, y: number, ch: number): number {
  const u = x / (N - 1), w = y / (N - 1);
  // per-channel diagonal ramps over [0.12, 0.62] with channel-dependent orientation so
  // there is mild chroma structure (not pure grayscale), still smooth.
  const ramp = ch === 0 ? 0.5 * u + 0.5 * w
             : ch === 1 ? 0.5 * (1 - u) + 0.5 * w
             :            0.5 * u + 0.5 * (1 - w);
  const sinusoid = 0.06 * Math.sin(2 * Math.PI * (u * 1.5 + w * 1.0) + ch);
  return clamp01(0.12 + 0.50 * ramp + sinusoid);
}

function washoutImage(): LinearImage {
  const data = new Float32Array(N * N * 3);
  const rnd = mulberry32(0x5eed);
  const sigma = 1.5 / 255; // gamma-space per-pixel noise floor (§1.1)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const p = (y * N + x) * 3;
      for (let ch = 0; ch < 3; ch++) {
        const g = clamp01(baseGamma(x, y, ch) + sigma * gauss(rnd)); // gamma value [0,1]
        // savePng encodes linear→sRGB, so pre-image the intended gamma value through the
        // exact sRGB inverse (quantized to u8, the transport precision) → round-trips.
        data[p + ch] = srgbToLinear(Math.round(g * 255));
      }
    }
  }
  return { w: N, h: N, data };
}

async function main(): Promise<void> {
  const dir = 'bench/images';
  await mkdir(dir, { recursive: true });
  const out = join(dir, 'washout-stress.png');
  await savePng(washoutImage(), out);
  console.log(`wrote ${out} (${N}x${N}; smooth gamma field + σ=1.5/255 noise, seed 0x5eed)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
