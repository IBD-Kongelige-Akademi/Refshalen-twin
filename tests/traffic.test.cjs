const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = ['traffic.js', 'pedestrian-system.js']
  .map((file) => readFileSync(join(__dirname, '../js', file), 'utf8')).join('\n');

function trafficFunction(name, context) {
  const match = source.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}`));
  assert.ok(match, `${name} is present`);
  return vm.runInNewContext(`(${match[0].trim()})`, context);
}

function intersectionHarness() {
  const n = { signal: true, in: [] };
  const exit = { lanes: [0], outSide: 1 };
  const edge = { to: n, axisIndex: 0, occ: [[]], opposite: null, inSide: 0, len: 100 };
  const car = { edge, move: { to: exit, out: [0], turn: 'S' }, lane: 0, s: 80, speed: 4,
    driver: { b: 3 }, half: 2.25, wait: 0, commit: null };
  const state = { phase: 'red', occupied: false, pedestrians: false, space: true, conflict: false };
  const context = {
    LOOKAHEAD: 70,
    phaseOf: () => state.phase,
    canStopBefore: () => true,
    stopAt: () => -3,
    boxBusy: () => state.occupied,
    ahead: () => null,
    connector: () => ({ len: 20 }),
    yieldToCrossTraffic: () => state.conflict,
    pedestrianOn: () => state.pedestrians,
    laneCoord: () => 0,
    timeTo: () => 1,
    room: () => state.space,
    alongside: () => false,
    mergingAhead: () => null
  };
  return { car, state, mayEnter: trafficFunction('mayEnter', context), signalAhead: trafficFunction('signalAhead', context) };
}

test('cars stop at red and amber and go on green', () => {
  const { car, state, mayEnter, signalAhead } = intersectionHarness();
  for (const phase of ['red', 'amber']) {
    state.phase = phase;
    assert.equal(mayEnter(car, 18), false);
    assert.equal(signalAhead(car, car.edge, 18), -3);
  }
  state.phase = 'green';
  assert.equal(mayEnter(car, 18), true);
  assert.equal(signalAhead(car, car.edge, 18), 0);
});

test('cars still wait for crossing traffic, pedestrians and a blocked exit on green', () => {
  const { car, state, mayEnter } = intersectionHarness();
  state.phase = 'green';
  for (const [key, blocked] of [['occupied', true], ['pedestrians', true], ['space', false]]) {
    const initial = state[key];
    state[key] = blocked;
    assert.equal(mayEnter(car, 18), false, key);
    state[key] = initial;
  }
  assert.equal(mayEnter(car, 18), true);
});

test('the traffic module has no emergency-vehicle special cases', () => {
  assert.ok(!/isPolice|policeLight|lightbar/i.test(source));
});

test('resolved traffic car impact kicks the chassis and sparks once for a bicycle, not a pedestrian', async () => {
  const applyImpact = trafficFunction('applyVehicleImpact', {
    clamp: (x, lo, hi) => Math.max(lo, Math.min(hi, x))
  });
  const shouldEmitSparks = trafficFunction('shouldEmitImpactSparks', {});
  const { createCityCollisions } = await import('../js/city-collisions.js');
  const carBody = { type: 'car', yawVel: 0, yawOffset: 0, pitchVel: 0, rollVel: 0 };
  let sparkBursts = 0;
  const car = {
    kind: 'car', collisionIndex: 0, mode: 'car', spec: { width: 1.8, length: 4.4, height: 1.8 },
    radius: 2.2, mass: 1300, heading: 0, x: 0, y: 0, z: 0, prevX: 0, prevY: 0, prevZ: 0,
    _wasPlaced: false, vx: 5, vz: 0,
    getVelocity(out) { out.x = this.vx; out.z = this.vz; return out; },
    applyVelocity(dx, dz) { this.vx += dx; this.vz += dz; },
    move(dx, dz) { this.x += dx; this.z += dz; return this; },
    onContact(other, nx, nz, speed) {
      applyImpact(carBody, this, other, nx, nz, speed);
      if (speed > 2.2 && shouldEmitSparks(this, other)) sparkBursts++;
    }
  };
  const bicycle = {
    kind: 'cyclist', mode: 'cyclist', radius: 0.38, mass: 95, heading: 0,
    x: 0.5, y: 0, z: 0, prevX: 0.5, prevY: 0, prevZ: 0, _wasPlaced: false,
    getVelocity(out) { out.x = 0; out.z = 0; return out; },
    applyVelocity() {}, move(dx, dz) { this.x += dx; this.z += dz; return this; }
  };
  const stage = createCityCollisions();
  const result = stage.resolve([car, bicycle], { dt: 0 });
  assert.ok(result.stats.contacts > 0, 'the real shared contact stage resolves the impact');
  assert.notEqual(carBody.rollVel, 0, 'the car receives chassis roll response');
  assert.equal(sparkBursts, 1, 'the car/bicycle pair emits one spark burst');

  const pedestrian = {
    kind: 'pedestrian', mode: 'person', radius: 0.48, mass: 72,
    x: 0.5, y: 0, z: 0, prevX: 0.5, prevY: 0, prevZ: 0, _wasPlaced: false,
    getVelocity(out) { out.x = 0; out.z = 0; return out; },
    applyVelocity() {}, move(dx, dz) { this.x += dx; this.z += dz; return this; }
  };
  const personCar = { ...car, x: 0, y: 0, z: 0, prevX: 0, prevY: 0, prevZ: 0, _wasPlaced: false,
    onContact(other, nx, nz, speed) {
      applyImpact(carBody, this, other, nx, nz, speed);
      if (speed > 2.2 && shouldEmitSparks(this, other)) sparkBursts++;
    }
  };
  createCityCollisions().resolve([personCar, pedestrian], { dt: 0 });
  assert.equal(sparkBursts, 1, 'pedestrian contacts do not emit impact sparks');
  assert.equal(shouldEmitSparks({ kind: 'bus', mode: 'car', collisionIndex: 0 },
    { kind: 'car', mode: 'car', collisionIndex: 1 }), true);
  assert.equal(shouldEmitSparks({ kind: 'car', mode: 'car', collisionIndex: 1 },
    { kind: 'bus', mode: 'car', collisionIndex: 0 }), false, 'vehicle pairs choose one spark emitter');
});

test('active player actor resets sweep history when its entity or mode changes', async () => {
  const bind = trafficFunction('bindPlayerCollisionActor', {});
  const { createCityCollisions } = await import('../js/city-collisions.js');
  const fixed = { kind: 'pedestrian', mode: 'person', radius: 0.48, mass: 72,
    x: 2.5, y: 0, z: 0, prevX: 2.5, prevY: 0, prevZ: 0, _wasPlaced: true };
  const player = { kind: 'player', mode: 'person', radius: 0.48, mass: 72,
    entity: { position: { x: 0, y: 0, z: 0 } },
    x: 5, y: 0, z: 0, prevX: 0, prevY: 0, prevZ: 0, _wasPlaced: true };

  const staleStage = createCityCollisions();
  assert.ok(staleStage.resolve([player, fixed], { dt: 0.1 }).stats.contacts > 0,
    'an old identity sweeps across the stationary body');

  const switched = { kind: 'player', mode: 'person', radius: 0.48, mass: 72,
    entity: { position: { x: 0, y: 0, z: 0 } },
    x: 0, y: 0, z: 0, prevX: 0, prevY: 0, prevZ: 0, _wasPlaced: true };
  const stage = createCityCollisions();
  stage.resolve([switched, fixed], { dt: 0 });
  const nextEntity = { position: { x: 5, y: 0, z: 0 }, heading: 0 };
  bind(switched, nextEntity, 'cyclist');
  switched.x = nextEntity.position.x;
  switched.y = nextEntity.position.y;
  switched.z = nextEntity.position.z;
  assert.equal(switched._wasPlaced, false);
  assert.equal(switched.prevX, 5);
  assert.equal(stage.resolve([switched, fixed], { dt: 0.1 }).stats.contacts, 0,
    'the new actor begins at its current position instead of sweeping through the map');
});

function populationContext() {
  const context = {
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
    clamp: (x, lo, hi) => Math.max(lo, Math.min(hi, x)),
    hasView: true, camX: 0, camY: 10, camZ: 0, visible: () => true,
    focusX: 0, focusZ: 0, player: { active: false },
    clock: 0,
    VEHICLE_SPAWN_DISTANCE: 250, PED_SPAWN_DISTANCE: 150, NEAR_RADIUS: 350, PED_AVOID_INTERVAL: 0.12,
    nearEdges: [], nearSignals: [], track: {}, KERB: 1.6, QUEUE_GAP: 0.62,
    atCurb: () => {}, laneClear: () => true,
    place: (v, e, lane, s) => Object.assign(v, { edge: e, lane, s })
  };
  context.nearView = trafficFunction('nearView', context);
  context.groundHeight = null; context.pedRoutes = context.pedRoutes || { pathsNear: () => [] };
  return context;
}

function straightEdge(z, len = 20) {
  return { sx: 0, sz: z, dx: 0, dz: 1, rx: -1, rz: 0, len, lanes: [0], occ: [[]] };
}

test('cars replenish the road ahead while nearby visible spawning stays blocked', () => {
  const context = populationContext();
  const edge = straightEdge(140);
  context.nearEdges.push(edge);
  const spawnVehicle = trafficFunction('spawnVehicle', context);
  const car = { half: 2.25 };
  assert.equal(spawnVehicle(car, 100, 350, true), false);
  edge.sz = 290;
  assert.equal(spawnVehicle(car, 100, 350, true), true);
  assert.equal(edge.sz + car.s, 300);
  edge.sz = 140;
  context.visible = () => false;
  assert.equal(spawnVehicle(car, 100, 350, true), true);
});

test('pedestrians replenish visible sidewalks ahead without appearing nearby', () => {
  const context = populationContext();
  context.nearEdges.push(straightEdge(0));
  let z = 100;
  context.sidewalkTrack = () => {
    Object.assign(context.track, { ax: 0, az: z - 10, ux: 0, uz: 1, len: 20, node: null });
    return true;
  };
  const spawnPed = trafficFunction('spawnPed', context);
  const ped = { crossesStreets: false, speed: 1.4, rig: {} };
  assert.equal(spawnPed(ped, 60, 280, true), false);
  z = 220;
  assert.equal(spawnPed(ped, 60, 280, true), true);
  assert.equal(ped.z, 220);
  assert.equal(ped.v, ped.speed);
});

test('long roads are available near their ends and spawn only in the local section', () => {
  const context = populationContext();
  const edge = straightEdge(100, 2000);
  Object.assign(context, { edges: [edge, straightEdge(2000)], nodes: [], nearX: Infinity, nearZ: Infinity });
  trafficFunction('refreshNear', context)();
  assert.deepEqual(context.nearEdges, [edge]);
  const car = { half: 2.25 };
  assert.equal(trafficFunction('spawnVehicle', context)(car, 0, 350, false), true);
  assert.ok(edge.sz + car.s <= 350);
  assert.ok(car.s >= car.half + 5);
});

test('crossing pedestrians fall back to a sidewalk when nearby crosswalks are unusable', () => {
  const context = populationContext();
  context.nearSignals.push({});
  context.nearEdges.push(straightEdge(200));
  let crossings = 0;
  context.crosswalkTrack = () => { crossings++; return false; };
  context.sidewalkTrack = () => {
    Object.assign(context.track, { ax: 0, az: 200, ux: 0, uz: 1, len: 20, node: null });
    return true;
  };
  const ped = { crossesStreets: true, speed: 1.4, rig: {} };
  assert.equal(trafficFunction('spawnPed', context)(ped, 60, 280, true), true);
  assert.equal(crossings, 5);
  assert.equal(ped.node, null);
  assert.equal(ped.z, 210);
});

test('a vehicle is drawn on its level followed at a limited grade: a step is driven over, not popped through', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../js/traffic.js'), 'utf8');
  const from = src.indexOf('const SMOOTH_GRADE');
  const body = src.slice(from, src.indexOf('};', from) + 2);
  const followLevel = new Function(`${body}
