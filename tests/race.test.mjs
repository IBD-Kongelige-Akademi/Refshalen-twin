import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { TELEPORT_LOCATIONS } from '../js/city-config.js';
import { createRace, finishSegments, COUNTDOWN, FINISH_RADIUS } from '../js/race.js';
import { createScores, parFor } from '../js/race-scores.js';

const start = TELEPORT_LOCATIONS.akkc;
const target = TELEPORT_LOCATIONS.jomfru;
// the street as the road graph has it (data/city/roadgraph.json, Jomfru Ane Gade's footway links)
const STREET = [[-268.8, -158.2, -269.4, -165.6], [-269.4, -165.6, -263.7, -201.3], [-263.7, -201.3, -256.2, -237.4], [-256.2, -237.4, -250.2, -261.9], [-250.2, -261.9, -235.6, -310.6], [-235.6, -310.6, -233.8, -316.5]];

function fakeTwin({ mode = 'car', avatar = 'man', router = null } = {}) {
  const calls = [];
  const entity = { position: { x: 0, y: 0, z: 0 }, heading: 0, speed: 0 };
  const controllerManager = {
    activeMode: mode,
    entities: { person: { avatar } },
    getActiveEntity: () => entity,
    resetInput: () => calls.push(['resetInput'])
  };
  const mapSystem = {
    router, isFullMapOpen: false, waypoint: null, route: null,
    setWaypoint(x, z, name) { this.waypoint = { x, z, name }; },
    clearWaypoint() { this.waypoint = null; },
    toggleFullMap(open) { this.isFullMapOpen = open; }
  };
  const ui = {
    showHud: (info) => { ui.hud = info; }, hideHud: () => { ui.hud = null; },
    setRacing: (on) => { ui.racing = on; },
    aborted: (reason) => { ui.lastAbort = reason; },
    showResult: (result) => { ui.result = result; }, hideResult: () => { ui.result = null; },
    showBoard: (top, entry, rank) => { ui.board = { top, entry, rank }; }
  };
  const store = {};
  const storage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } };
  const deps = {
    controllerManager, mapSystem, ui,
    teleportTo: (x, z, h) => { entity.position.x = x; entity.position.z = z; entity.heading = h; calls.push(['teleport', x, z, h]); },
    finish: STREET,
    scores: createScores(storage)
  };
  return { deps, calls, entity, ui, mapSystem, controllerManager, storage };
}

const moveTo = (entity, x, z) => { entity.position.x = x; entity.position.z = z; };
// drives in a straight line from where the player is to (x, z) over `seconds`, in 0.1 s steps
function driveTo(race, entity, x, z, seconds) {
  const steps = Math.round(seconds / 0.1);
  const x0 = entity.position.x;
  const z0 = entity.position.z;
  for (let i = 1; i <= steps && race.blocking; i++) {
    moveTo(entity, x0 + (x - x0) * (i / steps), z0 + (z - z0) * (i / steps));
    race.update(0.1);
  }
}

// the road graph is gitignored: only where phase 2-3 have built it
const ROADGRAPH = new URL('../data/city/roadgraph.json', import.meta.url);
test('the finish line is Jomfru Ane Gade in the road graph', { skip: !existsSync(ROADGRAPH) && 'no data/city/roadgraph.json' }, () => {
  const graph = JSON.parse(readFileSync(ROADGRAPH, 'utf8'));
  const segs = finishSegments(graph);
  assert.ok(segs.length >= 3, 'the street has links');
  for (const [ax, az] of segs) assert.ok(Math.hypot(ax - target.x, az - target.z) < 120, 'near the Jomfru Ane Gade teleport');
  assert.deepEqual(finishSegments({ names: [], links: [], nodes: [] }), []);
  assert.deepEqual(finishSegments(null), []);
});

test('the race counts down at AKKC with the controls held, then runs the clock to the finish', () => {
  const { deps, calls, entity, ui, mapSystem } = fakeTwin();
  const race = createRace(deps);
  assert.ok(race.begin());
  assert.deepEqual(calls.find((c) => c[0] === 'teleport').slice(1, 3), [start.x, start.z]);
  assert.equal(mapSystem.waypoint.x, target.x, 'the GPS routes to the finish');
  assert.equal(ui.racing, true);
  assert.equal(race.state.phase, 'countdown');
  const held = calls.filter((c) => c[0] === 'resetInput').length;
  for (let i = 0; i < COUNTDOWN * 10 - 1; i++) race.update(0.1);
  assert.equal(race.state.phase, 'countdown');
  assert.ok(calls.filter((c) => c[0] === 'resetInput').length > held + 20, 'input reset every countdown frame');
  assert.equal(ui.hud.count, 1);
  race.update(0.1);
  assert.equal(race.state.phase, 'running');
  // across town in 50 legs of 1 s, never more than the teleport jump per update
  driveTo(race, entity, target.x, target.z, 60);
  assert.equal(race.state.phase, 'finished');
  assert.ok(race.state.result.time > 50 && race.state.result.time <= 60.1, `time ${race.state.result.time}`);
  assert.equal(ui.racing, false);
  assert.equal(mapSystem.waypoint, null);
  assert.equal(ui.result.rank, 1);
});

