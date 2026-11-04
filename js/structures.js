import * as THREE from 'three/webgpu';
import { attribute, color, float, step, abs, fract, mix, clamp } from 'three/tsl';
import { buildDeckArrays, buildTrackArrays, KIND } from './structures-geometry.js';

// js/structures.js
// The streamed `structures` layer (tools/geodata/city_structures.py): bridge decks and railway tracks. A deck or a track is listed whole by
// every tile it touches; it is built once (js/structures-geometry.js) when the first of them comes in and dropped with the last. The decks
// also go into the deck field (js/deck-field.js), which the ground model stands on (withDecks).

let material = null;
function structuresMaterial() {
  if (material) return material;
  const k = attribute('kind', 'float');
  const along = attribute('along', 'float');
  const is = (v) => step(abs(k.sub(v)), 0.25);
  // sleepers on the ballast top: concrete beams 0.65 m apart, a quarter of the spacing wide (along < 0 on the bed's slopes)
  const sleeper = step(0, along).mul(step(fract(along.div(0.65)), 0.27));
  const ballast = mix(color(0x6f6d69), color(0x9a978f), sleeper);
  let c = color(0x3b3e42); // road deck: asphalt
  c = mix(c, color(0x8f877d), is(KIND.foot)); // foot bridge: paving
  c = mix(c, color(0x6f6d69), is(KIND.ballastDeck));
  c = mix(c, color(0xa8a49c), is(KIND.concrete));
  c = mix(c, color(0x2c3034), is(KIND.metal));
  c = mix(c, ballast, is(KIND.ballast));
  c = mix(c, color(0x8e9399), is(KIND.steel));
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide });
  m.colorNode = c;
  m.roughnessNode = mix(float(0.88), float(0.35), clamp(is(KIND.steel).add(is(KIND.metal).mul(0.6)), 0, 1));
  m.metalnessNode = mix(float(0.0), float(0.8), is(KIND.steel));
  m.polygonOffset = true; // where the terrain carries a bridge the draped road lies on the deck top: the road wins
  m.polygonOffsetFactor = 1;
  m.polygonOffsetUnits = 2;
  m.name = 'structures';
  return (material = m);
}

function toMesh(a, name) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(a.position, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(a.normal, 3));
  g.setAttribute('kind', new THREE.Float32BufferAttribute(a.kind, 1));
  g.setAttribute('along', new THREE.Float32BufferAttribute(a.along, 1));
  g.setIndex(a.index);
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, structuresMaterial());
  mesh.name = name;
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

/**
 * `field`: the deck field (js/deck-field.js createDeckField). The decks and tracks carry their own heights (no terrain needed).
 */
export function createStructuresLayer(scene, { field }) {
  const group = new THREE.Group();
  group.name = 'structures';
  scene.add(group);
  const items = new Map(); // 'deck:<id>' | 'rail:<id>' -> { mesh, tiles: Set }
  const byTile = new Map();
  const stats = { decks: 0, tracks: 0, triangles: 0, builds: 0, buildMs: 0 };

  function take(key, tile, build) {
    let it = items.get(key);
    if (!it) {
      const t0 = performance.now();
      const mesh = build();
      stats.builds++;
      stats.buildMs += performance.now() - t0;
      it = { mesh, tiles: new Set() };
      items.set(key, it);
      if (mesh) {
        group.add(mesh);
        stats.triangles += mesh.geometry.index.count / 3;
      }
    }
    it.tiles.add(tile);
  }

  function addTile(tile, layer) {
    removeTile(tile);
    if (!layer) return;
    const keys = [];
    field.add(tile, layer.decks || []);
    for (const d of layer.decks || []) {
      const key = `deck:${d.id}`;
      keys.push(key);
      take(key, tile, () => {
        const { arrays } = buildDeckArrays(d);
        stats.decks++;
        return arrays.index.length ? toMesh(arrays, `deck-${d.id}${d.name ? ` ${d.name}` : ''}`) : null;
      });
    }
    for (const r of layer.rails || []) {
      const key = `rail:${r.id}`;
      keys.push(key);
      take(key, tile, () => {
        const { arrays } = buildTrackArrays(r);
        stats.tracks++;
        return arrays.index.length ? toMesh(arrays, `track-${r.id}`) : null;
      });
    }
    byTile.set(tile, keys);
  }

  function removeTile(tile) {
    const keys = byTile.get(tile);
    if (!keys) return;
    byTile.delete(tile);
    field.remove(tile);
    for (const key of keys) {
      const it = items.get(key);
      if (!it) continue;
      it.tiles.delete(tile);
      if (it.tiles.size) continue;
      if (it.mesh) {
        stats.triangles -= it.mesh.geometry.index.count / 3;
        group.remove(it.mesh);
        it.mesh.geometry.dispose();
      }
      items.delete(key);
      if (key.startsWith('deck:')) stats.decks--;
      else stats.tracks--;
    }
  }

  return { group, addTile, removeTile, stats };
}
