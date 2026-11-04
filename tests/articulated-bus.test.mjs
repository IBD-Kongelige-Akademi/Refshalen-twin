// The Plusbus kinematics (js/articulated-bus.js): the trailing modules follow the front one along its path, joints never pass 38°,
// and the layout matches the Urbino 24's dimensions.
import assert from 'node:assert/strict';
import test from 'node:test';
import { URBINO_24, createArticulation } from '../js/articulated-bus.js';

const DEG = Math.PI / 180;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// Drive the front module like js/controllers.js updateBus does: a bicycle model on the 5.9 m wheelbase from the reference axle
function drive(art, steps, speed, steer, dt = 1 / 60) {
  const s = art.state;
  const trace = [];
  for (let i = 0; i < steps; i++) {
    const ds = speed * dt;
    const h0 = s.headings[0];
    const h1 = h0 + ds * Math.tan(typeof steer === 'function' ? steer(i) : steer) / URBINO_24.wheelbase;
    const hm = (h0 + h1) / 2;
    art.follow(s.x + Math.sin(hm) * ds, s.z + Math.cos(hm) * ds, h1);
    trace.push({ joints: [...s.joints], axles: [0, 1, 2, 3].map((k) => art.axle(k)) });
  }
  return trace;
}

test('the layout is the Urbino 24: 24.7 m in three modules, bellows 0.7 m, axles and doors inside their modules', () => {
  const L = URBINO_24;
  assert.equal(L.modules[2].to, L.length);
  assert.ok(Math.abs(L.modules[1].from - L.modules[0].to - 0.7) < 1e-9);
  assert.ok(Math.abs(L.modules[2].from - L.modules[1].to - 0.7) < 1e-9);
  assert.ok(Math.abs(L.axles[1] - L.axles[0] - L.wheelbase) < 1e-9);
  const moduleOf = (d) => L.modules.findIndex((m) => d > m.from && d < m.to);
  assert.deepEqual(L.axles.map(moduleOf), [0, 0, 1, 2]);
  assert.deepEqual(L.doors.map(moduleOf), [0, 0, 1, 2, 2]);
  for (const door of L.doors) {
    for (const axle of L.axles) assert.ok(Math.abs(door - axle) > L.doorWidth / 2 + 0.5, `door ${door} clears axle ${axle}`);
  }
});

test('placed straight, the modules line up nose to tail with the bellows gaps between them', () => {
  const art = createArticulation();
  art.place(10, -20, 0.6);
  const f = { x: Math.sin(0.6), z: Math.cos(0.6) };
  for (let i = 0; i < 3; i++) {
    const m = art.module(i);
    const mod = URBINO_24.modules[i];
    // the front module's centre is the placed point; every centre sits on the line at its distance from the nose
    const back = (mod.from + mod.to) / 2 - 5;
    assert.ok(Math.hypot(m.x - (10 - f.x * back), m.z - (-20 - f.z * back)) < 1e-9, `module ${i}`);
    assert.ok(Math.abs(wrap(m.yaw - 0.6)) < 1e-12);
  }
  const b = art.bellows(0);
  assert.ok(Math.abs(Math.hypot(b.b.x - b.a.x, b.b.z - b.a.z) - 0.7) < 1e-9);
});

// js/controllers.js BUS_STEER.max
const LOCK = 30 * DEG;

test('the clamp holds every joint at 38° even when the front turns tighter than the trailers can follow', () => {
  const art = createArticulation();
  art.place(0, 0, 0);
  const trace = drive(art, 60 * 30, 3, 40 * DEG);
  let maxJoint = 0;
  for (const t of trace) for (const j of t.joints) maxJoint = Math.max(maxJoint, Math.abs(j));
  assert.ok(maxJoint <= 38 * DEG + 1e-9, `max joint ${(maxJoint / DEG).toFixed(2)}°`);
});

