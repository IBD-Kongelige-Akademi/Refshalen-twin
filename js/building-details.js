// Pure geometry helpers for light facade and roof details. The generated meshes are closed solids so they can be
// batched into a cell-wide stream without relying on a double-sided material.
// Dormers stay deferred: this data has no surveyed opening locations, and adding them requires invasive roof cutouts.

import { facadeStyle, hasFacadeDetails, ERA, FACADE_CORNER_PIER, WINDOW } from './facade-style.js';
import { KIND } from './groundfloor.js';

const MAX_STREET_EDGES = 4;
const MIN_DETAIL_EDGE_LENGTH = 1.5;
const EAVE_JOG = 0.3; // m: neighbouring eaves this close are one line, at the lower of them; further apart the band steps
const CORNICE_UNDER_EAVE = 0.18; // m between the eave and the cornice's top
const CORNICE_MIN_H = 0.15; // m: a cornice with less room than this over the windows is left out
const GUTTER_UNDER_EAVE = 0.035;
const GUTTER_H = 0.13;
const GUTTER_MIN_H = 0.05;
const WINDOW_CLEARANCE = 0.05; // m kept free over a window's head

const dot2 = (a, b) => a[0] * b[0] + a[1] * b[1];
const length2 = (a) => Math.hypot(a[0], a[1]);

/** Main's street/venue/party-wall classification also selects physical trim. Long frontages win the four-edge cap. */
function selectDetailEdges(rings, wallKinds) {
  const selected = Array(rings.reduce((n, ring) => n + ring.length, 0)).fill(false);
  const candidates = rings[0].map((p, i) => {
    const q = rings[0][(i + 1) % rings[0].length];
    return { i, length: Math.hypot(q[0] - p[0], q[1] - p[1]), kind: wallKinds?.[i]?.kind };
  }).filter((e) => e.length >= MIN_DETAIL_EDGE_LENGTH && (e.kind === KIND.entry || e.kind === KIND.shop));
  candidates.sort((a, b) => b.length - a.length || a.i - b.i);
  for (const { i } of candidates.slice(0, MAX_STREET_EDGES)) selected[i] = true;
  return selected;
}

function outwardOffsetRing(ring, projection) {
  const n = ring.length;
  const normals = ring.map((p, i) => {
    const q = ring[(i + 1) % n];
    const dx = q[0] - p[0], dz = q[1] - p[1];
    const l = Math.hypot(dx, dz) || 1;
    return [-dz / l, dx / l];
  });
  return ring.map((p, i) => {
    const prev = normals[(i + n - 1) % n];
    const next = normals[i];
    const denominator = Math.max(0.25, 1 + dot2(prev, next));
    const scale = Math.min(projection / denominator, projection * 2.5);
    return [p[0] + (prev[0] + next[0]) * scale, p[1] + (prev[1] + next[1]) * scale];
  });
}

function properSegmentCross(a, b, c, d) {
  const orient = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const abC = orient(a, b, c), abD = orient(a, b, d);
  const cdA = orient(c, d, a), cdB = orient(c, d, b);
  return ((abC > 1e-8 && abD < -1e-8) || (abC < -1e-8 && abD > 1e-8))
    && ((cdA > 1e-8 && cdB < -1e-8) || (cdA < -1e-8 && cdB > 1e-8));
}

function edgeRuns(selected, ring) {
  const count = ring.length;
  const edges = Array.from({ length: count }, (_, i) => {
    const p = ring[i];
    const q = ring[(i + 1) % count];
    return (selected?.[i] ?? true) && Math.hypot(q[0] - p[0], q[1] - p[1]) >= MIN_DETAIL_EDGE_LENGTH;
  });
  if (!edges.some(Boolean)) return [];
  if (edges.every(Boolean)) return [{ edges: Array.from({ length: count }, (_, i) => i), closed: true }];
  const runs = [];
  for (let i = 0; i < count; i++) {
    if (!edges[i] || edges[(i + count - 1) % count]) continue;
    const run = [];
    let j = i;
    while (edges[j]) {
      run.push(j);
      j = (j + 1) % count;
    }
    runs.push({ edges: run, closed: false });
  }
  return runs;
}

