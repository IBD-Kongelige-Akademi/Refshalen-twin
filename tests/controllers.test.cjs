const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const source = readFileSync(join(__dirname, '../js/controllers.js'), 'utf8');
let collisionShapesModule;
let staticCollidersModule;
let articulatedBusModule;

test.before(async () => {
  [collisionShapesModule, staticCollidersModule, articulatedBusModule] = await Promise.all([
    import('../js/collision-shapes.js'), import('../js/static-colliders.js'), import('../js/articulated-bus.js')
  ]);
});

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) || []) listener(event);
    }
  };
}

function keyboardHarness(overrides = {}, moduleImports = {}) {
  const window = eventTarget();
  const document = { ...eventTarget(), hidden: false };
  const config = {
    TELEPORT_LOCATIONS: { torv: { z: 0 } },
    isTypingInField: (event) => ['INPUT', 'SELECT'].includes(event.target?.tagName),
    ...overrides
  };
  const { ThirdPersonControllerManager } = loadModule(source, {
    globals: { window, document },
    imports: {
      'three/webgpu': {},
      './city-config.js': config,
      './tsl-materials.js': {},
      './actor-models.js': {},
      './pedestrians.js': {},
      './vehicle-lights.js': {},
      './collision-shapes.js': collisionShapesModule,
      './static-colliders.js': staticCollidersModule,
      './rigid-meshes.js': { mergeRigidMeshes: () => ({}) },
      './articulated-bus.js': articulatedBusModule,
      ...moduleImports
    }
  });
  // Exercise the production event handlers without constructing the scene's 3D models.
  const controller = Object.create(ThirdPersonControllerManager.prototype);
  controller.keys = Object.fromEntries(['forward', 'backward', 'left', 'right', 'up', 'down', 'boost'].map((action) => [action, false]));
  controller.bindKeyboard();
  return {
    controller,
    window,
    document,
    key(type, code, tagName = 'BODY') {
      window.dispatch(type, { code, target: { tagName } });
    }
  };
}

test('releasing a movement key after focusing search stops movement', () => {
  const { controller, key } = keyboardHarness();
  key('keydown', 'KeyW');
  assert.equal(controller.keys.forward, true);
  key('keyup', 'KeyW', 'INPUT');
  assert.equal(controller.keys.forward, false);

  key('keydown', 'KeyW', 'INPUT');
  assert.equal(controller.keys.forward, false, 'typing in search does not move the player');
});

test('releasing one movement binding preserves another held binding', () => {
  const { controller, key } = keyboardHarness();
  key('keydown', 'KeyW');
  key('keydown', 'ArrowUp');
  key('keyup', 'ArrowUp');
  assert.equal(controller.keys.forward, true);
  key('keyup', 'KeyW');
  assert.equal(controller.keys.forward, false);
});

test('either Shift key keeps boost active until both are released', () => {
  const { controller, key } = keyboardHarness();
  key('keydown', 'ShiftLeft');
  key('keydown', 'ShiftRight');
  key('keyup', 'ShiftLeft');
  assert.equal(controller.keys.boost, true);
  key('keyup', 'ShiftRight');
  assert.equal(controller.keys.boost, false);
});

test('keyboard and touch input remain active independently', () => {
  const { controller, key } = keyboardHarness();
  controller.setTouchInput('forward', 0.35);
  assert.equal(controller.keys.forward, 0.35);
  key('keydown', 'KeyW');
  assert.equal(controller.keys.forward, true);
  controller.setTouchInput('forward', 0.6);
  assert.equal(controller.keys.forward, true);
  key('keyup', 'KeyW');
  assert.equal(controller.keys.forward, 0.6);
  controller.setTouchInput('forward', 0);
  assert.equal(controller.keys.forward, false);
});

test('clearing touch input preserves held keyboard controls', () => {
  const { controller, key } = keyboardHarness();
  key('keydown', 'KeyW');
  controller.setTouchInput('forward', 0.4);
  controller.setTouchInput('left', 0.7);
  controller.setTouchInput('boost', true);
  controller.clearTouchInput();
  assert.equal(controller.keys.forward, true);
  assert.equal(controller.keys.left, false);
  assert.equal(controller.keys.boost, false);
  key('keyup', 'KeyW');
  assert.equal(controller.keys.forward, false);
});

test('touch strengths are clamped and unknown actions are ignored', () => {
  const { controller } = keyboardHarness();
  controller.setTouchInput('forward', 2);
  controller.setTouchInput('left', -0.5);
  controller.setTouchInput('up', true);
  controller.setTouchInput('unknown', 1);
  assert.equal(controller.keys.forward, 1);
  assert.equal(controller.keys.left, false);
  assert.equal(controller.keys.up, true);
  assert.equal(Object.hasOwn(controller.keys, 'unknown'), false);
});

for (const interruption of ['blur', 'hidden', 'reset']) {
  test(`${interruption} clears held controls and their physical key state`, () => {
    const { controller, window, document, key } = keyboardHarness();
    key('keydown', 'KeyW');
    key('keydown', 'KeyA');
    key('keydown', 'Space');
    key('keydown', 'ShiftLeft');
    controller.setTouchInput('forward', 0.4);
    controller.setTouchInput('backward', 0.8);
    controller.setTouchInput('down', true);
    if (interruption === 'blur') {
      window.dispatch('blur');
    } else if (interruption === 'hidden') {
      document.hidden = true;
      document.dispatch('visibilitychange');
    } else {
      controller.resetInput();
    }
    assert.equal(Object.values(controller.keys).some(Boolean), false);

    // A fresh use of the alias must not revive the old key whose keyup was lost.
    key('keydown', 'ArrowUp');
    key('keyup', 'ArrowUp');
    assert.equal(controller.keys.forward, false);
  });
}

