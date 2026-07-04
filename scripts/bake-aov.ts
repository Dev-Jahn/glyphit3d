import { parseArgs } from 'node:util';
import { createServer, type Server } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
import { chromium } from 'playwright';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { buildAtlas } from '../src/atlas/atlas.js';

// M1 RENDERER driver. Serves node_modules + render3d + the model dir over a tiny
// http server, drives Playwright/SwiftShader to run render3d/page.ts's bake(),
// writes the five AOV PNGs + meta.json (M1-SPEC §1/§2).

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
const CHROME_ARGS = [
  '--use-angle=swiftshader',
  '--use-gl=angle',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--disable-gpu-sandbox',
];

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ktx2': 'image/ktx2', '.svg': 'image/svg+xml',
};

function startServer(modelDir: string): Promise<{ server: Server; port: number }> {
  const server = createServer(async (req, res) => {
    try {
      const url = decodeURIComponent((req.url || '/').split('?')[0]!);
      let filePath: string;
      if (url.startsWith('/model/')) filePath = join(modelDir, url.slice('/model/'.length));
      else filePath = join(ROOT, url);
      // path-escape guard
      const base = url.startsWith('/model/') ? modelDir : ROOT;
      if (!resolve(filePath).startsWith(resolve(base))) { res.writeHead(403).end(); return; }

      if (filePath.endsWith('.ts')) {
        const src = await readFile(filePath, 'utf8');
        const out = await transform(src, { loader: 'ts', format: 'esm' });
        res.writeHead(200, { 'content-type': 'text/javascript' }).end(out.code);
        return;
      }
      const buf = await readFile(filePath);
      res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' }).end(buf);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((res) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as import('node:net').AddressInfo).port;
      res({ server, port });
    });
  });
}

function dataUrlToBuffer(dataUrl: string): Buffer {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

async function pngStats(buf: Buffer): Promise<{ w: number; h: number; data: Uint8ClampedArray }> {
  const img = await loadImage(buf);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, img.width, img.height).data;
  return { w: img.width, h: img.height, data: d };
}

async function withPage<T>(port: number, fn: (page: import('playwright').Page) => Promise<T>): Promise<T> {
  const browser = await chromium.launch({ headless: true, args: CHROME_ARGS });
  try {
    const page = await browser.newPage();
    const errs: string[] = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    await page.goto(`http://127.0.0.1:${port}/render3d/page.html`, { waitUntil: 'load' });
    await page.waitForFunction('window.__ready === true', null, { timeout: 30000 });
    try {
      return await fn(page);
    } catch (e) {
      throw new Error(`${e}\npage errors:\n${errs.join('\n')}`);
    }
  } finally {
    await browser.close();
  }
}

async function runSmoke(): Promise<void> {
  const { server, port } = await startServer(ROOT);
  try {
    const dataUrl = await withPage(port, async (page) => page.evaluate('window.smoke()') as Promise<string>);
    const { w, h, data } = await pngStats(dataUrlToBuffer(dataUrl));
    // background is #05070a; count pixels meaningfully brighter than bg
    let nonBg = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i]! > 30 || data[i + 1]! > 30 || data[i + 2]! > 30) nonBg++;
    }
    const frac = nonBg / (w * h);
    console.log(`smoke: ${w}x${h}, non-background = ${(frac * 100).toFixed(2)}%`);
    if (frac <= 0.05) throw new Error(`SMOKE FAIL: only ${(frac * 100).toFixed(2)}% non-bg (<=5%). SwiftShader/three render is broken.`);
    console.log('smoke: PASS (SwiftShader WebGL2 + three.js render verified)');
  } finally {
    server.close();
  }
}

interface Meta {
  model: string; cols: number; rows: number; cellW: number; cellH: number;
  gridW: number; gridH: number; camera: { yaw: number; pitch: number; dist: number }; threeVersion: string;
}

