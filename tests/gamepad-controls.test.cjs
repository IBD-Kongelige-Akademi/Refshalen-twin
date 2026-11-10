const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

// js/gamepad-controls.js: the standard-mapping pad, its button edges, the View tap / long press and the full-map controls.
const source = readFileSync(join(__dirname, '../js/gamepad-controls.js'), 'utf8');

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

function harness({ mapping = 'standard', mode = 'person' } = {}) {
  const pad = {
    connected: true, index: 0, id: 'Test pad', mapping,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }))
  };
  const window = eventTarget();
  const document = { ...eventTarget(), hidden: false, hasFocus: () => true, activeElement: null };
  const navigator = { getGamepads: () => [pad] };
  const clock = { t: 0 };
  const performance = { now: () => clock.t };
  const { GamepadControls } = loadModule(source, {
    globals: { window, document, navigator, performance },
    imports: { './city-config.js': { isTypingInField: () => false } }
  });
  const inputs = {};
  const controller = {
    activeMode: mode,
    setGamepadInput: (action, value) => { inputs[action] = value; },
    clearGamepadInput: () => { for (const k of Object.keys(inputs)) delete inputs[k]; },
    getGoBoatInteraction: () => null
  };
  const camera = { resetOrbit() {}, applyGamepadInput() {} };
  const calls = [];
  const record = (name) => (...args) => calls.push([name, ...args]);
  const callbacks = Object.fromEntries([
    'onCycleMode', 'onCycleCamera', 'onToggleMap', 'onCloseMap', 'onInteract', 'onMapInput', 'onMapTeleport', 'onMapWaypoint',
    'onHorn', 'onToggleHud', 'onToggleSound', 'onCycleLevel', 'onInspect'
  ].map((name) => [name, record(name)]));
  const controls = new GamepadControls(controller, camera, callbacks);
  const names = (list) => list.filter(([name]) => name !== 'onMapInput').map(([name, ...args]) => [name, ...args]);
  return {
    pad, controls, calls, inputs,
    press(i, value = 1) { pad.buttons[i] = { pressed: value > 0.5, value }; },
    release(i) { pad.buttons[i] = { pressed: false, value: 0 }; },
    frame(dt = 1 / 60) { clock.t += dt * 1000; controls.update(dt); },
    clock,
    tap(i) { this.press(i); this.frame(); this.release(i); this.frame(); },
    events: () => names(calls)
  };
}

const A = 0, B = 1, X = 2, LT = 6, RT = 7, VIEW = 8, MENU = 9, L3 = 10, LEFT = 14, RIGHT = 15;

test('only pads with the standard mapping are read', () => {
  const h = harness({ mapping: '' });
  h.frame();
  h.tap(L3);
  assert.equal(h.controls.connected, false);
  assert.deepEqual(h.events(), []);
});

test('left stick click honks, the D-pad sides step the building level, B inspects the building ahead', () => {
  const h = harness();
  h.frame();
  h.tap(L3);
  h.tap(RIGHT);
  h.tap(LEFT);
  h.tap(B);
  assert.deepEqual(h.events(), [['onHorn'], ['onCycleLevel', 1], ['onCycleLevel', -1], ['onInspect']]);
});

test('a button held when the pad connects does not fire until released and pressed again', () => {
  const h = harness();
  h.press(L3);
  h.frame();
  h.frame();
  assert.deepEqual(h.events(), []);
  h.release(L3);
  h.frame();
  h.tap(L3);
  assert.deepEqual(h.events(), [['onHorn']]);
});

test('View: a tap toggles the HUD, a long press toggles the sound once and not the HUD', () => {
  const h = harness();
  h.frame();
  h.tap(VIEW);
  assert.deepEqual(h.events(), [['onToggleHud']]);
  h.calls.length = 0;
  h.press(VIEW);
  for (let i = 0; i < 60; i++) h.frame(0.05); // 3 s held
  h.release(VIEW);
  h.frame();
  assert.deepEqual(h.events(), [['onToggleSound']]);
  // at 8 fps the game passes a capped dt; the hold still counts wall-clock time
  h.calls.length = 0;
  h.press(VIEW);
  for (let i = 0; i < 6; i++) { h.clock.t += 125 - 50; h.frame(0.05); } // 0.75 s held, 0.3 s of dt
  h.release(VIEW);
  h.frame();
  assert.deepEqual(h.events(), [['onToggleSound']]);
});

test('with the map open: the stick pans, the triggers zoom, A teleports, X routes, B closes; game buttons do nothing', () => {
  const h = harness();
  h.frame();
  h.controls.setEnabled(false);
  h.pad.axes = [1, 0, 0, 0];
  h.press(RT, 1);
  h.frame(0.1);
  const [, panX, panY, zoom, dt] = h.calls.find(([name]) => name === 'onMapInput');
  assert.equal(panX, 1);
  assert.equal(panY, 0);
  assert.equal(zoom, 1);
  assert.equal(dt, 0.1);
  h.release(RT);
  h.press(LT, 0.5);
  h.calls.length = 0;
  h.frame();
  assert.equal(h.calls.find(([name]) => name === 'onMapInput')[3], -0.5);
  h.release(LT);
  h.pad.axes = [0, 0, 0, 0];
  h.calls.length = 0;
  h.tap(L3);
  h.tap(VIEW);
  h.tap(A);
  h.tap(X);
  h.tap(B);
  assert.deepEqual(h.events(), [['onMapTeleport'], ['onMapWaypoint'], ['onCloseMap']]);
  assert.deepEqual(h.inputs, {}, 'no driving input while the map is open');
});

test('Menu opens the map; the button that closed it does not inspect a building afterwards', () => {
  const h = harness();
  h.frame();
  h.tap(MENU);
  assert.deepEqual(h.events(), [['onToggleMap']]);
  h.controls.setEnabled(false);
  h.press(B);
  h.frame();
  h.controls.setEnabled(true); // the map's onToggle runs inside onCloseMap
  h.frame();
  h.release(B);
  h.frame();
  assert.deepEqual(h.events(), [['onToggleMap'], ['onCloseMap']]);
});
