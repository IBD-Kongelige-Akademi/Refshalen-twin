import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLod2Record, loadLod2, lod2EdgeTops, lod2WallPieces, clipAbove, roofHeightSampler } from '../js/lod2-geometry.js';

test('roofHeightSampler: the height of a gable roof under a point, null off the roof or without a record', () => {
  // 10 x 10 m, eaves at x = 0 and x = 10 (5 m), ridge along z at x = 5 (8 m), plus a vertical gable triangle that must not count
  const pos = new Float32Array([0, 5, 0, 5, 8, 0, 5, 8, 10, 0, 5, 10, 10, 5, 0, 10, 5, 10, 5, 5, 0]);
  const tris = [[0, 1, 2], [0, 2, 3], [1, 4, 5], [1, 5, 2], [6, 1, 4]];
  const rec = { nV: 7, nT: tris.length, pos, idx: new Uint16Array(tris.flat()), kind: new Uint8Array([0, 0, 0, 0, 1]) };
  const at = roofHeightSampler((id) => (id === 'gdk:1' ? rec : null));
  assert.ok(Math.abs(at('gdk:1', 2.5, 5) - 6.5) < 1e-6, 'half way up the slope');
  assert.ok(Math.abs(at('gdk:1', 5, 5) - 8) < 1e-6, 'the ridge');
  assert.ok(Math.abs(at('gdk:1', 9, 2) - 5.6) < 1e-6, 'the other slope');
  assert.equal(at('gdk:1', 20, 5), null, 'beside the building');
  assert.equal(at('gdk:2', 2.5, 5), null, 'no LoD2 record');
});
import { createAccumulator, addBuilding, cleanRing } from '../js/building-geometry.js';
import { texturedWalls } from '../js/appearance.js';

// Mirrors tools/lod2/convert.py pack_record: a 10 x 6 m gabled house, ground 5, eave 9, ridge 11 along x.
const RING = [0, 0, 10, 0, 10, -6, 0, -6];
const P = { A: [0, 5, 0], B: [10, 5, 0], C: [10, 5, -6], D: [0, 5, -6], a: [0, 9, 0], b: [10, 9, 0], c: [10, 9, -6], d: [0, 9, -6], r0: [0, 11, -3], r1: [10, 11, -3] };
const names = Object.keys(P);
function packRecord(tris, edges, kinds, tops) {
  const nV = names.length, nT = tris.length, nE = tops.length;
  const size = 18 + 6 * nV + 6 * nT + nT + 2 * nT + 2 * nE;
  const buf = new ArrayBuffer(size + ((4 - (size % 4)) % 4));
  const v = new DataView(buf);
  v.setFloat32(0, 5, true); v.setFloat32(4, 0, true); v.setFloat32(8, -3, true); // origin
  v.setUint16(12, nV, true); v.setUint16(14, nT, true); v.setUint16(16, nE, true);
  let o = 18;
  for (const n of names) { v.setInt16(o, Math.round((P[n][0] - 5) * 100), true); v.setInt16(o + 2, Math.round(P[n][1] * 100), true); v.setInt16(o + 4, Math.round((P[n][2] + 3) * 100), true); o += 6; }
  for (const t of tris) for (const n of t) { v.setUint16(o, names.indexOf(n), true); o += 2; }
  for (const k of kinds) { v.setUint8(o, k); o += 1; }
  for (const e of edges) { v.setInt16(o, e, true); o += 2; }
  for (const t of tops) { v.setInt16(o, t === null ? -32768 : Math.round(t * 100), true); o += 2; }
  return buf;
}
// CCW from outside. Walls: south (edge 0), east gable (1), north (2), west gable (3); two roof planes; one inner wall at x=5.
const TRIS = [
  [['A', 'B', 'b'], 1, 0], [['A', 'b', 'a'], 1, 0],
  [['B', 'C', 'c'], 1, 1], [['B', 'c', 'r1'], 1, 1], [['B', 'r1', 'b'], 1, 1],
  [['C', 'D', 'd'], 1, 2], [['C', 'd', 'c'], 1, 2],
  [['D', 'A', 'a'], 1, 3], [['D', 'a', 'r0'], 1, 3], [['D', 'r0', 'd'], 1, 3],
  [['a', 'b', 'r1'], 0, -1], [['a', 'r1', 'r0'], 0, -1], [['d', 'r0', 'r1'], 0, -1], [['d', 'r1', 'c'], 0, -1]
];
const record = () => parseLod2Record(packRecord(TRIS.map((t) => t[0]), TRIS.map((t) => t[2]), TRIS.map((t) => t[1]), [9, 9, 9, 9]));
const building = (extra = {}) => ({ id: 'gdk:1', ring: RING, ground: 5, eave: 9, ridge: 9.2, roof: 'flat', roof_material: 'tegl', facade: { floor_h: 2.8, ground_floor_h: 3.6, window_w: 1.2, bay_w: 4.7, ground_type: 'residential', tone: [0.7, 0.6, 0.5] }, ...extra });

