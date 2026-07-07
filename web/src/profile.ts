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

// ---- Canonical profile hash (ADR-0001, Contract B) --------------------------
// The profileHash covers the FULL canonical payload — not coverage alone. Scalar
// stats (sumA/sumAA/gradAA/ink), cell geometry, and font metadata are first-class
// objective truth that decodeProfile trusts and the matcher consumes, so tampering
// with ANY of them must invalidate the hash. `buildCanonicalPayload` is the SINGLE
// byte-layout definition; the exporter (scripts/export-atlas.ts) imports it too so
// the produce and verify sides are provably byte-identical.
//
// Layout (all little-endian). `str s` = u32 utf8-byteLength ++ utf8 bytes;
// `bytes b` = u32 length ++ raw bytes; floats are Float64 (JSON.stringify emits the
// shortest decimal that round-trips to the same f64, so JSON.parse restores the
// exact bits the exporter hashed):
//   header : u32 version, str font.family, f64 font.size, u32 cellW, u32 cellH,
//            f64 ascent
//   glyph  : (in array order) str ch, u32 cp, bytes coverage, f64 sumA, f64 sumAA,
//            f64 gradAA, f64 ink
const canonEnc = new TextEncoder();

function u32Bytes(v: number): Uint8Array {
  const a = new Uint8Array(4);
  new DataView(a.buffer).setUint32(0, v >>> 0, true);
  return a;
}
function f64Bytes(v: number): Uint8Array {
  const a = new Uint8Array(8);
  new DataView(a.buffer).setFloat64(0, v, true);
  return a;
}

export function buildCanonicalPayload(profile: Profile): Uint8Array {
  const chunks: Uint8Array[] = [];
  const pushStr = (s: string) => {
    const b = canonEnc.encode(s);
    chunks.push(u32Bytes(b.length), b);
  };
  const pushBytes = (b: Uint8Array) => {
    chunks.push(u32Bytes(b.length), b);
  };
  chunks.push(u32Bytes(profile.version));
  pushStr(profile.font.family);
  chunks.push(f64Bytes(profile.font.size));
  chunks.push(u32Bytes(profile.cellW), u32Bytes(profile.cellH), f64Bytes(profile.ascent));
  for (const g of profile.glyphs) {
    pushStr(g.ch);
    chunks.push(u32Bytes(g.cp));
    pushBytes(decodeAlphaB64(g.alphaB64));
    chunks.push(f64Bytes(g.sumA), f64Bytes(g.sumAA), f64Bytes(g.gradAA), f64Bytes(g.ink));
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// sha256 of the canonical payload — the value the exporter writes to profileHash.
export function computeProfileHash(profile: Profile): string {
  return sha256Hex(buildCanonicalPayload(profile));
}

// Recompute the profileHash the exporter wrote and throw on mismatch. Verified
// before decode so a tampered/corrupt artifact fails loudly rather than silently
// feeding bad glyph coverage OR bad scalar stats into the matcher.
export async function verifyProfileHash(profile: Profile): Promise<void> {
  const hex = computeProfileHash(profile);
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
