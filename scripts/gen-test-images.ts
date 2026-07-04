import { mkdir } from 'node:fs/promises';
import type { LinearImage } from '../src/core/types.js';
import { savePng } from '../src/render/raster.js';

// All shading done in linear RGB [0,1]; savePng encodes to sRGB.
const N = 512;

function newImg(): LinearImage {
  return { w: N, h: N, data: new Float32Array(N * N * 3) };
}
function put(img: LinearImage, x: number, y: number, r: number, g: number, b: number): void {
  const i = (y * N + x) * 3;
  img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b;
}
function norm(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function dot(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

const LIGHT = norm([-0.5, -0.6, 0.9]);
const VIEW: [number, number, number] = [0, 0, 1];

// (1) Lambert + specular shaded sphere on a dark vertical gradient background.
function sphereImage(): LinearImage {
  const img = newImg();
  const cx = N / 2, cy = N / 2, R = N * 0.4;
  const albedo: [number, number, number] = [0.85, 0.35, 0.25];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = x - cx, dy = y - cy;
      const r2 = dx * dx + dy * dy;
      if (r2 <= R * R) {
        const nz = Math.sqrt(R * R - r2);
        const nrm = norm([dx, dy, nz]);
        const diff = Math.max(0, dot(nrm, LIGHT));
        const h = norm([LIGHT[0] + VIEW[0], LIGHT[1] + VIEW[1], LIGHT[2] + VIEW[2]]);
        const spec = Math.pow(Math.max(0, dot(nrm, h)), 40);
        const amb = 0.05;
        put(img, x, y,
          Math.min(1, albedo[0] * (amb + diff) + spec),
          Math.min(1, albedo[1] * (amb + diff) + spec),
          Math.min(1, albedo[2] * (amb + diff) + spec));
      } else {
        const g = 0.02 + 0.10 * (y / N);
        put(img, x, y, g * 0.4, g * 0.5, g);
      }
    }
  }
  return img;
}

// (2) Torus via analytic raymarch (SDF), lambert + specular.
function torusSDF(p: [number, number, number]): number {
  const R = 0.55, r = 0.22;
  const qx = Math.hypot(p[0], p[2]) - R;
  return Math.hypot(qx, p[1]) - r;
}
function torusNormal(p: [number, number, number]): [number, number, number] {
  const e = 1e-3;
  const dxv = torusSDF([p[0] + e, p[1], p[2]]) - torusSDF([p[0] - e, p[1], p[2]]);
  const dyv = torusSDF([p[0], p[1] + e, p[2]]) - torusSDF([p[0], p[1] - e, p[2]]);
  const dzv = torusSDF([p[0], p[1], p[2] + e]) - torusSDF([p[0], p[1], p[2] - e]);
  return norm([dxv, dyv, dzv]);
}
function torusImage(): LinearImage {
  const img = newImg();
  // tilt the torus so the hole is visible
  const ca = Math.cos(1.0), sa = Math.sin(1.0);
  const albedo: [number, number, number] = [0.25, 0.55, 0.85];
  const ro: [number, number, number] = [0, 0, 2.5];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = (x / N) * 2 - 1;
      const v = (y / N) * 2 - 1;
      const rd = norm([u, v, -1.5]);
      let t = 0, hit = false, p: [number, number, number] = [0, 0, 0];
      for (let s = 0; s < 80; s++) {
        p = [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t];
        // rotate sample into torus space about X axis
        const pr: [number, number, number] = [p[0], ca * p[1] - sa * p[2], sa * p[1] + ca * p[2]];
        const d = torusSDF(pr);
        if (d < 1e-3) { hit = true; p = pr; break; }
        t += d;
        if (t > 6) break;
      }
      if (hit) {
        const nrm = torusNormal(p);
        const diff = Math.max(0, dot(nrm, LIGHT));
        const h = norm([LIGHT[0] + VIEW[0], LIGHT[1] + VIEW[1], LIGHT[2] + VIEW[2]]);
        const spec = Math.pow(Math.max(0, dot(nrm, h)), 30);
        const amb = 0.06;
        put(img, x, y,
          Math.min(1, albedo[0] * (amb + diff) + spec),
          Math.min(1, albedo[1] * (amb + diff) + spec),
          Math.min(1, albedo[2] * (amb + diff) + spec));
      } else {
        const g = 0.03 + 0.06 * (x / N);
        put(img, x, y, g, g * 0.9, g * 0.8);
      }
    }
  }
  return img;
}

// (3) Three overlapping matte (lambert) spheres, distinct hues, z-buffered.
function spheresImage(): LinearImage {
  const img = newImg();
  const R = N * 0.26;
  const spheres: { cx: number; cy: number; cz: number; col: [number, number, number] }[] = [
    { cx: N * 0.38, cy: N * 0.42, cz: 0, col: [0.85, 0.20, 0.20] },
    { cx: N * 0.60, cy: N * 0.40, cz: 30, col: [0.20, 0.75, 0.30] },
    { cx: N * 0.50, cy: N * 0.62, cz: 60, col: [0.25, 0.35, 0.90] },
  ];
  const zbuf = new Float32Array(N * N).fill(-Infinity);
  // dark background
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) put(img, x, y, 0.02, 0.02, 0.03);
  for (const s of spheres) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const dx = x - s.cx, dy = y - s.cy;
        const r2 = dx * dx + dy * dy;
        if (r2 > R * R) continue;
        const nz = Math.sqrt(R * R - r2);
        const zw = nz + s.cz;
        const zi = y * N + x;
        if (zw <= zbuf[zi]!) continue;
        zbuf[zi] = zw;
        const nrm = norm([dx, dy, nz]);
        const diff = Math.max(0, dot(nrm, LIGHT));
        const amb = 0.08;
        put(img, x, y, s.col[0] * (amb + diff), s.col[1] * (amb + diff), s.col[2] * (amb + diff));
      }
    }
  }
  return img;
}

async function main(): Promise<void> {
  const dir = 'bench/images';
  await mkdir(dir, { recursive: true });
  await savePng(sphereImage(), `${dir}/sphere.png`);
  await savePng(torusImage(), `${dir}/torus.png`);
  await savePng(spheresImage(), `${dir}/spheres.png`);
  console.log(`wrote ${dir}/{sphere,torus,spheres}.png (512x512)`);
}

main();
