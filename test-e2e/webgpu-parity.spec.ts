// WebGPU parity + perf harness (perf/webgpu-matcher, SPEC §6/§7/§8). Standalone tsx script —
// NOT vitest, NOT @playwright/test. Spins the vite dev server (secure-context localhost so
// WebGPU is available), drives web/parity.html in headless Chromium on the local NVIDIA
// Blackwell GPU, and for each (source, charset, cols, space) runs BOTH the CPU truth
// (src/core/match.ts matchGrid) and the GPU matcher (gpu-matcher.ts) on the identical image,
// asserting the SPEC §6 parity contract and reporting the §7 perf. Run:
//   npx tsx test-e2e/webgpu-parity.spec.ts   (or: npm run parity)

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const webRoot = resolve(repoRoot, 'web');
const configFile = resolve(webRoot, 'vite.config.ts');

// Secure-context WebGPU on the NVIDIA GPU via ANGLE-Vulkan.
const LAUNCH_ARGS = ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-gpu'];

interface Cfg {
  label: string; source: 'scene' | 'image'; charset: 'ascii' | 'blocks' | 'braille' | 'full'; cols: number;
  space: 'linear' | 'gamma'; yaw?: number; pitch?: number; image?: string;
}

// chore/parity-adversarial-fixtures (O1). A minimal, dependency-free 8-bit-RGB PNG encoder so
// the parity sweep can drive CRAFTED targets (not just the demo scene / bench images) straight
// at the worst-case numeric regimes. PIL and the browser are standard PNG decoders, so a valid
// encoding decodes byte-identically in-page. Parity is CPU-vs-GPU on the SAME decoded image, so
// a real f32 divergence on a crafted input surfaces as a non-tie disagreement or a colour Δ.
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}
function craftPng(w: number, h: number, px: (x: number, y: number) => [number, number, number]): string {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, colour type 2 (RGB); rest (compression/filter/interlace) = 0
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const rs = y * (1 + w * 3);
    raw[rs] = 0; // per-scanline filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b] = px(x, y);
      const o = rs + 1 + x * 3;
      raw[o] = r & 255; raw[o + 1] = g & 255; raw[o + 2] = b & 255;
    }
  }
  const png = Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

// Author each crafted target at the EXACT cols=100 grid footprint (gridW=cols·cellW,
// gridH=round(cols·cellW/cellH)·cellH for the DejaVu-16 10×19 cell) so the in-page
// drawImage(0,0,gridW,gridH) is an identity blit — no resampling blurs the intra-cell structure.
const CELLW = 10, CELLH = 19;
const FW = 100 * CELLW;                                  // 1000
const FH = Math.max(1, Math.round((100 * CELLW) / CELLH)) * CELLH; // 53·19 = 1007

// (1) washout: a low-contrast field (~16/255 across the frame) with a faint sub-cell dither, so
// per-cell AC straddles the contrast gate — the invisible-ink / gate-boundary regime.
const craftWashout = craftPng(FW, FH, (x, y) => {
  const g = 124 + Math.round(8 * (x / FW + y / FH));
  const s = ((x / 3 | 0) + (y / 3 | 0)) & 1 ? 2 : -2;
  return [g + s, g + s, g + s];
});
// (2) checker: 4×5 sub-cell squares ⇒ strong INTRA-cell AC (each 10×19 cell holds several
// squares) at sharp contrast — the box-constrained path plus many genuine glyph near-ties.
const craftChecker = craftPng(FW, FH, (x, y) => (
  ((x / 4 | 0) + (y / 5 | 0)) & 1 ? [225, 215, 200] : [30, 35, 60]
));
// (3) hi-DC / low-AC: a bright field (~0.9) with a ±3/255 intra-cell dither sitting just past the
// gate — the S1T²/P cancellation regime the centered kernel exists to defend. Slightly different
// per channel so the gate sees chroma structure, not luma-only.
const craftHiDc = craftPng(FW, FH, (x, y) => {
  const d = ((x / 3 | 0) + (y / 5 | 0)) & 1 ? 3 : -3;
  return [232 + d, 229 + d, 226 + d];
});

