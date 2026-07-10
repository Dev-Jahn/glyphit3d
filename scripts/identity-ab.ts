import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { dirname, join } from 'node:path';
import { buildAtlas } from '../src/atlas/atlas.js';
import { resampleArea } from '../src/image/image.js';
import { loadLinear } from '../src/image/image-io.js';
import { matchGrid } from '../src/core/match.js';
import { rasterizeGrid } from '../src/render/raster.js';
import { savePng } from '../src/render/raster-io.js';
import { defaultOptions } from '../src/core/options.js';
import type { Atlas, LinearImage, MatchOptions } from '../src/core/types.js';

// Blind A/B pair composer for the ASCII-identity aesthetic judgment (ADR-0002 §5: the PRIMARY
// verdict is a pre-registered BLIND visual A/B, forced-choice "reads as character art vs
// dithered brightness field / washout"). For each scene it renders the baseline (Q2) and the
// feature-on contestant, composes them side-by-side with a SEEDED randomized left/right shuffle,
// and writes:
//   pair-NN.png       — side-by-side composite (which side is which is hidden by the shuffle)
//   judging.html      — self-contained forced-choice sheet (embeds pair PNGs, NO answer key)
//   key.json          — the SEALED answer key: base64 of the mapping + a sha256 commitment
// The KEY IS NEVER printed to stdout NOR embedded readably in the sheet; the sheet carries only the
// sha256 COMMITMENT (reveals nothing) so that after judging the key can be decoded and verified to
// match — a pre-registration guarantee against post-hoc key edits.
//
// Repro (deterministic):  npx tsx scripts/identity-ab.ts [--seed N] [--images a,b,c]
//   → bench/out/identity-ab/

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'bench', 'out', 'identity-ab');
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
const FONT_SIZE = 16;
const COLS = 120;
const CHARSET = 'blocks' as const;
const GUTTER = 8; // mid-gray separator px between the two panels

// mulberry32 — small seeded PRNG so the left/right shuffle is reproducible from --seed.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Contestant options. Baseline = Q2; feature-on = the shipped ASCII-identity preset (spec §5:
// identityLambda=5, identityTau=2.5e-4, coupling defaults, contrastFloor=24/255).
function baselineOpts(): MatchOptions { return defaultOptions(2); }
function featureOpts(): MatchOptions {
  return Object.assign(defaultOptions(2), {
    identityLambda: 5, identityTau: 2.5e-4, coupling: {}, contrastFloor: 24 / 255,
  });
}
const FEATURE_LABEL = 'ASCII-identity preset (A+B+floor)';

// Compose two equal-size linear panels side-by-side into one image with a mid-gray gutter.
function sideBySide(left: LinearImage, right: LinearImage): LinearImage {
  if (left.w !== right.w || left.h !== right.h) throw new Error('sideBySide: panel size mismatch');
  const w = left.w + GUTTER + right.w, h = left.h;
  const data = new Float32Array(w * h * 3);
  const g = 0.25; // gutter linear gray
  for (let i = 0; i < w * h * 3; i++) data[i] = g;
  const blit = (src: LinearImage, x0: number) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < src.w; x++) {
        const s = (y * src.w + x) * 3, d = (y * w + (x0 + x)) * 3;
        data[d] = src.data[s]!; data[d + 1] = src.data[s + 1]!; data[d + 2] = src.data[s + 2]!;
      }
    }
  };
  blit(left, 0);
  blit(right, left.w + GUTTER);
  return { w, h, data };
}