function triangleNormal(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  return [nx, ny, nz];
}

function pushVertex(mesh, point, normal, material) {
  mesh.position.push(point[0], point[1], point[2]);
  mesh.normal.push(normal[0], normal[1], normal[2]);
  mesh.color.push(material.color[0], material.color[1], material.color[2]);
  mesh.mat.push(material.rough, material.metal);
}

function addTriangle(mesh, a, b, c, expectedNormal, material) {
  let p1 = b, p2 = c;
  const n = triangleNormal(a, p1, p2);
  if (dot2([n[0], n[2]], [expectedNormal[0], expectedNormal[2]]) + n[1] * expectedNormal[1] < 0) [p1, p2] = [p2, p1];
  const normal = triangleNormal(a, p1, p2);
  const base = mesh.position.length / 3;
  pushVertex(mesh, a, normal, material);
  pushVertex(mesh, p1, normal, material);
  pushVertex(mesh, p2, normal, material);
  mesh.index.push(base, base + 1, base + 2);
}

function addQuad(mesh, a, b, c, d, expectedNormal, material) {
  addTriangle(mesh, a, b, c, expectedNormal, material);
  addTriangle(mesh, a, c, d, expectedNormal, material);
}

function appendPart(mesh, parts, id, kind, build, edges = []) {
  const start = mesh.index.length;
  build();
  const end = mesh.index.length;
  if (end > start) parts.push({ id, kind, start, end, edges });
}

/** A run of edges cut where the band's height changes, so that every piece is level. */
function levelRuns(run, bottoms, tops) {
  const same = (a, b) => Math.abs(tops[a] - tops[b]) < 1e-4 && Math.abs(bottoms[a] - bottoms[b]) < 1e-4;
  const list = run.edges;
  let edges = list;
  if (run.closed) {
    const k = list.findIndex((e, i) => !same(e, list[(i + list.length - 1) % list.length]));
    if (k < 0) return [run];
    edges = [...list.slice(k), ...list.slice(0, k)];
  }
  const out = [];
  for (const e of edges) {
    const cur = out[out.length - 1];
    if (cur && same(cur.edges[cur.edges.length - 1], e)) cur.edges.push(e);
    else out.push({ edges: [e], closed: false });
  }
  return out;
}

