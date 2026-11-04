// The AI Plusbuses in js/traffic.js (section 2b): which edges are on line 2's route, the moves they take, where the next stop is,
// and the stop itself (doors open for PLUS_DWELL, shut before moving off). Functions are lifted out of the closure like
// tests/traffic.test.cjs does.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../js/traffic.js'), 'utf8');

function trafficFunction(name, context) {
  const match = source.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}`));
  assert.ok(match, `${name} is present`);
  return vm.runInNewContext(`(${match[0].trim()})`, context);
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
// A straight line along +z from z = 0 to z = 400, stops at 150 and 300
const line = { path: [0, 0, 0, 200, 0, 400], cum: new Float64Array([0, 200, 400]), stops: [150, 300], back: false };
const edge = (sx, sz, dx, dz, len) => ({ sx, sz, dx, dz, len, lanes: [1.6], moves: [] });

function lineContext() {
  const context = { clamp, lineHit: { s: 0, d: 0, tx: 0, tz: 1 }, busLines: [line], lineEdgeCache: new WeakMap(), PLUS_ROUTE_TOLERANCE: 14 };
  context.lineProject = trafficFunction('lineProject', context);
  context.onLine = trafficFunction('onLine', context);
  return context;
}

test('an edge is on the route when it runs along the path its way, not against it or beside it', () => {
  const { onLine, lineProject } = lineContext();
  const q = lineProject(line, 5, 250);
  assert.ok(Math.abs(q.s - 250) < 1e-9 && Math.abs(q.d - 5) < 1e-9 && q.tz === 1);
  assert.equal(onLine(edge(2, 20, 0, 1, 60), 0), true);
  assert.equal(onLine(edge(-2, 80, 0, -1, 60), 0), false, 'the oncoming carriageway');
  assert.equal(onLine(edge(40, 20, 0, 1, 60), 0), false, 'a parallel street 40 m away');
  assert.equal(onLine(edge(0, 100, 1, 0, 60), 0), false, 'a cross street');
});

test('at a junction a Plusbus takes the move onto its route, preferring one its lane allows', () => {
  const context = lineContext();
  const onRoute = edge(0, 120, 0, 1, 60);
  const offRoute = edge(0, 120, 1, 0, 60);
  const e = edge(0, 40, 0, 1, 70);
  e.moves = [{ to: offRoute, turn: 'R', out: [0] }, { to: onRoute, turn: 'S', out: [-1] }, { to: onRoute, turn: 'S', out: [0] }];
  context.weights = [];
  context.nearestLane = () => 0;
  const chooseMove = trafficFunction('chooseMove', context);
  const v = { plus: true, line: 0, edge: e, lane: 0, s: 30, offRoute: false };
  assert.equal(chooseMove(v, false), e.moves[2]);
  assert.equal(v.offRoute, false);
  e.moves = [{ to: offRoute, turn: 'R', out: [0] }];
  assert.equal(chooseMove(v, false), e.moves[0], 'the route leaves the network: any move');
  assert.equal(v.offRoute, true);
});

test('the next stop is measured from the front bumper; a stop left behind counts as served', () => {
  const context = lineContext();
  context.front = { x: 0, z: 0, dx: 0, dz: 1 };
  context.pathPoint = (v, c, out) => { out.x = 0; out.z = v.bumper; return out; };
  const trackLine = trafficFunction('trackLine', context);
  const v = { line: 0, conn: null, s: 0, half: 12.55, bumper: 120, servedS: -Infinity, offRoute: false };
  trackLine(v);
  assert.ok(Math.abs(v.stopD - 30) < 1e-9 && v.nextStop === 150);
  v.bumper = 160; // pushed past the stop without standing there
  trackLine(v);
  assert.equal(v.servedS, 150);
  assert.ok(Math.abs(v.stopD - 140) < 1e-9 && v.nextStop === 300);
  v.bumper = 380;
  v.servedS = 300;
  trackLine(v);
  assert.equal(v.stopD, Infinity);
});

test('at the stop the doors open for the dwell and shut before the bus moves off', () => {
  let tracked = 0, driven = 0;
  const context = {
    PLUS_DWELL: 14, hasView: false, visible: () => false, retire: () => assert.fail('not retired'),
    trackLine: (v) => { tracked++; v.stopD = 1.2; v.nextStop = 150; },
    changeLanes: () => {}, accelerate: () => { driven++; }
  };
  const drive = trafficFunction('drive', context);
  const v = { plus: true, dwell: 0, doors: 0, speed: 0.3, acc: 0, stopD: Infinity, servedS: -Infinity, offRoute: false, laneTimer: 1 };
  drive(v, 0.1);
  assert.equal(v.dwell, 14);
  assert.equal(v.speed, 0);
  let t = 0;
  while (v.dwell > 0) { drive(v, 0.1); t += 0.1; }
  assert.ok(Math.abs(t - 14) < 0.11, `dwelt ${t.toFixed(1)} s`);
  assert.equal(v.doors, 1);
  assert.equal(v.servedS, 150);
  const before = driven;
  drive(v, 0.5);
  assert.equal(v.doors, 0.5);
  assert.equal(driven, before, 'still shutting the doors');
  drive(v, 0.5);
  assert.equal(v.doors, 0);
});

test('Plusbuses spawn on their route only, in the curb lane, and use the Urbino 24 layout', () => {
  assert.match(source, /function spawnVehicle\(v, rMin, rMax, protectView\) \{\r?\n\s+if \(v\.plus\) return spawnPlus/);
  const curbLane = vm.runInNewContext(`(${source.match(/const curbLane = \(e\) => \{[^]*?\n  \};/)[0].replace(/^const curbLane = |;$/g, '')})`);
  assert.equal(curbLane({ lanes: [-1.6, 1.6, 4.8] }), 2);
  assert.match(source, /createVehicle\(true, URBINO_24\.length \/ 2 \+ 0\.2/);
});
