import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createWalkSpace } from '../js/walk-space.js';

const lakes = JSON.parse(readFileSync(new URL('./fixtures/cph/cph-lakes.json', import.meta.url), 'utf8'));
const ringCentre = (ring) => {
  let x = 0, z = 0;
  for (let i = 0; i < ring.length; i += 2) { x += ring[i]; z += ring[i + 1]; }
  return [x / (ring.length / 2), z / (ring.length / 2)];
};

test('pedestrians keep off the open water of the lakes but may cross a bridge deck', () => {
  const walk = createWalkSpace({ buildings: [] }, lakes);
  // Peblinge Soe, off Kaffesalonen's pier, is water
  assert.equal(walk.inWater(0, -440), true);
  assert.equal(walk.walkable(-0.5, 0.5, -440.5, -439.5), false);
  // Dronning Louises Bro's deck lies inside the lake outline and stays walkable
  const [bx, bz] = ringCentre(lakes.bridges[0].ring);
  assert.equal(walk.inWater(bx, bz), false);
  assert.equal(walk.walkable(bx - 0.4, bx + 0.4, bz - 0.4, bz + 0.4), true);
  // without a lake document only buildings block
  assert.equal(createWalkSpace({ buildings: [] }).walkable(-0.5, 0.5, -440.5, -439.5), true);
});

test('walking lines keep off the carriageways, the water and the railway; corners cross only at an intersection without signals', async () => {
  const { createPedestrianRoutes } = await import('../js/pedestrian-routes.js');
  const block = { id: 'b', poly: [] };
  const node = (x, z, signal = false) => ({ x, z, signal, in: [], out: [], arms: [] });
  const edge = (from, to, half, sz = 0) => {
    const e = { from, to, half, sx: from.x, sz: from.z + sz, dx: 1, dz: 0, rx: 0, rz: 1, len: to.x - from.x };
    from.out.push(e); to.in.push(e);
    return e;
  };
  const routes = (roadAt, hazardAt) => createPedestrianRoutes({ walkable: () => true, roadAt, hazardAt }, () => block);
  const zs = (list) => list.map((t) => t.az);

  // a road drawn 10 m wide on an edge whose half width says 3: the lines move out, off the carriageway, on both sides
  const wide = edge(node(0, 0), node(100, 0), 3);
  const off = routes((x, z) => (Math.abs(z) < 5 ? { class: 'secondary' } : null), () => false).along(wide);
  assert.ok(off.length >= 2 && off.every((t) => Math.abs(t.az) >= 5), `lines at z ${zs(off)}`);

  // no room for a line: water beside the road on one side, the tracks along it on the other
  const tight = edge(node(0, 0), node(100, 0), 3);
  assert.deepEqual(routes(() => null, () => true).along(tight), []);

  // a driveway's mouth is crossed, a street running through the line is not
  const mouth = (cls) => (x) => (x > 50 && x < 56 ? { class: cls } : null);
  assert.ok(routes(mouth('service'), () => false).along(edge(node(0, 0), node(100, 0), 3)).length > 0);
  assert.equal(routes(mouth('secondary'), () => false).along(edge(node(0, 0), node(100, 0), 3)).length, 0, 'the push cannot clear a street across it');

  // a line that ends on the street it meets stops at the kerb
  const ending = routes((x) => (x > 96 ? { class: 'secondary' } : null), () => false).along(edge(node(0, 0), node(100, 0), 3));
  assert.ok(ending.length && ending.every((t) => t.ax + t.ux * t.len <= 96.01), 'drawn back to the kerb');

  // a corner over the road: allowed at the mouth of an intersection without signals, not at signals
  const corner = (signal) => {
    const n = node(100, 0, signal);
    n.arms = [{ half: 3 }];
    const a = edge(node(0, 0), n, 3);
    const b = edge(n, node(200, 0), 3);
    const r = routes((x, z) => (Math.abs(x - 100) < 3 && Math.abs(z) < 20 ? { class: 'residential' } : null), () => false);
    const track = r.along(a).find((t) => t.az > 0);
    // the walker may step over to the other line of its own side; does any choice reach the far side of the street?
    for (let i = 0; i < 40; i++) {
      const path = r.next(track, 1, 300, 5);
      if (path && path[path.length - 1].track.edge === b) return true;
    }
    return false;
  };
  assert.equal(corner(false), true, 'over the mouth');
  assert.equal(corner(true), false, 'at signals the crosswalk is the way over')
});