function advanceWithTouch(mode, strength, reverse) {
  const { controller } = keyboardHarness();
  const entity = { position: { x: 0, y: 0, z: 0 }, heading: 0, speed: 0 };
  if (mode === 'Person') Object.assign(entity, { verticalVel: 0 });
  if (mode === 'Car') Object.assign(entity, {
    vx: 0, vz: 0, angularVel: 0, steerAngle: 0, pitchVel: 0, rollVel: 0, heaveVel: 0, heaveY: 0, wheelSpin: 0,
    chassisPivot: { rotation: { x: 0, z: 0 }, position: { y: 0 } }, wheels: []
  });
  if (mode === 'Cyclist' || mode === 'Cargobike') Object.assign(entity, {
    standAmount: 0, bikeFrame: {},
    leanAngle: 0, leanPivot: { rotation: { z: 0 } },
    frontWheel: { rotation: { x: 0 } }, rearWheel: { rotation: { x: 0 } },
    pedalPhase: 0, crankPivot: { rotation: { x: 0 } }, pedals: []
  });
  if (mode === 'Drone') Object.assign(entity, {
    position: { x: 0, y: 20, z: 0 }, velX: 0, velZ: 0, verticalSpeed: 0, pitchAngle: 0, rollAngle: 0, motorLoad: 0, landed: false,
    tiltPivot: { rotation: { x: 0, z: 0 }, position: { y: 0 } }, gimbal: { rotation: { x: 0, z: 0 } }
  });
  controller.entities = { [mode.toLowerCase()]: entity };
  controller.getGroundHeight = () => 0;
  controller.droneSupportAt = () => 0;
  controller.resolveHorizontalCollision = () => {};
  controller.setTouchInput(reverse ? 'backward' : 'forward', strength);
  controller.setTouchInput(reverse ? 'right' : 'left', strength);
  if (mode === 'Drone') controller.setTouchInput(reverse ? 'down' : 'up', strength);
  if (mode === 'Cyclist' || mode === 'Cargobike') controller.updateCyclist(0.1, entity, mode.toLowerCase());
  else controller[`update${mode}`](0.1, 0);
  return entity;
}

for (const mode of ['Person', 'Car', 'Cyclist', 'Cargobike', 'Drone']) {
  test(`analog ${mode.toLowerCase()} input proportionally scales movement and turning`, () => {
    for (const reverse of [false, true]) {
      const full = advanceWithTouch(mode, 1, reverse);
      const partial = advanceWithTouch(mode, 0.4, reverse);
      assert.ok(Math.abs(partial.speed - full.speed * 0.4) < 1e-10, 'movement should scale with joystick strength');
      const turn = mode === 'Car' ? 'steerAngle' : 'heading';
      assert.ok(Math.abs(partial[turn] - full[turn] * 0.4) < 1e-10, 'turning should scale with joystick strength');
      if (mode === 'Drone') {
        assert.ok(Math.abs(partial.verticalSpeed - full.verticalSpeed * 0.4) < 1e-10);
      }
    }
  });
}

function teleportHarness(mode, colliders = [], shore = () => ({ westX: -500, eastX: 500 })) {
  const harness = keyboardHarness({
    ISLAND_BOUNDS: { minX: -500, maxX: 500, minZ: -500, maxZ: 500, sidewalkHeight: 0.22 },
    CENTRAL_PARK_BOUNDS: { minX: 1000, maxX: 1100, minZ: 1000, maxZ: 1100 },
    getIslandBoundsAtZ: shore,
    blockAt: () => null
  });
  const { controller } = harness;
  const position = (x = 0, y = 0, z = 0) => ({ x, y, z, copy(p) { this.x = p.x; this.y = p.y; this.z = p.z; } });
  const pivot = () => ({ position: position(), rotation: { x: 0.1, y: 0, z: -0.2 } });
  const chase = { person: [4.3, 1.95], car: [6.9, 2.12], cyclist: [4.8, 2.05], cargobike: [6.2, 2.35], drone: [4.0, 1.5] };
  const ent = {
    type: mode, chaseDistance: chase[mode][0], chaseHeight: chase[mode][1],
    position: position(400, mode === 'drone' ? 120 : 0, 400), heading: 1, speed: 20,
    mesh: pivot(),
    verticalVel: 5, vx: 3, vz: -4, angularVel: 2, steerAngle: 0.4,
    pitchVel: 3, rollVel: 4, heaveY: 0.1, heaveVel: 2, chassisPivot: pivot(),
    lastCollisionSpark: { speed: 5 }, carState: { value: { x: 0 } }, wheelSpin: 1,
    wheels: [{ isFront: true, steerPivot: { rotation: { y: 0.4 } }, tire: { rotation: { x: 0 } } }],
    leanAngle: 0.3, leanPivot: pivot(), pedalPhase: 0.7, standAmount: 0, bikeFrame: {},
    frontWheel: { rotation: { x: 0 } }, rearWheel: { rotation: { x: 0 } },
    crankPivot: { rotation: { x: 0 } },
    verticalSpeed: -8, pitchAngle: 0.2, rollAngle: -0.2, tiltPivot: pivot(), velX: 2, velZ: -1, motorLoad: 0.6, gimbal: pivot(),
    pedals: [],
    rig: { reset(...args) { this.resetArgs = args; } },
    crowd: { begin() {}, add() {}, end() {} }
  };
  controller.activeMode = mode;
  controller.entities = { [mode]: ent };
  controller.colliders = colliders;
  controller._colliderCells = null;
  controller.getGroundHeight = (x, z, mode) => mode === 'person' ? (x < 0 ? 1.24 : 0.22) : 0;
  return { ...harness, ent };
}