async function renderContestant(atlas: Atlas, ref: LinearImage, opts: MatchOptions): Promise<LinearImage> {
  return rasterizeGrid(matchGrid(ref, atlas, opts), atlas, 'gamma');
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { seed: { type: 'string', default: '3735928559' }, images: { type: 'string' } } });
  const seed = parseInt(values.seed!, 10) >>> 0;
  const images = values.images ? values.images.split(',').map((s) => s.trim()).filter(Boolean)
    : ['sphere', 'torus', 'spheres', 'DamagedHelmet', 'FlightHelmet', 'BoomBox'];
  const rng = mulberry32(seed);

  const atlas = await buildAtlas(FONT, FONT_SIZE, CHARSET);
  const { cellW, cellH } = atlas;
  await mkdir(OUT, { recursive: true });

  // The answer key — SEALED (written base64) and never printed. Records, per pair, which side holds
  // the baseline vs the feature.
  const key: { seed: number; feature: string; pairs: { id: string; scene: string; left: 'baseline' | 'feature'; right: 'baseline' | 'feature' }[] } = {
    seed, feature: FEATURE_LABEL, pairs: [],
  };
  const sheetPairs: { id: string; scene: string; file: string }[] = [];

  let idx = 0;
  for (const scene of images) {
    const src = await loadLinear(join(ROOT, 'bench', 'images', `${scene}.png`));
    const rows = Math.round(COLS * (src.h / src.w) * (cellW / cellH));
    const ref = resampleArea(src, COLS * cellW, rows * cellH);
    const basePanel = await renderContestant(atlas, ref, baselineOpts());
    const featPanel = await renderContestant(atlas, ref, featureOpts());

    const baselineOnLeft = rng() < 0.5; // seeded L/R shuffle
    const composite = baselineOnLeft ? sideBySide(basePanel, featPanel) : sideBySide(featPanel, basePanel);
    const id = `pair-${String(idx).padStart(2, '0')}`;
    const file = `${id}.png`;
    await savePng(composite, join(OUT, file));
    key.pairs.push({ id, scene, left: baselineOnLeft ? 'baseline' : 'feature', right: baselineOnLeft ? 'feature' : 'baseline' });
    sheetPairs.push({ id, scene, file });
    idx++;
  }

  // Seal the key: base64 of the JSON + a sha256 commitment over the SAME bytes. The commitment is
  // the only key-derived value that appears anywhere public (in the sheet); it reveals nothing.
  const keyJson = JSON.stringify(key);
  const b64 = Buffer.from(keyJson, 'utf8').toString('base64');
  const commit = createHash('sha256').update(keyJson, 'utf8').digest('hex');
  await writeFile(join(OUT, 'key.json'), JSON.stringify({
    sealed: true,
    note: 'Answer key intentionally NOT plaintext. Decode: JSON.parse(atob(b64)). Verify: sha256(atob(b64)) === commit (matches the commitment printed on judging.html).',
    commit, b64,
  }, null, 2) + '\n');

  // Self-contained forced-choice sheet. Embeds ONLY the pair PNGs (by relative path) + the sha256
  // commitment. No mapping, no scene→side data, nothing that reveals which panel is the feature.
  const rowsHtml = sheetPairs.map((p, i) => `
    <section class="pair">
      <h2>Pair ${i + 1} <span class="pid">(${p.id})</span></h2>
      <img src="${p.file}" alt="${p.id}" />
      <div class="q">Which side reads more as <b>character art</b> (vs a dithered brightness field / washout)?
        <label><input type="radio" name="${p.id}" value="L"> Left</label>
        <label><input type="radio" name="${p.id}" value="R"> Right</label>
        <label><input type="radio" name="${p.id}" value="="> No difference</label>
      </div>
      <div class="q">Regression on either side (readability collapse / color banding)?
        <input type="text" name="${p.id}-note" placeholder="describe or leave blank" size="60" />
      </div>
    </section>`).join('\n');

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>ASCII-identity blind A/B — forced choice</title>
<style>
 body{font:15px/1.5 system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#111;background:#fafafa}
 .pair{border:1px solid #ccc;border-radius:8px;padding:1rem;margin:1.2rem 0;background:#fff}
 .pair img{max-width:100%;height:auto;image-rendering:pixelated;border:1px solid #eee}
 .pid{color:#999;font-weight:400;font-size:.8em}
 .q{margin:.6rem 0}.q label{margin-right:1.2rem}
 header{border-bottom:2px solid #111;padding-bottom:.6rem}
 .commit{font:12px/1.4 monospace;color:#555;word-break:break-all}
 button{font-size:15px;padding:.5rem 1rem;margin-top:1rem;cursor:pointer}
</style></head><body>
<header>
 <h1>ASCII-identity blind A/B — forced choice</h1>
 <p>Pre-registered forced-choice: for each pair pick the side that reads more as <b>character art</b>.
 Panels are baseline vs feature-on in a <b>seeded-random left/right order</b>; the answer key is sealed
 (base64 in <code>key.json</code>). This sheet contains <b>no</b> key — only the commitment below.</p>
 <p class="commit">key sha256 commitment: ${commit}</p>
</header>
${rowsHtml}
<button onclick="(function(){const o={};document.querySelectorAll('input:checked, input[type=text]').forEach(e=>{if(e.type==='text'){if(e.value)o[e.name]=e.value}else o[e.name]=e.value});const b=new Blob([JSON.stringify(o,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='ab-verdicts.json';a.click()})()">Export my picks (ab-verdicts.json)</button>
</body></html>`;
  await writeFile(join(OUT, 'judging.html'), html);

  // stdout: counts + commitment + paths ONLY. The mapping (which side is the feature) is NEVER printed.
  console.log(`composed ${sheetPairs.length} blind A/B pairs (seed ${seed}, charset ${CHARSET}) → ${OUT}`);
  console.log(`feature-on contestant: ${FEATURE_LABEL}`);
  console.log(`key sealed in key.json (base64); sha256 commitment ${commit}`);
  console.log(`open judging.html to judge; the answer key is NOT in the sheet or this output.`);
}

main().catch((e) => { console.error(e); process.exit(2); });
