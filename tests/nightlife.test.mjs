import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PRESET_LEVEL, nightlifeLevel, venueLook, clusterVenues, beatPulse, selectAudible, venueGain, renderBeatLoop, createNightlifeState, hash01
} from '../js/nightlife.js';

// a strip like Jomfru Ane Gade: venues every ~8 m on both sides of a 10 m street, plus a lone pub far away
const strip = [];
for (let i = 0; i < 12; i++) {
  strip.push({ name: `V${i}`, kind: i % 4 === 0 ? 'nightclub' : i % 4 === 3 ? 'pub' : 'bar', x: i % 2 ? 5 : -5, z: i * 8, nx: i % 2 ? -1 : 1, nz: 0, street: 'Jomfru Ane Gade' });
}
const lone = { name: 'Lone', kind: 'pub', x: 400, z: 400, nx: 0, nz: 1, street: 'Elsewhere' };

test('activity follows the time of day: none at Midday, building at Blue Hour, full at Night, a little at Dawn', () => {
  assert.equal(nightlifeLevel('midday'), 0);
  assert.equal(nightlifeLevel('midnight'), 1);
  assert.ok(nightlifeLevel('twilight') > 0.3 && nightlifeLevel('twilight') < 0.7);
  assert.ok(nightlifeLevel('golden') > 0 && nightlifeLevel('golden') < nightlifeLevel('twilight'));
  for (const v of Object.values(PRESET_LEVEL)) assert.ok(v >= 0 && v <= 1);
  // an unknown preset follows the night factor
  assert.equal(nightlifeLevel('custom', 0), 0);
  assert.ok(Math.abs(nightlifeLevel('custom', 0.86) - 1) < 1e-9);
});

test('a venue keeps its look: deterministic, clubs louder and faster than pubs, pubs warm', () => {
  const club = venueLook({ name: 'Club', kind: 'nightclub', x: 1, z: 2 });
  assert.deepEqual(venueLook({ name: 'Club', kind: 'nightclub', x: 1, z: 2 }), club);
  const pub = venueLook({ name: 'Pub', kind: 'pub', x: 1, z: 2 });
  assert.ok(club.loud > pub.loud && club.range > pub.range && club.bpm > pub.bpm);
  assert.equal(club.style, 'club');
  assert.equal(pub.style, 'rock');
  assert.ok(pub.sign[0] > pub.sign[2], 'the pub sign is warm');
  assert.ok(Number.isInteger(club.bpm) && club.bpm >= 124 && club.bpm <= 130);
  assert.ok(club.phase >= 0 && club.phase < 1);
  const unknown = venueLook({ name: 'X', kind: 'karaoke', x: 0, z: 0 });
  assert.equal(unknown.style, 'house', 'an unknown kind sounds like a bar');
  assert.ok(hash01('a') !== hash01('b') && hash01('a') >= 0 && hash01('a') < 1);
});

test('clusters: a strip of bars is one cluster named for its street; a lone pub is none', () => {
  const clusters = clusterVenues([...strip, lone]);
  assert.equal(clusters.length, 1);
  const c = clusters[0];
  assert.equal(c.venues.length, 12);
  assert.equal(c.name, 'Jomfru Ane Gade');
  assert.ok(Math.abs(c.x) < 1 && Math.abs(c.z - 44) < 1);
  assert.ok(c.r > 44 && c.r < 70, `radius covers the strip: ${c.r}`);
  assert.equal(clusterVenues([...strip, lone], { min: 1 }).length, 2, 'with min 1 the lone pub is its own cluster');
  assert.equal(clusterVenues(strip, { link: 3 }).length, 0, 'too far apart to link');
});

test('the light pulse flashes on the beat and decays before the next one', () => {
  const bpm = 120; // a beat every 0.5 s
  assert.ok(Math.abs(beatPulse(0, bpm) - 1) < 1e-9);
  assert.ok(Math.abs(beatPulse(0.5, bpm) - 1) < 1e-6);
  assert.ok(beatPulse(0.1, bpm) < 0.5 && beatPulse(0.45, bpm) < 0.05);
  // a phase of half a beat moves the flash to the off-beat
  assert.ok(Math.abs(beatPulse(0.25, bpm, 0.5) - 1) < 1e-6);
});

