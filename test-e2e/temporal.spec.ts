// Temporal-coherence harness + honest-reporting driver (feat/temporal-animation, DESIGN §4.9).
// Standalone tsx script — NOT vitest, NOT @playwright/test — mirroring test-e2e/webgpu-parity.spec.ts.
// Spins the vite dev server (secure-context localhost so WebGPU is available), drives
// web/temporal.html in headless Chromium on the local NVIDIA Blackwell GPU via ANGLE-Vulkan, and:
//   1. HARNESS SELF-CHECK: the deterministic FAST/SLOW orbits render reproducibly and matchGrid is
//      byte-identical to itself (proves the substrate; a failure here is a harness-integrity bug).
//   2. CENTRAL INVARIANT (hard-fail CONTRACT): for FAST and SLOW orbits, 61 frames each rendered
//      ONCE and shared, the temporal rematch at epsilon=0/delta=0 is BYTE-IDENTICAL to the same-frame
//      full rematch on every cell of all 61/61 × 2 frames. This is the only thing that fails the run.
//   3. HYSTERESIS logic-agreement (DESIGN §4.9 hypothesis) on sampled frames with delta>0.
//   4. REUSE-SPEEDUP probe (DESIGN §4.9 delta-encoding hypothesis).
// Prints the honest-reporting table with per-prediction MET / PARTIAL / FALSIFIED verdicts and the
// measured numbers. Exits NONZERO ONLY on a CONTRACT violation (byte-identity break, or a broken
// harness self-check) — NEVER on a falsified performance/hypothesis prediction (a falsified
// pre-registered prediction is a publishable result, reported verbatim, not hidden or tuned away).
// If the temporal rematch path (agents A/B) is not yet landed, the invariant/hysteresis/perf stages
// are reported PENDING (unverified, not violated) and the run exits 3 (distinct from a real
// violation) — the honest "not runnable end-to-end yet" state.
//
//   no-flag repro: npx tsx test-e2e/temporal.spec.ts   (or: npm run temporal)

import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { classifyStageError, hysteresisVerdict, driftVerdict, type HysteresisStats } from '../web/src/temporal-logic.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const webRoot = resolve(repoRoot, 'web');
const configFile = resolve(webRoot, 'vite.config.ts');

// Secure-context WebGPU on the NVIDIA GPU via ANGLE-Vulkan (identical to the parity harness).
const LAUNCH_ARGS = ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-gpu'];

type Verdict = 'MET' | 'PARTIAL' | 'FALSIFIED' | 'PENDING';
interface Row { id: string; prediction: string; measured: string; verdict: Verdict }

// Distinct exit codes: 0 = all contracts held; 1 = a CONTRACT was VIOLATED (byte-identity break or
// harness self-check failure); 3 = temporal path not landed → invariant UNVERIFIED (not violated).
const EXIT_OK = 0, EXIT_CONTRACT_VIOLATION = 1, EXIT_PENDING = 3;

interface Cfg { mode: 'fast' | 'slow'; charset: 'ascii' | 'blocks' | 'braille' | 'full'; cols: number; space: 'linear' | 'gamma'; label: string }

