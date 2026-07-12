import * as THREE from 'three';
import { TeapotGeometry } from 'three/addons/geometries/TeapotGeometry.js';

// feat/web-model-picker: procedural three.js models for the demo model dropdown. Zero new deps —
// all THREE core geometries except the Utah Teapot, which ships in the three package's addons
// (three/addons/geometries/TeapotGeometry.js), same as the GLTFLoader addon scene.ts already uses.
// setModel (main.ts) takes a name, builds the mesh here with the studio material preset (reused from
// scene.ts defaultModel), and hands it to scene.setModel — the SAME commit path as a drag-dropped GLB
// (bounds-driven reframing + lights). The default stays the torus knot (first-load unchanged).

export type ModelName =
  | 'torusknot' | 'sphere' | 'torus' | 'box' | 'cone' | 'cylinder' | 'icosahedron' | 'teapot';

export const MODELS: readonly ModelName[] = [
  'torusknot', 'sphere', 'torus', 'box', 'cone', 'cylinder', 'icosahedron', 'teapot',
];

export function isModelName(s: string): s is ModelName {
  return (MODELS as readonly string[]).includes(s);
}

// The studio material preset shared with scene.ts's default torus knot.
function studioMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0xcc7744, roughness: 0.35, metalness: 0.25 });
}

// Radii/sizes are tuned to a ~unit bounding sphere so every model fills the frame comparably (the
// scene reframes to bounds anyway, but similar scales keep the perceived size steady across swaps).
function geometryFor(name: ModelName): THREE.BufferGeometry {
  switch (name) {
    case 'torusknot': return new THREE.TorusKnotGeometry(0.6, 0.24, 220, 32); // == scene.ts defaultModel
    case 'sphere': return new THREE.SphereGeometry(0.85, 64, 48);
    case 'torus': return new THREE.TorusGeometry(0.6, 0.26, 32, 96);
    case 'box': return new THREE.BoxGeometry(1.15, 1.15, 1.15);
    case 'cone': return new THREE.ConeGeometry(0.75, 1.4, 64);
    case 'cylinder': return new THREE.CylinderGeometry(0.6, 0.6, 1.3, 64);
    case 'icosahedron': return new THREE.IcosahedronGeometry(0.9, 0);
    case 'teapot': return new TeapotGeometry(0.62);
  }
}

// No fallback: an unknown name is a wiring bug — setModel (main.ts) validates via isModelName first,
// and the TS union makes geometryFor exhaustive.
export function makeModel(name: ModelName): THREE.Mesh {
  return new THREE.Mesh(geometryFor(name), studioMaterial());
}