for (const mode of ['person', 'car', 'cyclist', 'cargobike', 'drone']) {
  test(`${mode} teleport stops carried motion and updates its arrival pose immediately`, () => {
    const { controller, ent, key } = teleportHarness(mode);
    key('keydown', 'KeyW');
    key('keydown', 'Space');
    controller.setTouchInput('left', 0.8);
    const result = controller.teleportActiveTo(30, 20, 0.7);
    assert.deepEqual({ ...result }, { x: 30, z: 20 }, 'an open destination is kept exactly');
    assert.equal(ent.heading, 0.7);
    assert.equal(ent.speed, 0);
    assert.equal(Object.values(controller.keys).some(Boolean), false);
    assert.equal(controller._pressedCodes.size, 0);
    assert.deepEqual([ent.mesh.position.x, ent.mesh.position.y, ent.mesh.position.z], [ent.position.x, ent.position.y, ent.position.z]);
    assert.equal(ent.mesh.rotation.y, 0.7);
    if (mode === 'person') {
      assert.equal(ent.verticalVel, 0);
      assert.equal(ent.position.y, 0.22);
      assert.deepEqual(ent.rig.resetArgs.slice(0, 3), [30, 20, 0.7]);
      assert.equal(ent.rig.resetArgs[3](ent.rig.resetArgs[4], 30, 20), 0.22);
    } else if (mode === 'car') {
      for (const field of ['vx', 'vz', 'angularVel', 'steerAngle', 'pitchVel', 'rollVel', 'heaveY', 'heaveVel']) assert.equal(ent[field], 0, field);
      assert.equal(ent.chassisPivot.rotation.x, 0);
      assert.equal(ent.chassisPivot.rotation.z, 0);
      assert.equal(ent.chassisPivot.position.y, 0);
      assert.equal(ent.wheels[0].steerPivot.rotation.y, 0);
      assert.equal(ent.lastCollisionSpark, null);
    } else if (mode === 'cyclist' || mode === 'cargobike') {
      assert.equal(ent.leanAngle, 0);
      assert.equal(ent.leanPivot.rotation.z, 0);
    } else {
      for (const field of ['verticalSpeed', 'pitchAngle', 'rollAngle', 'velX', 'velZ', 'motorLoad']) assert.equal(ent[field], 0, field);
      assert.equal(ent.tiltPivot.rotation.x, 0);
      assert.equal(ent.tiltPivot.rotation.z, 0);
      assert.equal(ent.tiltPivot.position.y, 0);
      assert.equal(ent.position.y, 40, 'the drone arrives 40 m above the ground');
    }
    const before = [ent.position.x, ent.position.y, ent.position.z, ent.heading];
    if (mode === 'cyclist' || mode === 'cargobike') controller.updateCyclist(0.1, ent, mode);
    else controller[`update${mode[0].toUpperCase()}${mode.slice(1)}`](0.1, 0);
    assert.deepEqual([ent.position.x, ent.position.y, ent.position.z, ent.heading], before, 'the first neutral frame stays at the arrival');
  });
}

test('teleport checks all overlapping buildings instead of leaving a sequential push trap', () => {
  const colliders = [
    { minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 200 },
    { minX: 9, maxX: 20, minZ: 0, maxZ: 10, maxY: 200 }
  ];
  for (const mode of ['person', 'car', 'cyclist', 'drone']) {
    // Reverse order as well: a valid arrival must not rely on collider traversal order.
    for (const list of [colliders, colliders.slice().reverse()]) {
      const { controller, ent } = teleportHarness(mode, list.map(c => ({ ...c })));
      const result = controller.teleportActiveTo(11, 5, 0);
      assert.notDeepEqual({ ...result }, { x: 11, z: 5 });
      const before = [ent.position.x, ent.position.z];
      const radius = mode === 'drone' ? 0.4 : mode === 'person' ? 0.48 : 0.65;
      controller.resolveHorizontalCollision(ent.position, radius, mode === 'car' ? ent : null);
      assert.deepEqual([ent.position.x, ent.position.z], before, `${mode} must already be collision-free`);
      assert.equal(ent.position.y, mode === 'drone' ? 40 : controller.getGroundHeight(result.x, result.z, mode));
    }
  }
});