test('the listener hears the few loudest venues within range, without allocating', () => {
  const venues = [...strip, lone].map((v) => ({ ...v, look: venueLook(v) }));
  const out = [], scratch = [];
  selectAudible(venues, 0, 0, 3, out, scratch);
  assert.equal(out.length, 3);
  assert.ok(!out.includes(12), 'the lone pub is out of range');
  const d = (i) => Math.hypot(venues[i].x, venues[i].z);
  assert.ok(out.every((i) => d(i) <= venues[i].look.range));
  assert.equal(out[0], 0, 'the nightclub at the door is loudest');
  const same = out;
  selectAudible(venues, 400, 400, 3, out, scratch);
  assert.equal(out, same, 'the output array is reused');
  assert.deepEqual(out, [12]);
  selectAudible(venues, 5000, 5000, 3, out, scratch);
  assert.equal(out.length, 0);
});

test('a venue is silent by day and loudest at full night', () => {
  const look = venueLook({ name: 'Club', kind: 'nightclub', x: 0, z: 0 });
  assert.equal(venueGain(look, 0), 0);
  assert.ok(venueGain(look, 0.45) > 0 && venueGain(look, 0.45) < venueGain(look, 1));
  assert.ok(venueGain(look, 1) <= 1);
});

test('beat loops: whole beats, seamless, kicks on the beat, deterministic, within full scale', () => {
  const rate = 8000;
  for (const style of ['club', 'house', 'rock']) {
    const a = renderBeatLoop(style, 120, rate, { seed: 0.3 });
    assert.equal(a.beats, 8);
    assert.equal(a.samples.length, a.samplesPerBeat * 8);
    assert.ok(Math.abs(a.duration - 4) < 1e-3, '2 bars of 4/4 at 120 bpm = 4 s');
    let peak = 0;
    for (const s of a.samples) peak = Math.max(peak, Math.abs(s));
    assert.ok(peak <= 0.9 + 1e-6 && peak > 0.5, `${style} peak ${peak}`);
    const b = renderBeatLoop(style, 120, rate, { seed: 0.3 });
    assert.deepEqual(a.samples, b.samples, 'deterministic');
    // energy in the 60 ms after the downbeat is far above the energy just before it (the kick)
    const energy = (from, n) => { let e = 0; for (let i = from; i < from + n; i++) e += a.samples[i] ** 2; return e / n; };
    const w = Math.round(rate * 0.06);
    assert.ok(energy(0, w) > 3 * energy(a.samplesPerBeat - w, w), `${style}: a kick on beat 1`);
  }
});

test('shared state: venues get looks and clusters; the hotspot is there only at night', () => {
  const s = createNightlifeState();
  s.setVenues([...strip, lone, { name: 'bad', x: NaN, z: 0 }]);
  assert.equal(s.venues.length, 13, 'records without a position are dropped');
  assert.ok(s.venues.every((v) => v.look && Number.isFinite(v.nx)));
  assert.equal(s.clusters.length, 1);
  s.setLevel(0);
  assert.equal(s.hotspotNear(0, 40, 100), null, 'no hotspot by day');
  s.setLevel(1);
  assert.equal(s.hotspotNear(0, 40, 100), s.clusters[0]);
  assert.equal(s.hotspotNear(2000, 2000, 100), null, 'too far');
  s.setLevel(7);
  assert.equal(s.level, 1);
});

test('walk limits: the footways through a nightlife strip are walked, even off the green; the paths are laid again when the strips change', async () => {
  const { createWalkLimits } = await import('../js/walk-limits.js');
  let spots = [];
  const limits = createWalkLimits({ hotspots: () => spots });
  limits.add('t', { footways: [{ id: 'jag', pts: [0, -20, 0, 100] }, { id: 'other', pts: [500, 0, 600, 0] }] });
  assert.deepEqual(limits.parkPaths().map((p) => p.id), [], 'no strip yet: a street footway is no park path');
  const before = limits.parkPaths.stamp();
  const s = createNightlifeState().setVenues(strip);
  spots = s.clusters;
  assert.notEqual(limits.parkPaths.stamp(), before);
  const paths = limits.parkPaths();
  assert.deepEqual(paths.map((p) => p.id), ['jag']);
  assert.equal(paths[0].hot, true);

  const { createPedestrianRoutes } = await import('../js/pedestrian-routes.js');
  spots = [];
  const r = createPedestrianRoutes({ walkable: () => true, parkPaths: limits.parkPaths, edges: [] }, () => null);
  assert.equal(r.pathsNear(0, 40, 80).length, 0);
  spots = s.clusters;
  const hot = r.pathsNear(0, 40, 80);
  assert.equal(hot.length, 1, 'rebuilt on the new stamp');
  assert.equal(hot[0].hot, true);
});
