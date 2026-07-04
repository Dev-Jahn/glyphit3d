import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Browser-side AOV bake. Served (transpiled) by scripts/bake-aov.ts and driven
// via Playwright: window.bake(modelUrl, opts) returns the five AOV PNGs as
// data-URLs plus meta. window.smoke() is the first-deliverable SwiftShader proof.
//
// Rendering is antialias:false on purpose: object-id / coverage passes must have
// sharp, exact per-pixel values (MSAA would blend an id=1 edge against bg=0 into
// fractional ids). The shaded/albedo passes lose MSAA smoothing but render at the
// exact grid footprint (no downsample), which is what the optimizer consumes.

interface BakeOpts {
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
}

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.NoToneMapping;

const YAW_DEG = 30;
const PITCH_DEG = -15; // downward tilt; camera is placed +15° ABOVE the target
const FOV_DEG = 35;
const FILL = 0.8; // sphere fills ~80% of the shorter view dimension

function gradientTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#232a33');
  g.addColorStop(1, '#05070a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function collectMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
}

// Mask AOVs (coverage/objectid) must honor KHR alphaMode:MASK cutouts, else masked
// geometry (e.g. Sponza foliage) renders SOLID in the mask passes while shaded/albedo
// honor the cutout. Copy the source alphaTest + alpha source (map/alphaMap) so the same
// fragments discard, then force the fragment RGB back to the flat mask color AFTER the
// texture multiply: the meshbasic chunk order is map → color → alphamap → alphatest, and
// map samples tint rgb AND scale alpha, so we keep the scaled alpha for the discard but
// overwrite rgb with the `diffuse` uniform (the flat color) just before alphatest. This
// keeps coverage flat white and the objectid R byte EXACT for opaque pixels (verified by
// sanityCheck's round-trip probe: G/B-leak=0, ids integral). Applied ONLY when the source
// actually cuts out (alphaTest>0), so opaque meshes render bit-identically to the plain
// flat-color override (no map sampling, no shader patch).
function applyMask(mat: THREE.MeshBasicMaterial, o: any): THREE.MeshBasicMaterial {
  if (o && o.alphaTest > 0 && (o.map || o.alphaMap)) {
    mat.alphaTest = o.alphaTest;
    if (o.map) mat.map = o.map;
    if (o.alphaMap) mat.alphaMap = o.alphaMap;
    if (o.side != null) mat.side = o.side;
    mat.onBeforeCompile = (shader: any) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <alphatest_fragment>',
        'diffuseColor.rgb = diffuse;\n\t#include <alphatest_fragment>',
      );
    };
  }
  return mat;
}

function frameCamera(scene: THREE.Object3D, aspect: number): THREE.PerspectiveCamera {
  const box = new THREE.Box3().setFromObject(scene);
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  const center = sphere.center;
  const radius = sphere.radius || 1;

  const cam = new THREE.PerspectiveCamera(FOV_DEG, aspect, 0.01, 100);
  const halfV = (FOV_DEG * Math.PI) / 180 / 2;
  const halfH = Math.atan(Math.tan(halfV) * aspect);
  const halfMin = Math.min(halfV, halfH);
  const dist = radius / Math.sin(FILL * halfMin);

  const yaw = (YAW_DEG * Math.PI) / 180;
  const el = -((PITCH_DEG * Math.PI) / 180); // pitch -15° (down) → camera 15° above
  const dir = new THREE.Vector3(
    Math.cos(el) * Math.sin(yaw),
    Math.sin(el),
    Math.cos(el) * Math.cos(yaw),
  );
  cam.position.copy(center).addScaledVector(dir, dist);
  cam.lookAt(center);
  cam.near = Math.max(0.001, dist - radius * 2);
  cam.far = dist + radius * 4;
  cam.updateProjectionMatrix();
  (cam as any).userData = { center, radius, dist };
  return cam;
}

function studioLights(cam: THREE.PerspectiveCamera): THREE.Group {
  const center = (cam as any).userData.center as THREE.Vector3;
  const radius = (cam as any).userData.radius as number;
  const g = new THREE.Group();

  const forward = center.clone().sub(cam.position).normalize();
  const right = new THREE.Vector3().crossVectors(forward, cam.up).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();

  const key = new THREE.DirectionalLight(0xfff1dd, 3.2); // warm
  const keyDir = right.clone().multiplyScalar(-1).add(up).addScaledVector(forward, 0.3).normalize();
  key.position.copy(center).addScaledVector(keyDir, radius * 4);
  key.target.position.copy(center);
  g.add(key, key.target);

  const rim = new THREE.DirectionalLight(0xaecbff, 2.0); // cool, back-right
  const rimDir = right.clone().addScaledVector(up, 0.3).addScaledVector(forward, -1).normalize();
  rim.position.copy(center).addScaledVector(rimDir, radius * 4);
  rim.target.position.copy(center);
  g.add(rim, rim.target);

  g.add(new THREE.AmbientLight(0xffffff, 0.22));
  return g;
}

