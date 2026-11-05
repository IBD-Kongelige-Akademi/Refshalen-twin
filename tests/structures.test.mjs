// Bridge decks and railway tracks (the `structures` layer, tools/geodata/city_structures.py): the deck field the ground model stands on,
// levelAt for what drives onto a bridge or passes under it, and the deck / track geometry.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeckField, withDecks, deckHeight, deckGround, pointInRings, DECK_REACH } from '../js/deck-field.js';
import { buildDeckArrays, buildTrackArrays, KIND } from '../js/structures-geometry.js';

// a 40 m road bridge 8 m wide along +x, its deck 6 m over water at -1 m; ground at its ends meets the deck
const ring = [];
for (let x = 0; x <= 40; x += 4) ring.push(x, -4);
for (let x = 40; x >= 0; x -= 4) ring.push(x, 4);
const axis = [];
for (let x = 0; x <= 40; x += 2) {
  const g = x < 4 || x > 36 ? 5 : -1;
  axis.push(x, 0, 5, g);
}
const deck = { id: 'deck:t', kind: 'road', ring, ringG: ring.filter((_, i) => i % 2 === 0).map((x) => (x < 4 || x > 36 ? 5 : -1)), holes: [], holesG: [], axes: [{ way: 'w', kind: 'road', pts: axis }], clear: 6 };

test('the deck field finds a deck, shares it between tiles and lets it go with the last', () => {
  const f = createDeckField();
  f.add('a', [deck]);
  f.add('b', [deck]);
  assert.equal(f.size, 1);
  assert.equal(f.deckAt(20, 0), 5);
  assert.equal(f.deckAt(20, 9), null, 'beside it');
  f.remove('a');
  assert.equal(f.deckAt(20, 0), 5, 'still held by tile b');
  f.remove('b');
  assert.equal(f.deckAt(20, 0), null);
  assert.ok(pointInRings(20, 0, ring) && !pointInRings(50, 0, ring));
  assert.equal(deckHeight(deck, 20, 3), 5);
  assert.equal(deckGround(deck, 20, 0), -1);
});

test('levelAt: onto the deck from its end it stays on, under it it stays under', () => {
  const f = createDeckField();
  f.add('a', [deck]);
  const g = withDecks(f, { heightAt: () => -1, terrainAt: () => -1 });
  assert.equal(g.terrainAt(20, 0), 5, 'static things stand on the deck');
  assert.equal(g.levelAt(20, 0, 5), 5, 'on it');
  assert.equal(g.levelAt(20, 0, 5 - DECK_REACH + 0.1), 5, 'just under its level counts as on it');
  assert.equal(g.levelAt(20, 0, -1), -1, 'passing under');
  assert.equal(g.levelAt(60, 0, 5), -1, 'off the deck');
  // a deck the DSM sank under the ground loses to the ground
  const low = withDecks(f, { heightAt: () => 9, terrainAt: () => 9 });
  assert.equal(low.terrainAt(20, 0), 9);
});

test('a deck has a top, a soffit and fascia where it stands clear, parapets over the water and piers into it', () => {
  const { arrays, stats } = buildDeckArrays(deck);
  assert.ok(arrays.position.every(Number.isFinite));
  const kinds = new Set(arrays.kind);
  assert.ok(kinds.has(KIND.road) && kinds.has(KIND.concrete));
  assert.ok(stats.parapetM > 50 && stats.parapetM < 90, `parapets ${stats.parapetM} m`);
  assert.equal(stats.piers, 1, 'one pier in 40 m at 24 m spacing');
  // the top faces up
  const ys = [];
  for (let i = 0; i < arrays.kind.length; i++) if (arrays.kind[i] === KIND.road) ys.push(arrays.position[3 * i + 1]);
  assert.ok(Math.min(...ys) > 4.8 && Math.max(...ys) < 5.2);
  const foot = buildDeckArrays({ ...deck, kind: 'foot' });
  assert.ok(new Set(foot.arrays.kind).has(KIND.metal), 'a foot bridge has railings');
});

