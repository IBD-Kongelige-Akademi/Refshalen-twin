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
  assert.ok(Math.min(...ys) > 4.9 && Math.max(...ys) < 5.2);
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