test('teleports use oriented building footprints without rejecting clear corners of their bounds', () => {
  const cs = Math.SQRT1_2;
  const box = { minX: -8, maxX: 8, minZ: -8, maxZ: 8, maxY: 200, obb: { cx: 0, cz: 0, hx: 8, hz: 2, cs, sn: cs } };
  for (const mode of ['person', 'car', 'cyclist', 'drone']) {
    const { controller, ent } = teleportHarness(mode, [{ ...box }]);
    assert.deepEqual({ ...controller.teleportActiveTo(7, 7, 0.6) }, { x: 7, z: 7 });
    const actual = controller.teleportActiveTo(0, 0, 0.6);
    const before = [actual.x, actual.z];
    controller.resolveHorizontalCollision(ent.position, mode === 'drone' ? 0.4 : mode === 'person' ? 0.48 : 0.65,
      mode === 'car' ? ent : null);
    assert.deepEqual([ent.position.x, ent.position.z], before);
  }
});

test('pedestrians pass clear building corners and resolve real corner hits radially', () => {
  const { controller, ent } = teleportHarness('person', [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 30 }]);
  ent.position.x = ent.position.z = -0.4;
  controller.resolveHorizontalCollision(ent.position, 0.48);
  assert.deepEqual([ent.position.x, ent.position.z], [-0.4, -0.4], 'distance to the corner exceeds the body radius');

  ent.position.x = ent.position.z = -0.2;
  controller.resolveHorizontalCollision(ent.position, 0.48);
  assert.ok(Math.abs(Math.hypot(ent.position.x, ent.position.z) - 0.48) < 1e-6);
  assert.ok(Math.abs(ent.position.x - ent.position.z) < 1e-6, 'a diagonal contact pushes along the corner normal');
});

test('corner collision normals follow an oriented building footprint', () => {
  const cs = Math.SQRT1_2;
  const { controller, ent } = teleportHarness('person', [{
    minX: -10 * cs, maxX: 10 * cs, minZ: -10 * cs, maxZ: 10 * cs, maxY: 30,
    obb: { cx: 0, cz: 0, hx: 5, hz: 5, cs, sn: cs }
  }]);
  // Local (-5.2, -5.2) lies just outside the rotated square's leftmost corner.
  ent.position.x = -10.4 * cs;
  ent.position.z = 0;
  controller.resolveHorizontalCollision(ent.position, 0.48);
  assert.ok(Math.abs(ent.position.x - (-10 * cs - 0.48)) < 1e-6, `resolved X was ${ent.position.x}, ${ent.position.z}`);
  assert.ok(Math.abs(ent.position.z) < 1e-6, 'the correction must not slide sideways along the corner');
});

test('swept player, car, bicycle, cargo bike, and drone motion cannot tunnel through a thin pole', () => {
  const pole = {
    type: 'lamp', shape: 'circle', radius: 0.06,
    minX: -0.06, maxX: 0.06, minZ: -0.06, maxZ: 0.06, minY: 0, maxY: 4,
    obb: { cx: 0, cz: 0, hx: 0.06, hz: 0.06, cs: 1, sn: 0 }
  };
  const starts = { person: -4, car: -5, cyclist: -4, cargobike: -4, drone: -4 };
  const radii = { person: 0.48, car: 1.35, cyclist: 0.65, cargobike: 1.4, drone: 0.4 };
  for (const mode of Object.keys(starts)) {
    const { controller, ent } = teleportHarness(mode, [{ ...pole }]);
    ent.heading = Math.PI / 2;
    ent.position.x = 8;
    ent.position.y = 0;
    ent.position.z = 0;
    controller.resolveHorizontalCollision(ent.position, radii[mode], mode === 'car' ? ent : null, ent,
      { x: starts[mode], z: 0 });
    assert.ok(ent.position.x < 0, `${mode} stopped on the approach side at ${ent.position.x}`);
    assert.ok(Math.abs(ent.position.z) < 1e-6);
    assert.equal(controller._lastHorizontalCollisionResolved, true);
  }
});

test('each actual horizontal movement update supplies its previous position to the sweep', () => {
  const wall = { minX: 0, maxX: 0.08, minZ: -20, maxZ: 20, minY: 0, maxY: 30 };
  for (const mode of ['person', 'car', 'cyclist', 'cargobike', 'drone']) {
    const { controller, ent } = teleportHarness(mode, [{ ...wall }]);
    const start = mode === 'drone' ? -3 : mode === 'car' ? -4 : -3;
    Object.assign(ent.position, { x: start, y: 0, z: 0 });
    ent.heading = Math.PI / 2;
    ent.speed = 0;
    if (mode === 'car') ent.vx = ent.vz = 0;
    if (mode === 'drone') Object.assign(ent, { verticalSpeed: 0, velX: 0, velZ: 0, landed: false });
    controller.keys.forward = 1;
    if (mode === 'person') controller.updatePerson(1);
    else if (mode === 'car') controller.updateCar(1);
    else if (mode === 'cyclist' || mode === 'cargobike') controller.updateCyclist(1, ent, mode);
    else controller.updateDrone(1, 0);
    assert.ok(ent.position.x < 0, `${mode} update stopped before the wall at x=${ent.position.x}`);
    assert.equal(controller._lastHorizontalCollisionResolved, true);
  }
});

test('swept movement keeps tangent motion when glancing along a wall', () => {
  const { controller, ent } = teleportHarness('person', [{ minX: 0, maxX: 0.2, minZ: -10, maxZ: 10, minY: 0, maxY: 30 }]);
  Object.assign(ent.position, { x: 1, y: 0, z: 4 });
  controller.resolveHorizontalCollision(ent.position, 0.48, null, ent, { x: -1, z: -1 });
  assert.ok(ent.position.x <= -0.48 + 1e-6 && ent.position.x > -0.51, `wall clearance is ${ent.position.x}`);
  assert.ok(ent.position.z > 3.9, `the blocked inward component was removed while z reached ${ent.position.z}`);
});

