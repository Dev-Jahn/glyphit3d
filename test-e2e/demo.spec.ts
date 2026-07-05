// M2 E2E verify instrument (M2-SPEC §4, §5). Standalone tsx script — NOT vitest,
// NOT @playwright/test. Drives the vite dev app (checks 1-7) and a vite build+preview
// artifact (check 8) with plain `playwright` + node:assert, headless Chromium under
// SwiftShader (no WebGPU here, by design — spec header). Run: `npm run e2e`.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { build, createServer, preview, type PreviewServer, type ViteDevServer } from 'vite';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const configFile = resolve(webRoot, 'vite.config.ts');

// SwiftShader WebGL under headless Chromium (the M2 CPU floor — spec header).
const LAUNCH_ARGS = ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'];

const ESC = '\x1b';

interface CheckResult { n: number; name: string; pass: boolean; detail: string }
const results: CheckResult[] = [];
let perf: { render: number; resample: number; match: number; raster: number; ssim: number } | null = null;

async function check(n: number, name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const detail = await fn();
    results.push({ n, name, pass: true, detail });
    console.log(`  ✓ [${n}] ${name} — ${detail}`);
  } catch (e) {
    const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
    results.push({ n, name, pass: false, detail: detail.split('\n').slice(0, 4).join(' | ') });
    console.log(`  ✗ [${n}] ${name} — FAIL: ${detail.split('\n')[0]}`);
  }
}

// --- in-page helpers (evaluated in the browser) ---------------------------------

// Wait for main.ts's first render + __app surface.
async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction('window.__ready===true && !!window.__app.getOutput()', { timeout: 60000 });
  await page.waitForFunction('window.__ui!==undefined', { timeout: 60000 }).catch(() => {});
}

// Fire `action`, then resolve once a fresh PipelineOutput exists and the app is idle.
async function afterRematch(page: Page, action: () => Promise<void>): Promise<void> {
  await page.evaluate('window.__t = window.__app.getOutput()');
  await action();
  await page.waitForFunction('window.__app.getOutput() !== window.__t && !window.__app.getState().busy', { timeout: 60000 });
}

// These run in the browser (passed as functions so Playwright forwards args).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const document: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const window: any;

// Draw a (possibly WebGL) canvas into a 2D canvas and report its value range — a
// blank frame has min===max.
function canvasRange(sel: string): { mn: number; mx: number; w: number; h: number } {
  const c = document.querySelector(sel);
  const t = document.createElement('canvas');
  t.width = c.width; t.height = c.height;
  const x = t.getContext('2d');
  x.drawImage(c, 0, 0);
  const d = x.getImageData(0, 0, t.width, t.height).data;
  let mn = 255, mx = 0;
  for (let i = 0; i < d.length; i += 4) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  return { mn, mx, w: c.width, h: c.height };
}

// Cheap strided checksum of a 2D canvas's pixels.
function canvasHash(sel: string): number {
  const c = document.querySelector(sel);
  const x = c.getContext('2d');
  const d = x.getImageData(0, 0, c.width, c.height).data;
  let h = 0;
  for (let i = 0; i < d.length; i += 101) h = (Math.imul(h, 31) + d[i]) >>> 0;
  return h;
}

// Distinct glyph repertoire of the current grid.
function repertoire(): string[] {
  const g = window.__app.getOutput().grid;
  const s = new Set<string>();
  for (const c of g.cells) if (c) s.add(c.ch);
  return [...s];
}

async function readDownload(page: Page, triggerSelectorText: string): Promise<Buffer> {
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.locator('button.export-btn', { hasText: triggerSelectorText }).first().click(),
  ]);
  const path = await dl.path();
  return readFile(path);
}

// --- the eight checks ------------------------------------------------------------

