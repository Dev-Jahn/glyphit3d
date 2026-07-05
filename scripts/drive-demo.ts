import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FRAMES = `${ROOT}/bench/out/demo-frames`; // intermediate sweep frames (bench/out is gitignored)
const configFile = resolve(ROOT, 'web', 'vite.config.ts');
const LAUNCH_ARGS = ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'];

// Assemble the captured sweep frames into docs/assets/demo-sweep.gif (800px wide,
// 10fps) via ffmpeg with a generated palette. Matches the committed gif geometry.
function encodeGif(): Promise<void> {
  return new Promise((res, rej) => {
    const vf = 'scale=800:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3';
    const args = ['-y', '-framerate', '10', '-i', `${FRAMES}/frame_%03d.png`, '-vf', vf, `${ROOT}/docs/assets/demo-sweep.gif`];
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] });
    ff.on('error', rej);
    ff.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}`))));
  });
}

async function main(): Promise<void> {
  await rm(FRAMES, { recursive: true, force: true });
  await mkdir(FRAMES, { recursive: true });

  const dev: ViteDevServer = await createServer({ configFile, server: { port: 0 } });
  await dev.listen();
  const url = dev.resolvedUrls!.local[0]!;
  console.log(`dev server: ${url}`);

  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(e.message));

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction('window.__ready===true && !!window.__app.getOutput()', { timeout: 60000 });
  await page.waitForFunction('window.__ui!==undefined', { timeout: 60000 });
  // let the 2s intro auto-sweep settle to centre before we drive it
  await page.waitForTimeout(2600);

  const ssim = await page.evaluate('window.__app.getOutput().ssim') as number;
  console.log(`default render SSIM ${ssim.toFixed(4)}`);

  // (1) full-page demo screenshot at 1440px, divider back at centre.
  await page.evaluate('(()=>{const s=window.__ui.scrubber;s.frac=0.5;s.refresh();})()');
  await page.screenshot({ path: `${ROOT}/docs/assets/demo.png`, fullPage: true });
  console.log('demo.png written');

  // (2) divider sweep frames. Triangle 0.92 -> 0.08 -> 0.92 (seamless loop) so the
  // wipe reveals the glyph side and returns. frac set on the exposed Scrubber, then
  // refresh() repaints the composite + moves the handle.
  const down: number[] = [];
  const N = 13; // frames one-way
  for (let i = 0; i < N; i++) down.push(0.92 - (0.92 - 0.08) * (i / (N - 1)));
  const up = down.slice(1, N - 1).reverse();
  const fracs = [...down, ...up];

  let f = 0;
  for (const frac of fracs) {
    await page.evaluate(`(()=>{const s=window.__ui.scrubber;s.frac=${frac};s.refresh();})()`);
    await page.locator('.scrub-stage').screenshot({ path: `${FRAMES}/frame_${String(f).padStart(3, '0')}.png` });
    f++;
  }
  console.log(`captured ${f} sweep frames`);

  if (errs.length) console.log(`(page errors: ${errs.slice(0, 3).join(' | ')})`);
  await browser.close();
  await dev.close();

  await encodeGif();
  console.log('demo-sweep.gif written');
}
main().catch((e) => { console.error(e); process.exit(1); });