/** Appends one mitered, capped annular band per selected edge run; `bottoms` and `tops` are per edge, so every piece of it is horizontal. */
function appendRingBand(mesh, parts, id, kind, ring, selected, bottoms, tops, projection, material) {
  const n = ring.length;
  if (n < 3) return;
  const outer = outwardOffsetRing(ring, projection);
  const safe = selected.slice();
  for (let i = 0; i < n; i++) {
    if (!safe[i]) continue;
    for (let j = 0; j < n; j++) {
      if (j !== i && properSegmentCross(outer[i], outer[(i + 1) % n], ring[j], ring[(j + 1) % n])) {
        safe[i] = false;
        break;
      }
      if (j > i && safe[j] && j !== (i + 1) % n && i !== (j + 1) % n
        && properSegmentCross(outer[i], outer[(i + 1) % n], outer[j], outer[(j + 1) % n])) {
        safe[i] = false;
        safe[j] = false;
      }
    }
  }
  for (const run of edgeRuns(safe, ring).flatMap((r) => levelRuns(r, bottoms, tops))) {
    const yb = bottoms[run.edges[0]], yt = tops[run.edges[0]];
    appendPart(mesh, parts, id, kind, () => {
      for (const i of run.edges) {
        const j = (i + 1) % n;
        const inner0b = [ring[i][0], yb, ring[i][1]];
        const inner1b = [ring[j][0], yb, ring[j][1]];
        const outer0b = [outer[i][0], yb, outer[i][1]];
        const outer1b = [outer[j][0], yb, outer[j][1]];
        const inner0t = [ring[i][0], yt, ring[i][1]];
        const inner1t = [ring[j][0], yt, ring[j][1]];
        const outer0t = [outer[i][0], yt, outer[i][1]];
        const outer1t = [outer[j][0], yt, outer[j][1]];
        const dx = ring[j][0] - ring[i][0], dz = ring[j][1] - ring[i][1];
        const len = Math.hypot(dx, dz) || 1;
        const outwardNormal = [-dz / len, 0, dx / len];
        const inwardNormal = [dz / len, 0, -dx / len];
        addQuad(mesh, outer0b, outer1b, outer1t, outer0t, outwardNormal, material);
        addQuad(mesh, inner0b, inner1b, inner1t, inner0t, inwardNormal, material);
        addQuad(mesh, inner0t, inner1t, outer1t, outer0t, [0, 1, 0], material);
        addQuad(mesh, inner0b, outer0b, outer1b, inner1b, [0, -1, 0], material);
      }
      if (run.closed) return;
      const first = run.edges[0];
      const last = run.edges[run.edges.length - 1];
      const end = (last + 1) % n;
      const p = ring[first], q = outer[first];
      const d = ring[end], r = outer[end];
      const firstNext = ring[(first + 1) % n];
      const startDir = [firstNext[0] - p[0], firstNext[1] - p[1]];
      const startLen = length2(startDir) || 1;
      addQuad(mesh,
        [p[0], yb, p[1]], [q[0], yb, q[1]],
        [q[0], yt, q[1]], [p[0], yt, p[1]],
        [-startDir[0] / startLen, 0, -startDir[1] / startLen], material);
      const prev = ring[last];
      const endDir = [d[0] - prev[0], d[1] - prev[1]];
      const endLen = length2(endDir) || 1;
      addQuad(mesh,
        [d[0], yb, d[1]], [r[0], yb, r[1]],
        [r[0], yt, r[1]], [d[0], yt, d[1]],
        [endDir[0] / endLen, 0, endDir[1] / endLen], material);
    }, run.edges);
  }
}

