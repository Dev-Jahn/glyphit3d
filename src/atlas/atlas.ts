import * as fontkit from 'fontkit';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import type { Atlas, Glyph } from '../core/types.js';
import { CHARSETS } from './charsets.js';

const SS = 4; // supersample factor
// box drawing + block elements legitimately touch cell borders (DESIGN §5.6:
// terminals synthesize these to fill the whole cell), so they bypass the ink-leak drop.
const BORDER_OK_LO = 0x2500;
const BORDER_OK_HI = 0x259f;

const registered = new Set<string>();
function registerFont(fontPath: string): string {
  const family = 'atlas_' + Buffer.from(fontPath).toString('hex');
  if (!registered.has(family)) {
    GlobalFonts.registerFromPath(fontPath, family);
    registered.add(family);
  }
  return family;
}

export async function buildAtlas(
  fontPath: string,
  fontSize: number,
  charset: keyof typeof CHARSETS,
): Promise<Atlas> {
  const font = fontkit.openSync(fontPath) as any;
  const unitsPerEm: number = font.unitsPerEm;
  const monoAdvance: number = font.glyphForCodePoint(0x4d).advanceWidth; // 'M', font units

  // codepoints the font renders in a monospace cell
  const cps = CHARSETS[charset].filter(
    (cp) => font.hasGlyphForCodePoint(cp) && font.glyphForCodePoint(cp).advanceWidth === monoAdvance,
  );

  const family = registerFont(fontPath);

  // cell dimensions from canvas TextMetrics
  const measCanvas = createCanvas(4, 4);
  const measCtx = measCanvas.getContext('2d');
  measCtx.font = `${fontSize}px ${family}`;
  const m = measCtx.measureText('M');
  const cellW = Math.round(m.width);
  const cellH = Math.round(m.fontBoundingBoxAscent + m.fontBoundingBoxDescent);
  const ascent = m.fontBoundingBoxAscent;
  const P = cellW * cellH;

  const advancePx = (monoAdvance / unitsPerEm) * fontSize;
  const xOff = ((cellW - advancePx) / 2) * SS; // center advance box in the cell

  const ssW = cellW * SS;
  const ssH = cellH * SS;
  const rc = createCanvas(ssW, ssH);
  const rctx = rc.getContext('2d');
  rctx.font = `${fontSize * SS}px ${family}`;
  rctx.textBaseline = 'alphabetic';

  type Cand = { ch: string; cp: number; alpha: Float32Array };
  const cands: Cand[] = [];

  for (const cp of cps) {
    const ch = String.fromCodePoint(cp);
    rctx.fillStyle = 'black';
    rctx.fillRect(0, 0, ssW, ssH);
    rctx.fillStyle = 'white';
    rctx.fillText(ch, xOff, ascent * SS);
    const raw = rctx.getImageData(0, 0, ssW, ssH).data;

    // box-average 4x4 R-channel blocks → coverage α
    const alpha = new Float32Array(P);
    const inv = 1 / (SS * SS * 255);
    for (let cy = 0; cy < cellH; cy++) {
      for (let cx = 0; cx < cellW; cx++) {
        let s = 0;
        for (let sy = 0; sy < SS; sy++) {
          const row = (cy * SS + sy) * ssW;
          for (let sx = 0; sx < SS; sx++) {
            s += raw[(row + cx * SS + sx) * 4]!;
          }
        }
        alpha[cy * cellW + cx] = s * inv;
      }
    }
    cands.push({ ch, cp, alpha });
  }

  // ink-leak drop: border α sum > 20% of total, unless box/block (which fill the cell)
  const kept = cands.filter((c) => {
    if (c.cp === 0x20) return true; // space always survives
    if (c.cp >= BORDER_OK_LO && c.cp <= BORDER_OK_HI) return true;
    let total = 0;
    let border = 0;
    for (let y = 0; y < cellH; y++) {
      for (let x = 0; x < cellW; x++) {
        const v = c.alpha[y * cellW + x]!;
        total += v;
        if (x === 0 || x === cellW - 1 || y === 0 || y === cellH - 1) border += v;
      }
    }
    return total === 0 || border <= 0.2 * total;
  });

  // dedup: identical α within max-abs 1/255 → keep first (ascending cp order)
  const eps = 1 / 255;
  const glyphs: Glyph[] = [];
  const inkRaw: number[] = [];
  for (const c of kept) {
    let dup = false;
    for (const g of glyphs) {
      let maxAbs = 0;
      for (let i = 0; i < P; i++) {
        const d = Math.abs(g.alpha[i]! - c.alpha[i]!);
        if (d > maxAbs) maxAbs = d;
        if (maxAbs > eps) break;
      }
      if (maxAbs <= eps) {
        dup = true;
        break;
      }
    }
    if (dup) continue;

    // central-difference gradients, zero-padded at cell borders
    const dxA = new Float32Array(P);
    const dyA = new Float32Array(P);
    let sumA = 0;
    let sumAA = 0;
    let gradAA = 0;
    let ink = 0;
    const a = c.alpha;
    for (let y = 0; y < cellH; y++) {
      for (let x = 0; x < cellW; x++) {
        const i = y * cellW + x;
        const v = a[i]!;
        sumA += v;
        sumAA += v * v;
        let dx = 0;
        let dy = 0;
        if (x > 0 && x < cellW - 1) dx = (a[i + 1]! - a[i - 1]!) / 2;
        if (y > 0 && y < cellH - 1) dy = (a[i + cellW]! - a[i - cellW]!) / 2;
        dxA[i] = dx;
        dyA[i] = dy;
        gradAA += dx * dx + dy * dy;
        ink += Math.abs(dx) + Math.abs(dy);
      }
    }
    glyphs.push({ ch: c.ch, cp: c.cp, alpha: a, dxA, dyA, sumA, sumAA, gradAA, ink });
    inkRaw.push(ink);
  }

  // min-max normalize ink across atlas
  let inkMin = Infinity;
  let inkMax = -Infinity;
  for (const v of inkRaw) {
    if (v < inkMin) inkMin = v;
    if (v > inkMax) inkMax = v;
  }
  const inkSpan = inkMax - inkMin;
  for (const g of glyphs) {
    g.ink = inkSpan > 0 ? (g.ink - inkMin) / inkSpan : 0;
  }

  // space must be glyphs[0]
  const spaceIdx = glyphs.findIndex((g) => g.cp === 0x20);
  if (spaceIdx > 0) {
    const [sp] = glyphs.splice(spaceIdx, 1);
    glyphs.unshift(sp!);
  }

  return { cellW, cellH, P, fontPath, fontSize, ascent, glyphs, inkMin, inkMax };
}