test('either end of the walking street finishes; next to it does not', () => {
  const { deps } = fakeTwin();
  const race = createRace(deps);
  assert.ok(race.atFinish(-268.8, -158.2 + FINISH_RADIUS - 1), 'the north end');
  assert.ok(race.atFinish(-233.8 + 3, -316.5 - 3), 'the south end');
  assert.ok(!race.atFinish(-268.8 - FINISH_RADIUS - 2, -200), 'the parallel street');
  const fallback = createRace({ ...deps, finish: [] });
  assert.ok(fallback.atFinish(target.x + 10, target.z));
  assert.ok(!fallback.atFinish(target.x + 40, target.z));
});

test('the result is saved with a name and company, and a run too fast for its vehicle is rejected', () => {
  const { deps, entity, ui } = fakeTwin({ mode: 'person', avatar: 'man' });
  const race = createRace(deps);
  race.begin();
  assert.equal(race.state.mode, 'walk');
  const par = race.route.par;
  assert.ok(Math.abs(par - parFor('walk', race.route.length)) < 1e-9);
  for (let t = 0; t <= COUNTDOWN; t += 0.1) race.update(0.1);
  // a walker can't cross town at 30 m/s
  driveTo(race, entity, target.x, target.z, par * 0.3);
  assert.equal(race.state.result.rejected, true);
  assert.equal(race.submit('Speedy', ''), null);
  assert.ok(race.dismiss());
  assert.equal(race.state.phase, 'idle');

  race.begin();
  for (let t = 0; t <= COUNTDOWN; t += 0.1) race.update(0.1);
  driveTo(race, entity, target.x, target.z, par * 1.2);
  assert.equal(race.state.result.rejected, false);
  assert.equal(race.submit('', 'Nobody'), null, 'a name is required');
  const saved = race.submit('Anna', 'Aalborg Kommune');
  assert.equal(saved.rank, 1);
  assert.equal(ui.board.entry.company, 'Aalborg Kommune');
  assert.equal(race.state.phase, 'idle');
  assert.equal(race.scores.top(1)[0].mode, 'walk');
});

test('a mode switch, a teleport or Esc cancels the race', () => {
  const { deps, entity, ui, controllerManager } = fakeTwin();
  const race = createRace(deps);
  race.begin();
  controllerManager.activeMode = 'drone';
  race.update(0.1);
  assert.equal(ui.lastAbort, 'mode');
  assert.equal(race.blocking, false);
  assert.equal(ui.racing, false);

  controllerManager.activeMode = 'car';
  race.begin();
  for (let t = 0; t <= COUNTDOWN + 1; t += 0.1) race.update(0.1);
  moveTo(entity, target.x, target.z); // the map's teleport
  race.update(0.1);
  assert.equal(ui.lastAbort, 'teleport');
  assert.equal(race.state.result, null);

  race.begin();
  assert.ok(race.abort('user'));
  assert.equal(ui.lastAbort, 'user');
  assert.equal(race.abort('user'), false, 'nothing to abort');
});

test('the start faces along the route and par uses each mode\'s own route', () => {
  // a router whose car route makes a detour east first, the walking one goes straight
  const router = {
    route: (from, to, mode) => (mode === 'car'
      ? [{ x: from.x, z: from.z }, { x: from.x + 400, z: from.z }, { x: to.x, z: to.z }]
      : [{ x: from.x, z: from.z }, { x: to.x, z: to.z }])
  };
  const car = fakeTwin({ mode: 'car', router });
  const carRace = createRace({ ...car.deps, router });
  carRace.begin();
  assert.ok(Math.abs(car.entity.heading - Math.PI / 2) < 1e-6, 'faces east, along the detour');
  const bike = fakeTwin({ mode: 'cyclist', router });
  const bikeRace = createRace({ ...bike.deps, router });
  bikeRace.begin();
  const direct = Math.hypot(target.x - start.x, target.z - start.z);
  assert.ok(Math.abs(bikeRace.route.length - direct) < 1e-6);
  assert.ok(bikeRace.route.carLength > direct + 100);
  assert.equal(bikeRace.route.carPar, carRace.route.par);
  const drone = fakeTwin({ mode: 'drone', router });
  const droneRace = createRace({ ...drone.deps, router });
  droneRace.begin();
  assert.ok(Math.abs(droneRace.route.length - direct) < 1e-6, 'the drone flies straight');
});
