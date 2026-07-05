import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import * as fontkit from 'fontkit';
import { buildAtlas } from '../src/atlas/atlas.js';
import type { Atlas } from '../src/core/types.js';
import type { Profile, ProfileGlyph } from '../web/src/profile.js';
import type { CHARSETS } from '../src/atlas/charsets.js';

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
const FONT_SIZE = 16;
const PRESETS: (keyof typeof CHARSETS)[] = ['ascii', 'blocks', 'braille', 'full'];

// α [0,1] → u8 coverage bytes. round() keeps the max abs error at ≤ 0.5/255.
function quantizeAlpha(alpha: Float32Array): Uint8Array {
  const out = new Uint8Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) {
    const v = Math.round(alpha[i]! * 255);
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}

// Serialize a live Atlas into the profile artifact. `profileHash` = sha256 over
// the quantized glyph payload (cp + coverage bytes, in atlas order) so it is
// reproducible from the JSON. Exported so test/profile.test.ts drives the exact
// same serialization the export script writes.
export function atlasToProfile(atlas: Atlas, family: string, size: number): Profile {
  const hash = createHash('sha256');
  const cpBuf = Buffer.allocUnsafe(4);
  const glyphs: ProfileGlyph[] = atlas.glyphs.map((g) => {
    const bytes = quantizeAlpha(g.alpha);
    cpBuf.writeUInt32LE(g.cp, 0);
    hash.update(cpBuf);
    hash.update(bytes);
    return {
      ch: g.ch,
      cp: g.cp,
      sumA: g.sumA,
      sumAA: g.sumAA,
      gradAA: g.gradAA,
      ink: g.ink,
      alphaB64: Buffer.from(bytes).toString('base64'),
    };
  });
  return {
    version: 1,
    font: { family, size },
    cellW: atlas.cellW,
    cellH: atlas.cellH,
    ascent: atlas.ascent,
    profileHash: hash.digest('hex'),
    glyphs,
  };
}

async function main(): Promise<void> {
  await mkdir('web/public/profiles', { recursive: true });
  const font = fontkit.openSync(FONT) as any;
  const family: string = font.familyName;

  console.log(`font: ${family} @ ${FONT_SIZE}px`);
  console.log('| preset | glyphs | JSON bytes | gzip bytes |');
  console.log('|---|---|---|---|');
  for (const preset of PRESETS) {
    const atlas = await buildAtlas(FONT, FONT_SIZE, preset);
    const profile = atlasToProfile(atlas, family, FONT_SIZE);
    const json = JSON.stringify(profile);
    const path = `web/public/profiles/dejavu-16-${preset}.json`;
    await writeFile(path, json);
    const gz = gzipSync(Buffer.from(json)).length;
    console.log(
      `| ${preset} | ${profile.glyphs.length} | ${json.length} | ${gz} |`,
    );
  }
}

// Run the export only when invoked directly; importing atlasToProfile (e.g. from
// the round-trip test) must not trigger a write.
const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  main();
}