test('deep overlapping boxes resolve to a clear point after repeated bounded corrections', () => {
  const colliders = [
    { minX: 0, maxX: 10, minZ: -10, maxZ: 10, minY: 0, maxY: 30 },
    { minX: -10, maxX: 0.1, minZ: -10, maxZ: 10, minY: 0, maxY: 30 }
  ];
  const { controller, ent } = teleportHarness('person', colliders);
  Object.assign(ent.position, { x: 0, y: 0, z: 0 });
  controller.resolveHorizontalCollision(ent.position, 0.48, null, ent);
  const body = collisionShapesModule.collisionBody('person', 0.48, 0);
  assert.ok(colliders.every((c) => !collisionShapesModule.buildingContact(c, ent.position.x, ent.position.y, ent.position.z, body, {})),
    `unresolved overlap at ${ent.position.x}, ${ent.position.z}`);
  assert.equal(controller._lastHorizontalCollisionResolved, true);
});

test('swept car impacts still trigger the existing vehicle response', () => {
  const pole = {
    type: 'bollard', shape: 'circle', radius: 0.12,
    minX: -0.12, maxX: 0.12, minZ: -0.12, maxZ: 0.12, minY: 0, maxY: 1,
    obb: { cx: 0, cz: 0, hx: 0.12, hz: 0.12, cs: 1, sn: 0 }
  };
  const { controller, ent } = teleportHarness('car', [pole]);
  ent.heading = Math.PI / 2;
  ent.speed = 12;
  Object.assign(ent.position, { x: 5, y: 0, z: 0 });
  controller.resolveHorizontalCollision(ent.position, 1.35, ent, ent, { x: -5, z: 0 });
  assert.ok(ent.position.x < 0 && ent.position.x > -2.6);
  assert.ok(ent.speed < 0, 'a head-on impact still rebounds the car');
  assert.ok(ent.lastCollisionSpark, 'the existing impact spark response remains connected');
});

test('rotated cars use their own separating axes at building corners', () => {
  const { controller, ent } = teleportHarness('car', [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 30 }]);
  ent.heading = -Math.PI / 4;
  ent.speed = 0;
  ent.vx = ent.vz = 0;
  ent.position.x = ent.position.z = -1.8;
  controller.resolveHorizontalCollision(ent.position, 1.35, ent);
  assert.deepEqual([ent.position.x, ent.position.z], [-1.8, -1.8], 'the projected bounds overlap, but the actual car does not');

  ent.position.x = ent.position.z = -0.3;
  controller.resolveHorizontalCollision(ent.position, 1.35, ent);
  assert.ok(Math.abs(ent.position.x + 0.86 * Math.SQRT1_2) < 1e-6);
  assert.ok(Math.abs(ent.position.z + 0.86 * Math.SQRT1_2) < 1e-6, 'the shortest correction is perpendicular to the car side');
});

test('teleports preserve clear rounded corners and separated rotated cars', () => {
  for (const [mode, coordinate, heading] of [['person', -0.45, 0], ['car', -1.8, -Math.PI / 4]]) {
    const { controller, ent } = teleportHarness(mode, [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 30 }]);
    const arrival = controller.teleportActiveTo(coordinate, coordinate, heading);
    assert.deepEqual({ ...arrival }, { x: coordinate, z: coordinate }, `${mode} has room including the arrival margin`);
    controller.resolveHorizontalCollision(ent.position, mode === 'person' ? 0.48 : 1.35, mode === 'car' ? ent : null);
    assert.deepEqual([ent.position.x, ent.position.z], [coordinate, coordinate], 'teleport clearance agrees with movement');

    const blocked = controller.teleportActiveTo(-0.2, -0.2, heading);
    assert.notDeepEqual({ ...blocked }, { x: -0.2, z: -0.2 }, 'a real corner overlap still needs a different arrival');
  }
});

test('movement and teleports pass underneath elevated building sections', () => {
  for (const mode of ['person', 'car', 'cyclist', 'drone']) {
    const { controller, ent } = teleportHarness(mode, [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, minY: 4, maxY: 30 }]);
    controller.getGroundHeight = () => 0;
    const y = 0;
    Object.assign(ent.position, { x: 5, y, z: 5 });
    controller.resolveHorizontalCollision(ent.position, mode === 'drone' ? 0.4 : 0.65, mode === 'car' ? ent : null);
    assert.deepEqual([ent.position.x, ent.position.z], [5, 5], `${mode} fits below the overhang`);
    assert.deepEqual({ ...controller.teleportActiveTo(5, 5, 0, y) }, { x: 5, z: 5 });
  }
});

