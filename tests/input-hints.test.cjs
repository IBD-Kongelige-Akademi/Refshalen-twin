const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

// js/input-hints.js: the gamepad's button names, shown instead of keyboard keys while a pad is connected.
const source = readFileSync(join(__dirname, '../js/input-hints.js'), 'utf8');
const load = () => loadModule(source, { globals: {} });
const plain = (v) => JSON.parse(JSON.stringify(v));

test('PlayStation pads get their own button names; everything else Xbox names', () => {
  const { padFamily, padLabel } = load();
  assert.equal(padFamily('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'), 'playstation');
  assert.equal(padFamily('Xbox 360 Controller (XInput STANDARD GAMEPAD)'), 'xbox');
  assert.equal(padFamily(''), 'xbox');
  assert.equal(padLabel('xbox', 'MENU'), 'Menu');
  assert.equal(padLabel('playstation', 'A'), '✕');
  assert.equal(padLabel('playstation', 'MENU'), 'Options');
});

test('every mode with keyboard hints has pad hints', () => {
  const { PAD_HINTS, padHints } = load();
  const main = readFileSync(join(__dirname, '../js/main.js'), 'utf8');
  const block = /const controlHints = \{([\s\S]*?)\n {2}\};/.exec(main)[1];
  const modes = [...block.matchAll(/^\s+(\w+): \[/gm)].map((m) => m[1]);
  assert.ok(modes.length >= 6, `found modes ${modes}`);
  for (const mode of modes) assert.ok(PAD_HINTS[mode]?.length, `pad hints for ${mode}`);
  assert.deepEqual(plain(padHints('car', 'playstation')[0]), [['R2', 'L2'], 'Drive / Reverse']);
});

test('applyPadLabels swaps data-pad keys to pad names and back, and marks the body', () => {
  const { applyPadLabels } = load();
  const kbd = (text, pad) => ({ textContent: text, dataset: { pad } });
  const keys = [kbd('M', 'MENU'), kbd('Esc', 'B')];
  const classes = new Set();
  const doc = {
    body: { classList: { toggle: (n, on) => (on ? classes.add(n) : classes.delete(n)) } },
    querySelectorAll: (sel) => (sel === 'kbd[data-pad]' ? keys : [])
  };
  applyPadLabels(doc, 'xbox');
  assert.deepEqual(keys.map((k) => k.textContent), ['Menu', 'B']);
  assert.ok(classes.has('pad-input'));
  applyPadLabels(doc, 'playstation');
  assert.deepEqual(keys.map((k) => k.textContent), ['Options', '○']);
  applyPadLabels(doc, null);
  assert.deepEqual(keys.map((k) => k.textContent), ['M', 'Esc']);
  assert.ok(!classes.has('pad-input'));
});