test('a track lies at the heights it carries, two rails on a ballast bed with sleepers', () => {
  const pts = [];
  for (let x = 0; x <= 100; x += 4) pts.push(x, 10, x / 100);
  const { arrays, stats } = buildTrackArrays({ id: 't', kind: 'main', bridge: 0, pts });
  assert.ok(arrays.position.every(Number.isFinite));
  assert.equal(stats.metres, 100);
  const kinds = new Set(arrays.kind);
  assert.ok(kinds.has(KIND.ballast) && kinds.has(KIND.steel));
  assert.ok(arrays.along.some((a) => a > 50), 'the bed top carries the distance along for the sleepers');
  const disused = buildTrackArrays({ id: 'd', kind: 'disused', bridge: 0, pts });
  assert.ok(!new Set(disused.arrays.kind).has(KIND.steel), 'a disused track has rusty rails');
});

test('AI pedestrians and cyclists keep their level under and on a bridge (agentLevel)', async () => {
  const { readFileSync } = await import('node:fs');
  for (const file of ['../js/pedestrian-system.js', '../js/cyclists.js']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    const body = src.match(/const AGENT_JUMP = 5;\r?\nfunction agentLevel[^]*?\r?\n\}/)[0];
    const agentLevel = new Function(`${body}; return agentLevel;`)();
    const f = createDeckField();
    f.add('a', [deck]);
    const ground = withDecks(f, { heightAt: () => -1, terrainAt: () => -1 });
    const under = {};
    assert.equal(agentLevel(ground, under, 20, -1), 5, `${file}: placed on the deck's footprint with no history: the deck`);
    const walker = { gy: -1, gx: 20, gz: -1 };
    for (let x = 20; x < 30; x++) assert.equal(agentLevel(ground, walker, x, -1), -1, `${file}: under the deck it stays under`);
    const rider = { gy: 5, gx: 2, gz: 0 };
    for (let x = 2; x < 30; x++) assert.equal(agentLevel(ground, rider, x, 0), 5, `${file}: on the deck it stays on`);
    assert.equal(agentLevel(ground, rider, 60, 0), -1, `${file}: off the deck`);
  }
});

test('road surfaces: the bridge road is lifted onto its deck with its markings, a road under the deck stays on the ground', async () => {
  const { settleOnDecks } = await import('../js/road-compute.js');
  // the deck above carries way 'w' along z = 0; road 'u' passes under it along x = 20 on flat ground at 0
  const d = { ...deck, axes: [{ way: 'w', kind: 'road', pts: axis.map((v, i) => (i % 4 === 3 ? 0 : v)) }] };
  const geo = { roads: [{ id: 'w', pts: [0, 0, 40, 0], width: 8 }, { id: 'u', pts: [20, -30, 20, 30], width: 6 }], cycleTracks: [] };
  const terrain = { heightAt: () => 0 };
  // a strip of paint along the bridge road (z = 1) and one along the road under it (x = 21), each two triangles at 0.02 m
  const quad = (x0, z0, x1, z1) => [x0, 0.02, z0, x1, 0.02, z0, x1, 0.02, z1, x0, 0.02, z1];
  // at the crossing both lie inside both carriageways: the way each was drawn for (`owner`) decides
  const owned = (id) => ({ owner: new Int32Array(4), owners: [id] });
  const onRoad = { position: new Float32Array(quad(19, 0.8, 23, 1.2)), index: new Uint32Array([0, 1, 2, 0, 2, 3]), ...owned('w') };
  const underRoad = { position: new Float32Array(quad(20.8, -1, 21.2, 1)), index: new Uint32Array([0, 1, 2, 0, 2, 3]), ...owned('u') };
  // a register surface running past the outline: one vertex on the deck, two far outside on the ground
  const curtain = { position: new Float32Array([12, 0.02, 3.5, 12, 0.02, 9, 14, 0.02, 9]), index: new Uint32Array([0, 1, 2]) };
  const r = settleOnDecks([onRoad, underRoad, curtain], [d], terrain, geo);
  for (let i = 1; i < 12; i += 3) assert.ok(Math.abs(onRoad.position[i] - (5 + 0.06 + 0.02)) < 1e-4, `bridge paint on the deck: ${onRoad.position[i]}`);
  assert.equal(onRoad.index.length, 6);
  for (let i = 1; i < 12; i += 3) assert.ok(Math.abs(underRoad.position[i] - 0.02) < 1e-6, 'the paint under the bridge stays on the ground');
  assert.equal(underRoad.index.length, 6);
  assert.equal(curtain.index.length, 0, 'no curtain from the deck to the ground beside it');
  assert.ok(r.lifted >= 4 && r.dropped >= 1);
});

