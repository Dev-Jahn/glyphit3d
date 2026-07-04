import { describe, it, expect, beforeAll } from 'vitest';
import { buildAtlas } from '../src/atlas/atlas.js';
import { CHARSETS } from '../src/atlas/charsets.js';
import type { Atlas, Glyph } from '../src/core/types.js';

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
const SIZE = 16;

function findGlyph(atlas: Atlas, cp: number): Glyph | undefined {
  return atlas.glyphs.find((g) => g.cp === cp);
}

describe('charsets', () => {
  it('ascii is 0x20..0x7E', () => {
    expect(CHARSETS.ascii[0]).toBe(0x20);
    expect(CHARSETS.ascii[CHARSETS.ascii.length - 1]).toBe(0x7e);
    expect(CHARSETS.ascii.length).toBe(0x7e - 0x20 + 1);
  });
  it('nests ascii ⊂ blocks ⊂ braille ⊂ full', () => {
    const set = (a: number[]) => new Set(a);
    const asc = set(CHARSETS.ascii);
    const blk = set(CHARSETS.blocks);
    const brl = set(CHARSETS.braille);
    const full = set(CHARSETS.full);
    for (const cp of asc) expect(blk.has(cp)).toBe(true);
    for (const cp of blk) expect(brl.has(cp)).toBe(true);
    for (const cp of brl) expect(full.has(cp)).toBe(true);
    expect(brl.has(0x2588)).toBe(true); // full block in braille+
    expect(full.has(0xe9)).toBe(true); // é in full
  });
});

describe('buildAtlas (DejaVu Sans Mono)', () => {
  let ascii: Atlas;
  let blocks: Atlas;

  beforeAll(async () => {
    ascii = await buildAtlas(FONT, SIZE, 'ascii');
    blocks = await buildAtlas(FONT, SIZE, 'blocks');
  });

  it('ascii atlas has >= 90 glyphs', () => {
    expect(ascii.glyphs.length).toBeGreaterThanOrEqual(90);
  });

  it('space is glyphs[0] with sumA ~ 0', () => {
    expect(ascii.glyphs[0]!.cp).toBe(0x20);
    expect(ascii.glyphs[0]!.ch).toBe(' ');
    expect(ascii.glyphs[0]!.sumA).toBeLessThan(1e-3);
    expect(blocks.glyphs[0]!.cp).toBe(0x20);
  });

  it('cell geometry is sane', () => {
    expect(ascii.cellW).toBeGreaterThan(0);
    expect(ascii.cellH).toBeGreaterThan(0);
    expect(ascii.P).toBe(ascii.cellW * ascii.cellH);
    expect(ascii.ascent).toBeGreaterThan(0);
    expect(ascii.fontPath).toBe(FONT);
    expect(ascii.fontSize).toBe(SIZE);
  });

  it('full block U+2588 mean alpha >= 0.9', () => {
    const g = findGlyph(blocks, 0x2588);
    expect(g).toBeDefined();
    const mean = g!.sumA / blocks.P;
    expect(mean).toBeGreaterThanOrEqual(0.9);
  });

  it('upper-half block U+2580: top mean >= 0.85, bottom mean <= 0.1', () => {
    const g = findGlyph(blocks, 0x2580);
    expect(g).toBeDefined();
    const { cellW, cellH } = blocks;
    const half = Math.floor(cellH / 2);
    let top = 0;
    let bot = 0;
    for (let y = 0; y < cellH; y++) {
      for (let x = 0; x < cellW; x++) {
        const v = g!.alpha[y * cellW + x]!;
        if (y < half) top += v;
        else bot += v;
      }
    }
    const topMean = top / (half * cellW);
    const botMean = bot / ((cellH - half) * cellW);
    expect(topMean).toBeGreaterThanOrEqual(0.85);
    expect(botMean).toBeLessThanOrEqual(0.1);
  });

  it('no NaN/Inf anywhere and ink normalized to [0,1]', () => {
    for (const atlas of [ascii, blocks]) {
      for (const g of atlas.glyphs) {
        const check = (v: number) => expect(Number.isFinite(v)).toBe(true);
        check(g.sumA);
        check(g.sumAA);
        check(g.gradAA);
        check(g.ink);
        expect(g.ink).toBeGreaterThanOrEqual(0);
        expect(g.ink).toBeLessThanOrEqual(1);
        for (let i = 0; i < atlas.P; i++) {
          check(g.alpha[i]!);
          check(g.dxA[i]!);
          check(g.dyA[i]!);
          expect(g.alpha[i]!).toBeGreaterThanOrEqual(0);
          expect(g.alpha[i]!).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('sumAA and gradAA match alpha/gradient buffers', () => {
    const g = findGlyph(blocks, 0x2588)!;
    let sumAA = 0;
    let gradAA = 0;
    for (let i = 0; i < blocks.P; i++) {
      sumAA += g.alpha[i]! * g.alpha[i]!;
      gradAA += g.dxA[i]! * g.dxA[i]! + g.dyA[i]! * g.dyA[i]!;
    }
    expect(sumAA).toBeCloseTo(g.sumAA, 4);
    expect(gradAA).toBeCloseTo(g.gradAA, 4);
  });

  it('glyphs are deduplicated (no identical alpha within 1/255)', () => {
    const gs = ascii.glyphs;
    const eps = 1 / 255;
    for (let i = 0; i < gs.length; i++) {
      for (let j = i + 1; j < gs.length; j++) {
        let maxAbs = 0;
        for (let k = 0; k < ascii.P; k++) {
          const d = Math.abs(gs[i]!.alpha[k]! - gs[j]!.alpha[k]!);
          if (d > maxAbs) maxAbs = d;
        }
        expect(maxAbs).toBeGreaterThan(eps);
      }
    }
  });
});
