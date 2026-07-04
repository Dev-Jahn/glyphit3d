import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';

// Reproducibly fetch the Khronos zoo screenshot renders (DESIGN §10) into
// bench/images/ (gitignored). The 3 smooth synthetic renders are the LEAST favorable
// domain for the continuous-coverage thesis; these real screenshot renders round out
// the bench set. Node's built-in fetch (Node 24) — no npm deps.
//
// Fixed model list — do NOT swap models based on results. Each model dir in
// KhronosGroup/glTF-Sample-Assets carries screenshot/screenshot.{png,jpg}; we try png
// then jpg and re-encode to PNG so the bench's `<name>.png` convention holds.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'bench', 'images');
const BASE = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models';
const MODELS = ['DamagedHelmet', 'FlightHelmet', 'BoomBox'];
const EXTS = ['png', 'jpg'];

async function fetchScreenshot(model: string): Promise<Buffer> {
  for (const ext of EXTS) {
    const url = `${BASE}/${model}/screenshot/screenshot.${ext}`;
    const res = await fetch(url);
    if (res.ok) {
      console.log(`  ${model}: ${url}`);
      return Buffer.from(await res.arrayBuffer());
    }
  }
  throw new Error(`no screenshot.{${EXTS.join(',')}} found for ${model}`);
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  for (const model of MODELS) {
    const buf = await fetchScreenshot(model);
    const img = await loadImage(buf);
    const canvas = createCanvas(img.width, img.height);
    canvas.getContext('2d').drawImage(img, 0, 0);
    const dest = join(OUT, `${model}.png`);
    await writeFile(dest, await canvas.encode('png'));
    console.log(`  -> ${dest} (${img.width}x${img.height})`);
  }
  console.log(`done: ${MODELS.length} Khronos screenshots in bench/images/`);
}

main().catch((e) => { console.error(e); process.exit(1); });