test('parseLod2Record decodes the packed layout into absolute local metres', () => {
  const r = record();
  assert.equal(r.nV, 10);
  assert.equal(r.nT, TRIS.length);
  assert.deepEqual([...r.top], [9, 9, 9, 9]);
  const k = r.idx[0];
  assert.deepEqual([r.pos[3 * k], r.pos[3 * k + 1], r.pos[3 * k + 2]], P.A);
  assert.deepEqual([...r.edge].slice(0, 5), [0, 0, 1, 1, 1]);
});

test('edge tops map raw edges onto the cleaned ring and fall back to the DSM eave', () => {
  const b = building();
  const rings = [cleanRing(RING, true)];
  const rec = record();
  rec.top[2] = NaN; // an unmatched edge
  const lod = lod2EdgeTops(rec, b, rings, 8.5, 6);
  assert.equal(lod.tops.length, 4);
  const north = lod.cleaned.findIndex((c) => c[1] === -6 && c[3] === -6);
  assert.equal(lod.tops[north], 8.5);
  assert.equal(lod.tops.filter((t) => t === 9).length, 3);
  // tops below ground + 1 m are junk and ignored
  rec.top[0] = 5.2;
  assert.equal(lod2EdgeTops(rec, b, rings, 8.5, 6).tops.filter((t) => t === 8.5).length, 2);
});

test('clipAbove keeps only the part above the plane', () => {
  const tri = [[0, 0, 0], [4, 0, 0], [2, 4, 0]];
  const out = clipAbove(tri, 2);
  const area = out.reduce((s, t) => s + Math.abs((t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[2][0] - t[0][0]) * (t[1][1] - t[0][1])) / 2, 0);
  assert.ok(Math.abs(area - 2) < 1e-9, 'the top half of the triangle (base 2, height 2)');
  assert.equal(clipAbove(tri, 5).length, 0);
  assert.equal(clipAbove(tri, -1).length, 1);
});

test('wall pieces: only the gable triangles above the eave survive', () => {
  const b = building();
  const rec = record();
  const lod = lod2EdgeTops(rec, b, [cleanRing(RING, true)], 9, 6);
  const pieces = lod2WallPieces(rec, lod);
  assert.ok(pieces.length >= 2, 'both gable ends contribute');
  for (const { tri, edge } of pieces) {
    assert.ok(edge >= 0);
    for (const q of tri) assert.ok(q[1] >= 9 - 1e-3);
  }
});

test('addBuilding with a LoD2 record: pitched roof on top of walls that end at the roofer eave', () => {
  const acc = createAccumulator();
  const flat = createAccumulator();
  addBuilding(flat, building());
  const added = addBuilding(acc, building(), { lod2: record() });
  assert.equal(added.roofTriangles, 4, 'the four roof triangles replace the flat deck + parapet');
  const ys = acc.roof.position.filter((_, i) => i % 3 === 1);
  assert.equal(Math.max(...ys), 11);
  assert.equal(Math.min(...ys), 9);
  for (let i = 1; i < acc.roof.normal.length; i += 3) assert.ok(acc.roof.normal[i] > 0.5, 'roof normals face up');
  // facade quads (4 edges x 2 triangles) end at the eave; gable triangles add more wall above it
  assert.ok(added.wallTriangles >= 8 + 2);
  const wallYs = acc.wall.position.filter((_, i) => i % 3 === 1);
  assert.equal(Math.max(...wallYs), 11, 'gable apex is wall');
  assert.ok(acc.roofRanges.at(-1).end > acc.roofRanges.at(-1).start);
  // flat fallback unchanged
  assert.ok(flat.roof.index.length / 3 > 4);
});

test('wall tops follow a roofer eave that differs from the DSM eave', () => {
  const rec = record();
  rec.top.set([7.5, 7.5, 7.5, 7.5]);
  const acc = createAccumulator();
  addBuilding(acc, building(), { lod2: rec });
  // the extruded facade quads (kind: first 8 triangles = 4 quads x 2) top out at 7.5
  const quadTops = [];
  for (let q = 0; q < 4; q++) quadTops.push(acc.wall.position[(4 * q + 2) * 3 + 1]);
  assert.deepEqual(quadTops, [7.5, 7.5, 7.5, 7.5]);
});