function srgb(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

const PLINTH_MATERIAL = { color: [0.24, 0.25, 0.25].map(srgb), rough: 0.92, metal: 0.02 };
const GUTTER_MATERIAL = { color: [0.46, 0.49, 0.51].map(srgb), rough: 0.38, metal: 0.72 };
const CHIMNEY_MATERIAL = { color: [0.52, 0.28, 0.22].map(srgb), rough: 0.91, metal: 0.0 };

function corniceMetrics(year, era) {
  if (era === ERA.mid) return { projection: 0.25, height: 0.4 };
  if (year < 1870) return { projection: 0.34, height: 0.52 };
  if (year <= 1920) return { projection: 0.42, height: 0.64 };
  return { projection: 0.30, height: 0.46 };
}

/**
 * The height of the eave trim per edge of the outer ring: each edge's own wall top, never its neighbour's (a band laid from one wall's top to a lower neighbour's would slant
 * across the storeys). Neighbouring selected edges within EAVE_JOG share the lower height, so a measured eave's few centimetres do not step the band.
 */
function eaveLevels(edgeTops, selected, n) {
  const levels = edgeTops.slice(0, n);
  const link = (i, lo, hi) => selected[i] && Math.max(hi, levels[i]) - Math.min(lo, levels[i]) <= EAVE_JOG;
  let start = 0;
  for (let i = 0; i < n; i++) {
    const prev = (i + n - 1) % n;
    if (!link(i, levels[prev], levels[prev]) || !selected[prev]) { start = i; break; }
  }
  for (let k = 0; k < n;) {
    const first = (start + k) % n;
    if (!selected[first]) { k++; continue; }
    const group = [first];
    let lo = levels[first], hi = levels[first];
    for (k++; k < n && link((start + k) % n, lo, hi); k++) {
      const i = (start + k) % n;
      group.push(i);
      lo = Math.min(lo, levels[i]);
      hi = Math.max(hi, levels[i]);
    }
    for (const i of group) levels[i] = lo;
  }
  return levels;
}

/**
 * The head of the top window row that starts under a wall top `top` (m above the ground), by the same rows as the facade shader: a measured grid's, or the ground floor
 * and the storeys over it with the window ratio of js/facade-style.js. Above `top` when the wall cuts that row off; null without window rows.
 */
function topWindowHead(top, rows, edge) {
  if (!rows) return null;
  const m = rows.measured?.[edge] || null;
  const g = m ? m.g : rows.groundH;
  const f = m ? m.f : rows.floorH;
  if (!(f > 0) || !(g > 0)) return null;
  const sill = m ? m.sill : f * (1 - WINDOW.ratioY) / 2;
  const head = m ? Math.min(m.head, 0.97 * f) : f * (1 + WINDOW.ratioY) / 2;
  for (let r = Math.min(Math.floor((top - g) / f), m ? m.rows - 1 : Infinity); r >= 0; r--) {
    if (g + r * f + sill < top) return g + r * f + head;
  }
  return 0.76 * g; // the ground floor's openings (js/tsl-materials.js effHiY)
}

function addBox(mesh, parts, id, center, along, across, yBottom, yTop, lengthAlong, widthAcross, material) {
  const hx = along[0] * lengthAlong * 0.5;
  const hz = along[1] * lengthAlong * 0.5;
  const wx = across[0] * widthAcross * 0.5;
  const wz = across[1] * widthAcross * 0.5;
  const lower = [
    [center[0] - hx - wx, yBottom, center[1] - hz - wz],
    [center[0] + hx - wx, yBottom, center[1] + hz - wz],
    [center[0] + hx + wx, yBottom, center[1] + hz + wz],
    [center[0] - hx + wx, yBottom, center[1] - hz + wz]
  ];
  const upper = lower.map(([x, , z]) => [x, yTop, z]);
  appendPart(mesh, parts, id, 'chimney', () => {
    addQuad(mesh, lower[0], lower[3], lower[2], lower[1], [0, -1, 0], material);
    addQuad(mesh, upper[0], upper[1], upper[2], upper[3], [0, 1, 0], material);
    const normals = [
      [-across[0], 0, -across[1]],
      [along[0], 0, along[1]],
      [across[0], 0, across[1]],
      [-along[0], 0, -along[1]]
    ];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      addQuad(mesh, lower[i], lower[j], upper[j], upper[i], normals[i], material);
    }
  });
}

function keyPoint(p) {
  return `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)},${Math.round(p[2] * 100)}`;
}

/** Finds shared, near-horizontal edges between differently sloped roof triangles and merges their subdivisions. */
function ridgeLines(triangles) {
  const edges = new Map();
  let roofMax = -Infinity;
  const addEdge = (a, b, normal) => {
    const ka = keyPoint(a), kb = keyPoint(b);
    const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    let edge = edges.get(key);
    if (!edge) { edge = { a, b, normals: [] }; edges.set(key, edge); }
    edge.normals.push(normal);
  };
  for (const tri of triangles) {
    const normal = triangleNormal(tri[0], tri[1], tri[2]);
    roofMax = Math.max(roofMax, tri[0][1], tri[1][1], tri[2][1]);
    for (let i = 0; i < 3; i++) addEdge(tri[i], tri[(i + 1) % 3], normal);
  }
  const segments = [];
  for (const edge of edges.values()) {
    if (edge.normals.length < 2) continue;
    const [a, b] = [edge.a, edge.b];
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const length = Math.hypot(dx, dz);
    if (length < 0.25 || Math.abs(b[1] - a[1]) > 0.12 || (a[1] + b[1]) * 0.5 < roofMax - 0.35) continue;
    const n0 = edge.normals[0], n1 = edge.normals[1];
    const slope0 = Math.abs(n0[1]), slope1 = Math.abs(n1[1]);
    if (slope0 > 0.98 || slope1 > 0.98) continue;
    const ndot = Math.max(-1, Math.min(1, n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]));
    if (Math.abs(ndot) > 0.985) continue;
    let ux = dx / length, uz = dz / length;
    if (ux < -1e-6 || (Math.abs(ux) <= 1e-6 && uz < 0)) { ux = -ux; uz = -uz; }
    const px = -uz, pz = ux;
    const ta = a[0] * ux + a[2] * uz;
    const tb = b[0] * ux + b[2] * uz;
    segments.push({ ux, uz, px, pz, offset: (a[0] + b[0]) * 0.5 * px + (a[2] + b[2]) * 0.5 * pz, lo: Math.min(ta, tb), hi: Math.max(ta, tb), y: (a[1] + b[1]) * 0.5 });
  }
  segments.sort((a, b) => a.ux - b.ux || a.uz - b.uz || a.offset - b.offset || a.y - b.y || a.lo - b.lo);
  const groups = [];
  for (const segment of segments) {
    let group = groups.find((g) => {
      const parallel = Math.abs(g.ux * segment.uz - g.uz * segment.ux) < 0.015;
      const collinear = Math.abs(g.offset - segment.offset) < 0.18;
      const joined = segment.lo <= g.hi + 0.18 && segment.hi >= g.lo - 0.18;
      return parallel && collinear && joined && Math.abs(g.y - segment.y) < 0.2;
    });
    if (!group) { group = { ...segment }; groups.push(group); }
    else {
      group.lo = Math.min(group.lo, segment.lo);
      group.hi = Math.max(group.hi, segment.hi);
      group.y = (group.y + segment.y) * 0.5;
    }
  }
  return groups.filter((g) => g.hi - g.lo >= 1.5).map((g) => ({ ...g, length: g.hi - g.lo }));
}

