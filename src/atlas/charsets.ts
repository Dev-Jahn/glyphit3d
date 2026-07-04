// Codepoint sets for atlas construction (DESIGN §5.1). Arrays are ascending so
// dedup keeps the lowest codepoint. buildAtlas filters these to what the font
// actually renders in a monospace cell.

function range(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let cp = lo; cp <= hi; cp++) out.push(cp);
  return out;
}

const ASCII = range(0x20, 0x7e);

// box drawing + block elements (incl. shades)
const BOX = range(0x2500, 0x257f);
const BLOCK = range(0x2580, 0x259f);

// ~20 geometric shapes with reliable monospace coverage
const GEOMETRIC = [
  0x25a0, 0x25a1, 0x25aa, 0x25ab, 0x25b2, 0x25b3, 0x25b6, 0x25b7, 0x25ba,
  0x25bc, 0x25bd, 0x25c0, 0x25c1, 0x25c4, 0x25c6, 0x25c7, 0x25c9, 0x25cb,
  0x25ce, 0x25cf,
];

const BRAILLE = range(0x2800, 0x28ff);

const LATIN1 = range(0xa1, 0xff);

const blocks = [...ASCII, ...BOX, ...BLOCK, ...GEOMETRIC];
const braille = [...blocks, ...BRAILLE];
const full = [...braille, ...LATIN1];

export const CHARSETS: Record<'ascii' | 'blocks' | 'braille' | 'full', number[]> = {
  ascii: ASCII,
  blocks,
  braille,
  full,
};