test('furniture under a deck stands on the ground under it, on the deck it stands on the deck', async () => {
  const { furnitureGround } = await import('../js/street-furniture-data.js');
  const g = { heightAt: (x, z) => (Math.abs(z) < 4 ? 5 : 0), baseHeightAt: () => 0 };
  const fg = furnitureGround({ lamps: [{ x: 20, z: 1, under: 1 }, { x: 10, z: 3 }] }, g);
  assert.equal(fg.heightAt(20, 1), 0, 'the lamp under the bridge');
  assert.equal(fg.heightAt(10, 3), 5, 'the lamp on the bridge');
  assert.equal(furnitureGround({ lamps: [{ x: 10, z: 3 }] }, g), g, 'nothing under a deck: the ground model as it was');
});

test('levelAt keeps to the ramp it is on beside a flat deck; levelAlong places things under or on a bridge by walking in from off it', () => {
  // a flat deck at 8 m along z = 0, a ramp along z = 4 from 8 m down to 0 at x = 100; the ground is 0, and x > 100 is off the deck
  const ramp = [], flat = [];
  for (let x = 0; x <= 100; x += 2) { flat.push(x, 0, 8, 0); ramp.push(x, 4, 8 * (1 - x / 100), 0); }
  const d = { id: 'd', kind: 'road', ring: [0, -8, 100, -8, 100, 8, 0, 8], holes: [], axes: [{ way: 'flat', kind: 'road', pts: flat }, { way: 'ramp', kind: 'road', pts: ramp }], clear: 8 };
  const f = createDeckField();
  f.add('t', [d]);
  const g = withDecks(f, { heightAt: () => 0, terrainAt: () => 0 });
  assert.ok(Math.abs(g.levelAt(50, 2.5, 4) - 4) < 0.2, 'on the ramp, not snapped to the flat deck nearer by');
  assert.equal(g.levelAt(50, 1, 8), 8, 'on the flat deck');
  assert.equal(g.levelAlong(50, 40, 0, -1, 80, 40), 0, 'a road crossing under: from its end off the deck, under the deck');
  const up = g.levelAlong(101, 4, -1, 0, 101, 51);
  assert.ok(Math.abs(up - 4) < 0.2, `on the ramp half way up: ${up}`);
  assert.equal(g.levelAlong(20, 0, 1, 0, 40, 20), 8, 'wholly on the deck: on it');
});

test('a deck ends in an abutment where a road comes on: no parapet across the road, the wall down to the ground', () => {
  const ring = [];
  for (let x = 0; x <= 40; x += 4) ring.push(x, -4);
  for (let z = -2; z <= 2; z += 2) ring.push(40, z);
  for (let x = 40; x >= 0; x -= 4) ring.push(x, 4);
  for (let z = 2; z >= -2; z -= 2) ring.push(0, z);
  const axis = [];
  for (let x = 0; x <= 40; x += 2) axis.push(x, 0, 6, 0);
  const d = { id: 'e', kind: 'road', ring, ringG: new Array(ring.length / 2).fill(0), holes: [], holesG: [], axes: [{ way: 'w', kind: 'road', pts: axis }], clear: 6 };
  const { arrays, stats } = buildDeckArrays(d);
  assert.ok(Math.abs(stats.parapetM - 80) <= 8, `parapets along the two sides only: ${stats.parapetM} m`);
  let lowest = Infinity;
  for (let i = 0; i < arrays.position.length; i += 3) if (Math.abs(arrays.position[i]) < 1e-6 && Math.abs(arrays.position[i + 2]) < 2.5) lowest = Math.min(lowest, arrays.position[i + 1]);
  assert.ok(lowest <= 0.01, `the abutment reaches the ground: ${lowest}`);
});

