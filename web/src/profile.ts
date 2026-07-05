import type { Atlas, Glyph } from '../../src/core/types.js';
import { sha256Hex } from './sha256.js';

// Serialized font profile (M2-SPEC §1, DESIGN §5.4). `alphaB64` is base64 of
// Uint8Array(round(α·255)); u8 quantization is fine because atlas α already comes
// from 4× supersampling. Per-glyph gradients are NOT stored — they are recomputed
// from the decoded α by the loader (same convention as src/atlas/atlas.ts).
export interface ProfileGlyph {
  ch: string;
  cp: number;
  sumA: number;
  sumAA: number;
  gradAA: number;
  ink: number;
  alphaB64: string;
}

export interface Profile {
  version: 1;
  font: { family: string; size: number };
  cellW: number;
  cellH: number;
  ascent: number;
  profileHash: string;
  glyphs: ProfileGlyph[];
}

// base64 → Uint8Array. atob is available in browser, worker and node globals.
function decodeAlphaB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const n = bin.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Central-difference gradients of α over a cell, divided by 2, zero-padded at the
// cell borders. Copied verbatim (convention-for-convention) from src/atlas/atlas.ts
// — do NOT import the node atlas builder into browser code.
export function recomputeGradients(
  alpha: Float32Array,
  cellW: number,
  cellH: number,
): { dxA: Float32Array; dyA: Float32Array } {
  const P = cellW * cellH;
  const dxA = new Float32Array(P);
  const dyA = new Float32Array(P);
  for (let y = 0; y < cellH; y++) {
    for (let x = 0; x < cellW; x++) {
      const i = y * cellW + x;
      let dx = 0;
      let dy = 0;
      if (x > 0 && x < cellW - 1) dx = (alpha[i + 1]! - alpha[i - 1]!) / 2;
      if (y > 0 && y < cellH - 1) dy = (alpha[i + cellW]! - alpha[i - cellW]!) / 2;
      dxA[i] = dx;
      dyA[i] = dy;
    }
  }
  return { dxA, dyA };
}

// Decode a profile into the exact `Atlas` shape `matchGrid`/`rampGrid` consume.
// α is reconstructed from the quantized bytes; dxA/dyA are recomputed; the scalar
// stats (sumA/sumAA/gradAA/ink) are carried through from the profile. `fontPath`
// is set to the CSS family name (that is what `grid.font` becomes in the browser).
export function decodeProfile(profile: Profile): Atlas {
  const { cellW, cellH } = profile;
  const P = cellW * cellH;
  const glyphs: Glyph[] = profile.glyphs.map((pg) => {
    const bytes = decodeAlphaB64(pg.alphaB64);
    if (bytes.length !== P) {
      throw new Error(`glyph ${pg.cp} alpha length ${bytes.length} != P ${P}`);
    }
    const alpha = new Float32Array(P);
    for (let i = 0; i < P; i++) alpha[i] = bytes[i]! / 255;
    const { dxA, dyA } = recomputeGradients(alpha, cellW, cellH);
    return {
      ch: pg.ch,
      cp: pg.cp,
      alpha,
      dxA,
      dyA,
      sumA: pg.sumA,
      sumAA: pg.sumAA,
      gradAA: pg.gradAA,
      ink: pg.ink,
    };
  });
  return {
    cellW,
    cellH,
    P,
    fontPath: profile.font.family,
    fontSize: profile.font.size,
    ascent: profile.ascent,
    glyphs,
    // The profile carries per-glyph NORMALIZED ink only, not the raw-ink scale, so the
    // family MDL basis cannot be reconstructed here. The web pipeline never requests
    // families, so these are inert placeholders; if families are ever enabled in the
    // browser, the profile artifact must additionally serialize inkMin/inkMax.
    inkMin: 0,
    inkMax: 1,
  };
}

// Recompute the profileHash the exporter wrote and throw on mismatch. The exporter
// (scripts/export-atlas.ts atlasToProfile) hashes, in atlas/glyph order, each glyph's
// cp as UInt32LE followed by its u8 coverage bytes (the same bytes base64'd into
// alphaB64). Recomputing here over the decoded bytes proves the artifact is intact.
export async function verifyProfileHash(profile: Profile): Promise<void> {
  const covers = profile.glyphs.map((g) => decodeAlphaB64(g.alphaB64));
  const total = covers.reduce((s, c) => s + 4 + c.length, 0);
  const payload = new Uint8Array(total);
  const view = new DataView(payload.buffer);
  let off = 0;
  for (let i = 0; i < profile.glyphs.length; i++) {
    view.setUint32(off, profile.glyphs[i]!.cp, true); // little-endian, matches writeUInt32LE
    off += 4;
    payload.set(covers[i]!, off);
    off += covers[i]!.length;
  }
  const hex = sha256Hex(payload);
  if (hex !== profile.profileHash) {
    throw new Error(`profile hash mismatch: computed ${hex} != declared ${profile.profileHash}`);
  }
}

// Fetch + decode a profile artifact. Works in the worker (self.fetch). The hash is
// verified before decode so a tampered/corrupt artifact fails loudly rather than
// silently feeding bad glyph coverage into the matcher.
export async function loadProfile(url: string): Promise<Atlas> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`profile fetch ${url} failed: ${res.status}`);
  const profile = (await res.json()) as Profile;
  await verifyProfileHash(profile);
  return decodeProfile(profile);
}