test('loadLod2 joins by building id, serves only measured records and degrades to null', async () => {
  const bin = packRecord(TRIS.map((t) => t[0]), TRIS.map((t) => t[2]), TRIS.map((t) => t[1]), [9, 9, 9, 9]);
  const index = { version: 'lod2/1', tiles: { '6176_723': { file: '6176_723.bin' } }, buildings: {
    'gdk:1': { tile: '6176_723', offset: 0, length: bin.byteLength, conf: 'measured', scan_date: '2019-04-07' },
    'gdk:2': { tile: '6176_723', conf: 'inferred', reason: 'built after the point cloud was scanned' } } };
  const fetchImpl = async (url) => (url.endsWith('index.json') ? { ok: true, json: async () => index } : url.endsWith('.bin') ? { ok: true, arrayBuffer: async () => bin } : { ok: false });
  const lod = await loadLod2('x', fetchImpl);
  await lod.prefetch();
  assert.equal((await lod.ready('gdk:1')).nT, TRIS.length);
  assert.equal(await lod.ready('gdk:2'), null);
  assert.equal(await lod.ready('gdk:nope'), null);
  assert.equal(lod.entry('gdk:2').reason.startsWith('built after'), true);
  assert.equal(await loadLod2('x', async () => ({ ok: false })), null);
  assert.equal(await loadLod2('x', async () => { throw new Error('offline'); }), null);
  assert.equal(await loadLod2('x', async () => ({ ok: true, json: async () => ({ version: 'other' }) })), null);
});

test('photo walls cover the roofer gable above the eave with the same strip (v metric from the ground)', () => {
  const photoOf = (hM) => {
    const b = building({ observed: { walls: [{ ring: 0, edge: 1, tone: [0.6, 0.5, 0.4], conf: 'observed' }],
      atlas: { file: 'tex/gdk_1.jpg', size: [64, 64], walls: [{ ring: 0, edge: 1, len_m: 6, h_m: hM, eave_m: 4, filled_frac: 0, uv: [0, 0.2, 1, 0.8] }] } } });
    const quads = [];
    const added = addBuilding(createAccumulator(), b, { quads, lod2: record() });
    assert.ok(quads.every((q) => Array.isArray(q.pieces)));
    assert.ok(quads.some((q) => q.pieces.length), 'the gable pieces join their quad');
    return texturedWalls(b, quads, added.mapping);
  };
  const w = photoOf(6); // the strip was cut from the ground (5) to the ridge (11): eave 9 at h 4, apex at h 6
  assert.equal(w.count, 1);
  const ys = w.position.filter((_, i) => i % 3 === 1);
  assert.ok(Math.abs(Math.max(...ys) - 11) < 1e-6, 'the photo reaches the gable apex');
  for (let i = 0; i < ys.length; i++) {
    const v = w.uv[2 * i + 1];
    assert.ok(Math.abs(v - (0.8 + (0.2 - 0.8) * (ys[i] - 5) / 6)) < 1e-6, 'v = h / h_m everywhere (wall and gable)');
    assert.ok(Math.abs(w.wallUV[2 * i + 1] - (ys[i] - 5)) < 1e-6);
  }
  for (let k = 0; k < w.index.length; k += 3) { // the east wall faces +x, gable triangles included
    const p = (i) => w.position.slice(3 * w.index[k + i], 3 * w.index[k + i] + 3);
    const [a, c, d] = [p(0), p(1), p(2)];
    const u = c.map((v, j) => v - a[j]);
    const v = d.map((q, j) => q - a[j]);
    assert.ok(u[1] * v[2] - u[2] * v[1] > 0, 'front face points out');
  }
  // an older strip that stops at h 5 (y 10): the gable is photographed up to there only, never stretched
  const old = photoOf(5);
  assert.ok(Math.abs(Math.max(...old.position.filter((_, i) => i % 3 === 1)) - 10) < 1e-6);
  assert.ok(old.index.length > 6);
});

