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

// Divider-pane identity + orientation probe. Reads the composited .scrub-canvas and
// each source (#scene / #raster) scaled to the composite's size, then reports the
// mean-abs colour diff of the composite vs each source over the top third, bottom
// third, and full frame, plus the top-band and full-frame diffs against each source
// flipped vertically. A correctly-composited saturated pane matches its own source
// near-exactly (identical drawImage), matches the OTHER source poorly, and matches
// its own source FLIPPED poorly (so a top↔bottom flip is caught).
//
// NOTE: kept free of nested named function expressions on purpose — tsx/esbuild
// injects a `__name(fn,"…")` helper for those, which is undefined in the page and
// throws "__name is not defined" when Playwright serializes this into the browser.
function paneStats(): any {
  const scrub: any = document.querySelector('.scrub-canvas');
  const w: number = scrub.width, h: number = scrub.height;
  const sd: any = scrub.getContext('2d').getImageData(0, 0, w, h).data;
  const sources: any[] = [];
  for (const sel of ['#scene', '#raster']) {
    const src: any = document.querySelector(sel);
    const t: any = document.createElement('canvas'); t.width = w; t.height = h;
    const x: any = t.getContext('2d'); x.drawImage(src, 0, 0, w, h);
    sources.push(x.getImageData(0, 0, w, h).data);
  }
  const t1 = Math.floor(h / 3), b0 = Math.floor((h * 2) / 3);
  // [source-index, key, flip, y0, y1] — inline mean-abs-diff to avoid a nested fn.
  const specs: any[] = [
    [0, 'sceneTop', false, 0, t1], [0, 'sceneBot', false, b0, h], [0, 'sceneFull', false, 0, h],
    [0, 'sceneFlipTop', true, 0, t1], [0, 'sceneFlipFull', true, 0, h],
    [1, 'rasterTop', false, 0, t1], [1, 'rasterBot', false, b0, h], [1, 'rasterFull', false, 0, h],
    [1, 'rasterFlipTop', true, 0, t1], [1, 'rasterFlipFull', true, 0, h],
  ];
  const out: any = { w, h };
  for (const spec of specs) {
    const a: any = sources[spec[0]];
    const flip: boolean = spec[2], y0: number = spec[3], y1: number = spec[4];
    let sum = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      const ay = flip ? h - 1 - y : y;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, j = (ay * w + x) * 4;
        sum += Math.abs(sd[i] - a[j]) + Math.abs(sd[i + 1] - a[j + 1]) + Math.abs(sd[i + 2] - a[j + 2]);
        n += 3;
      }
    }
    out[spec[1]] = sum / n;
  }
  return out;
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

  await check(3, 'Charset round-trip blocks→ascii→blocks: block glyphs drop then RETURN', async () => {
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

    // Round-trip back to blocks — the regression guard for the worker's stale-atlas
    // bug (fix 1): re-selecting a previously-used charset must re-match against ITS
    // atlas, so the box/block glyphs have to RETURN. The old "last Map key" worker
    // kept matching against the ascii atlas here (Maps preserve first-insertion order)
    // and produced zero block glyphs.
    await afterRematch(page, () => page.locator('select.field-input').selectOption('blocks'));
    const blocks2 = await page.evaluate(repertoire);
    const blockInBlocks2 = blocks2.filter(isBlockGlyph);
    assert.ok(blockInBlocks2.length > 0, `round-trip blocks→ascii→blocks did not restore U+2500–259F glyphs (${blocks2.length} glyphs, 0 block) — worker matched a stale atlas`);

    return `blocks ${blocks.length} (${blockInBlocks.length} block) → ascii ${ascii.length} (0 block) → blocks ${blocks2.length} (${blockInBlocks2.length} block restored)`;
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
    // The export must carry real glyphs, not an all-null / all-blank grid.
    const printable = json.cells.some((c: any) => c && typeof c.ch === 'string' && (c.ch.codePointAt(0) ?? 0) > 0x20);
    assert.ok(printable, 'json export has no non-null printable glyph cell');

    const png = await readDownload(page, '.png');
    assert.ok(png.length > 0, 'PNG export empty');
    assert.ok(png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47, 'PNG magic bytes missing');

    return `.ans ${ans.length}B/${ansRows} rows, .json ${json.cells.length} cells (${json.color.channels}), .png ${png.length}B`;
  });

  await check(5, 'Scrubber: drag changes composite; left pane = #scene, right pane = #raster, upright', async () => {
    const box = await page.locator('.scrub-stage').boundingBox();
    assert.ok(box, 'scrub-stage not found');
    const y = box.y + box.height / 2;

    // Saturate the divider fully right (frac→1, whole composite = the LEFT source, the
    // native #scene render) and fully left (frac→0, whole composite = the RIGHT source,
    // #raster), reading pane stats at each end. Dragging PAST the stage edge under
    // pointer-capture pins frac to exactly 1/0 so no sliver of the other source leaks in.
    // Inlined per side (no nested fn — see paneStats note on the __name helper).

    // (a) dragging the divider changes the composite.
    await page.mouse.move(box.x + box.width * 0.15, y);
    await page.mouse.down();
    const hA = await page.evaluate(canvasHash, '.scrub-canvas');
    await page.mouse.move(box.x + box.width * 0.85, y, { steps: 4 });
    const hB = await page.evaluate(canvasHash, '.scrub-canvas');
    assert.notEqual(hA, hB, `composite unchanged across divider positions (hash ${hA})`);

    // --- Q3 (default): the glyph raster faithfully reproduces the render, so identity
    // and upright-orientation are checkable with a wide margin, but the two sources
    // look alike (that fidelity is the demo's whole point).
    await page.mouse.move(box.x + box.width + 400, y, { steps: 4 }); // frac→1
    const R3 = await page.evaluate(paneStats);
    await page.mouse.up();
    await page.mouse.move(box.x + box.width * 0.5, y);
    await page.mouse.down();
    await page.mouse.move(box.x - 400, y, { steps: 4 }); // frac→0
    const L3 = await page.evaluate(paneStats);
    await page.mouse.up();

    // identity: each saturated pane is a faithful copy of its OWN source (same drawImage).
    assert.ok(R3.sceneFull < 4, `fully-right pane ≠ #scene (Δ ${R3.sceneFull.toFixed(1)})`);
    assert.ok(L3.rasterFull < 4, `fully-left pane ≠ #raster (Δ ${L3.rasterFull.toFixed(1)})`);
    // orientation: upright beats vertically-flipped by a wide margin — top-light /
    // bottom-dark background gradient + the asymmetric knot — so a flipped pane fails.
    assert.ok(R3.sceneFlipFull > R3.sceneFull + 10, `#scene pane vertically flipped (upright ${R3.sceneFull.toFixed(1)} vs flipped ${R3.sceneFlipFull.toFixed(1)})`);
    assert.ok(L3.rasterFlipFull > L3.rasterFull + 10, `#raster pane vertically flipped (upright ${L3.rasterFull.toFixed(1)} vs flipped ${L3.rasterFlipFull.toFixed(1)})`);

    // --- Q0: its crude mono ramp differs sharply from the render (SSIM ~0.05, check 2),
    // so the panes become distinguishable and a source SWAP / same-source-both-sides
    // (invisible at Q3) is caught: self≈0 but the OTHER source is far off.
    await afterRematch(page, () => page.locator('button.q-btn', { hasText: /^Q0$/ }).click());
    await page.mouse.move(box.x + box.width * 0.5, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width + 400, y, { steps: 4 }); // frac→1
    const R0 = await page.evaluate(paneStats);
    await page.mouse.up();
    await page.mouse.move(box.x + box.width * 0.5, y);
    await page.mouse.down();
    await page.mouse.move(box.x - 400, y, { steps: 4 }); // frac→0
    const L0 = await page.evaluate(paneStats);
    await page.mouse.up();

    assert.ok(R0.sceneFull < 4 && R0.rasterFull > R0.sceneFull + 10, `fully-right pane is not the #scene source at Q0 (self ${R0.sceneFull.toFixed(1)} vs other ${R0.rasterFull.toFixed(1)})`);
    assert.ok(L0.rasterFull < 4 && L0.sceneFull > L0.rasterFull + 10, `fully-left pane is not the #raster source at Q0 (self ${L0.rasterFull.toFixed(1)} vs other ${L0.sceneFull.toFixed(1)})`);

    return `drag ${hA}≠${hB}; Q3 identity scene ${R3.sceneFull.toFixed(1)}/raster ${L3.rasterFull.toFixed(1)}, flip scene ${R3.sceneFlipFull.toFixed(1)}/raster ${L3.rasterFlipFull.toFixed(1)}; Q0 source scene self ${R0.sceneFull.toFixed(1)}·other ${R0.rasterFull.toFixed(1)} / raster self ${L0.rasterFull.toFixed(1)}·other ${L0.sceneFull.toFixed(1)}`;
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

  await check(7, 'Perf at defaults: match+raster < 500ms; main thread stays live during a rematch', async () => {
    assert.ok(perf, 'no default perf captured');
    const interactive = perf.match + perf.raster;
    assert.ok(interactive < 500, `interactive (match+raster) ${interactive.toFixed(1)}ms >= 500ms`);

    // Worker-execution guard: the heavy match/raster/ssim run off-thread, so the main
    // thread must keep servicing tasks during a rematch. Beat a setTimeout(0) heartbeat
    // while a rematch runs and assert it ticked repeatedly with no stall spanning the
    // whole compute — a main-thread matcher would freeze the loop for the full duration.
    // NOTE: no nested named function — tsx/esbuild's `__name` helper would be undefined
    // in the page. The heartbeat is an anonymous setInterval callback; state lives in an
    // object so the arrow can mutate it without a `const beat = …` binding.
    const probe = await page.evaluate(async () => {
      const before = window.__app.getOutput();
      const s = { ticks: 0, maxGap: 0, last: performance.now() };
      const timer = setInterval(() => {
        const now = performance.now();
        const gap = now - s.last; s.last = now;
        if (gap > s.maxGap) s.maxGap = gap;
        s.ticks++;
      }, 0);
      const t0 = performance.now();
      await window.__app.rematch();
      const dur = performance.now() - t0;
      clearInterval(timer);
      return { ticks: s.ticks, maxGap: s.maxGap, dur, changed: window.__app.getOutput() !== before };
    }) as { ticks: number; maxGap: number; dur: number; changed: boolean };

    assert.ok(probe.changed, 'liveness rematch did not produce a fresh output');
    assert.ok(probe.ticks >= 3, `main thread starved during rematch: only ${probe.ticks} heartbeat(s) in ${probe.dur.toFixed(0)}ms`);
    assert.ok(probe.maxGap < probe.dur, `main thread blocked ${probe.maxGap.toFixed(0)}ms of a ${probe.dur.toFixed(0)}ms rematch (≈ whole compute ⇒ ran on main thread)`);

    return `render ${perf.render.toFixed(1)}ms · match ${perf.match.toFixed(1)}ms · raster ${perf.raster.toFixed(1)}ms · ssim ${perf.ssim.toFixed(1)}ms → interactive ${interactive.toFixed(1)}ms; liveness ${probe.ticks} beats, max stall ${probe.maxGap.toFixed(0)}/${probe.dur.toFixed(0)}ms`;
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