test('in a steady circle under 26° of lock the joints stay under 38° unclamped and the trailers track inside the front', () => {
  const steer = 24 * DEG;
  const art = createArticulation();
  art.place(0, 0, 0);
  const trace = drive(art, 60 * 40, 3, steer);
  let maxJoint = 0;
  for (const t of trace) for (const j of t.joints) maxJoint = Math.max(maxJoint, Math.abs(j));
  assert.ok(maxJoint < 38 * DEG - 0.5 * DEG, `max joint ${(maxJoint / DEG).toFixed(2)}°`);
  assert.ok(maxJoint > 25 * DEG, 'the bus does articulate');
  // in the steady turn every axle runs on a circle about the same centre; trailing axles run on smaller ones (off-tracking)
  const last = trace[trace.length - 1].axles;
  const R2 = URBINO_24.wheelbase / Math.tan(steer);
  const h = art.state.headings[0];
  // the heading grows, so the centre lies along d(forward)/dh = (cos h, -sin h)
  const cx = last[1].x + Math.cos(h) * R2, cz = last[1].z - Math.sin(h) * R2;
  const radii = last.map((a) => Math.hypot(a.x - cx, a.z - cz));
  assert.ok(Math.abs(radii[1] - R2) < 1e-6);
  assert.ok(radii[0] > radii[1] && radii[2] < radii[1] && radii[3] < radii[2], radii.map((r) => r.toFixed(2)).join(' '));
});

test('a 90° corner at full lock: about a 24 m front-axle circle, joints held at 38°, no axle swinging outside the front one', () => {
  const art = createArticulation();
  art.place(0, 0, 0);
  const s = art.state;
  drive(art, 60 * 3, 3, 0);
  // the corner's centre, from the reference axle as the turn begins
  const R2 = URBINO_24.wheelbase / Math.tan(LOCK);
  const R0 = URBINO_24.wheelbase / Math.sin(LOCK);
  const h = s.headings[0];
  const c = { x: art.axle(1).x + Math.cos(h) * R2, z: art.axle(1).z - Math.sin(h) * R2 };
  // inside the corner's sector (from the radius through the front axle as the turn starts to the one a quarter turn on) no
  // trailing axle is further from the centre than the front axle runs; before it, they are still on the approach straight
  const angle = (p) => Math.atan2(p.x - c.x, p.z - c.z);
  const a0 = angle(art.axle(0));
  const inSector = (p) => { const d = Math.atan2(Math.sin(angle(p) - a0), Math.cos(angle(p) - a0)); return d >= 0 && d <= Math.PI / 2; };
  let maxJoint = 0, outside = 0, checked = 0;
  for (let i = 0; i < 60 * 60 && s.headings[0] < h + 90 * DEG; i++) {
    const t = drive(art, 1, 3, LOCK)[0];
    for (const j of t.joints) maxJoint = Math.max(maxJoint, Math.abs(j));
    for (const k of [2, 3]) {
      if (!inSector(t.axles[k])) continue;
      checked++;
      if (Math.hypot(t.axles[k].x - c.x, t.axles[k].z - c.z) > R0 + 1e-6) outside++;
    }
  }
  assert.ok(checked > 30, `${checked} samples in the corner`);
  assert.ok(s.headings[0] >= h + 90 * DEG - 1e-9, 'the corner is made');
  assert.ok(maxJoint <= 38 * DEG + 1e-9, `max joint ${(maxJoint / DEG).toFixed(2)}°`);
  assert.equal(outside, 0, 'no trailing axle outside the front axle circle');
  assert.ok(2 * R0 > 22 && 2 * R0 < 26, `front axle circle ${(2 * R0).toFixed(1)} m`);
});

test('after a turn the bus straightens out and the trailers run in the front module tracks', () => {
  const art = createArticulation();
  art.place(0, 0, 0);
  drive(art, 60 * 6, 5, (i) => (i < 60 * 3 ? 25 * DEG : 0));
  drive(art, 60 * 20, 8, 0);
  for (const j of art.state.joints) assert.ok(Math.abs(j) < 0.5 * DEG, `joint ${(j / DEG).toFixed(2)}°`);
  const h = art.state.headings[0];
  const lateral = (p) => (p.x - art.axle(1).x) * Math.cos(h) - (p.z - art.axle(1).z) * Math.sin(h);
  for (const k of [2, 3]) assert.ok(Math.abs(lateral(art.axle(k))) < 0.05, `axle ${k} on the track`);
});

test('reversing is clamped too, and save / restore undo a move exactly', () => {
  const art = createArticulation();
  art.place(0, 0, 0);
  drive(art, 60 * 2, 3, 20 * DEG);
  const saved = art.save();
  const before = [0, 1, 2].map((i) => art.module(i));
  drive(art, 60 * 8, -1.5, 30 * DEG);
  for (const j of art.state.joints) assert.ok(Math.abs(j) <= 38 * DEG + 1e-9);
  art.restore(saved);
  const after = [0, 1, 2].map((i) => art.module(i));
  assert.deepEqual(JSON.stringify(after), JSON.stringify(before));
});
