import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { makePath, harbourBusMotion, CRUISE, DWELL, TURN_DWELL } from '../js/harbour-bus-motion.js';

const straight = makePath([0, 0, 0, 1000]);

test('a path gives points and headings along its length', () => {
  assert.equal(straight.total, 1000);
  const p = straight.at(250);
  assert.deepEqual([p.x, p.z], [0, 250]);
  assert.ok(Math.abs(p.heading) < 1e-9, 'south is heading 0 (forward is (sin h, cos h))');
});

test('the boat cruises, stops at rest at each stop, lies alongside, then turns into the other line at the end', () => {
  const lines = [{ ref: '991', path: straight, stops: [400, 800] }, { ref: '992', path: makePath([0, 1000, 0, 0]), stops: [200, 600] }];
  const m = harbourBusMotion(lines);
  let maxV = 0, t = 0;
  while (m.state.wait === 0 && t < 600) { m.step(0.1); t += 0.1; maxV = Math.max(maxV, m.state.v); }
  assert.ok(Math.abs(m.state.s - 400) < 0.1, `stopped at the first stop (${m.state.s})`);
  assert.ok(maxV <= CRUISE + 1e-9 && maxV > CRUISE * 0.9, `cruised at ${maxV}`);
  assert.equal(m.state.wait, DWELL);
  for (let i = 0; i < 4000 && m.state.line === 0; i++) m.step(0.1);
  assert.equal(m.state.line, 1, 'sails the other line after the end of the first');
  assert.equal(m.state.s, 0);
  assert.equal(m.state.wait, TURN_DWELL);
});

const FERRY = new URL('../data/city/ferry-lines.json', import.meta.url);
test('the built harbour bus lines call at Refshaleøen, Operaen and Nyhavn', { skip: !existsSync(FERRY) && 'no data/city/ferry-lines.json' }, () => {
  const doc = JSON.parse(readFileSync(FERRY, 'utf8'));
  const names = new Set(doc.lines.flatMap((l) => l.directions.flatMap((d) => d.stops.map((s) => s.name))));
  for (const n of ['Refshaleøen', 'Operaen', 'Nyhavn']) assert.ok(names.has(n), n);
});
