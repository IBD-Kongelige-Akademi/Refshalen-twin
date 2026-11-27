// js/harbour-bus.js
// Copenhagen's harbour buses (Movia lines 991 south / 992 north, data/city/ferry-lines.json from tools/geodata/bus_lines.py build_ferries):
// boats that sail the real sailing line through the district, slow down for each stop (Refshaleøen, Nordre Toldbod, Operaen,
// Nyhavn), lie alongside for a while and sail on. A boat that reaches the end of its line inside the district turns into the
// other line and sails back, so the district always has boats in both directions.
//
// The boat is a simple model of an electric harbour bus (about 23 x 6.5 m: a dark hull, a white deck, a glazed cabin under a
// Movia-yellow band and a pale roof); it is not a measured model of the real boats. The motion is js/harbour-bus-motion.js.

import * as THREE from 'three/webgpu';
import { makePath, harbourBusMotion } from './harbour-bus-motion.js';

const LENGTH = 23, BEAM = 6.5;

function boatModel() {
  const g = new THREE.Group();
  g.name = 'harbour-bus';
  const mat = (c, r = 0.6, m = 0) => new THREE.MeshStandardNodeMaterial({ color: c, roughness: r, metalness: m });
  const hull = new THREE.Mesh(new THREE.BoxGeometry(BEAM, 1.6, LENGTH), mat(0x23303c, 0.5, 0.2));
  hull.position.y = 0.2;
  const bowL = LENGTH / 2;
  // a tapered bow and stern: two wedges
  const wedge = new THREE.CylinderGeometry(BEAM / 2, BEAM / 2, 1.6, 3, 1, false, Math.PI / 2, Math.PI);
  const bow = new THREE.Mesh(wedge, hull.material);
  bow.scale.set(1, 1, 0.55); bow.position.set(0, 0.2, bowL); bow.rotation.y = Math.PI;
  const stern = new THREE.Mesh(wedge, hull.material);
  stern.scale.set(1, 1, 0.4); stern.position.set(0, 0.2, -bowL);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(BEAM - 0.1, 0.12, LENGTH), mat(0xe8e8e4, 0.7));
  deck.position.y = 1.06;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(BEAM - 1.2, 2.2, LENGTH * 0.62), mat(0x1b2b36, 0.08, 0.6));
  cabin.position.set(0, 2.2, -0.8);
  const band = new THREE.Mesh(new THREE.BoxGeometry(BEAM - 1.15, 0.45, LENGTH * 0.62 + 0.05), mat(0xf7c600, 0.5));
  band.position.set(0, 3.32, -0.8);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(BEAM - 0.8, 0.22, LENGTH * 0.66), mat(0xf2f2ee, 0.6));
  roof.position.set(0, 3.66, -0.8);
  const wheel = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.0, 1.8), mat(0x1b2b36, 0.08, 0.6));
  wheel.position.set(0, 4.25, LENGTH * 0.18);
  for (const m of [hull, bow, stern, deck, cabin, band, roof, wheel]) { m.castShadow = true; g.add(m); }
  return g;
}

/**
 * The boats in the scene: setLines(doc) builds them from ferry-lines.json, update(dt, t) moves them.
 * `waterLevel` is the local y of the sea (js/tile-grid.js SEA_LEVEL_LOCAL).
 */
export function createHarbourBuses(scene, { waterLevel = 0, perLine = 1 } = {}) {
  const group = new THREE.Group();
  group.name = 'harbour-buses';
  scene.add(group);
  const boats = [];
  const stats = { boats: 0, lines: 0 };
  function setLines(doc) {
    for (const b of boats) group.remove(b.mesh);
    boats.length = 0;
    const lines = [];
    for (const line of doc?.lines || []) {
      for (const d of line.directions || []) {
        if (!d.path || d.path.length < 4) continue;
        lines.push({ ref: line.ref, path: makePath(d.path), stops: (d.stops || []).map((s) => s.s) });
      }
    }
    stats.lines = lines.length;
    if (!lines.length) return;
    // one boat per line, half-way along it, so the two directions are not in step
    for (let k = 0; k < lines.length; k++) {
      for (let j = 0; j < perLine; j++) {
        const motion = harbourBusMotion(lines, { line: k, s: lines[k].path.total * ((j + 0.45) / (perLine + 0.5)) });
        const mesh = boatModel();
        group.add(mesh);
        boats.push({ motion, mesh, phase: k * 1.7 + j });
      }
    }
    stats.boats = boats.length;
  }
  function update(dt, t = 0) {
    const step = Math.min(dt, 0.1);
    for (const b of boats) {
      b.motion.step(step);
      const p = b.motion.pose();
      b.mesh.position.set(p.x, waterLevel + 0.05 * Math.sin(t * 0.9 + b.phase), p.z);
      b.mesh.rotation.set(0.006 * Math.sin(t * 0.7 + b.phase), p.heading, 0.01 * Math.sin(t * 0.6 + b.phase));
    }
  }
  return { group, setLines, update, boats, stats };
}
