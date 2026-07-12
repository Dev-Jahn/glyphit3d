import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Scene } from './scene.js';

// fix/model-drop-latest-wins. Two overlapping model drops must be latest-request-wins: whichever
// loadGLB was requested LAST commits, and an older request whose load resolves LATER is dropped
// (it must never clobber the newer model). We drive the REAL loadGLB against an injected loader,
// isolating it from the WebGL constructor via a bare prototype instance whose setModel records
// commits — so no DOM/WebGL is needed. RED on the current code: loadGLB has no generation guard and
// no injectable loader seam, so the injected loader is ignored (the real GLTFLoader load rejects).

// A GLB load whose resolution the test controls: resolve(model) settles it with a scene object.
function deferredLoad(): { promise: Promise<{ scene: THREE.Object3D }>; resolve: (m: THREE.Object3D) => void } {
  let resolve!: (m: THREE.Object3D) => void;
  const promise = new Promise<{ scene: THREE.Object3D }>((res) => { resolve = (m) => res({ scene: m }); });
  return { promise, resolve };
}

// A Scene with only the state loadGLB touches — no constructor, so no WebGLRenderer. setModel is
// stubbed to record which model object is committed (the real one needs a live GL scene graph).
function bareScene(): { scene: Scene; committed: THREE.Object3D[] } {
  const scene = Object.create(Scene.prototype) as Scene;
  (scene as unknown as { modelSeq: number }).modelSeq = 0;
  const committed: THREE.Object3D[] = [];
  (scene as unknown as { setModel: (o: THREE.Object3D) => void }).setModel = (o) => { committed.push(o); };
  return { scene, committed };
}

describe('Scene.loadGLB latest-request-wins (fix/model-drop-latest-wins)', () => {
  it('drops a stale older-requested load that resolves last; the latest model commits', async () => {
    const { scene, committed } = bareScene();
    const older = deferredLoad();
    const newer = deferredLoad();
    const modelOld = new THREE.Object3D();
    const modelNew = new THREE.Object3D();

    // Two overlapping drops; loadGLB captures its generation synchronously, so the second call
    // supersedes the first before either load resolves.
    const p1 = scene.loadGLB('old.glb', () => older.promise);
    const p2 = scene.loadGLB('new.glb', () => newer.promise);

    // Resolve in REVERSE order: the newer (latest) settles first and commits…
    newer.resolve(modelNew);
    await p2;
    expect(committed).toEqual([modelNew]);

    // …then the older resolves LAST and must be DROPPED (its generation is stale).
    older.resolve(modelOld);
    await p1;
    expect(committed).toEqual([modelNew]); // modelOld never committed
  });

  it('a single drop commits normally (invariant: single drop unchanged)', async () => {
    const { scene, committed } = bareScene();
    const only = deferredLoad();
    const model = new THREE.Object3D();
    const p = scene.loadGLB('solo.glb', () => only.promise);
    only.resolve(model);
    await p;
    expect(committed).toEqual([model]);
  });
});