async function runDevChecks(page: Page, baseURL: string): Promise<void> {
  // Capture default-settings perf up front, on the pristine load (spec §4.7 / §5.2).
  const out0 = await page.evaluate('(()=>{const o=window.__app.getOutput();return {t:o.timings,ssim:o.ssim,params:window.__app.getState().params,w:o.raster.w,h:o.raster.h};})()') as any;
  perf = out0.t;

  await check(1, 'Page loads, default torus knot renders (canvas non-blank)', async () => {
    const r = await page.evaluate(canvasRange, '#scene');
    assert.ok(r.w > 0 && r.h > 0, 'scene canvas has no drawing buffer');
    assert.ok(r.mx - r.mn > 10, `scene canvas appears blank (range ${r.mn}..${r.mx})`);
    return `#scene ${r.w}x${r.h}, luma range ${r.mn}..${r.mx}; default SSIM ${out0.ssim.toFixed(4)}`;
  });

  await check(2, 'Ladder Q0→Q3: different grids, SSIM(Q3) > SSIM(Q0), badge updates', async () => {
    await afterRematch(page, () => page.locator('button.q-btn', { hasText: /^Q0$/ }).click());
    const q0 = await page.evaluate('(()=>({ssim:window.__app.getOutput().ssim,chars:window.__app.getOutput().grid.cells.map(c=>c?c.ch:null).join(""),badge:document.getElementById("ssim").textContent}))()') as any;
    await afterRematch(page, () => page.locator('button.q-btn', { hasText: /^Q3$/ }).click());
    const q3 = await page.evaluate('(()=>({ssim:window.__app.getOutput().ssim,chars:window.__app.getOutput().grid.cells.map(c=>c?c.ch:null).join(""),badge:document.getElementById("ssim").textContent}))()') as any;
    assert.notEqual(q0.chars, q3.chars, 'Q0 and Q3 produced identical grids');
    assert.ok(q3.ssim > q0.ssim, `SSIM not monotone: Q0=${q0.ssim} Q3=${q3.ssim}`);
    assert.equal(q3.badge, q3.ssim.toFixed(4), `badge "${q3.badge}" != SSIM ${q3.ssim.toFixed(4)}`);
    return `SSIM Q0=${q0.ssim.toFixed(4)} < Q3=${q3.ssim.toFixed(4)}; badge="${q3.badge}"`;
  });

  await check(3, 'Charset blocks→ascii changes the ANSI glyph repertoire', async () => {
    // Re-targeted (2026-07-05): the original check switched to 'braille', but DejaVu Sans
    // Mono carries zero braille glyphs, so the braille/full presets are byte-identical to
    // blocks (DESIGN §15.7) — a physically impossible assertion with this font. blocks↔ascii
    // genuinely differ: blocks adds U+2500–259F box/block glyphs, ascii is 7-bit only.
    const isBlockGlyph = (s: string): boolean => {
      const cp = s.codePointAt(0)!;
      return (cp >= 0x2500 && cp <= 0x257f) || (cp >= 0x2580 && cp <= 0x259f);
    };
    const blocks = await page.evaluate(repertoire); // default charset is 'blocks'
    await afterRematch(page, () => page.locator('select.field-input').selectOption('ascii'));
    const ascii = await page.evaluate(repertoire);
    const blockInBlocks = blocks.filter(isBlockGlyph);
    const blockInAscii = ascii.filter(isBlockGlyph);
    assert.ok(blockInBlocks.length > 0, `blocks repertoire has no U+2500–259F glyph (${blocks.length} glyphs)`);
    assert.equal(blockInAscii.length, 0, `ascii repertoire leaked box/block glyphs: ${blockInAscii.join('')}`);
    return `blocks ${blocks.length} glyphs (${blockInBlocks.length} in U+2500–259F) → ascii ${ascii.length} glyphs (0 block glyphs)`;
  });

  await check(4, 'Exports: ANSI (ESC, rows), JSON (§3 shape), PNG (non-empty)', async () => {
    const grid = await page.evaluate('(()=>{const g=window.__app.getOutput().grid;return {rows:g.rows,cols:g.cols};})()') as { rows: number; cols: number };

    const ans = (await readDownload(page, '.ans')).toString('utf8');
    assert.ok(ans.length > 0, 'ANSI export empty');
    assert.equal(ans[0], ESC, 'ANSI does not start with ESC');
    const ansRows = (ans.match(/\r\n/g) ?? []).length;
    assert.equal(ansRows, grid.rows, `ANSI row count ${ansRows} != grid.rows ${grid.rows}`);

    const json = JSON.parse((await readDownload(page, '.json')).toString('utf8'));
    assert.equal(json.version, 1, 'json.version != 1');
    assert.equal(typeof json.cols, 'number');
    assert.equal(typeof json.rows, 'number');
    assert.ok(json.cell && typeof json.cell.width === 'number' && typeof json.cell.height === 'number' && typeof json.cell.aspect === 'number', 'cell shape invalid');
    assert.ok(json.font && typeof json.font.family === 'string' && typeof json.font.size === 'number' && typeof json.font.profileHash === 'string', 'font shape invalid');
    assert.ok(['mono', 'fg', 'fg-bg'].includes(json.color.channels), 'color.channels invalid');
    assert.equal(json.color.depth, 'truecolor', 'color.depth != truecolor');
    assert.equal(json.cells.length, json.cols * json.rows, 'cells length != cols*rows');
    for (const c of json.cells) {
      if (c === null) continue;
      assert.ok(typeof c.ch === 'string' && 'fg' in c && 'bg' in c, 'cell entry shape invalid');
    }

    const png = await readDownload(page, '.png');
    assert.ok(png.length > 0, 'PNG export empty');
    assert.ok(png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47, 'PNG magic bytes missing');

    return `.ans ${ans.length}B/${ansRows} rows, .json ${json.cells.length} cells (${json.color.channels}), .png ${png.length}B`;
  });

  await check(5, 'Scrubber divider drag changes the composite', async () => {
    const box = await page.locator('.scrub-stage').boundingBox();
    assert.ok(box, 'scrub-stage not found');
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.15, y);
    await page.mouse.down();
    const hA = await page.evaluate(canvasHash, '.scrub-canvas');
    await page.mouse.move(box.x + box.width * 0.85, y, { steps: 4 });
    const hB = await page.evaluate(canvasHash, '.scrub-canvas');
    await page.mouse.up();
    assert.notEqual(hA, hB, `composite unchanged across divider positions (hash ${hA})`);
    return `divider 15% hash ${hA} ≠ 85% hash ${hB}`;
  });

  await check(6, 'Permalink round-trip: settings survive reload', async () => {
    await afterRematch(page, () => page.evaluate(() => { window.__app.setParams({ cols: 140, quality: 1, charset: 'ascii', space: 'linear' }); return window.__app.rematch(); }));
    const hash = await page.evaluate('location.hash') as string;
    assert.ok(hash.includes('cols=140') && hash.includes('quality=1') && hash.includes('charset=ascii') && hash.includes('space=linear'), `fragment not written by permalink device: ${hash}`);

    // True reload round-trip: navigate the same page to the fragment URL so main.ts's
    // applyFragment runs on a fresh load.
    await page.goto(baseURL + hash, { waitUntil: 'load' });
    await waitReady(page);
    const p = await page.evaluate('window.__app.getState().params') as any;
    assert.equal(p.cols, 140, 'cols not restored');
    assert.equal(p.quality, 1, 'quality not restored');
    assert.equal(p.charset, 'ascii', 'charset not restored');
    assert.equal(p.space, 'linear', 'space not restored');
    return `fragment ${hash} → reload restored {cols:140, quality:1, charset:ascii, space:linear}`;
  });

  await check(7, 'Perf at defaults: match+raster < 500ms', async () => {
    assert.ok(perf, 'no default perf captured');
    const interactive = perf.match + perf.raster;
    assert.ok(interactive < 500, `interactive (match+raster) ${interactive.toFixed(1)}ms >= 500ms`);
    return `render ${perf.render.toFixed(1)}ms · match ${perf.match.toFixed(1)}ms · raster ${perf.raster.toFixed(1)}ms · ssim ${perf.ssim.toFixed(1)}ms → interactive ${interactive.toFixed(1)}ms`;
  });
}

