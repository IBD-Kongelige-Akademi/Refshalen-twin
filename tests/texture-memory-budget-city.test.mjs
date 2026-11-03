import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { PHOTO, selectPhotoSet, wallDistance } from '../js/facade-lod.js';

// The facade texture budget on the built Aalborg tiles (data/tiles/*/buildings.json + appearance.json atlases, tools/geodata/
// appearance_city_atlas.py) along `cityCameraRoute`: Gammel Torv, Budolfi, Jomfru Ane Gade, Limfjordsbroen, the harbour front, Aalborghus,
// Utzon Center and back through the old town (the teleports of js/city-config.js). texture-memory-budget.test.mjs runs the same rules on upstream's Copenhagen fixture; this one is
// skipped until the tiles hold atlases.
const readJson = (url) => JSON.parse(readFileSync(url, 'utf8'));
const budget = readJson(new URL('../tools/perf/texture-memory-budget.json', import.meta.url));
const TILES = new URL('../data/tiles/', import.meta.url);

function loadCandidates() {
  if (!existsSync(TILES)) return [];
  const out = [];
  for (const tid of readdirSync(TILES)) {
    const app = new URL(`${tid}/appearance.json`, TILES);
    const bld = new URL(`${tid}/buildings.json`, TILES);
    if (!existsSync(app) || !existsSync(bld)) continue;
    const atlases = readJson(app).buildings || {};
    for (const b of readJson(bld).buildings) {
      const atlas = atlases[b.id]?.atlas;
      if (b.wall_material === 'glas' || !(b.ring?.length >= 6) || !atlas?.size || !atlas.walls?.length) continue;
      let cx = 0;
      let cz = 0;
      for (let i = 0; i < b.ring.length; i += 2) { cx += b.ring[i]; cz += b.ring[i + 1]; }
      const n = b.ring.length / 2;
      out.push({ id: b.id, cx: cx / n, cz: cz / n, ring: b.ring, holes: b.holes || [], y0: b.ground ?? 0, y1: b.eave ?? (b.ground ?? 0) + 10, walls: { size: atlas.size } });
    }
  }
  return out;
}

const candidates = loadCandidates();
const skip = candidates.length < 100 && 'no city atlases: run tools/geodata/appearance_city_atlas.py atlas all';
const inBand = (x, y, z) => candidates.filter((c) => { const d = wallDistance(c, x, y, z); return d.near < PHOTO.far && d.far > PHOTO.close0; });

test('Aalborg: the facade texture budget holds along the city route and the photo band is complete', { skip }, () => {
  const route = budget.cityCameraRoute;
  let tiers = new Map();
  let density;
  let peak = 0;
  let band = 0;
  let samples = 0;
  const plan = (x, z) => {
    const p = selectPhotoSet(candidates, x, z, PHOTO, tiers, budget.cameraHeight, density);
    tiers = new Map([...p.qualityById].map(([id, q]) => [id, q.tier]));
    density = p.density;
    samples++;
    const at = `(${x.toFixed(0)}, ${z.toFixed(0)})`;
    assert.ok(p.residentBytes <= budget.maxBytes, `budget exceeded at ${at}: ${p.residentBytes}`);
    assert.ok(p.want.length <= budget.maxResidentAtlases, `count exceeded at ${at}`);
    const want = new Set(p.want);
    const inside = inBand(x, budget.cameraHeight, z);
    assert.deepEqual(inside.filter((c) => !want.has(c.id)).map((c) => c.id), [], `photo band incomplete at ${at}`);
    band = Math.max(band, inside.length);
    peak = Math.max(peak, p.residentBytes);
  };
  for (let s = 0; s < route.length - 1; s++) {
    const [x0, z0] = route[s];
    const [x1, z1] = route[s + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / budget.sampleEveryMetres));
    for (let k = 0; k < steps; k++) plan(x0 + ((x1 - x0) * k) / steps, z0 + ((z1 - z0) * k) / steps);
  }
  plan(...route.at(-1));
  console.log(`aalborg: ${candidates.length} atlas buildings; ${samples} samples; peak ${(peak / 1024 / 1024).toFixed(1)} MiB; largest photo band ${band}`);
});

test('Aalborg: from the air no atlas is resident', { skip }, () => {
  for (const [x, z] of budget.cityCameraRoute) {
    assert.equal(selectPhotoSet(candidates, x, z, PHOTO, new Map(), budget.aerialHeight).want.length, 0, `atlases resident above (${x}, ${z})`);
  }
});