test('building clearance uses the full player height beneath an overhang', () => {
  for (const [mode, height] of [['person', 1.9], ['car', 1.8], ['cyclist', 1.9], ['drone', 0.3]]) {
    const y = 0;
    const { controller, ent } = teleportHarness(mode, [{
      minX: 0, maxX: 10, minZ: 0, maxZ: 10, minY: y + height - 0.1, maxY: 30
    }]);
    controller.getGroundHeight = () => 0;
    Object.assign(ent.position, { x: 5, y, z: 5 });
    controller.resolveHorizontalCollision(ent.position, mode === 'drone' ? 0.4 : 0.65, mode === 'car' ? ent : null);
    assert.notDeepEqual([ent.position.x, ent.position.z], [5, 5], `${mode} intersects the underside`);
    assert.notDeepEqual({ ...controller.teleportActiveTo(5, 5, 0, y) }, { x: 5, z: 5 });
  }
});

test('players above a roof are clear once their body bottoms clear it', () => {
  for (const mode of ['person', 'car', 'cyclist', 'drone']) {
    const { controller, ent } = teleportHarness(mode, [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 10 }]);
    controller.getGroundHeight = () => 10.1;
    const y = 10.1;
    Object.assign(ent.position, { x: 5, y, z: 5 });
    controller.resolveHorizontalCollision(ent.position, mode === 'drone' ? 0.4 : 0.65, mode === 'car' ? ent : null);
    assert.deepEqual([ent.position.x, ent.position.z], [5, 5], `${mode} clears the visible roof`);
    assert.deepEqual({ ...controller.teleportActiveTo(5, 5, 0, y) }, { x: 5, z: 5 });
  }
});

test('the drone cannot sink its feet into a roof it is beside', () => {
  const { controller, ent } = teleportHarness('drone', [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 10 }]);
  Object.assign(ent.position, { x: 5, y: 9.9, z: 5 });
  controller.resolveHorizontalCollision(ent.position, 0.4);
  assert.notDeepEqual([ent.position.x, ent.position.z], [5, 5]);
  assert.notDeepEqual({ ...controller.teleportActiveTo(5, 5, 0, 9.9) }, { x: 5, z: 5 });
});

test('ground arrivals share movement shoreline limits while the drone arrives above lower buildings', () => {
  const shore = z => ({ westX: -40 + z * 0.05, eastX: 40 + z * 0.05 });
  const { controller, ent } = teleportHarness('person', [], shore);
  const result = controller.teleportActiveTo(1000, -1000);
  assert.deepEqual({ ...result }, { x: 8.5, z: -470 });
  controller.resolveHorizontalCollision(ent.position, 0.48);
  assert.deepEqual([ent.position.x, ent.position.z], [result.x, result.z]);

  const drone = teleportHarness('drone', [{ minX: -30, maxX: 30, minZ: -30, maxZ: 30, maxY: 30 }]);
  drone.ent.position.y = 10;
  assert.deepEqual({ ...drone.controller.teleportActiveTo(0, 0) }, { x: 0, z: 0 });
  assert.equal(drone.ent.position.y, 40, 'a 30 m building is below the 40 m arrival');
  // a restored altitude is kept, but never above the 120 m ceiling over the ground
  drone.controller.teleportActiveTo(0, 0, 0, 500);
  assert.equal(drone.ent.position.y, 120);
});

test('a displaced pedestrian samples ground and resets its feet at the resolved destination', () => {
  const { controller, ent } = teleportHarness('person', [{ minX: -4, maxX: 0, minZ: -10, maxZ: 10, maxY: 30 }]);
  assert.deepEqual({ ...controller.teleportActiveTo(-1, 0) }, { x: 3, z: 0 });
  assert.equal(ent.position.y, 0.22, 'the requested point was on the higher ground, but the clear arrival is lower');
  assert.deepEqual(ent.rig.resetArgs.slice(0, 2), [3, 0]);
});

test('failed or invalid teleports keep the current position and stop the player with bounded search', () => {
  const { controller, ent } = teleportHarness('car', [{ minX: -300, maxX: 300, minZ: -300, maxZ: 300, maxY: 500 }]);
  let checks = 0;
  const near = controller.nearColliders;
  controller.nearColliders = function (...args) { checks++; return near.apply(this, args); };
  assert.deepEqual({ ...controller.teleportActiveTo(0, 0) }, { x: 400, z: 400 });
  assert.ok(checks <= 2049, 'the search must be bounded even inside an enormous obstacle');
  assert.equal(ent.speed, 0);
  assert.equal(ent.vx, 0);
  assert.equal(ent.angularVel, 0);
  assert.deepEqual({ ...controller.teleportActiveTo(NaN, Infinity) }, { x: 400, z: 400 });
});

test('successive mode teleports keep parked players out of the arrival and default chase view', () => {
  const { controller, ent: car } = teleportHarness('car');
  const person = teleportHarness('person').ent;
  const cyclist = teleportHarness('cyclist').ent;
  controller.entities = { car, person, cyclist };
  person.position.x = 300;
  cyclist.position.x = 200;
  const heading = Math.PI / 2; // The first radial candidate is +X: its rear camera would sit on the parked car.
  assert.deepEqual({ ...controller.teleportActiveTo(0, 0, heading) }, { x: 0, z: 0 });
  const arrivals = [car];
  const radii = { car: 2.4, person: 0.48, cyclist: 1.0 };
  for (const mode of ['person', 'cyclist']) {
    controller.activeMode = mode;
    const ent = controller.entities[mode];
    const actual = controller.teleportActiveTo(0, 0, heading);
    assert.notDeepEqual({ ...actual }, { x: 0, z: 0 });
    for (const parked of arrivals) {
      const dx = parked.position.x - actual.x, dz = parked.position.z - actual.z;
      const cameraBack = Math.cos(0.09) * ent.chaseDistance;
      const along = Math.max(0, Math.min(cameraBack, -dx));
      assert.ok(Math.hypot(dx, dz) > radii[parked.type] + radii[mode], 'player bodies must not overlap');
      assert.ok(Math.hypot(dx + along, dz) > radii[parked.type] + 0.5, 'the complete default chase corridor must be clear');
    }
    assert.deepEqual([car.position.x, car.position.z], [0, 0], 'switching modes leaves the parked car in place');
    arrivals.push(ent);
  }
});

