import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// three.js reference render (M2-SPEC §2, DESIGN §9). WebGLRenderer works under
// SwiftShader headless (proven in M1). The default scene is a TorusKnot with the
// M1 studio-light preset; drag&drop .glb/.gltf replaces the model. The render
// target is sized to the grid footprint and read back as ImageData for the matcher.

// M1 framing + light constants (render3d/page.ts) reused verbatim.
const FOV_DEG = 35;
const FILL = 0.8; // model fills ~80% of the shorter view dimension

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

function defaultModel(): THREE.Object3D {
  const geo = new THREE.TorusKnotGeometry(0.6, 0.24, 220, 32);
  const mat = new THREE.MeshStandardMaterial({ color: 0xcc7744, roughness: 0.35, metalness: 0.25 });
  return new THREE.Mesh(geo, mat);
}

export class Scene {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.01, 100);
  private readonly group = new THREE.Group();
  private lights: THREE.Group | null = null;
  private center = new THREE.Vector3();
  private radius = 1;

  yawDeg = 30;
  pitchDeg = -15;
  onOrbitEnd: (() => void) | null = null;
  onOrbitMove: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    THREE.ColorManagement.enabled = true;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.background = gradientTexture();
    this.scene.add(this.group);
    this.setModel(defaultModel());
    // SwiftShader/headless reads back the very first WebGL frame blank; prime it
    // once here so the initial renderToImageData returns a real image.
    this.renderer.setSize(16, 16, false);
    this.placeCamera(1);
    this.renderer.render(this.scene, this.camera);
    this.attachOrbit(canvas);
  }

  setModel(obj: THREE.Object3D): void {
    this.group.clear();
    this.group.add(obj);
    const box = new THREE.Box3().setFromObject(obj);
    const sphere = new THREE.Sphere();
    box.getBoundingSphere(sphere);
    this.center.copy(sphere.center);
    this.radius = sphere.radius || 1;
    this.rebuildLights();
  }

  async loadGLB(url: string): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(url);
    this.setModel(gltf.scene);
  }

  private rebuildLights(): void {
    if (this.lights) this.scene.remove(this.lights);
    this.placeCamera(1);
    const g = new THREE.Group();
    const forward = this.center.clone().sub(this.camera.position).normalize();
    const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();
    const r = this.radius;

    const key = new THREE.DirectionalLight(0xfff1dd, 3.2); // warm
    const keyDir = right.clone().multiplyScalar(-1).add(up).addScaledVector(forward, 0.3).normalize();
    key.position.copy(this.center).addScaledVector(keyDir, r * 4);
    key.target.position.copy(this.center);
    g.add(key, key.target);

    const rim = new THREE.DirectionalLight(0xaecbff, 2.0); // cool, back-right
    const rimDir = right.clone().addScaledVector(up, 0.3).addScaledVector(forward, -1).normalize();
    rim.position.copy(this.center).addScaledVector(rimDir, r * 4);
    rim.target.position.copy(this.center);
    g.add(rim, rim.target);

    g.add(new THREE.AmbientLight(0xffffff, 0.22));
    this.lights = g;
    this.scene.add(g);
  }

  // Place the camera from yaw/pitch at the FILL-framed distance for the given aspect.
  private placeCamera(aspect: number): void {
    const halfV = (FOV_DEG * Math.PI) / 180 / 2;
    const halfH = Math.atan(Math.tan(halfV) * aspect);
    const halfMin = Math.min(halfV, halfH);
    const dist = this.radius / Math.sin(FILL * halfMin);

    const yaw = (this.yawDeg * Math.PI) / 180;
    const el = -((this.pitchDeg * Math.PI) / 180); // pitch -15° (down) → camera above
    const dir = new THREE.Vector3(
      Math.cos(el) * Math.sin(yaw),
      Math.sin(el),
      Math.cos(el) * Math.cos(yaw),
    );
    this.camera.aspect = aspect;
    this.camera.position.copy(this.center).addScaledVector(dir, dist);
    this.camera.lookAt(this.center);
    this.camera.near = Math.max(0.001, dist - this.radius * 2);
    this.camera.far = dist + this.radius * 4;
    this.camera.updateProjectionMatrix();
  }

  setOrbit(yawDeg: number, pitchDeg: number): void {
    this.yawDeg = yawDeg;
    this.pitchDeg = Math.max(-89, Math.min(89, pitchDeg));
  }

  // Render at the grid footprint and read the frame back as sRGB ImageData.
  renderToImageData(gridW: number, gridH: number): ImageData {
    this.renderer.setSize(gridW, gridH, false);
    this.placeCamera(gridW / gridH);
    this.renderer.render(this.scene, this.camera);
    const src = this.renderer.domElement;
    const c2d = document.createElement('canvas');
    c2d.width = gridW;
    c2d.height = gridH;
    const ctx = c2d.getContext('2d')!;
    ctx.drawImage(src, 0, 0);
    return ctx.getImageData(0, 0, gridW, gridH);
  }

  // Orbit input, attachable to any surface (constructor: renderer canvas; UI: the
  // scrubber stage). Per-call closure state keeps each attached surface independent.
  // onOrbitMove fires after every drag re-render; onOrbitEnd on pointerup/cancel.
  // Scoped to one pointerId: the stage is an ancestor of the divider handle, so a
  // captured handle-drag pointer's moves bubble here — filtering by id stops a second
  // finger's divider drag from also orbiting the camera.
  attachOrbit(target: HTMLElement): void {
    let activeId: number | null = null;
    let px = 0;
    let py = 0;
    target.addEventListener('pointerdown', (e) => {
      if (activeId !== null) return;
      activeId = e.pointerId; px = e.clientX; py = e.clientY;
      target.setPointerCapture(e.pointerId);
    });
    target.addEventListener('pointermove', (e) => {
      if (e.pointerId !== activeId) return;
      this.setOrbit(this.yawDeg + (e.clientX - px) * 0.5, this.pitchDeg - (e.clientY - py) * 0.5);
      px = e.clientX; py = e.clientY;
      this.placeCamera(this.camera.aspect);
      this.renderer.render(this.scene, this.camera);
      this.onOrbitMove?.();
    });
    const end = (e: PointerEvent): void => {
      if (e.pointerId !== activeId) return;
      activeId = null;
      target.releasePointerCapture(e.pointerId);
      this.onOrbitEnd?.();
    };
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  }
}