// SPEC §6 thresholds.
const GLYPH_AGREE_MIN = 99.5;   // %
const DSSIM_MAX = 5e-4;
const COLOR_DELTA_MAX = 1;      // u8 levels
// SPEC §7 perf predictions.
const MATCH_MS_MAX = 15;        // dispatch→readback, warm, cols=100/blocks
const READBACK_MS_MAX = 2;

async function dataUrl(rel: string): Promise<string> {
  const buf = await readFile(resolve(repoRoot, rel));
  return `data:image/png;base64,${buf.toString('base64')}`;
}

async function main(): Promise<void> {
  const browser: Browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const dev: ViteDevServer = await createServer({ configFile, server: { port: 0 } });
  await dev.listen();
  const base = dev.resolvedUrls!.local[0]!.replace(/\/$/, '');
  const url = `${base}/parity.html`;
  console.log(`\ndev server: ${base}\nparity page: ${url}`);

  const page: Page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction('window.__parityReady === true', { timeout: 60000 });

  const info = await page.evaluate('window.__gpuInfo()') as { hasGpu: boolean; adapter?: { vendor?: string; architecture?: string } | null };
  console.log(`navigator.gpu: ${info.hasGpu}; adapter: ${JSON.stringify(info.adapter ?? null)}`);
  assert.ok(info.hasGpu && info.adapter, 'WebGPU / adapter unavailable in the harness browser — cannot verify parity');

  // Bench images (scaled to the grid footprint in-page). Parity is CPU-vs-GPU on the SAME
  // in-page LinearImage, so the decode path is irrelevant to the contract.
  const torus = await dataUrl('bench/images/torus.png');
  const helmet = await dataUrl('bench/images/DamagedHelmet.png');
  const washout = await dataUrl('bench/images/washout-stress.png');

  const configs: Cfg[] = [
    // demo scene (default pose): full cols × charset coverage (SPEC §6 grid).
    { label: 'scene@30/-15', source: 'scene', charset: 'blocks', cols: 80, space: 'gamma' },
    { label: 'scene@30/-15', source: 'scene', charset: 'blocks', cols: 100, space: 'gamma' },
    { label: 'scene@30/-15', source: 'scene', charset: 'blocks', cols: 140, space: 'gamma' },
    { label: 'scene@30/-15', source: 'scene', charset: 'ascii', cols: 80, space: 'gamma' },
    { label: 'scene@30/-15', source: 'scene', charset: 'ascii', cols: 100, space: 'gamma' },
    { label: 'scene@30/-15', source: 'scene', charset: 'ascii', cols: 140, space: 'gamma' },
    // demo scene alt pose.
    { label: 'scene@120/20', source: 'scene', charset: 'blocks', cols: 100, space: 'gamma', yaw: 120, pitch: 20 },
    { label: 'scene@120/20', source: 'scene', charset: 'ascii', cols: 100, space: 'gamma', yaw: 120, pitch: 20 },
    // linear working space (the other supported space).
    { label: 'scene linear', source: 'scene', charset: 'blocks', cols: 100, space: 'linear' },
    // bench images.
    { label: 'torus.png', source: 'image', charset: 'blocks', cols: 100, space: 'gamma', image: torus },
    { label: 'torus.png', source: 'image', charset: 'ascii', cols: 140, space: 'gamma', image: torus },
    { label: 'DamagedHelmet.png', source: 'image', charset: 'blocks', cols: 100, space: 'gamma', image: helmet },
    { label: 'DamagedHelmet.png', source: 'image', charset: 'ascii', cols: 100, space: 'gamma', image: helmet },
    { label: 'DamagedHelmet.png', source: 'image', charset: 'blocks', cols: 140, space: 'linear', image: helmet },
    { label: 'washout-stress.png', source: 'image', charset: 'blocks', cols: 100, space: 'gamma', image: washout },
    { label: 'washout-stress.png', source: 'image', charset: 'ascii', cols: 140, space: 'gamma', image: washout },

    // ── chore/parity-adversarial-fixtures (O1): strengthen the byte-exact claim past the 14-config
    // sample with crafted whole-scene targets + a G sweep. Same SPEC §6 thresholds; all expected
    // green by the centered-algebra design. Any FAIL here is a genuine finding to triage, not a
    // loosened bar (the asserts below are unchanged).

    // Crafted synthetic targets (authored at the cols=100 footprint → identity blit). These hit
    // the worst-case regimes head-on: gate boundary, box path, and the high-DC/low-AC f32
    // cancellation regime the kernel centers to survive.
    { label: 'craft:washout', source: 'image', charset: 'blocks', cols: 100, space: 'gamma', image: craftWashout },
    { label: 'craft:washout', source: 'image', charset: 'ascii', cols: 100, space: 'gamma', image: craftWashout },
    { label: 'craft:checker', source: 'image', charset: 'ascii', cols: 100, space: 'gamma', image: craftChecker },
    { label: 'craft:checker', source: 'image', charset: 'blocks', cols: 100, space: 'linear', image: craftChecker },
    { label: 'craft:hi-dc', source: 'image', charset: 'blocks', cols: 100, space: 'gamma', image: craftHiDc },
    { label: 'craft:hi-dc', source: 'image', charset: 'ascii', cols: 100, space: 'linear', image: craftHiDc },

    // G sweep: all bundled DejaVu profiles are P=190 (the P>256 workgroup-scratch guard is
    // unit-tested in gpu-matcher-pguard.test.ts — no >256 profile ships to drive it end-to-end),
    // but G spans 94→364. braille (270) and full (364) exercise the longest strided glyph scans,
    // the argmin tie path, and the workgroup reduction under the most contention.
    { label: 'scene@30/-15', source: 'scene', charset: 'braille', cols: 100, space: 'gamma' },
    { label: 'scene@30/-15', source: 'scene', charset: 'full', cols: 100, space: 'gamma' },
    { label: 'scene@30/-15', source: 'scene', charset: 'full', cols: 140, space: 'gamma' },
    { label: 'washout-stress.png', source: 'image', charset: 'full', cols: 100, space: 'gamma', image: washout },

    // Crafted scene poses: near-grazing maximizes flat background (gate boundary); a steep pose
    // redistributes the silhouette AC — both away from the two default poses.
    { label: 'scene grazing', source: 'scene', charset: 'blocks', cols: 100, space: 'gamma', yaw: 5, pitch: -80 },
    { label: 'scene steep', source: 'scene', charset: 'ascii', cols: 100, space: 'linear', yaw: 200, pitch: 60 },
  ];

  const active = process.env.PARITY_QUICK
    ? configs.filter((c) => ['scene@30/-15', 'torus.png', 'washout-stress.png'].includes(c.label) && c.cols === 100 && c.charset === 'blocks')
    : configs;

  const rows: Record<string, number | string | boolean>[] = [];
  let failures = 0;
  for (const cfg of active) {
    const r = await page.evaluate((c) => window.__parity(c as any), {
      source: cfg.source, charset: cfg.charset, cols: cfg.cols, space: cfg.space,
      yaw: cfg.yaw, pitch: cfg.pitch, imageDataUrl: cfg.image, label: cfg.label,
    }) as Record<string, number>;
    rows.push(r);

    const problems: string[] = [];
    if ((r.glyphAgreePct as number) < GLYPH_AGREE_MIN) problems.push(`glyph ${(r.glyphAgreePct as number).toFixed(3)}% < ${GLYPH_AGREE_MIN}%`);
    if ((r.nonTieDisagreements as number) !== 0) problems.push(`${r.nonTieDisagreements} NON-TIE disagreements`);
    if ((r.gateMismatch as number) !== 0) problems.push(`${r.gateMismatch} gate mismatches`);
    if ((r.maxColorDelta as number) > COLOR_DELTA_MAX) problems.push(`color Δ ${r.maxColorDelta} > ${COLOR_DELTA_MAX}`);
    if ((r.dssim as number) >= DSSIM_MAX) problems.push(`dSSIM ${(r.dssim as number).toExponential(2)} >= ${DSSIM_MAX}`);
    const ok = problems.length === 0;
    if (!ok) failures++;
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'} [${cfg.label} ${cfg.charset} c${cfg.cols} ${cfg.space}] ` +
      `glyph ${(r.glyphAgreePct as number).toFixed(3)}% (${r.disagreements} dis, ${r.nonTieDisagreements} non-tie, worstRel ${(r.worstRelGap as number).toExponential(2)}), ` +
      `gateMiss ${r.gateMismatch}, colorΔ ${r.maxColorDelta}, gated ${r.gatedCount}/${r.numCells}, ` +
      `SSIM cpu ${(r.ssimCpu as number).toFixed(5)}/gpu ${(r.ssimGpu as number).toFixed(5)} dΔ ${(r.dssim as number).toExponential(2)}, ` +
      `match ${(r.matchMs as number).toFixed(2)}ms` + (ok ? '' : `  <-- ${problems.join('; ')}`),
    );
  }

  // Perf (SPEC §7.1/§7.4): warm median at cols=100/Q3/blocks/gamma.
  const perf = await page.evaluate('window.__parityPerf({source:"scene",charset:"blocks",cols:100,space:"gamma",label:"perf"}, 30)') as { matchMs: number; gpuMs: number; readbackMs: number; prepMs: number };
  console.log(`\nPerf @ cols=100/Q3/blocks/gamma (warm median of 30): GPU-compute(timestamp) ${perf.gpuMs.toFixed(2)}ms, match(dispatch→readback wall-clock) ${perf.matchMs.toFixed(2)}ms, map-latency ${perf.readbackMs.toFixed(2)}ms, cpu-prep ${perf.prepMs.toFixed(2)}ms`);

  await page.close();
  await dev.close();
  await browser.close();

  if (pageErrors.length) console.log(`\n(page/console errors: ${pageErrors.slice(0, 6).join(' | ')})`);

  console.log('\n================ WEBGPU PARITY RESULTS ================');
  console.log(`${rows.length - failures}/${rows.length} configs pass SPEC §6 (glyph ≥ ${GLYPH_AGREE_MIN}%, 0 non-tie, 0 gate-miss, colorΔ ≤ ${COLOR_DELTA_MAX}, dSSIM < ${DSSIM_MAX}).`);
  // SPEC §7.1 predicts GPU `match` (the compute) < 15ms; the honest GPU-execution number is
  // the timestamp-query gpuMs. The dispatch→readback WALL-CLOCK (matchMs) additionally carries
  // headless-Dawn's mapAsync callback latency, reported separately.
  const perfProblems: string[] = [];
  if (perf.gpuMs >= MATCH_MS_MAX) perfProblems.push(`GPU-compute ${perf.gpuMs.toFixed(2)}ms >= ${MATCH_MS_MAX}ms`);
  console.log(perfProblems.length
    ? `§7.1 GPU-compute prediction NOT met: ${perfProblems.join('; ')}`
    : `§7.1 GPU-compute prediction met (timestamp ${perf.gpuMs.toFixed(2)}ms < ${MATCH_MS_MAX}ms). Wall-clock ${perf.matchMs.toFixed(2)}ms is map-latency-bound (${perf.readbackMs.toFixed(2)}ms), not compute.`);
  console.log('\nno-flag repro: npx tsx test-e2e/webgpu-parity.spec.ts');

  // §6 parity is the correctness gate that must hold. Perf is a measured on-record prediction.
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