test('player clearance respects altitude and permits a ground arrival under an airborne drone', () => {
  const { controller, ent } = teleportHarness('person');
  const drone = teleportHarness('drone').ent;
  drone.position.x = drone.position.z = 0;
  drone.position.y = 120;
  controller.entities.drone = drone;
  assert.deepEqual({ ...controller.teleportActiveTo(0, 0) }, { x: 0, z: 0 });
  assert.equal(ent.position.y, 0.22);
  drone.position.y = 1;
  assert.notDeepEqual({ ...controller.teleportActiveTo(0, 0) }, { x: 0, z: 0 }, 'a drone hovering at head height must be avoided');
});

// ---------------------------------------------------------------------------------------------------------------------
// the drone's flight

function droneHarness(colliders = [], ground = 0) {
  const h = teleportHarness('drone', colliders);
  h.controller.getGroundHeight = () => ground;
  Object.assign(h.ent, { heading: 0, speed: 0, velX: 0, velZ: 0, verticalSpeed: 0, pitchAngle: 0, rollAngle: 0, motorLoad: 0, landed: false });
  h.fly = (seconds, dt = 1 / 60) => { for (let t = 0; t < seconds; t += dt) h.controller.updateDrone(dt, t); };
  return h;
}

test('drone: 60 km/h, 75 km/h in sport, the body tilted forward but never more than 25°, level again in a hover', () => {
  const { ent, key, fly } = droneHarness();
  Object.assign(ent.position, { x: 0, y: 20, z: 0 });
  key('keydown', 'KeyW');
  fly(6);
  assert.ok(Math.abs(Math.hypot(ent.velX, ent.velZ) * 3.6 - 60) < 0.1, `cruise ${Math.hypot(ent.velX, ent.velZ) * 3.6} km/h`);
  assert.ok(ent.pitchAngle > 0 && ent.pitchAngle <= 25 * Math.PI / 180 + 1e-9, 'nose down towards the travel direction');
  key('keydown', 'ShiftLeft');
  fly(6);
  assert.ok(Math.abs(Math.hypot(ent.velX, ent.velZ) * 3.6 - 75) < 0.1, 'sport');
  key('keyup', 'KeyW');
  key('keyup', 'ShiftLeft');
  fly(6);
  assert.ok(Math.hypot(ent.velX, ent.velZ) < 0.05 && Math.abs(ent.pitchAngle) < 0.01 && Math.abs(ent.rollAngle) < 0.01, 'brakes to a level hover');
  assert.ok(Math.abs(ent.position.y - 20) < 1e-9, 'holds its height without input');
});

test('drone: the velocity follows the nose in a turn (no momentum lost)', () => {
  const { ent, key, fly } = droneHarness();
  Object.assign(ent.position, { x: 0, y: 20, z: 0 });
  key('keydown', 'KeyW');
  fly(6);
  key('keydown', 'KeyA');
  fly(1);
  key('keyup', 'KeyA');
  fly(1.5);
  const along = ent.velX * Math.sin(ent.heading) + ent.velZ * Math.cos(ent.heading);
  assert.ok(Math.abs(ent.heading) > 1, 'it turned');
  assert.ok(along * 3.6 > 59, `full speed along the new heading: ${along * 3.6} km/h`);
});

test('drone: never more than 120 m over the ground', () => {
  for (const ground of [0, 35]) {
    const { ent, key, fly } = droneHarness([], ground);
    Object.assign(ent.position, { x: 0, y: ground + 100, z: 0 });
    key('keydown', 'Space');
    fly(10);
    assert.ok(Math.abs(ent.position.y - (ground + 120)) < 1e-9, `capped at ${ent.position.y - ground} m over the ground`);
  }
});

test('drone: lands on a roof, stands still there and takes off with a climb', () => {
  const roof = { minX: -10, maxX: 10, minZ: -10, maxZ: 10, maxY: 14 };
  const { ent, key, fly } = droneHarness([roof]);
  Object.assign(ent.position, { x: 0, y: 18, z: 0 });
  key('keydown', 'KeyQ');
  fly(3);
  assert.equal(ent.position.y, 14, 'it settles on the roof, not inside the building');
  assert.equal(ent.landed, true);
  key('keyup', 'KeyQ');
  key('keydown', 'KeyW');
  fly(1);
  assert.deepEqual([ent.position.x, ent.position.z], [0, 0], 'standing on the roof it does not slide');
  key('keyup', 'KeyW');
  key('keydown', 'Space');
  fly(1);
  assert.ok(ent.position.y > 15 && !ent.landed, 'a climb takes off again');
  assert.ok(ent.motorLoad > 0.4, 'the motors work harder in the climb');
});