function addChimneys(mesh, parts, id, triangles) {
  const lines = ridgeLines(triangles);
  for (const line of lines) {
    const count = line.length < 16 ? 1 : Math.max(1, Math.round(line.length / 10));
    const spacing = line.length / count;
    for (let i = 0; i < count; i++) {
      const t = line.lo + spacing * (i + 0.5);
      const center = [line.ux * t + line.px * line.offset, line.uz * t + line.pz * line.offset];
      addBox(mesh, parts, id, center, [line.ux, line.uz], [line.px, line.pz], line.y - 0.65, line.y + 0.9, 0.8, 0.5, CHIMNEY_MATERIAL);
    }
  }
}

// Keep main's inferred entrance bay clear. The shader uses the same pier/bay fit and building hash.
// Shop plinths stop at the existing stall riser instead of covering the glazing above it.
function plinthOutline(building, ring, selected, height, layout) {
  if (!layout) return { ring, selected, tops: Array(ring.length).fill(building.ground + height) };
  const points = [], mask = [], edgeHeights = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const kind = layout.wallKinds?.[i]?.kind;
    const h = kind === KIND.shop ? Math.min(height, layout.groundH * 0.17) : height;
    points.push(p); mask.push(selected[i]); edgeHeights.push(h);
    if (!selected[i] || (kind !== KIND.entry && kind !== KIND.shop)) continue;
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const m = layout.measured?.[i]; // a measured window grid (js/facade-layout.js): the shader's bays are its columns
    const pier = m ? m.u0 : Math.min(FACADE_CORNER_PIER, len * 0.2);
    const bays = m ? m.n : Math.max(1, Math.floor((len - 2 * pier) / layout.bayW + 0.5));
    const bay = m ? m.p : (len - 2 * pier) / bays;
    const door = Math.min(Math.floor(layout.tone * bays), bays - 1);
    for (const [u, keep] of [[0.21, false], [0.79, true]]) {
      const t = (pier + (door + u) * bay) / len;
      points.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      mask.push(keep); edgeHeights.push(h);
    }
  }
  return { ring: points, selected: mask, tops: edgeHeights.map((h) => building.ground + h) };
}

