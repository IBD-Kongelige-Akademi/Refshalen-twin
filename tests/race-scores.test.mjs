import assert from 'node:assert/strict';
import test from 'node:test';
import { REF_SPEED, STORAGE_KEY, parFor, adjustedTime, raceMode, formatTime, cleanText, createScores } from '../js/race-scores.js';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (Object.hasOwn(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; }
  };
}

test('the walker, skater and boarder are separate race modes; other modes keep their name', () => {
  assert.equal(raceMode('person', 'man'), 'walk');
  assert.equal(raceMode('person', 'woman'), 'walk');
  assert.equal(raceMode('person', 'skater'), 'skates');
  assert.equal(raceMode('person', 'skateboarder'), 'board');
  for (const m of ['car', 'bus', 'cyclist', 'cargobike', 'drone']) assert.equal(raceMode(m), m);
  assert.ok(Object.values(REF_SPEED).every((v) => v > 0));
});

test('a run at par scores the car par, whatever the mode', () => {
  const carPar = parFor('car', 1200);
  for (const mode of Object.keys(REF_SPEED)) {
    const par = parFor(mode, 1000);
    assert.ok(Math.abs(adjustedTime(par, par, carPar) - carPar) < 1e-9, mode);
  }
  // a walker 10 % faster than par beats a car 5 % slower than par
  const walkPar = parFor('walk', 1000);
  assert.ok(adjustedTime(walkPar * 0.9, walkPar, carPar) < adjustedTime(carPar * 1.05, carPar, carPar));
});

test('times read as m:ss.t', () => {
  assert.equal(formatTime(0), '0:00.0');
  assert.equal(formatTime(65.43), '1:05.4');
  assert.equal(formatTime(599.99), '9:59.9');
  assert.equal(formatTime(NaN), '--:--.-');
});

test('names are trimmed, cut, stripped of markup and rude words', () => {
  assert.equal(cleanText('  Anna   Hansen ', 20), 'Anna Hansen');
  assert.equal(cleanText('<b>Bo</b>', 20), 'bBo/b');
  assert.equal(cleanText('x'.repeat(40), 20).length, 20);
  assert.equal(cleanText('fuck', 20), '');
  assert.equal(cleanText('Sh1t happens', 20), '');
  assert.equal(cleanText('Søren Kierkegaard', 20), 'Søren Kierkegaard');
  assert.equal(cleanText('Pikachu', 20), 'Pikachu', 'a short word only blocks as a whole word');
});

test('the list is sorted by adjusted time, survives a reload and ranks a new run', () => {
  const storage = memoryStorage();
  const scores = createScores(storage);
  const carPar = 60;
  assert.equal(scores.add({ mode: 'car', time: 70, par: 60, carPar }, 'Car', 'A/S').rank, 1);
  assert.equal(scores.add({ mode: 'walk', time: 150, par: 150, carPar }, 'Walker', '').rank, 1, 'at par beats 70 s against a 60 s par');
  assert.equal(scores.add({ mode: 'cyclist', time: 200, par: 150, carPar }, 'Bike', 'Rambøll').rank, 3);
  assert.equal(scores.add({ mode: 'car', time: 1, par: 60, carPar }, '', 'nameless'), null, 'a name is required');
  const again = createScores(storage);
  assert.deepEqual(again.top(10).map((e) => e.name), ['Walker', 'Car', 'Bike']);
  assert.equal(again.top(10)[2].company, 'Rambøll');
  assert.equal(again.rankOf(65), 2);
  assert.match(again.toCsv(), /^rank,name,company,mode,adjusted_s,time_s,finished\n1,"Walker","",On foot,60\.0,150\.0,/);
  again.clear();
  assert.equal(createScores(storage).size, 0);
  assert.equal(storage.getItem(STORAGE_KEY), null);
});

test('broken or missing storage gives an empty list and never throws', () => {
  assert.equal(createScores(memoryStorage({ [STORAGE_KEY]: '{not json' })).size, 0);
  assert.equal(createScores(memoryStorage({ [STORAGE_KEY]: JSON.stringify({ version: 99, entries: [{}] }) })).size, 0);
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  const scores = createScores(throwing);
  assert.equal(scores.size, 0);
  assert.ok(scores.add({ mode: 'car', time: 60, par: 60, carPar: 60 }, 'Kiosk', ''), 'kept in memory');
  scores.clear();
  assert.equal(createScores(null).size, 0);
});
