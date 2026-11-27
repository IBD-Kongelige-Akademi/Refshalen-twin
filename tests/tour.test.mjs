import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { TELEPORT_LOCATIONS } from '../js/city-config.js';
import { TOUR_STOPS } from '../js/tour-script.js';
import { createTour, tourDuration, beatsFor, shotPose, ARRIVE_RADIUS } from '../js/tour.js';
import { setLang } from '../js/i18n.js';

setLang('en'); // the card texts below are checked in English (the default is Danish, tests/i18n.test.mjs)

const camerasSource = readFileSync(new URL('../js/cameras.js', import.meta.url), 'utf8');
const cameraIds = new Set([...camerasSource.matchAll(/\{ id: '([\w-]+)'/g)].map((m) => m[1]));

// A twin made of recorders: the tour only sees these functions and objects
function fakeTwin({ mode = 'car', loading = () => false } = {}) {
  const calls = [];
  const log = (name) => (...args) => calls.push([name, ...args]);
  const entity = { position: { x: 0, y: 0, z: 0 }, heading: 0 };
  const controllerManager = {
    activeMode: mode,
    entities: { person: { avatar: 'man' } },
    getActiveEntity: () => entity,
    resetInput: log('resetInput'),
    setGamepadInput: log('setGamepadInput'),
    setPersonAvatar(kind) { this.entities.person.avatar = kind; calls.push(['avatar', kind]); }
  };
  const lightingSystem = {
    activePresetId: 'golden',
    skyMode: 'clear',
    wetnessOverride: null,
    setSkyMode(m) { this.skyMode = m; calls.push(['sky', m]); },
    applyPreset(id) { calls.push(['applyPreset', id]); }
  };
  const mapSystem = {
    isFullMapOpen: false,
    waypoint: null,
    route: null,
    setWaypoint(x, z, name) { this.waypoint = { x, z, name }; calls.push(['waypoint', name]); },
    clearWaypoint() { this.waypoint = null; this.route = null; },
    toggleFullMap(open) { this.isFullMapOpen = open; calls.push(['map', open]); }
  };
  const buildings = { level: 'full', showBuilding: (id) => { calls.push(['building', id]); return {}; } };
  const ui = { fade: log('fade'), showCard: (info) => { ui.card = info; }, hideCard: () => { ui.card = null; }, setTouring: log('touring'), hideBuilding: () => {}, closePopovers: () => {} };
  const deps = {
    teleportTo: (x, z, h) => { entity.position.x = x; entity.position.z = z; calls.push(['teleport', x, z, h]); },
    selectMode: (m) => { controllerManager.activeMode = m; calls.push(['mode', m]); },
    selectCamera: (id, snap) => calls.push(['camera', id, snap]),
    selectTime: (id) => { lightingSystem.activePresetId = id; calls.push(['time', id]); },
    selectBuildingLevel: (l) => { buildings.level = l; calls.push(['level', l]); },
    controllerManager, cameraSystem: {}, mapSystem, lightingSystem, buildings,
    audioSystem: { enabled: false, honk: log('honk') },
    ui, isLoading: loading, idleSeconds: 0
  };
  return { deps, calls, entity, ui, mapSystem, lightingSystem, controllerManager, buildings };
}

const stopAt = (x, z) => Object.entries(TELEPORT_LOCATIONS).find(([, p]) => p.x === x && p.z === z)?.[0];
const teleports = (calls) => calls.filter((c) => c[0] === 'teleport').map((c) => stopAt(c[1], c[2])).filter(Boolean); // the stops (not the start scene's cuts)
// presses next until the tour reaches stop i (it then fades over)
function skipTo(tour, i) {
  for (let n = 0; n < 50 && tour.state.stopIndex < i; n++) { tour.next(); tour.update(0.1); }
}
function runFor(tour, seconds, step = 0.1) {
  for (let t = 0; t < seconds && tour.active; t += step) tour.update(step);
}

test('the tour starts and ends at AKKC and every stop has a location and a scenic camera', () => {
  assert.equal(TOUR_STOPS[0].id, 'reffen');
  assert.equal(TOUR_STOPS.at(-1).id, 'reffen');
  assert.deepEqual(TOUR_STOPS.slice(0, -1).map((s) => s.id).sort(), Object.keys(TELEPORT_LOCATIONS).sort(), 'every teleport is a stop');
  for (const stop of TOUR_STOPS) {
    assert.ok(TELEPORT_LOCATIONS[stop.id], `${stop.id} is a teleport`);
    assert.ok(beatsFor(stop, 'express').length >= 1, `${stop.id} has an express beat`);
    for (const kind of ['express', 'full']) {
      // no vehicle carried into a park or onto a quay, and stepping back looks the same as the run
      const first = beatsFor(stop, kind)[0].do;
      assert.ok(first.some((a) => a.mode), `${stop.id} (${kind}) sets the mode first`);
      assert.ok(first.some((a) => a.time) && first.some((a) => a.sky), `${stop.id} (${kind}) sets time and sky first`);
    }
    for (const beat of stop.beats) {
      assert.ok(beat.caption && beat.hold > 0, `${stop.id}: caption and hold`);
      for (const a of beat.do) if (a.camera) assert.ok(cameraIds.has(a.camera), `${stop.id}: camera ${a.camera} exists`);
    }
  }
});

test('Express takes about 2 minutes and Full about 6', () => {
  const express = tourDuration('express');
  const full = tourDuration('full');
  assert.ok(express >= 100 && express <= 150, `express ${express.toFixed(0)} s`);
  assert.ok(full >= 240 && full <= 420, `full ${full.toFixed(0)} s`);
});

test('a guided tour teleports to each stop in order and puts the visitor back at Reffen as they were', () => {
  const twin = fakeTwin({ mode: 'cyclist' });
  twin.lightingSystem.activePresetId = 'midday';
  const tour = createTour(twin.deps);
  assert.ok(tour.start('express'));
  assert.ok(tour.guided);
  runFor(tour, tourDuration('express') + 30);
  assert.equal(tour.active, false, 'the tour finished by itself');
  const order = TOUR_STOPS.map((s) => s.id);
  // the stops (the welcome beat puts the walker back on Europa Plads after the Vesterbro showcase), then home on the restore
  assert.deepEqual(teleports(twin.calls), [order[0], 'reffen', ...order.slice(1), 'reffen']);
  assert.equal(twin.controllerManager.activeMode, 'cyclist', 'mode restored');
  assert.equal(twin.lightingSystem.activePresetId, 'midday', 'time restored');
  assert.equal(twin.lightingSystem.skyMode, 'clear');
  assert.ok(twin.calls.some((c) => c[0] === 'camera' && c[1] === 'bw' && c[2] === true), 'the first camera of a stop snaps under the black');
  assert.ok(twin.calls.some((c) => c[0] === 'resetInput'), 'the player is held still');
});

test('the full tour steps through the building levels and restores the visitor\'s level', () => {
  const twin = fakeTwin();
  twin.buildings.level = 'photo';
  const tour = createTour(twin.deps);
  tour.start('full');
  runFor(tour, tourDuration('full') + 30, 0.25);
  const levels = twin.calls.filter((c) => c[0] === 'level').map((c) => c[1]);
  assert.deepEqual(levels, ['white', 'full', 'photo']);
  assert.ok(twin.calls.some((c) => c[0] === 'time' && c[1] === 'midnight'));
  assert.ok(twin.calls.some((c) => c[0] === 'sky' && c[1] === 'overcast'));
});

test('the black hold waits for loading tiles, but not forever', () => {
  let loading = true;
  const twin = fakeTwin({ loading: () => loading });
  const tour = createTour(twin.deps);
  tour.start('express');
  runFor(tour, 1.5);
  assert.equal(tour.state.phase, 'load');
  loading = false;
  tour.update(0.1);
  assert.equal(tour.state.phase, 'beat');
  loading = true;
  skipTo(tour, 1); // to Budolfi
  runFor(tour, 3.5);
  assert.equal(tour.state.stopIndex, 1);
  assert.equal(tour.state.phase, 'beat', 'gave up waiting after HOLD_MAX');
});

test('next, prev and end step through a guided tour', () => {
  const twin = fakeTwin();
  const tour = createTour(twin.deps);
  tour.start('express');
  runFor(tour, 2);
  tour.next(); tour.update(0.1);
  assert.equal(tour.state.beatIndex, 1);
  skipTo(tour, 1);
  runFor(tour, 2);
  assert.equal(tour.state.stopIndex, 1);
  tour.prev(); // first beat of Budolfi: back to AKKC
  assert.equal(tour.state.stopIndex, 0);
  tour.command('end');
  assert.equal(tour.active, false);
  assert.equal(teleports(twin.calls).at(-1), 'reffen');
});

test('the drive tour routes stop to stop and arrives within the radius', () => {
  const twin = fakeTwin({ mode: 'drone' });
  const tour = createTour(twin.deps);
  tour.start('drive');
  assert.equal(twin.controllerManager.activeMode, 'car', 'the drone starts the drive tour in the car');
  assert.equal(tour.guided, false);
  runFor(tour, 20);
  assert.equal(tour.state.phase, 'leg');
  const operaen = TELEPORT_LOCATIONS[TOUR_STOPS[1].id];
  assert.deepEqual(twin.mapSystem.waypoint, { x: operaen.x, z: operaen.z, name: TOUR_STOPS[1].title });
  assert.match(twin.ui.card.title, /Next: B&W/);
  twin.entity.position.x = operaen.x + ARRIVE_RADIUS - 1;
  twin.entity.position.z = operaen.z;
  tour.update(0.1);
  assert.equal(tour.state.phase, 'arrive');
  assert.equal(twin.mapSystem.waypoint, null);
  // the arrival leaves the visitor in control: no camera or mode changes
  const before = twin.calls.length;
  runFor(tour, 20);
  assert.ok(!twin.calls.slice(before).some((c) => c[0] === 'camera' || c[0] === 'mode' || c[0] === 'teleport'));
  assert.equal(tour.state.stopIndex, 2);
  assert.equal(twin.mapSystem.waypoint.name, TOUR_STOPS[2].title);
  // a car route ends short of the walking street: reaching its end counts too
  const akademiet = TELEPORT_LOCATIONS[TOUR_STOPS[2].id];
  twin.mapSystem.route = { pts: [{ x: 0, z: 0 }, { x: akademiet.x + 50, z: akademiet.z }] };
  twin.entity.position.x = akademiet.x + 52;
  twin.entity.position.z = akademiet.z;
  tour.update(0.1);
  assert.equal(tour.state.phase, 'arrive');
});

test('skip leg teleports to the next stop and the drive tour ends at AKKC where the visitor is', () => {
  const twin = fakeTwin();
  const tour = createTour(twin.deps);
  tour.start('drive');
  for (let i = 0; i < 40 && tour.active; i++) {
    tour.skipLeg();
    tour.update(0.1);
  }
  assert.equal(tour.active, false);
  assert.deepEqual(teleports(twin.calls), TOUR_STOPS.slice(1).map((s) => s.id));
});

test('the attract loop starts after the idle time and any input ends it', () => {
  const twin = fakeTwin({ mode: 'bus' });
  const tour = createTour({ ...twin.deps, idleSeconds: 60 });
  runFor(tour, 120);
  assert.equal(tour.active, false, 'not before the boot is over');
  tour.setReady();
  for (let t = 0; t < 59; t += 0.25) tour.update(0.25);
  assert.equal(tour.active, false);
  tour.noteInput({ end: false }); // a mouse move resets the timer
  for (let t = 0; t < 59; t += 0.25) tour.update(0.25);
  assert.equal(tour.active, false);
  for (let t = 0; t < 1.5; t += 0.25) tour.update(0.25);
  assert.equal(tour.active, true);
  assert.equal(tour.state.loop, true);
  assert.equal(tour.state.kind, 'express');
  // it loops: run past the end and it is still going, back at the start
  runFor(tour, tourDuration('express') + 5);
  assert.equal(tour.active, true);
  assert.ok(tour.state.stopIndex <= 1);
  assert.equal(tour.noteInput(), true);
  assert.equal(tour.active, false);
  assert.equal(twin.controllerManager.activeMode, 'bus');
  assert.equal(teleports(twin.calls).at(-1), 'reffen');
});

test('director shots orbit a point and glide between views, over the ground', () => {
  const orbit = shotPose({ orbit: [100, 50], radius: 10, height: 20, lookY: 5, from: 0, speed: Math.PI / 2 }, 1, () => 2);
  assert.deepEqual(orbit.look, [100, 7, 50]);
  assert.ok(Math.abs(orbit.pos[0] - 110) < 1e-9 && Math.abs(orbit.pos[2] - 50) < 1e-9 && orbit.pos[1] === 22, 'a quarter turn east of the point');
  const glide = { glide: [[[0, 100, 0], [0, 0, 10]], [[10, 20, 0], [10, 0, 10]]], duration: 4 };
  assert.deepEqual(shotPose(glide, 0).pos, [0, 100, 0]);
  assert.deepEqual(shotPose(glide, 2).pos, [5, 60, 0]);
  assert.deepEqual(shotPose(glide, 9).pos, [10, 20, 0]);
});

test('the start scene flies over the city, then shows the car, the bike and the Plusbus driving on Refshalevej', () => {
  const twin = fakeTwin();
  const views = [];
  const tour = createTour({ ...twin.deps, setView: (v) => views.push(v) });
  tour.start('express');
  runFor(tour, 30, 0.1);
  assert.ok(views.some((v) => v && v.pos[1] > 300), 'an aerial view high over the city');
  assert.equal(views.at(-1), null, 'the shot hands the camera back');
  const modes = twin.calls.filter((c) => c[0] === 'mode').map((c) => c[1]);
  for (const m of ['car', 'cyclist', 'bus']) assert.ok(modes.includes(m), `shows the ${m}`);
  assert.ok(twin.calls.some((c) => c[0] === 'setGamepadInput' && c[1] === 'forward' && c[2] > 0), 'the vehicles drive off');
  // the Plusbus only drives in the start scene: never at the harbour front or in the park
  const busStops = TOUR_STOPS.slice(1).filter((s) => s.beats.some((b) => b.do.some((a) => a.mode === 'bus')));
  assert.deepEqual(busStops, []);
});

test('the drive tour skips the start scene', () => {
  const twin = fakeTwin();
  const tour = createTour(twin.deps);
  tour.start('drive');
  assert.ok(beatsFor(TOUR_STOPS[0], 'drive').every((b) => !b.guidedOnly));
  runFor(tour, 15);
  assert.equal(tour.state.phase, 'leg');
  assert.ok(!twin.calls.some((c) => c[0] === 'mode' && c[1] === 'bus'));
});

test('Mastekranen is in the middle of its director shot', () => {
  const mastekranen = TOUR_STOPS.find((s) => s.id === 'mastekranen');
  const { shot } = beatsFor(mastekranen, 'express')[0].do.find((a) => a.shot);
  const pin = TELEPORT_LOCATIONS.mastekranen.pin;
  assert.deepEqual(shot.orbit, [pin.x, pin.z]);
});

test('the bike starts on the cycle track and the skater on the pavement, beside the car lane', async () => {
  const { REFSHALEVEJ, REFSHALEVEJ_CYCLE, REFSHALEVEJ_PAVEMENT } = await import('../js/tour-script.js');
  const start = TOUR_STOPS[0].beats;
  const placeOf = (mode) => start.find((b) => b.do.some((a) => a.mode === mode) && b.do.some((a) => a.place))?.do.find((a) => a.place).place;
  assert.equal(placeOf('cyclist'), REFSHALEVEJ_CYCLE);
  assert.equal(placeOf('person'), REFSHALEVEJ_PAVEMENT);
  assert.equal(placeOf('car'), REFSHALEVEJ);
  // west of the southbound lane (its right), the pavement outside the cycle track
  const right = (p) => -(p.x - REFSHALEVEJ.x) * Math.cos(REFSHALEVEJ.heading) + (p.z - REFSHALEVEJ.z) * Math.sin(REFSHALEVEJ.heading);
  assert.ok(right(REFSHALEVEJ_CYCLE) > 1.5 && right(REFSHALEVEJ_PAVEMENT) > right(REFSHALEVEJ_CYCLE) + 1);
});

test('the Utzon Center and Musikkens Hus are filmed from the fjord side (north)', () => {
  for (const id of ['mastekranen', 'bw']) {
    const stop = TOUR_STOPS.find((s) => s.id === id);
    for (const beat of stop.beats) {
      const shot = beat.do.find((a) => a.shot)?.shot;
      if (!shot) continue;
      for (const t of [0, beat.hold / 2, beat.hold]) {
        const { pos, look } = shotPose(shot, t);
        assert.ok(pos[2] < look[2] - 80, `${id}: the camera is north of the building, over the water (t=${t})`);
      }
    }
  }
});