function renderPNG(scene: THREE.Scene, cam: THREE.Camera): string {
  renderer.render(scene, cam);
  return canvas.toDataURL('image/png');
}

async function bake(modelUrl: string, opts: BakeOpts): Promise<{
  shaded: string; shading: string; albedo: string; objectid: string; coverage: string;
  meta: { camera: { yaw: number; pitch: number; dist: number }; meshCount: number; idOverflow: boolean };
}> {
  const gridW = opts.cols * opts.cellW;
  const gridH = opts.rows * opts.cellH;
  renderer.setSize(gridW, gridH, false);

  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(modelUrl);
  const scene = new THREE.Scene();
  scene.add(gltf.scene);

  const cam = frameCamera(gltf.scene, gridW / gridH);
  const meshes = collectMeshes(gltf.scene);
  const originals = meshes.map((m) => m.material);
  const grad = gradientTexture();

  const setOverride = (mk: (m: THREE.Mesh, i: number) => THREE.Material) => {
    meshes.forEach((m, i) => { m.material = mk(m, i); });
  };
  const restore = () => { meshes.forEach((m, i) => { m.material = originals[i]; }); };
  const firstMat = (m: THREE.Mesh): any => (Array.isArray(m.material) ? m.material[0] : m.material);

  // --- shaded: original PBR materials + studio lights, dark gradient bg
  THREE.ColorManagement.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const lights = studioLights(cam);
  scene.add(lights);
  scene.background = grad;
  const shaded = renderPNG(scene, cam);

  // --- shading: albedo-free light-only (all-white standard) + same lights
  setOverride(() => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 }));
  const shading = renderPNG(scene, cam);
  restore();
  scene.remove(lights);

  // --- albedo: unlit baseColor (original map/color), same bg
  setOverride((m) => {
    const o = firstMat(m);
    const mat = new THREE.MeshBasicMaterial();
    if (o && o.map) mat.map = o.map;
    if (o && o.color) mat.color.copy(o.color);
    if (o) { mat.transparent = !!o.transparent; mat.alphaTest = o.alphaTest || 0; mat.side = o.side; mat.vertexColors = !!o.vertexColors; }
    return mat;
  });
  const albedo = renderPNG(scene, cam);
  restore();

  // --- coverage: geometry white on black, unlit (honors alpha cutouts, §applyMask)
  scene.background = null;
  renderer.setClearColor(0x000000, 1);
  setOverride((m) => applyMask(new THREE.MeshBasicMaterial({ color: 0xffffff }), firstMat(m)));
  const coverage = renderPNG(scene, cam);
  restore();

  // --- objectid: per-mesh flat id in R, G=B=0, DATA (no color management)
  THREE.ColorManagement.enabled = false;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  setOverride((m, i) => {
    const mat = new THREE.MeshBasicMaterial();
    mat.color.setRGB((i + 1) / 255, 0, 0); // CM off → raw byte
    return applyMask(mat, firstMat(m)); // keeps R byte exact; only masks cutout fragments
  });
  const objectid = renderPNG(scene, cam);
  restore();
  THREE.ColorManagement.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // §4.2: id = traversal index+1 encoded in the R byte. Index > 254 (>255 meshes) makes
  // ids ≥256 clamp/collide — flag it (no encoding change at M1). Reported via meta.
  const idOverflow = meshes.length > 255;
  if (idOverflow) console.warn(`objectid overflow: ${meshes.length} meshes; traversal index exceeds 254 → ids >255 collide in the R byte.`);

  const ud = (cam as any).userData;
  return {
    shaded, shading, albedo, objectid, coverage,
    meta: { camera: { yaw: YAW_DEG, pitch: PITCH_DEG, dist: ud.dist }, meshCount: meshes.length, idOverflow },
  };
}

function smoke(): string {
  renderer.setSize(240, 240, false);
  THREE.ColorManagement.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070a);
  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0xcc7744, roughness: 0.6, metalness: 0.1 }),
  );
  scene.add(cube);
  const cam = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  cam.position.set(2, 1.5, 2.5);
  cam.lookAt(0, 0, 0);
  const key = new THREE.DirectionalLight(0xffffff, 3);
  key.position.set(-2, 3, 2);
  scene.add(key, new THREE.AmbientLight(0xffffff, 0.3));
  return renderPNG(scene, cam);
}

declare global {
  interface Window {
    bake: typeof bake;
    smoke: typeof smoke;
    __ready: boolean;
  }
}

window.bake = bake;
window.smoke = smoke;
window.__ready = true;