// an LoD2 roof sampler over one building: `roof(x, z)` inside its footprint, a record for `id` only
function lod2Roof(id, roof) {
  const at = (bid, x, z) => (bid === id ? roof(x, z) : null);
  at.has = (bid) => bid === id;
  return at;
}

test('drone: on an LoD2 roof it stands on the roof as drawn, slopes and lower wings included', () => {
  const house = { id: 'building:gdk:7', type: 'building', minX: -10, maxX: 10, minZ: -10, maxZ: 10, maxY: 12.45 }; // eave 12 + 0.45
  const { controller, ent, key, fly } = droneHarness([house]);
  // a gable along z: 12 m at x = +-10, 16 m on the ridge at x = 0; a 6 m wing at z > 5 with no roof over the strip x > 9.6
  controller.roofHeightAt = lod2Roof('gdk:7', (x, z) => (x > 9.6 ? null : z > 5 ? 6 : 16 - 0.4 * Math.abs(x)));
  for (const [x, z, roof] of [[0, 0, 16], [5, 0, 14], [-5, 8, 6], [9.8, 0, 12.45]]) {
    Object.assign(ent.position, { x, y: 22, z });
    Object.assign(ent, { velX: 0, velZ: 0, verticalSpeed: 0, landed: false });
    key('keydown', 'KeyQ');
    fly(4);
    key('keyup', 'KeyQ');
    assert.ok(Math.abs(ent.position.y - roof) < 1e-9 && ent.landed, `(${x}, ${z}): on the roof at ${ent.position.y}, expected ${roof}`);
    assert.deepEqual([ent.position.x, ent.position.z], [x, z], 'not pushed off by the walls');
  }
});

test('drone: a heightfield building stops it at the wall of its higher part and lets it slide along', () => {
  const house = { id: 'building:gdk:8', type: 'building', minX: 0, maxX: 20, minZ: -50, maxZ: 50, maxY: 10.45 };
  const { controller, ent, key, fly } = droneHarness([house]);
  controller.roofHeightAt = lod2Roof('gdk:8', () => 10);
  Object.assign(ent.position, { x: -5, y: 4, z: 0 });
  ent.heading = Math.PI / 2 - 0.3; // towards +x, a little towards +z
  key('keydown', 'KeyW');
  fly(3);
  assert.ok(ent.position.x <= -DRONE_RADIUS + 1e-9, `held outside the wall at x ${ent.position.x}`);
  assert.ok(ent.position.z > 3, 'slid along the facade');
  key('keyup', 'KeyW');
  // above the roof it flies across
  Object.assign(ent.position, { x: -5, y: 11, z: 0 });
  Object.assign(ent, { velX: 0, velZ: 0, heading: Math.PI / 2 });
  key('keydown', 'KeyW');
  fly(2);
  assert.ok(ent.position.x > 20, 'over the roof');
});
const DRONE_RADIUS = 0.4;

test('drone: flying low down a street it stays out of the buildings on either side', () => {
  const buildings = [
    { minX: -40, maxX: -4, minZ: 0, maxZ: 120, maxY: 15 }, // the street is x -4..4, z 0..120
    { minX: 4, maxX: 40, minZ: 0, maxZ: 120, maxY: 15 }
  ];
  const { controller, ent, key, fly } = droneHarness(buildings);
  Object.assign(ent.position, { x: 0, y: 6, z: 2 });
  ent.heading = 0.12; // a little off the street's axis: it meets the right-hand facade
  key('keydown', 'KeyW');
  const body = collisionShapesModule.collisionBody('drone', 0.4, 0);
  for (let i = 0; i < 240; i++) {
    fly(1 / 60);
    for (const b of buildings) {
      assert.ok(!collisionShapesModule.buildingContact(b, ent.position.x, ent.position.y, ent.position.z, body, {}), `inside a building at ${ent.position.x}, ${ent.position.z}`);
    }
  }
  assert.ok(ent.position.z > 40, 'it slid along the facade instead of stopping');
  assert.equal(controller._lastHorizontalCollisionResolved, true);
});

for (const mode of ['cyclist', 'cargobike']) {
  test(`${mode} reaches 25 km/h normally and 30 km/h sprinting, standing only during acceleration`, () => {
    const { controller, ent, key } = teleportHarness(mode);
    controller.resolveHorizontalCollision = () => {};
    ent.speed = 0;
    const step = (frames) => {
      for (let i = 0; i < frames; i++) controller.updateCyclist(1 / 60, ent, mode);
    };
    key('keydown', 'KeyW');
    step(20);
    assert.ok(ent.speed > 0 && ent.speed * 3.6 < 25);
    assert.ok(ent.bikeFrame.upright > 0.5, 'rider rises while gaining speed');
    step(240);
    assert.ok(Math.abs(ent.speed * 3.6 - 25) < 1e-8);
    assert.ok(ent.bikeFrame.upright < 0.01, 'rider settles onto the saddle at steady speed');
    key('keydown', 'ShiftLeft');
    step(180);
    assert.ok(Math.abs(ent.speed * 3.6 - 30) < 1e-8);
    key('keyup', 'KeyW');
    key('keyup', 'ShiftLeft');
    step(120);
    assert.ok(ent.speed * 3.6 < 30, 'released pedals allow the bike to slow');
    assert.ok(ent.bikeFrame.upright < 0.01, 'coasting does not stand the rider up');
  });
}

