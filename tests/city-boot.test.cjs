const assert = require('node:assert/strict');
const { readFileSync, readdirSync, existsSync } = require('node:fs');
const { join, posix } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const root = join(__dirname, '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

// Names of the removed New York modules and data: none may exist, be imported or be preloaded
const REMOVED_MODULES = [
  'city', 'city-config-nyc', 'city-config-cph', 'world-nyc', 'world-cph', 'nyc-geodata', 'nyc-map', 'city-grid',
  'boroughs', 'landmarks', 'landmark-state', 'fire-escapes', 'street-details', 'road-paint', 'buildings', 'trees'
];

// Every module reachable from js/main.js through static imports, dynamic import()s and Web Workers (`new Worker(new URL('./x.js', import.meta.url))`).
function reachable() {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = read(file);
    for (const m of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s*|\bnew\s+URL\(\s*)['"](\.[^'"]+)['"]/gm)) {
      visit(posix.normalize(posix.join('js', m[1])));
    }
  };
  visit('js/main.js');
  return seen;
}

test('Copenhagen is the only city: no New York modules exist, are imported or are preloaded', () => {
  const graph = reachable();
  assert.ok(graph.has('js/world.js') && graph.has('js/city-config.js'));
  assert.ok(graph.has('js/controllers.js') && graph.has('js/cameras.js') && graph.has('js/lighting.js'));
  const html = read('index.html');
  for (const name of REMOVED_MODULES) {
    assert.ok(!existsSync(join(root, `js/${name}.js`)), `js/${name}.js is deleted`);
    assert.ok(!graph.has(`js/${name}.js`), `js/${name}.js is not imported`);
    assert.ok(!html.includes(`href="./js/${name}.js"`), `js/${name}.js is not preloaded`);
  }
  for (const file of ['tools/build-geodata.mjs', 'tools/overpass.sh', 'tools/data']) {
    assert.ok(!existsSync(join(root, file)), `${file} is deleted`);
  }
});

test('every module in js/ is reachable from main.js (no dead modules)', () => {
  const graph = reachable();
  for (const file of readdirSync(join(root, 'js'))) assert.ok(graph.has(`js/${file}`), `js/${file} is imported by something`);
});

test('there is no ?city switch and no NYC strings in the shipped sources', () => {
  const files = ['index.html', 'css/style.css', ...readdirSync(join(root, 'js')).map((f) => `js/${f}`)];
  for (const file of files) {
    const source = read(file);
    assert.ok(!/\?city=|IS_NYC|resolveCity|NYC_LANDMARKS|Slop New York|\bmph\b|NYC Yellow Taxi|NYPD|MTA\b/.test(source.replace(/Based on Slop New York by mrdoob \(MIT\)/g, '')), `${file} has New York leftovers`);
  }
});

test('the Aalborg frame matches docs/cph-geodata-schema.md', async () => {
  const { CPH_FRAME, toLocal, toEtrs, ISLAND_BOUNDS, TELEPORT_LOCATIONS } = await import('../js/city-config.js');
  const [e0, n0, h0] = CPH_FRAME.origin;
  assert.deepEqual([e0, n0], [556000.0, 6323100.0]);
  assert.equal(CPH_FRAME.epsg, 25832);
  assert.deepEqual([...CPH_FRAME.bbox], [-1000, -900, 1000, 1100]);
  assert.match(CPH_FRAME.axes, /x=east, z=south/);
  const p = toLocal(e0 + 100, n0 + 40, h0 + 3);
  assert.ok([p.x - 100, p.y - 3, p.z + 40].every((d) => Math.abs(d) < 1e-9), 'north is -z');
  const back = toEtrs(p.x, p.z, p.y);
  assert.ok(Math.abs(back.e - (e0 + 100)) < 1e-9 && Math.abs(back.n - (n0 + 40)) < 1e-9 && Math.abs(back.h - (h0 + 3)) < 1e-9);
  assert.deepEqual([ISLAND_BOUNDS.minX, ISLAND_BOUNDS.minZ, ISLAND_BOUNDS.maxX, ISLAND_BOUNDS.maxZ], [-1000, -900, 1000, 1100]);
  assert.deepEqual(Object.keys(TELEPORT_LOCATIONS), ['torv', 'budolfi', 'jomfru', 'aalborghus', 'limfjord', 'utzon']);
});

