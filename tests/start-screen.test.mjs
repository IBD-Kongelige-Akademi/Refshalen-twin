import assert from 'node:assert/strict';
import test from 'node:test';
import { createStartScreen, primaryMode } from '../js/start-screen.js';

// js/start-screen.js: opening and closing, the mode picker, the three actions, and the keys and pad buttons it takes.
function harness({ enabled = true, mode = 'car' } = {}) {
  const calls = [];
  const state = { mode, shown: false, marked: null, focused: null };
  const ui = {
    show: () => { state.shown = true; },
    hide: () => { state.shown = false; },
    markMode: (m) => { state.marked = m; },
    focus: (item) => { state.focused = `${item.kind}:${item.id}`; }
  };
  const screen = createStartScreen({
    ui, enabled,
    getMode: () => state.mode,
    onSelectMode: (m) => { state.mode = m; calls.push(['mode', m]); },
    onExplore: () => calls.push(['explore']),
    onRace: () => calls.push(['race', screen.isOpen]),
    onTour: () => calls.push(['tour', screen.isOpen]),
    onOpenChange: (open) => calls.push(['open', open])
  });
  return { screen, state, calls };
}

test('opens with the current mode marked and Explore highlighted; disabled it never opens', () => {
  const h = harness({ mode: 'cargobike' });
  assert.equal(h.screen.open(), true);
  assert.equal(h.state.shown, true);
  assert.equal(h.state.marked, 'cyclist', 'the cargo bike is a Cycle');
  assert.equal(h.state.focused, 'action:explore');
  assert.equal(h.screen.open(), false, 'already open');
  const off = harness({ enabled: false });
  assert.equal(off.screen.open(), false);
  assert.equal(off.state.shown, false);
  assert.equal(off.screen.handleKey('Enter'), false, 'a closed screen takes no keys');
});

test('keys 1-5 pick the mode and keep the screen open; Enter explores', () => {
  const h = harness();
  h.screen.open();
  assert.equal(h.screen.handleKey('Digit3'), true);
  assert.equal(h.state.mode, 'cyclist');
  assert.equal(h.state.marked, 'cyclist');
  assert.equal(h.screen.isOpen, true);
  h.screen.handleKey('Enter');
  assert.equal(h.screen.isOpen, false);
  assert.equal(h.state.shown, false);
  assert.deepEqual(h.calls, [['open', true], ['mode', 'cyclist'], ['open', false], ['explore']]);
});

test('R and T close the screen before starting the race or the tour; Escape explores', () => {
  for (const [key, expected] of [['KeyR', ['race', false]], ['KeyT', ['tour', false]], ['Escape', ['explore']]]) {
    const h = harness();
    h.screen.open();
    h.screen.handleKey(key);
    assert.deepEqual(h.calls.at(-1), expected);
    assert.equal(h.screen.isOpen, false);
  }
});

test('every other key is swallowed while open', () => {
  const h = harness();
  h.screen.open();
  for (const key of ['KeyW', 'KeyM', 'KeyH', 'Digit7']) assert.equal(h.screen.handleKey(key), true);
  assert.deepEqual(h.calls, [['open', true]]);
  assert.equal(h.screen.isOpen, true);
});

test('the arrows walk the two rows; Enter on a mode tile picks it and moves on to Explore', () => {
  const h = harness({ mode: 'car' });
  h.screen.open();
  h.screen.handleKey('ArrowRight');
  assert.equal(h.state.focused, 'action:race');
  h.screen.handleKey('ArrowRight');
  h.screen.handleKey('ArrowRight');
  assert.equal(h.state.focused, 'action:explore', 'the row wraps');
  h.screen.handleKey('ArrowUp');
  assert.equal(h.state.focused, 'mode:car', 'up lands on the selected mode');
  h.screen.handleKey('ArrowLeft');
  assert.equal(h.state.focused, 'mode:person');
  h.screen.handleKey('Space');
  assert.equal(h.state.mode, 'person');
  assert.equal(h.state.focused, 'action:explore');
  assert.equal(h.screen.isOpen, true);
  h.screen.handleKey('ArrowUp');
  h.screen.handleKey('ArrowDown');
  assert.equal(h.state.focused, 'action:explore');
});

test('the gamepad: LB / RB cycle the mode, D-pad moves, A presses, Y races, X tours, B explores', () => {
  const h = harness({ mode: 'bus' });
  h.screen.open();
  h.screen.handlePad('rb');
  assert.equal(h.state.mode, 'person', 'RB wraps from the bus to walking');
  h.screen.handlePad('lb');
  assert.equal(h.state.mode, 'bus');
  h.screen.handlePad('right');
  h.screen.handlePad('a');
  assert.deepEqual(h.calls.at(-1), ['race', false]);
  for (const [button, expected] of [['x', ['tour', false]], ['b', ['explore']], ['y', ['race', false]]]) {
    const g = harness();
    g.screen.open();
    g.screen.handlePad(button);
    assert.deepEqual(g.calls.at(-1), expected);
  }
});

test('a click moves the highlight and acts', () => {
  const h = harness();
  h.screen.open();
  h.screen.click({ kind: 'mode', id: 'drone' });
  assert.equal(h.state.mode, 'drone');
  assert.equal(h.state.focused, 'mode:drone');
  h.screen.click({ kind: 'action', id: 'tour' });
  assert.deepEqual(h.calls.at(-1), ['tour', false]);
  assert.equal(h.screen.click({ kind: 'action', id: 'race' }), false, 'closed');
});

test('primaryMode maps controller modes onto the five tiles', () => {
  assert.equal(primaryMode('cargobike'), 'cyclist');
  assert.equal(primaryMode('drone'), 'drone');
  assert.equal(primaryMode('goboat'), 'car');
});
