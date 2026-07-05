import { describe, it, expect } from 'vitest';
import * as fontkit from 'fontkit';
import { buildAtlas } from '../src/atlas/atlas.js';
import { matchGrid } from '../src/core/match.js';
import { defaultOptions } from '../src/cli.js';
import { srgbToLinear } from '../src/core/color.js';
import type { LinearImage } from '../src/core/types.js';
import { atlasToProfile } from '../scripts/export-atlas.js';
import { decodeProfile, recomputeGradients, verifyProfileHash } from '../web/src/profile.js';
import { imageDataToLinear } from '../web/src/browser-image.js';

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
const SIZE = 16;

function family(): string {
  const f = fontkit.openSync(FONT) as any;
  return f.familyName as string;
}

// Smooth synthetic linear image: enough intra-cell contrast to pass the gate and
// exercise glyph selection, but low-frequency so each cell has an unambiguous best
// glyph (no near-ties for u8 α quantization to flip — the §5.4 acceptance requires
// identical glyph choices, which only holds away from ties).
function synthImage(w: number, h: number): LinearImage {
  const data = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const b = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) {
        const v = 0.5 + 0.5 * Math.sin(x * 0.05 + c * 2.1) * Math.sin(y * 0.0375 + c * 1.3);
        data[b + c] = v;
      }
    }
  }
  return { w, h, data };
}

describe('profile export/decode round-trip', () => {
  it('α within 1/255, stats within f32, gradient loop faithful', async () => {
    const atlas = await buildAtlas(FONT, SIZE, 'blocks');
    const profile = atlasToProfile(atlas, family(), SIZE);
    const decoded = decodeProfile(profile);

    expect(decoded.glyphs.length).toBe(atlas.glyphs.length);
    expect(decoded.cellW).toBe(atlas.cellW);
    expect(decoded.cellH).toBe(atlas.cellH);
    expect(decoded.ascent).toBe(atlas.ascent);

    const P = atlas.cellW * atlas.cellH;
    let maxAlphaErr = 0;
    let maxGradErr = 0;
    const rel = (a: number, b: number) => Math.abs(a - b) / (1 + Math.abs(b));
    for (let gi = 0; gi < atlas.glyphs.length; gi++) {
      const live = atlas.glyphs[gi]!;
      const dec = decoded.glyphs[gi]!;
      expect(dec.cp).toBe(live.cp);
      expect(dec.ch).toBe(live.ch);

      for (let i = 0; i < P; i++) {
        const e = Math.abs(dec.alpha[i]! - live.alpha[i]!);
        if (e > maxAlphaErr) maxAlphaErr = e;
      }

      // stored scalar stats carry through the profile unchanged (within f32).
      expect(rel(dec.sumA, live.sumA)).toBeLessThan(1e-6);
      expect(rel(dec.sumAA, live.sumAA)).toBeLessThan(1e-6);
      expect(rel(dec.gradAA, live.gradAA)).toBeLessThan(1e-6);
      expect(rel(dec.ink, live.ink)).toBeLessThan(1e-6);

      // the loader's gradient recompute reproduces the atlas convention: feeding
      // the LIVE α through the copied loop must match the atlas's own dxA/dyA.
      const { dxA, dyA } = recomputeGradients(live.alpha, atlas.cellW, atlas.cellH);
      for (let i = 0; i < P; i++) {
        const ex = Math.abs(dxA[i]! - live.dxA[i]!);
        const ey = Math.abs(dyA[i]! - live.dyA[i]!);
        if (ex > maxGradErr) maxGradErr = ex;
        if (ey > maxGradErr) maxGradErr = ey;
      }
    }
    expect(maxAlphaErr).toBeLessThanOrEqual(1 / 255 + 1e-9);
    expect(maxGradErr).toBeLessThanOrEqual(1e-6);
  });

  it('matchGrid on the decoded atlas == on the live atlas (§5.4 consistency)', async () => {
    const atlas = await buildAtlas(FONT, SIZE, 'blocks');
    const decoded = decodeProfile(atlasToProfile(atlas, family(), SIZE));
    const img = synthImage(10 * atlas.cellW, 8 * atlas.cellH);

    const near = (a: [number, number, number] | null, b: [number, number, number] | null) => {
      if (a === null || b === null) {
        expect(a).toBe(b);
        return;
      }
      for (let c = 0; c < 3; c++) expect(Math.abs(a[c]! - b[c]!)).toBeLessThanOrEqual(1);
    };

    for (const q of [2, 3] as const) {
      const opts = defaultOptions(q);
      const gLive = matchGrid(img, atlas, opts);
      const gDec = matchGrid(img, decoded, opts);
      expect(gDec.cols * gDec.rows).toBeGreaterThan(0);
      expect(gDec.cells.length).toBe(gLive.cells.length);
      for (let i = 0; i < gLive.cells.length; i++) {
        expect(gDec.cells[i]!.ch).toBe(gLive.cells[i]!.ch); // same glyph choice
        near(gDec.cells[i]!.fg, gLive.cells[i]!.fg);
        near(gDec.cells[i]!.bg, gLive.cells[i]!.bg);
      }
    }
  });
});

describe('profileHash verification', () => {
  it('accepts the untampered exporter hash', async () => {
    const atlas = await buildAtlas(FONT, SIZE, 'blocks');
    const profile = atlasToProfile(atlas, family(), SIZE);
    await expect(verifyProfileHash(profile)).resolves.toBeUndefined();
  });

  it('rejects a profile whose coverage bytes were tampered', async () => {
    const atlas = await buildAtlas(FONT, SIZE, 'blocks');
    const profile = atlasToProfile(atlas, family(), SIZE);
    // Flip one coverage byte of the first glyph but keep the declared profileHash —
    // a decode that trusts the hash would silently feed corrupt glyph α to the matcher.
    const bytes = Uint8Array.from(atob(profile.glyphs[0]!.alphaB64), (c) => c.charCodeAt(0));
    bytes[0] = bytes[0]! ^ 0xff;
    profile.glyphs[0]!.alphaB64 = Buffer.from(bytes).toString('base64');
    await expect(verifyProfileHash(profile)).rejects.toThrow(/hash mismatch/);
  });
});

describe('imageDataToLinear', () => {
  it('mirrors loadLinear: straight alpha over black in linear space', () => {
    // 2 px: opaque mid-grey, and half-alpha white.
    const data = new Uint8ClampedArray([128, 128, 128, 255, 255, 255, 255, 128]);
    const out = imageDataToLinear({ width: 2, height: 1, data });
    const g = srgbToLinear(128);
    const w = srgbToLinear(255);
    const a = 128 / 255;
    // LinearImage.data is Float32Array, so compare at f32 precision.
    expect(out.data[0]).toBeCloseTo(g, 6);
    expect(out.data[1]).toBeCloseTo(g, 6);
    expect(out.data[2]).toBeCloseTo(g, 6);
    expect(out.data[3]).toBeCloseTo(a * w, 6);
    expect(out.data[4]).toBeCloseTo(a * w, 6);
    expect(out.data[5]).toBeCloseTo(a * w, 6);
  });
});