test('the city config is the Aalborg one', async () => {
  const config = await import('../js/city-config.js');
  assert.equal(config.ISLAND_BOUNDS.maxX, 1000);
  assert.equal(config.isTypingInField({ target: { tagName: 'INPUT' } }), true);
  assert.equal(config.isTypingInField({ target: { tagName: 'DIV' } }), false);
  assert.equal(config.TELEPORT_LOCATIONS.torv.name, 'Gammel Torv', 'start at Gammel Torv, by the frame origin');
});

test('geodata is optional: absent data boots the empty plane, present data is exposed', async () => {
  const { CPH_FRAME } = await import('../js/city-config.js');
  const warnings = [];
  const { loadCphGeodata } = loadModule(read('js/world.js'), {
    imports: {
      'three/webgpu': {}, './city-config.js': { CPH_FRAME }, './traffic.js': {}, './road-surfaces.js': {},
      './actor-models.js': { BODY_SPECS: {} }, './city-collisions.js': { createCityCollisions: () => ({ resolve: () => ({ movedActors: [], stats: {} }) }) },
      './static-colliders.js': { buildStaticColliders: () => [], createStaticIndex: () => ({ query: () => [] }) },
      './cyclists.js': {}, './direction-overlay.js': {}, './signal-heads.js': {}, './walk-space.js': {}, './water.js': { buildLakes: () => null }, './lakes.js': { applySurfaceCuts: (d) => d }, './appearance.js': { setCalibration() {} }, './street-furniture-data.js': { loadCphFurniture: async () => null }, './street-furniture.js': {}, './buildings-real.js': { buildRealBuildings: async () => null }, './lod2-geometry.js': { loadLod2: async () => null }, './tile-store.js': { openTileStore: async () => null }, './terrain.js': {}, './layout.js': {}, './zones.js': {}, './placement.js': {}, './grass.js': { createGrass: () => null },
      // the streamed city (buildStreamedWorld) is not exercised here
      './ground-height.js': {}, './grass-layout.js': {}, './tile-grid.js': {}, './tile-data.js': {}, './tile-streamer.js': {}, './tile-rings.js': {}, './buildings-stream.js': {}, './ground-stream.js': {}, './yield-frame.js': {}, './agent-region.js': {}, './tile-pool.js': {}, './road-compute.js': {}, './furniture-compute.js': {}, './road-network.js': {}, './far-lod.js': {}, './ground-shader.js': {}, './water-stream.js': {}, './reflect-gate.js': {},
      './detail-overrides.js': { overrideFootprints: (b) => b }
    },
    globals: { console: { warn: (...a) => warnings.push(a), info() {} }, globalThis: {}, document: {} }
  });
  const reply = (ok, body) => async () => ({ ok, json: async () => body });
  assert.equal(await loadCphGeodata('x', reply(false, null)), null, '404');
  assert.equal(await loadCphGeodata('x', async () => { throw new Error('offline'); }), null, 'network failure');
  assert.equal(await loadCphGeodata('x', reply(true, { nope: 1 })), null, 'wrong document');
  const geo = { version: 'cph-geodata/1', frame: { origin: [...CPH_FRAME.origin] }, buildings: [] };
  assert.deepEqual(await loadCphGeodata('x', reply(true, geo)), geo);
  assert.equal(warnings.filter((w) => /frame origin/.test(w[0])).length, 0);
  await loadCphGeodata('x', reply(true, { ...geo, frame: { origin: [1, 2, 3] } }));
  assert.equal(warnings.filter((w) => /frame origin/.test(w[0])).length, 1, 'a mismatched frame is flagged');
});
