import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { buildFurniturePlan, planCounts } from '../js/street-furniture-data.js';
import { pointInRing } from '../js/polygon.js';

// The built Aalborg furniture (tools/geodata/furniture_dk.py through build_city.py --stage furniture): data/tiles/*/furniture.json
// merged into one document. street-furniture.test.mjs runs the same plan mapping on upstream's Copenhagen fixture; this one is
// skipped until the tiles hold furniture.
const TILES = new URL('../data/tiles/', import.meta.url);
const LISTS = ['trees', 'lamps', 'parkingBays', 'parkMeters', 'bins', 'glassContainers', 'binStands', 'bollards', 'rescuePosts', 'monuments',
  'benches', 'bikeRacks', 'busStops', 'lakeLights'];
const read = (url) => JSON.parse(readFileSync(url, 'utf8'));

function load() {
  if (!existsSync(TILES)) return null;
  const doc = Object.fromEntries(LISTS.map((k) => [k, []]));
  const buildings = [];
  const water = [];
  let tiles = 0;
  for (const id of readdirSync(TILES)) {
    const f = new URL(`${id}/furniture.json`, TILES);
    if (!existsSync(f)) continue;
    tiles++;
    const layer = read(f);
    for (const k of LISTS) doc[k].push(...(layer[k] || []));
    const b = new URL(`${id}/buildings.json`, TILES);
    if (existsSync(b)) buildings.push(...read(b).buildings);
    const w = new URL(`${id}/water.json`, TILES);
    if (existsSync(w)) for (const body of read(w).bodies || []) water.push(...(body.polys || []));
  }
  if (!tiles) return null;
  doc.version = 'cph-furniture/1';
  return { doc, buildings, water };
}

const data = load();
const skip = !data && 'no furniture layers: run tools/geodata/build_city.py --stage furniture';

// a coarse grid over building footprints and water polygons: is a point inside one?
function insideIndex(polys) {
  const cell = 50;
  const grid = new Map();
  for (const p of polys) {
    const r = p.ring;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < r.length; i += 2) { x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); z0 = Math.min(z0, r[i + 1]); z1 = Math.max(z1, r[i + 1]); }
    for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++) {
      for (let j = Math.floor(z0 / cell); j <= Math.floor(z1 / cell); j++) {
        const k = `${i},${j}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(p);
      }
    }
  }
  return (x, z) => (grid.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`) || [])
    .some((p) => pointInRing(p.ring, x, z) && !(p.holes || []).some((h) => pointInRing(h, x, z)));
}

test('Aalborg furniture maps to a plan, and every item carries src / conf / licence', { skip }, () => {
  const { doc } = data;
  const counts = planCounts(buildFurniturePlan(doc, null, { seed: 1 }));
  assert.equal(counts.trees, doc.trees.length);
  assert.equal(counts.lamps, doc.lamps.length);
  assert.equal(counts.flags, doc.busStops.length);
  assert.ok(counts.cars <= doc.parkingBays.length, 'some bays stay empty');
  assert.ok(doc.trees.length > 4000 && doc.lamps.length > 500 && doc.benches.length > 100 && doc.busStops.length > 20, JSON.stringify(counts));
  for (const key of LISTS) {
    for (const f of doc[key]) {
      assert.ok(Array.isArray(f.src) && f.src.length, `${key} has src`);
      assert.ok(['measured', 'observed', 'scaled', 'inferred'].includes(f.conf), `${key} has conf`);
      assert.ok(f.licence, `${key} has licence`);
    }
  }
});

test('Aalborg trees: plausible heights and crowns, measured for most, none inside a building or the water', { skip }, () => {
  const { doc, buildings, water } = data;
  const inBuilding = insideIndex(buildings);
  const inWater = insideIndex(water);
  let measured = 0, inside = 0, wet = 0;
  for (const t of doc.trees) {
    assert.ok(t.height >= 2 && t.height <= 45, `tree height ${t.height}`);
    assert.ok(t.crown_radius >= 1 && t.crown_radius <= 9 && t.crown_radius <= Math.max(1.2, 0.55 * t.height) + 0.05, `crown ${t.crown_radius} at height ${t.height}`);
    if (t.conf_fields?.height === 'measured') measured++;
    if (inBuilding(t.x, t.z)) inside++;
    if (inWater(t.x, t.z)) wet++;
  }
  assert.ok(measured / doc.trees.length > 0.7, `measured heights ${measured} of ${doc.trees.length}`);
  // GeoDanmark trees are surveyed where they stand: a handful at a courtyard edge fall inside a generalised footprint
  assert.ok(inside / doc.trees.length < 0.01, `${inside} trees inside building footprints`);
  assert.ok(wet / doc.trees.length < 0.005, `${wet} trees in the water`);
  const detected = doc.trees.filter((t) => t.src[0] === 'dhm:ndsm:crown');
  assert.ok(detected.every((t) => t.conf === 'inferred' && t.canopy_added && t.genus === 'generic'), 'detected crowns are marked as such');
});

test('Aalborg lamps, bays and small furniture stand outside buildings', { skip }, () => {
  const { doc, buildings } = data;
  const inBuilding = insideIndex(buildings);
  for (const l of doc.lamps) assert.ok(l.mount === 'mast' && [6, 8].includes(l.pole_h) && l.cct === 3000, 'tube masts with an LED head');
  const share = (items) => items.filter((i) => inBuilding(i.x, i.z)).length / Math.max(1, items.length);
  assert.ok(share(doc.lamps) < 0.01, `lamps in buildings: ${share(doc.lamps)}`);
  assert.ok(share(doc.parkingBays) < 0.02, `bays in buildings: ${share(doc.parkingBays)}`);
  for (const k of ['benches', 'bins', 'bollards', 'bikeRacks', 'busStops']) assert.ok(share(doc[k]) < 0.05, `${k} in buildings: ${share(doc[k])}`);
});
