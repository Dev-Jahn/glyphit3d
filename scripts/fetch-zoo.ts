import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// M1-SPEC §2: fetch the FIXED model zoo from KhronosGroup/glTF-Sample-Assets,
// "glTF" variant only (separate .gltf + .bin + textures — no Draco, no KTX2),
// into bench/zoo/ (gitignored). If a model's glTF variant is unavailable, we
// substitute in the FIXED order ABeautifulGame → Corset → Lantern and print the
// substitution. NO result-based swapping.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'bench', 'zoo');
const BASE = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models';

const PRIMARY = ['DamagedHelmet', 'FlightHelmet', 'BoomBox', 'SciFiHelmet', 'Fox', 'Sponza'];
const SUBSTITUTES = ['ABeautifulGame', 'Corset', 'Lantern'];

// Resolve any relative uri in a .gltf (buffers[].uri, images[].uri), skipping
// data: uris. Fetch each sibling asset preserving its relative path.
function assetUris(gltf: any): string[] {
  const uris: string[] = [];
  for (const arr of [gltf.buffers, gltf.images]) {
    if (!Array.isArray(arr)) continue;
    for (const e of arr) {
      if (e && typeof e.uri === 'string' && !e.uri.startsWith('data:')) uris.push(e.uri);
    }
  }
  return [...new Set(uris)];
}

async function fetchModel(name: string, destName: string): Promise<boolean> {
  const gltfUrl = `${BASE}/${name}/glTF/${name}.gltf`;
  const res = await fetch(gltfUrl);
  if (!res.ok) { console.log(`  ${name}: glTF variant unavailable (${res.status})`); return false; }
  const text = await res.text();
  const gltf = JSON.parse(text);

  const dir = join(OUT, destName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${destName}.gltf`), text);

  const uris = assetUris(gltf);
  for (const uri of uris) {
    const assetUrl = `${BASE}/${name}/glTF/${uri}`;
    const ar = await fetch(assetUrl);
    if (!ar.ok) { console.log(`  ${name}: asset ${uri} failed (${ar.status})`); return false; }
    const outPath = join(dir, uri);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, Buffer.from(await ar.arrayBuffer()));
  }
  console.log(`  ${destName}: ${name}.gltf + ${uris.length} asset(s) -> ${dir}`);
  return true;
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const subs = [...SUBSTITUTES];
  const fetched: string[] = [];
  for (const primary of PRIMARY) {
    let ok = await fetchModel(primary, primary);
    let used = primary;
    while (!ok && subs.length) {
      const sub = subs.shift()!;
      console.log(`  substituting ${primary} -> ${sub} (fixed order)`);
      ok = await fetchModel(sub, sub);
      used = sub;
    }
    if (ok) fetched.push(used);
    else console.log(`  ${primary}: no available substitute (exhausted)`);
  }
  console.log(`done: ${fetched.length}/${PRIMARY.length} models in bench/zoo/ [${fetched.join(', ')}]`);
}

main().catch((e) => { console.error(e); process.exit(1); });