async function runBake(model: string, cols: number, outDir: string | undefined): Promise<void> {
  const modelPath = resolve(model);
  if (!existsSync(modelPath)) throw new Error(`model not found: ${modelPath}`);
  const name = basename(model).replace(/\.(gltf|glb)$/i, '');
  const out = outDir ? resolve(outDir) : join(ROOT, 'bench', 'aov', name);
  await mkdir(out, { recursive: true });

  const atlas = await buildAtlas(FONT, 16, 'ascii');
  const { cellW, cellH } = atlas;
  const rows = Math.max(1, Math.round((cols * cellW) / cellH)); // ~square pixel canvas
  const gridW = cols * cellW;
  const gridH = rows * cellH;
  const threeVersion = JSON.parse(await readFile(join(ROOT, 'node_modules/three/package.json'), 'utf8')).version;

  const { server, port } = await startServer(dirname(modelPath));
  try {
    const result = await withPage(port, async (page) => {
      return page.evaluate(
        (args) => (globalThis as any).bake(args.url, args.opts),
        { url: `/model/${basename(modelPath)}`, opts: { cols, rows, cellW, cellH } },
      ) as Promise<{ shaded: string; shading: string; albedo: string; objectid: string; coverage: string; meta: any }>;
    });

    for (const key of ['shaded', 'shading', 'albedo', 'objectid', 'coverage'] as const) {
      await writeFile(join(out, `${key}.png`), dataUrlToBuffer((result as any)[key]));
    }
    const meta: Meta = {
      model: name, cols, rows, cellW, cellH, gridW, gridH,
      camera: result.meta.camera, threeVersion,
    };
    await writeFile(join(out, 'meta.json'), JSON.stringify(meta, null, 2));

    console.log(`baked ${name}: ${gridW}x${gridH} (${cols}x${rows}), meshes=${result.meta.meshCount} -> ${out}`);
    await sanityCheck(out, result);
  } finally {
    server.close();
  }
}

async function sanityCheck(
  out: string,
  result: { shaded: string; objectid: string; coverage: string },
): Promise<void> {
  // objectid round-trip: read R channel, confirm G=B=0 and ids are exact integers
  const id = await pngStats(dataUrlToBuffer(result.objectid));
  const ids = new Set<number>();
  let chromaLeak = 0;
  for (let i = 0; i < id.data.length; i += 4) {
    const r = id.data[i]!, g = id.data[i + 1]!, b = id.data[i + 2]!;
    if (g !== 0 || b !== 0) chromaLeak++;
    if (r > 0) ids.add(r);
  }
  const cov = await pngStats(dataUrlToBuffer(result.coverage));
  let covOn = 0;
  for (let i = 0; i < cov.data.length; i += 4) if (cov.data[i]! > 10) covOn++;
  const sh = await pngStats(dataUrlToBuffer(result.shaded));
  let lumaSum = 0;
  for (let i = 0; i < sh.data.length; i += 4) lumaSum += 0.2126 * sh.data[i]! + 0.7152 * sh.data[i + 1]! + 0.0722 * sh.data[i + 2]!;
  const meanLuma = lumaSum / (sh.data.length / 4);

  const sortedIds = [...ids].sort((a, b) => a - b);
  console.log(`  objectid: ${sortedIds.length} distinct nonzero id(s) = [${sortedIds.slice(0, 12).join(',')}${sortedIds.length > 12 ? ',…' : ''}], G/B-leak pixels=${chromaLeak}`);
  console.log(`  coverage: ${(100 * covOn / (cov.w * cov.h)).toFixed(2)}% geometry`);
  console.log(`  shaded:   mean luma=${meanLuma.toFixed(1)}/255`);
  if (sortedIds.length < 1) throw new Error('sanity FAIL: no nonzero object ids');
  if (chromaLeak > 0) console.warn(`  WARN: objectid has ${chromaLeak} pixels with nonzero G/B (expected 0)`);
  if (covOn === 0) throw new Error('sanity FAIL: coverage empty');
  if (meanLuma < 3) throw new Error('sanity FAIL: shaded all-dark');
  console.log(`  sanity: PASS -> ${out}`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      cols: { type: 'string', default: '120' },
      out: { type: 'string' },
      smoke: { type: 'boolean', default: false },
    },
  });
  if (values.smoke) { await runSmoke(); return; }
  const model = positionals[0];
  if (!model) {
    console.error('usage: tsx scripts/bake-aov.ts <model.glb|.gltf> --cols 120 [--out dir]');
    console.error('       tsx scripts/bake-aov.ts --smoke');
    process.exit(2);
  }
  await runBake(model, parseInt(values.cols!, 10), values.out);
}

main().catch((e) => { console.error(e); process.exit(1); });