test('something on a deck that runs just past its edge stays on it; farther off, or at another height, it does not', () => {
  const f = createDeckField();
  f.add('t', [deck]); // 40 x 8 m at 5 m over the ground at -1
  const g = withDecks(f, { heightAt: () => -1, terrainAt: () => -1 });
  assert.equal(g.levelAt(20, 5, 5), 5, 'a metre past the edge, at the deck height');
  assert.equal(g.levelAt(20, 9, 5), -1, 'well past it');
  assert.equal(g.levelAt(20, 5, -1), -1, 'on the ground beside the deck');
});

test('a way with both ends under decks is placed from the part of it between them', () => {
  const box = (id, x0, x1) => ({ id, kind: 'road', ring: [x0, -10, x1, -10, x1, 10, x0, 10], holes: [], axes: [{ way: id, kind: 'road', pts: [x0, -10, 6, 0, x0, 10, 6, 0] }], clear: 6 });
  const f = createDeckField();
  f.add('t', [box('a', -10, 10), box('b', 40, 60)]);
  const g = withDecks(f, { heightAt: () => 0, terrainAt: () => 0 });
  assert.equal(g.levelAlong(0, 0, 1, 0, 50, 5), 0, 'under the first deck, seen from the gap');
  assert.equal(g.levelAlong(0, 0, 1, 0, 50, 45), 0, 'under the second');
});

test('the road that joins a deck end lies on the deck where it enters the footprint', async () => {
  const { settleOnDecks } = await import('../js/road-compute.js');
  const d = { ...deck, axes: [{ way: 'w', kind: 'road', pts: axis.map((v, i) => (i % 4 === 3 ? 0 : v)) }] };
  const geo = { roads: [{ id: 'w', pts: [0, 0, 40, 0], width: 8 }, { id: 'approach', pts: [-30, 0, 0, 0], width: 8 }], cycleTracks: [] };
  const quad = { position: new Float32Array([1, 0.02, -1, 3, 0.02, -1, 3, 0.02, 1, 1, 0.02, 1]), index: new Uint32Array([0, 1, 2, 0, 2, 3]), owner: new Int32Array(4), owners: ['approach'] };
  settleOnDecks([quad], [d], { heightAt: () => 0 }, geo);
  assert.ok(Math.abs(quad.position[1] - 5.08) < 0.01, `on the deck: ${quad.position[1]}`);
});

test('parts of a split deck: no wall along a sibling at the same height; a road of the family lies on either part', async () => {
  const ring = [0, -4, 40, -4, 40, 4, 0, 4];
  const axis2 = [];
  for (let x = 0; x <= 40; x += 2) axis2.push(x, 0, 6, 0);
  const whole = { id: 'p', family: 'f', kind: 'road', ring, ringG: [0, 0, 0, 0], holes: [], holesG: [], axes: [{ way: 'w', kind: 'road', pts: axis2 }], clear: 6 };
  const walled = buildDeckArrays(whole).stats.parapetM;
  const open = buildDeckArrays({ ...whole, joined: [[1, 1, 0, 0]] }).stats.parapetM; // the long side at z = -4 runs along a sibling
  assert.ok(open < walled, `no parapet along the sibling: ${open} < ${walled}`);
  const { settleOnDecks } = await import('../js/road-compute.js');
  const sibling = { id: 'q', family: 'f', ring, holes: [], axes: [{ way: 'w2', kind: 'road', pts: axis2 }] };
  const quad = { position: new Float32Array([10, 0.02, -1, 12, 0.02, -1, 12, 0.02, 1, 10, 0.02, 1]), index: new Uint32Array([0, 1, 2, 0, 2, 3]), owner: new Int32Array(4), owners: ['w2'] };
  settleOnDecks([quad], [{ ...whole }, sibling], { heightAt: () => 0 }, { roads: [], cycleTracks: [] });
  assert.ok(quad.position[1] > 5.9, `the family's road lies on the deck: ${quad.position[1]}`);
});