// --- runner ----------------------------------------------------------------------

async function main(): Promise<void> {
  const browser: Browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });

  // Checks 1-7 against the vite dev server.
  const dev: ViteDevServer = await createServer({ configFile, server: { port: 0 } });
  await dev.listen();
  const devURL = dev.resolvedUrls!.local[0];
  console.log(`\ndev server: ${devURL}`);
  const page = await browser.newPage();
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await page.goto(devURL, { waitUntil: 'load' });
  await waitReady(page);
  await runDevChecks(page, devURL);
  await page.close();
  await dev.close();

  // Check 8: static build artifact + preview.
  await check(8, 'vite build succeeds and vite preview serves a working page', async () => {
    await build({ configFile });
    const server: PreviewServer = await preview({ configFile, preview: { port: 0 } });
    const url = server.resolvedUrls!.local[0];
    const pp = await browser.newPage();
    const errs: string[] = [];
    pp.on('pageerror', (e) => errs.push(e.message));
    try {
      await pp.goto(url, { waitUntil: 'load' });
      await waitReady(pp);
      const r = await pp.evaluate(canvasRange, '#scene');
      const ssim = await pp.evaluate('window.__app.getOutput().ssim') as number;
      assert.ok(r.mx - r.mn > 10, 'preview scene canvas blank');
      assert.ok(ssim > 0.5, `preview SSIM implausible: ${ssim}`);
      assert.equal(errs.length, 0, `preview page errors: ${errs.join('; ')}`);
      return `preview ${url} — scene luma ${r.mn}..${r.mx}, SSIM ${ssim.toFixed(4)}`;
    } finally {
      await pp.close();
      await new Promise<void>((res) => server.httpServer.close(() => res()));
    }
  });

  await browser.close();

  if (consoleErrors.length) console.log(`\n(dev console/page errors: ${consoleErrors.slice(0, 5).join(' | ')})`);

  // Report.
  console.log('\n================ M2 E2E RESULTS ================');
  for (const r of results) console.log(`[${r.n}] ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (perf) {
    const inter = perf.match + perf.raster;
    console.log(`\nPerf @ defaults (cols=100,Q3,blocks,gamma): render ${perf.render.toFixed(1)}ms · match ${perf.match.toFixed(1)}ms · raster ${perf.raster.toFixed(1)}ms · ssim ${perf.ssim.toFixed(1)}ms · interactive(match+raster) ${inter.toFixed(1)}ms`);
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL [${f.n}] ${f.name}\n    ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