return followLevel;`)();
  const v = { gy: 0 };
  followLevel(v, 1);
  assert.equal(v.gs, 0, 'starts on its level');
  v.gy = 5;
  followLevel(v, 1);
  assert.ok(Math.abs(v.gs - 0.3) < 1e-9, 'a 5 m step: 0.3 m per metre driven');
  for (let i = 0; i < 20; i++) followLevel(v, 1);
  assert.equal(v.gs, 5, 'and it arrives');
  followLevel(v, 0);
  assert.equal(v.gs, 5, 'standing still it stays');
});

// Drivers dodging the player: late, as people do, and committed to whatever they do
function dodgeHarness({ isRoadClear = (x) => Math.abs(x) <= 6.65 } = {}) {
  const context = {
    AVOID_NOTICE: 1.8, AVOID_HOLD: 1.2, clock: 0,
    threat: { ahead: 0, aside: 0, across: 0 },
    player: { active: true, x: 0, z: 0, vx: 0, vz: 0, fx: 0, fz: 1, halfW: 0.86, halfL: 2.18 },
    network: { isRoadClear }
  };
  for (const name of ['threatTime', 'swerveRoom', 'react']) context[name] = trafficFunction(name, context);
  // a car heading +z (its right is -x) in the middle of the road
  const car = { x: 0, z: 0, tx: 0, tz: 1, yaw: 0, speed: 12, half: 2.25, halfWidth: 0.86, dl: 0,
    evade: 0, alarm: 0, panicUntil: 0, panicAcc: 0, reaction: 0.8 };
  // the player at (x, z) heading `heading` at `speed`, the car on at its speed, for `seconds` at 60 Hz
  const step = (x, z, heading, speed, seconds) => {
    for (let k = 0; k < seconds * 60; k++) {
      Object.assign(context.player, { x, z, fx: Math.sin(heading), fz: Math.cos(heading),
        vx: Math.sin(heading) * speed, vz: Math.cos(heading) * speed });
      context.react(car, 1 / 60);
      context.clock += 1 / 60;
      car.z += car.speed / 60;
      x += Math.sin(heading) * speed / 60;
      z += Math.cos(heading) * speed / 60;
    }
    return { x, z };
  };
  return { context, car, step };
}

test('drivers notice a player about to hit them only shortly before, and react later still', () => {
  const { context, car, step } = dodgeHarness();
  // head-on at 12 + 14 m/s from 60 m: 2.1 s to impact, noticed 1.8 s before (after 0.3 s), acted on 0.8 s later
  let p = step(0, 60, Math.PI, 14, 0.3);
  assert.equal(car.alarm, 0, 'not noticed yet');
  p = step(p.x, p.z, Math.PI, 14, 0.7);
  assert.ok(car.alarm > 0 && car.panicUntil === 0, 'noticed, not reacting yet');
  step(p.x, p.z, Math.PI, 14, 0.2);
  assert.ok(car.panicUntil > 0, 'reacting, about a second before impact');
  assert.ok(Math.abs(context.threatTime(car) - 0.95) < 0.15);
});

test('a driver about to be hit head-on brakes and swerves; hit from behind, it floors it instead of braking', () => {
  const head = dodgeHarness();
  head.step(0, 40, Math.PI, 14, 1.2);
  assert.equal(head.car.panicAcc, -1);
  assert.equal(head.car.evade, 2.2, 'to the right, the player coming straight at it');
  const rear = dodgeHarness();
  rear.step(0.5, -25, 0, 26, 1.2);
  assert.equal(rear.car.panicAcc, 1);
  assert.equal(rear.car.evade, 2.2, 'right, away from the player coming up on its left (+x)');
});

test('drivers swerve behind a player crossing their way, and to the side with room', () => {
  // crossing from the car's left (+x) to its right: swerving left, behind the player
  const cross = dodgeHarness();
  cross.step(25, 25, -Math.PI / 2, 12, 1.2);
  assert.ok(cross.car.evade < 0);
  // head-on with the curb close on its right (-x): left it is
  const curb = dodgeHarness({ isRoadClear: (x) => x >= -2.55 && x <= 8 });
  curb.step(0, 40, Math.PI, 14, 1.2);
  assert.equal(curb.car.evade, -2.2);
});

test('drivers commit to their manoeuvre whatever the player does then', () => {
  const { car, step } = dodgeHarness();
  let p = step(0, 40, Math.PI, 14, 1.2);
  const { evade, panicAcc } = car;
  assert.ok(evade !== 0);
  // the player swerves the same way: the driver keeps on
  p = step(p.x - 3, p.z, Math.PI, 14, 0.3);
  assert.equal(car.evade, evade);
  assert.equal(car.panicAcc, panicAcc);
});

test('a player passing in the next lane or going away is no threat', () => {
  const { context, car } = dodgeHarness();
  Object.assign(context.player, { x: -3.6, z: -10, vx: 0, vz: 20, fx: 0, fz: 1 });
  assert.equal(context.threatTime(car), Infinity);
  Object.assign(context.player, { x: 0, z: 10, vx: 0, vz: 20 });
  assert.equal(context.threatTime(car), Infinity);
});

// Steering: cars turn only as fast as their front wheels turn them, the wheels as fast as a person turns them
function steeringHarness() {
  const consts = ['CAR_DRIVER', 'BUS_DRIVER', 'PLUS_DRIVER', 'LOCK_MAX', 'NOSE_MAX'].map((name) => source.match(new RegExp(`^const ${name} = .*$`, 'm'))?.[0])
    .concat(['bendA', 'bendB', 'at'].map((name) => source.match(new RegExp(`^  const ${name} = .*$`, 'm'))?.[0]));
  assert.ok(consts.every(Boolean), 'steering constants are present');
  const context = { clamp: (x, lo, hi) => Math.max(lo, Math.min(hi, x)), connector() {}, curvePoint() {} };
  vm.runInNewContext(consts.join('\n').replace(/^\s*const /gm, 'var '), context);
  for (const name of ['steer', 'previewPoint', 'lanePoint', 'pathPoint', 'locate']) {
    context[name] = trafficFunction(name, context);
  }
  const edge = { sx: 0, sz: 0, dx: 0, dz: 1, rx: -1, rz: 0, len: 5000, lanes: [-1.8, 1.8] };
  const car = (speed, extra = {}) => {
    const v = { half: 2.25, axle: 1.38, driver: context.CAR_DRIVER, edge, lane: 0, s: 10, conn: null, trail: null,
      speed, dl: 0, dlv: 0, delta: 0, evade: 0, yaw: 0, nose: 0, yawRate: 0, yawVel: 0, tx: 0, tz: 1, x: 0, z: 0,
      move: { out: [0, 1], to: null }, ...extra };
    context.locate(v);
    return v;
  };
  // drive v on for `seconds` at 60 Hz, as drive() moves it along its path; the fastest it turns and turns the wheel
  const run = (v, seconds) => {
    let yawRate = 0, wheelRate = 0;
    for (let k = 0; k < seconds * 60; k++) {
      const { yaw, delta } = v;
      v.s += v.speed * Math.cos(v.nose) / 60;
      context.steer(v, 1 / 60);
      context.locate(v);
      yawRate = Math.max(yawRate, Math.abs(v.yaw - yaw) * 60);
      wheelRate = Math.max(wheelRate, Math.abs(v.delta - delta) * 60);
    }
    return { yawRate, wheelRate };
  };
  return { context, car, run };
}

test('a lane change is steered: the car turns only as fast as its wheels let it, and settles in its lane', () => {
  const { context, car, run } = steeringHarness();
  const v = car(12, { dl: 3.6 }); // (just changed lanes: 3.6 m right of its new lane's centre)
  const { yawRate, wheelRate } = run(v, 6);
  assert.ok(wheelRate <= context.CAR_DRIVER.steerRate + 1e-9, `wheel turned at ${wheelRate}`);
  assert.ok(yawRate * 12 <= 1.3 * context.CAR_DRIVER.aLat + 0.05, `turned at ${yawRate} rad/s`);
  assert.ok(Math.abs(v.dl) < 0.1 && Math.abs(v.yaw) < 0.02, 'in its lane, heading down it');
});

test('a panicking driver yanks the wheel, but the car still turns only as fast as the tyres grip', () => {
  const { context, car, run } = steeringHarness();
  const v = car(12, { evade: -2.2 });
  const { yawRate, wheelRate } = run(v, 1.5);
  assert.ok(wheelRate <= 2.5 * context.CAR_DRIVER.steerRate + 1e-9);
  assert.ok(yawRate * 12 <= context.CAR_DRIVER.grip + 0.05, `turned at ${yawRate} rad/s`);
  assert.ok(v.dl < -1.5, 'well out of the way after 1.5 s');
});

test('a standing car does not turn, however far it is off its line', () => {
  const { car, run } = steeringHarness();
  const v = car(0, { dl: 2 });
  run(v, 2);
  assert.equal(v.yaw, 0);
  assert.equal(v.dl, 2);
});

// Aalborg's lane-to-lane links can turn 90 degrees in a metre or two, faster than any car turns: there the car is
// turned with its path rather than left heading off it sideways (it would creep along and drift across the junction)
test('a car heading far off its path is turned with it, unless it swerves or spins from a knock', () => {
  const { context, car, run } = steeringHarness();
  const v = car(3, { yaw: 1.4 }); // (as if its path had just turned 80 degrees under it)
  context.locate(v);
  run(v, 1 / 60);
  assert.ok(Math.abs(v.nose) <= context.NOSE_MAX + 1e-9, `heads ${v.nose} rad off its path`);
  const spun = car(3, { yaw: 1.4, yawVel: 2 });
  context.locate(spun);
  run(spun, 1 / 60);
  assert.ok(Math.abs(spun.nose) > 1, 'a knock may spin it off its path');
});