/** Adds cornices, plinths, the zinc eave band and eligible ridge chimneys to a detail stream. */
function appendBuildingDetails(mesh, parts, building, rings, edgeTops, streetEdges, roofTriangles, wallTone, layout = null, rows = null) {
  const style = facadeStyle(building);
  if (!hasFacadeDetails(building, style)) return mesh.index.length;
  const id = building.id;
  const ring = rings[0];
  if (!ring || ring.length < 3) return 0;
  const n = ring.length;
  const ground = building.ground;
  const minWall = 0.75;
  // an edge whose wall is too low for trim (or has no known top) gets none; the others keep theirs
  const selected = (streetEdges ? streetEdges.slice(0, n) : Array(n).fill(true)).map((s, i) => !!s && edgeTops[i] - ground >= minWall);
  if (!selected.some(Boolean)) return mesh.index.length;
  const eaves = eaveLevels(edgeTops, selected, n);
  const year = building.year !== null && building.year !== undefined && Number.isFinite(Number(building.year)) ? Number(building.year) : null;
  const plinthHeight = Math.min(1.2, Math.max(0.6, building.facade?.plinth_h || (year !== null && year < 1950 ? 0.95 : 0.75)));
  const heads = eaves.map((y, i) => (selected[i] ? topWindowHead(y - ground, rows, i) : null));
  const cornice = corniceMetrics(year || 1900, style.era);
  // The cornice under the eave and clear of the windows: it gives way to the top row's head, and an edge without room for it has none.
  // Keep it above the plinth too: very low sheds do not have room for all the details.
  const corniceH = eaves.map((y, i) => {
    const wall = y - ground;
    if (!selected[i] || wall < CORNICE_UNDER_EAVE + cornice.height + plinthHeight + 0.03) return 0;
    const room = heads[i] === null ? Infinity : wall - CORNICE_UNDER_EAVE - heads[i] - WINDOW_CLEARANCE;
    return room < CORNICE_MIN_H ? 0 : Math.min(cornice.height, room);
  });
  // one height along a straight line of eaves, the lowest any of its windows allows
  const corniceAt = corniceH.slice();
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    if (!corniceH[i] || !corniceH[next] || Math.abs(eaves[i] - eaves[next]) > 1e-4) continue;
    const h = Math.min(corniceAt[i], corniceAt[next]);
    corniceAt[i] = corniceAt[next] = h;
  }
  const hasCornice = corniceAt.map((h) => h > 0);
  if (hasCornice.some(Boolean)) {
    const tops = eaves.map((y) => y - CORNICE_UNDER_EAVE);
    const bottoms = tops.map((y, i) => y - corniceAt[i]);
    const color = (wallTone || [0.48, 0.4, 0.32]).map((v) => v * 0.9);
    appendRingBand(mesh, parts, id, 'cornice', ring, hasCornice, bottoms, tops, cornice.projection, { color, rough: 0.88, metal: 0.01 });
  }

  const plinth = plinthOutline(building, ring, selected, plinthHeight, layout);
  appendRingBand(mesh, parts, id, 'plinth', plinth.ring, plinth.selected, Array(plinth.ring.length).fill(ground), plinth.tops, 0.04, PLINTH_MATERIAL);

  const gutterTops = eaves.map((y) => y - GUTTER_UNDER_EAVE);
  // the gutter is thinner over a window that comes close to the eave, and is left out over a row the wall cuts off
  const gutterBottoms = gutterTops.map((y, i) => (heads[i] === null ? y - GUTTER_H : Math.max(y - GUTTER_H, ground + heads[i] + 0.02)));
  const hasGutter = selected.map((s, i) => s && gutterTops[i] - gutterBottoms[i] >= GUTTER_MIN_H);
  const gutterProjection = hasCornice.some(Boolean) ? cornice.projection + 0.14 : 0.15;
  appendRingBand(mesh, parts, id, 'gutter', ring, hasGutter, gutterBottoms, gutterTops, gutterProjection, GUTTER_MATERIAL);

  const pitched = roofTriangles.some((tri) => {
    const ny = triangleNormal(tri[0], tri[1], tri[2])[1];
    return ny < 0.98 && ny > 0.1;
  });
  if (year !== null && year < 1940 && pitched && roofTriangles.length) addChimneys(mesh, parts, id, roofTriangles);
  return mesh.index.length;
}

export { selectDetailEdges, appendBuildingDetails, outwardOffsetRing, ridgeLines, eaveLevels, topWindowHead };
