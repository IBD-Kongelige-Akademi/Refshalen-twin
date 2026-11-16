const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

// js/hud-nav.js: the gamepad D-pad walks the HUD's buttons by screen position, opens dropdowns and backs out of them.
const source = readFileSync(join(__dirname, '../js/hud-nav.js'), 'utf8');

const rect = (left, top, w = 40, h = 30) => ({ left, top, right: left + w, bottom: top + h, width: w, height: h });

function classList() {
  const names = new Set();
  return {
    add: (n) => names.add(n), remove: (n) => names.delete(n), contains: (n) => names.has(n),
    toggle(n, on) { if (on) names.add(n); else names.delete(n); }
  };
}

// A tiny HUD: a toolbar row (Map, Time ▾, Teleport ▾, Sound), the Time dropdown under it, and the mode bar below
function fakeHud() {
  const all = [];
  const button = (id, r, { popover = null, parent = null, onClick = null, active = false } = {}) => {
    const el = {
      id, classList: classList(), hidden: false, disabled: false, parent, rect: r, clicks: 0,
      getBoundingClientRect() { return this.parent && !this.parent.open && !this.parent.animating ? rect(0, 0, 0, 0) : this.rect; },
      getAttribute: (name) => (name === 'popovertarget' ? popover : null),
      closest(sel) { return sel === '[hidden]' ? null : this.parent || null; },
      matches: () => false,
      click() { this.clicks++; onClick?.(this); }
    };
    if (active) el.classList.add('active');
    all.push(el);
    return el;
  };
  const pop = {
    id: 'time-popover', open: false, animating: false,
    matches(sel) { return sel === ':popover-open' && this.open; },
    hidePopover() { this.open = false; },
    querySelectorAll: () => all.filter((el) => el.parent === pop)
  };
  const map = button('btn-open-map', rect(100, 10));
  const time = button('btn-time', rect(150, 10), { popover: 'time-popover', onClick: () => { pop.open = !pop.open; } });
  const teleport = button('btn-teleport', rect(200, 10));
  const sound = button('btn-sound', rect(250, 10));
  const close = () => { pop.open = false; };
  const golden = button('time-golden', rect(100, 50, 160), { parent: pop, onClick: close, active: true });
  const midday = button('time-midday', rect(100, 85, 160), { parent: pop, onClick: close });
  const night = button('time-midnight', rect(100, 120, 160), { parent: pop, onClick: close });
  const walk = button('mode-person', rect(120, 400));
  const drive = button('mode-car', rect(170, 400));
  const woman = button('walk-woman', rect(110, 360));
  const document = {
    querySelectorAll(sel) {
      if (sel === '.popover[popover]') return [pop];
      return all.filter((el) => !el.parent);
    },
    querySelector(sel) { return sel === '[popovertarget="time-popover"]' ? time : null; },
    defaultView: null
  };
  let t = 0;
  const { HudNav, pickNext } = loadModule(source, { globals: {} });
  const nav = new HudNav({ document, now: () => t });
  return { nav, pickNext, pop, time, map, teleport, sound, golden, midday, night, walk, drive, woman, advance: (ms) => { t += ms; } };
}

test('pickNext prefers the button straight across over a nearer one off to the side', () => {
  const { pickNext } = loadModule(source, { globals: {} });
  const from = rect(100, 100);
  const rects = [rect(180, 100), rect(150, 170), rect(20, 100), rect(100, 220)];
  assert.equal(pickNext(from, rects, 'right'), 0);
  assert.equal(pickNext(from, rects, 'left'), 2);
  assert.equal(pickNext(from, rects, 'down'), 1, 'the one below and overlapping wins over the farther one');
  assert.equal(pickNext(from, rects, 'up'), -1);
  // a taller button on the same row, reaching a little lower, is not "below"
  assert.equal(pickNext(rect(100, 400, 40, 40), [rect(600, 395, 30, 60)], 'down'), -1);
  assert.equal(pickNext(rect(100, 400, 40, 40), [rect(600, 395, 30, 60)], 'right'), 0);
});

test('the first D-pad press shows the highlight on Map; left / right walk the toolbar, down reaches the mode bar', () => {
  const h = fakeHud();
  h.nav.move('right');
  assert.equal(h.nav.current, h.map);
  assert.ok(h.map.classList.contains('pad-focus'));
  h.nav.move('right');
  h.nav.move('right');
  assert.equal(h.nav.current, h.teleport);
  assert.ok(!h.map.classList.contains('pad-focus'), 'one highlight at a time');
  h.nav.move('left');
  assert.equal(h.nav.current, h.time);
  h.nav.move('down');
  assert.equal(h.nav.current, h.woman, 'the walker switch sits above the mode bar');
  h.nav.move('down');
  assert.equal(h.nav.current, h.walk);
  h.nav.move('right');
  assert.equal(h.nav.current, h.drive);
});

test('A opens a dropdown on its chosen item; the D-pad stays inside; A picks and hands the highlight back; B closes', () => {
  const h = fakeHud();
  h.nav.move('right');
  h.nav.move('right');
  assert.equal(h.nav.press(), true);
  assert.equal(h.pop.open, true);
  assert.equal(h.nav.current, h.golden, 'the chosen time of day');
  h.nav.move('down');
  h.nav.move('down');
  assert.equal(h.nav.current, h.night);
  h.nav.move('down');
  assert.equal(h.nav.current, h.night, 'no way out of the dropdown but A or B');
  h.nav.move('right');
  assert.equal(h.nav.current, h.night);
  h.nav.press();
  assert.equal(h.night.clicks, 1);
  assert.equal(h.pop.open, false);
  assert.equal(h.nav.current, h.time, 'back on the Time button');
  h.nav.press();
  assert.equal(h.pop.open, true);
  assert.equal(h.nav.back(), true);
  assert.equal(h.pop.open, false);
  assert.equal(h.nav.current, h.time);
  assert.equal(h.nav.back(), true, 'B again hides the highlight');
  assert.equal(h.nav.active, false);
  assert.ok(!h.time.classList.contains('pad-focus'));
  assert.equal(h.nav.back(), false, 'and then B is the game\'s again');
  assert.equal(h.nav.press(), false);
});

test('picking an item while its dropdown still animates out, or closing it with the mouse, returns the highlight to its button', () => {
  const h = fakeHud();
  h.nav.move('right');
  h.nav.move('right');
  h.nav.press();
  h.pop.animating = true; // the exit transition keeps the items laid out for a moment
  h.nav.move('down');
  h.nav.press();
  assert.equal(h.pop.open, false);
  assert.equal(h.nav.current, h.time);
  h.nav.press();
  h.pop.open = false; // a click elsewhere light-dismisses it
  h.nav.tick();
  assert.equal(h.nav.current, h.time);
  assert.equal(h.nav.active, true);
});

test('the highlight hides itself after a while without D-pad input', () => {
  const h = fakeHud();
  h.nav.move('down');
  h.advance(5000);
  h.nav.tick();
  assert.equal(h.nav.active, true);
  h.advance(4000);
  h.nav.tick();
  assert.equal(h.nav.active, false);
});

test('hidden or disabled buttons are skipped', () => {
  const h = fakeHud();
  h.map.disabled = true;
  h.nav.move('right');
  h.nav.move('right');
  assert.equal(h.nav.current, h.teleport);
});