test('the shell of a LoD2 building closes: bad records are refused, unmatched walls reach the roof, a deck lies under gaps', async () => {
  const { createAccumulator, addBuilding } = await import('../js/building-geometry.js');
  const { lod2RoofCover, lod2Usable, lod2ClosingWalls } = await import('../js/lod2-geometry.js');
  // a 20 x 20 m footprint, wound as the data is
  const b = { id: 'gdk:1', ring: [0, 0, 20, 0, 20, 20, 0, 20], ground: 0, eave: 6, ridge: 8 };
  const record = (roofs, walls = [], top = [NaN, NaN, NaN, NaN]) => {
    const pos = [];
    const idx = [], kind = [], edge = [];
    for (const [k, list] of [[0, roofs], [1, walls]]) {
      for (const tri of list) {
        const at = pos.length / 3;
        for (const q of tri.q ?? tri) pos.push(...q);
        idx.push(at, at + 1, at + 2);
        kind.push(k);
        edge.push(tri.e ?? -1);
      }
    }
    return { nV: pos.length / 3, nT: kind.length, nE: top.length, pos: new Float32Array(pos), idx: new Uint16Array(idx), kind: new Uint8Array(kind), edge: new Int16Array(edge), top: new Float32Array(top) };
  };
  // a flat roof at 10 m over all of it, faces up
  const full = [[[0, 10, 0], [0, 10, 20], [20, 10, 20]], [[0, 10, 0], [20, 10, 20], [20, 10, 0]]];
  // only 1 m2 of roof
  const scrap = [[[9, 10, 9], [9, 10, 11], [10, 10, 11]]];
  const yRange = (m) => { let lo = Infinity, hi = -Infinity; for (let i = 1; i < m.position.length; i += 3) { lo = Math.min(lo, m.position[i]); hi = Math.max(hi, m.position[i]); } return [lo, hi]; };

  assert.ok(Math.abs(lod2RoofCover(b, full) - 1) < 1e-6);
  assert.equal(lod2Usable(record(scrap), b), false, 'a scrap of roof is no roof');

  // refused: an extrusion to the building's own eave, with a whole roof
  const refused = createAccumulator({ lite: true });
  addBuilding(refused, b, { lite: true, lod2: record(scrap) });
  assert.equal(yRange(refused.wall)[1], 6);
  assert.equal(yRange(refused.roof)[0], 6, 'a deck at the eave');
  // refused, and barely over the ground: an underground car park under a square (Budolfi Plads) is not drawn at all
  const low = createAccumulator({ lite: true });
  assert.equal(addBuilding(low, { ...b, eave: 0.6 }, { lite: true, lod2: record(scrap) }), null);
  assert.equal(low.wall.position.length + low.roof.position.length, 0);
  // without a record a low building stays what it was
  assert.ok(addBuilding(createAccumulator({ lite: true }), { ...b, eave: 0.6 }, { lite: true }));

  // used: unmatched walls (no roofer eave) reach the roof, higher or lower than the generic eave
  const up = createAccumulator({ lite: true });
  addBuilding(up, b, { lite: true, lod2: record(full) });
  assert.ok(Math.abs(yRange(up.wall)[1] - 10) < 1e-3, `the walls end at the roof, not at the eave of 6: ${yRange(up.wall)}`);
  const under = createAccumulator({ lite: true });
  addBuilding(under, { ...b, eave: 14 }, { lite: true, lod2: record(full) });
  assert.ok(Math.abs(yRange(under.wall)[1] - 10) < 1e-3, 'no wall standing over the roof');

  // a whole roof needs no deck under it; a roof with a gap gets one, 0.3 m under its lowest
  assert.equal(under.roof.position.length / 3, 6, 'only the roof');
  const partRoof = [[[0, 10, 0], [0, 10, 20], [20, 10, 20]], [[0, 10, 0], [10, 10, 10], [20, 10, 0]]]; // a corner of the plan is left open
  const decked = createAccumulator({ lite: true });
  addBuilding(decked, b, { lite: true, lod2: record(partRoof) });
  assert.ok(decked.roof.position.filter((_, i) => i % 3 === 1).some((v) => Math.abs(v - 9.7) < 1e-3), 'a deck 0.3 m under the roof');

  // a matched wall with an eave of 6 under a roof at 10, and no roofer wall above it: the gap is closed, faces outward
  const lod = { tops: new Float32Array([6]), cleaned: [[20, 0, 0, 0]], rawToClean: new Int32Array([0]) }; // the z = 0 edge, the solid on its +z side
  const closing = lod2ClosingWalls(lod, [], full);
  assert.ok(closing.length >= 2);
  for (const { tri: [a, c, d] } of closing) {
    const nz = (c[0] - a[0]) * (d[1] - a[1]) - (c[1] - a[1]) * (d[0] - a[0]);
    assert.ok(Math.max(a[1], c[1], d[1]) <= 10 + 1e-6 && Math.min(a[1], c[1], d[1]) >= 6 - 1e-6);
    assert.ok(nz < 0, 'it faces out, away from the solid');
  }
  assert.equal(lod2ClosingWalls({ ...lod, tops: new Float32Array([10]) }, [], full).length, 0, 'nothing to close');
});