async function main(): Promise<void> {
  const browser: Browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const dev: ViteDevServer = await createServer({ configFile, server: { port: 0 } });
  await dev.listen();
  const base = dev.resolvedUrls!.local[0]!.replace(/\/$/, '');
  const url = `${base}/temporal.html`;
  console.log(`\ndev server: ${base}\ntemporal page: ${url}`);

  const page: Page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction('window.__temporalReady === true', { timeout: 60000 });

  const info = await page.evaluate('window.__temporalGpuInfo()') as { hasGpu: boolean; adapter?: unknown };
  console.log(`navigator.gpu: ${info.hasGpu}; adapter: ${JSON.stringify(info.adapter ?? null)}`);
  assert.ok(info.hasGpu && info.adapter, 'WebGPU / adapter unavailable in the harness browser — cannot verify temporal contract');

  const rows: Row[] = [];
  let contractViolation = false;
  let pending = false;

  // ── Stage 1: harness self-check (CONTRACT — must hold for any measurement to mean anything) ──
  const selfCfgs: Cfg[] = [
    { mode: 'slow', charset: 'blocks', cols: 100, space: 'gamma', label: 'self:slow' },
    { mode: 'fast', charset: 'blocks', cols: 100, space: 'gamma', label: 'self:fast' },
  ];
  console.log('\n---------------- HARNESS SELF-CHECK (render+match determinism) ----------------');
  let selfBad = 0;
  for (const c of selfCfgs) {
    const r = await page.evaluate((cfg) => window.__temporalSelfCheck(cfg as never), c) as Record<string, number | string>;
    const ok = (r.mismatchFrames as number) === 0;
    if (!ok) { selfBad++; contractViolation = true; }
    console.log(`  ${ok ? 'PASS' : 'FAIL'} [${c.label} ${c.charset} c${c.cols} ${c.space}] ${r.frames} frames, mismatchFrames ${r.mismatchFrames}, mismatchCells ${r.mismatchCellsTotal}` + (ok ? '' : `  <-- ${r.firstDetail}`));
  }
  rows.push({
    id: 'H0 harness-determinism',
    prediction: 'The deterministic FAST/SLOW orbit renders reproducibly and matchGrid is byte-identical to itself (substrate for the invariant).',
    measured: selfBad === 0 ? '0 mismatched frames across both orbits (122 frames)' : `${selfBad} orbit(s) non-deterministic`,
    verdict: selfBad === 0 ? 'MET' : 'FALSIFIED',
  });

  // ── Stage 2: CENTRAL INVARIANT + STATE-INVALIDATION (hard-fail contract) ─────────────────────
  // Each orbit's config is NOT frozen: the in-page invariantPlan flips space→cols→charset mid-orbit
  // with prev threaded across the flips, so byte-identity also certifies temporal-state invalidation
  // (the stale-state bug class). A crash AFTER the runner resolved is a VIOLATION, not PENDING.
  const invModes: Array<'fast' | 'slow'> = ['fast', 'slow'];
  console.log('\n---------------- CENTRAL INVARIANT + STATE-INVALIDATION: temporal(ε=0,δ=0) ≡ full ----------------');
  let invMismatchFrames = 0, invRan = 0, invNote = '', invCrash = '';
  const invTransitions = new Set<string>();
  for (const mode of invModes) {
    let r: Record<string, number | string>;
    try {
      r = await page.evaluate((m) => window.__temporalInvariant(m as never), mode) as Record<string, number | string>;
    } catch (e) {
      const msg = (e as Error).message.split('\n')[0];
      if (classifyStageError(msg) === 'violation') {
        contractViolation = true; invCrash = msg;
        console.log(`  VIOLATION [inv:${mode}] runner threw after resolving (NOT a pending state) — ${msg}`);
      } else {
        pending = true; invNote = msg;
        console.log(`  PENDING [inv:${mode}] ${msg}`);
      }
      continue;
    }
    invRan++;
    for (const t of String(r.transitions ?? '').split(',').filter(Boolean)) invTransitions.add(t);
    const bad = (r.mismatchFrames as number) > 0;
    if (bad) { invMismatchFrames += r.mismatchFrames as number; contractViolation = true; }
    console.log(`  ${bad ? 'VIOLATION' : 'PASS'} [inv:${mode}] matcher=${r.matcher}, ${r.frames} frames (transitions: ${r.transitions || 'none'}), mismatchFrames ${r.mismatchFrames}, mismatchCells ${r.mismatchCellsTotal}` + (bad ? `  <-- ${r.firstDetail}` : ''));
  }
  const invCovers = [...invTransitions].sort().join(',') || 'none';
  rows.push({
    id: 'P-invariant (CONTRACT)',
    prediction: 'temporal rematch at epsilon=0 AND delta=0 is byte-identical to the same-frame full rematch on all 61 frames × 2 orbits, INCLUDING across mid-orbit space/cols/charset changes (state invalidation): reuse/hysteresis is suppressed and stale state must never survive a config change.',
    measured: invCrash ? `CONTRACT VIOLATED — runner crashed after resolving: ${invCrash}` : (invRan === 0 ? `not runnable — ${invNote}` : (invMismatchFrames === 0 ? `0 mismatched cells across ${invRan} orbit(s) × 61 frames; invalidation transitions exercised: ${invCovers}` : `${invMismatchFrames} mismatched frame(s) — CONTRACT VIOLATED`)),
    verdict: invCrash ? 'FALSIFIED' : (invRan === 0 ? 'PENDING' : (invMismatchFrames === 0 ? 'MET' : 'FALSIFIED')),
  });

  // ── Stage 3: HYSTERESIS δ-margin ORACLE (DESIGN §4.9 hypothesis, δ>0) ─────────────────────────
  // TRUE reprojection-aware oracle: the in-page half rescores each cell (prev-reprojected vs fresh
  // winner) and counts ghosting/sparkle rule violations. hysteresisVerdict FALSIFIES on any
  // violation (so pure ghosting — the §4.9 "과도하면 끈적임" failure — reports FALSIFIED, not MET).
  console.log('\n---------------- HYSTERESIS δ-margin ORACLE (δ>0) on sampled frames ----------------');
  const sampleFrames = [10, 20, 30, 40, 50, 60];
  let hystRan = false, hystVerdict: Verdict = 'PENDING', hystMeasured = '', hystNote = '', hystCrash = '';
  try {
    const r = await page.evaluate(({ cfg, delta, sf }) => window.__temporalHysteresis(cfg as never, delta, sf), {
      cfg: { mode: 'fast', charset: 'blocks', cols: 100, space: 'gamma', label: 'hyst:fast' } as Cfg, delta: 0.02, sf: sampleFrames,
    }) as Record<string, number | string>;
    hystRan = true;
    const stats: HysteresisStats = {
      cellsWithPrev: r.cellsWithPrev as number, expectRetain: r.expectRetain as number, expectReplace: r.expectReplace as number,
      sticky: r.sticky as number, ghostingViolations: r.ghostingViolations as number, sparkleViolations: r.sparkleViolations as number,
      strayEmissions: r.strayEmissions as number,
    };
    hystVerdict = hysteresisVerdict(stats);
    const stickyPct = (r.stickyFrac as number) * 100;
    hystMeasured = `${stats.cellsWithPrev} cells w/ predecessor, sticky ${stats.sticky} (${stickyPct.toFixed(2)}%), rule-violations: ghosting ${stats.ghostingViolations} / sparkle ${stats.sparkleViolations} / stray ${stats.strayEmissions}`;
    console.log(`  RAN [hyst:fast δ=0.02] sampled ${r.sampledFrames} frames — ${hystMeasured} → ${hystVerdict}`);
  } catch (e) {
    const msg = (e as Error).message.split('\n')[0];
    hystNote = msg;
    if (classifyStageError(msg) === 'violation') { contractViolation = true; hystCrash = msg; console.log(`  VIOLATION [hyst:fast] runner threw after resolving — ${msg}`); }
    else console.log(`  PENDING [hyst:fast] ${msg}`);
  }
  rows.push({
    id: 'P-hysteresis',
    prediction: 'DESIGN §4.9: hysteresis replaces a glyph only when a new candidate wins by margin ≥ δ — under motion the temporal path holds prior glyphs on near-tie cells WITHOUT ghosting (keeping a glyph a decisive winner beats) or sparkle (swapping on a near-tie).',
    measured: hystCrash ? `CONTRACT VIOLATED — runner crashed after resolving: ${hystCrash}` : (!hystRan ? `not runnable — ${hystNote}` : hystMeasured),
    verdict: hystCrash ? 'FALSIFIED' : (!hystRan ? 'PENDING' : hystVerdict),
  });

  // ── Stage 3b: REFERENCE-FRAME DRIFT / KEYFRAME (DESIGN §4.9 codec I-frame, ε>0) ───────────────
  // The ONLY output-correctness assertion in the ε>0 regime: at each keyframe the temporal output
  // MUST byte-equal the same-frame full rematch (a full recompute snaps accumulated drift back to
  // ground truth). A keyframe that differs is unbounded reference-frame drift → CONTRACT VIOLATION
  // (exit 1). Between keyframes the max divergence fraction from ground truth is reported as DATA.
  console.log('\n---------------- REFERENCE-FRAME DRIFT / KEYFRAME (SLOW orbit, ε>0) ----------------');
  let driftRan = false, driftVerd: Verdict = 'PENDING', driftMeasured = '', driftNote = '', driftCrash = '';
  try {
    const r = await page.evaluate(({ cfg, eps, delta }) => window.__temporalDrift(cfg as never, eps, delta), {
      cfg: { mode: 'slow', charset: 'blocks', cols: 100, space: 'gamma', label: 'drift:slow' } as Cfg, eps: 1e-4, delta: 0.02,
    }) as Record<string, number | string>;
    driftRan = true;
    const kfViol = r.keyframeViolations as number;
    if (kfViol > 0) { contractViolation = true; }
    driftVerd = driftVerdict(kfViol, r.nonKfFramesMeasured as number);
    driftMeasured = `keyframe violations ${kfViol} (${r.keyframeMismatchCells} cells), max between-keyframe divergence ${((r.maxNonKfFrac as number) * 100).toFixed(2)}% over ${r.nonKfFramesMeasured} frames`;
    console.log(`  ${kfViol > 0 ? 'VIOLATION' : 'RAN'} [drift:slow ε=1e-4 δ=0.02] ${driftMeasured} → ${driftVerd}` + (kfViol > 0 ? `  <-- ${r.firstDetail}` : ''));
  } catch (e) {
    const msg = (e as Error).message.split('\n')[0];
    driftNote = msg;
    if (classifyStageError(msg) === 'violation') { contractViolation = true; driftCrash = msg; console.log(`  VIOLATION [drift:slow] runner threw after resolving — ${msg}`); }
    else console.log(`  PENDING [drift:slow] ${msg}`);
  }
  rows.push({
    id: 'P-drift (CONTRACT: keyframe)',
    prediction: 'DESIGN §4.9 "delta 인코딩 (터미널 비디오 코덱)": at each keyframe the temporal output is a full recompute — byte-identical to the same-frame full rematch — so reference-frame drift on slowly-varying cells stays bounded (never accumulates unbounded past the ε per-frame threshold).',
    measured: driftCrash ? `CONTRACT VIOLATED — runner crashed after resolving: ${driftCrash}` : (!driftRan ? `not runnable — ${driftNote}` : driftMeasured),
    verdict: driftCrash ? 'FALSIFIED' : (!driftRan ? 'PENDING' : driftVerd),
  });

  // ── Stage 4: REUSE-SPEEDUP probe (DESIGN §4.9 delta-encoding hypothesis) ─────────────────────
  console.log('\n---------------- REUSE-SPEEDUP (SLOW orbit, warm) ----------------');
  let perfRan = false, fullMs = 0, tmpMs = 0, perfNote = '', perfCrash = '';
  try {
    const r = await page.evaluate(({ cfg, eps, delta, n }) => window.__temporalPerf(cfg as never, eps, delta, n), {
      cfg: { mode: 'slow', charset: 'blocks', cols: 100, space: 'gamma', label: 'perf:slow' } as Cfg, eps: 1e-4, delta: 0.02, n: 20,
    }) as { fullMs: number; temporalMs: number };
    perfRan = true; fullMs = r.fullMs; tmpMs = r.temporalMs;
    console.log(`  RAN [perf:slow ε=1e-4 δ=0.02] full ${fullMs.toFixed(2)}ms vs temporal ${tmpMs.toFixed(2)}ms (median of 20)`);
  } catch (e) {
    const msg = (e as Error).message.split('\n')[0];
    perfNote = msg;
    if (classifyStageError(msg) === 'violation') { contractViolation = true; perfCrash = msg; console.log(`  VIOLATION [perf:slow] runner threw after resolving — ${msg}`); }
    else console.log(`  PENDING [perf:slow] ${msg}`);
  }
  const speedup = perfRan && tmpMs > 0 ? fullMs / tmpMs : 0;
  rows.push({
    id: 'P-reuse-speedup',
    prediction: 'DESIGN §4.9: reusing prior-frame selections on near-static cells (delta-encoding) makes a temporal rematch faster than a full rematch on the SLOW orbit.',
    measured: perfCrash ? `CONTRACT VIOLATED — runner crashed after resolving: ${perfCrash}` : (!perfRan ? `not runnable — ${perfNote}` : `full ${fullMs.toFixed(2)}ms vs temporal ${tmpMs.toFixed(2)}ms (${speedup.toFixed(2)}× )`),
    verdict: perfCrash ? 'FALSIFIED' : (!perfRan ? 'PENDING' : (speedup > 1.05 ? 'MET' : (speedup >= 0.95 ? 'PARTIAL' : 'FALSIFIED'))),
  });

  await page.close();
  await dev.close();
  await browser.close();
  if (pageErrors.length) console.log(`\n(page/console errors: ${pageErrors.slice(0, 6).join(' | ')})`);

  // ── Honest-reporting table ───────────────────────────────────────────────────────────────────
  console.log('\n================ TEMPORAL HONEST-REPORTING TABLE ================');
  for (const r of rows) {
    console.log(`\n[${r.id}]  →  ${r.verdict}`);
    console.log(`  prediction: ${r.prediction}`);
    console.log(`  measured:   ${r.measured}`);
  }
  console.log('\nno-flag repro: npx tsx test-e2e/temporal.spec.ts');

  // Exit policy: NONZERO only on a CONTRACT violation (byte-identity break / harness self-check).
  // A falsified perf/hysteresis prediction NEVER fails the run. A not-landed temporal path is
  // PENDING (unverified) → exit 3, distinct from a real violation.
  if (contractViolation) { console.log('\nRESULT: CONTRACT VIOLATION — see VIOLATION/FAIL rows above.'); process.exit(EXIT_CONTRACT_VIOLATION); }
  if (pending) { console.log('\nRESULT: PENDING — temporal path not landed; invariant UNVERIFIED (not violated). Assemble reruns after A/B land.'); process.exit(EXIT_PENDING); }
  console.log('\nRESULT: all contracts held.');
  process.exit(EXIT_OK);
}

main().catch((e) => { console.error(e); process.exit(EXIT_CONTRACT_VIOLATION); });
