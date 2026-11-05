// js/lod2-geometry.js
// Pure (no three.js) LoD2 roof support for the Copenhagen buildings. The offline pipeline (tools/lod2/) turns DHM
// Punktsky point clouds into roofer LoD2.2 meshes and packs them per 1 km tile into data/lod2/<tile>.bin, addressed by
// data/lod2/index.json ({buildings: {id: {tile, offset, length, conf, ...}}}). Record layout: tools/lod2/convert.py.
//
// How the engine uses a record (building-geometry.js addBuilding):
//   - roof triangles replace the flat deck + parapet (or the hipped cap),
//   - the footprint-extruded facade walls stay (they carry the facade shader frame) but now end at the roofer eave of
//     each edge (`top`), so a pitched roof meets its wall instead of floating above or sinking into it,
//   - roofer outer-wall triangles are kept only above that eave (gables, dormer-height steps) and inner step walls
//     (edge -1) are kept whole; both are drawn as plain masonry.

const LOD2_NO_TOP = -32768;
const ROOF = 0;
const WALL = 1;

/** Decodes one record. Positions come back in absolute local metres (x east, y up, z south). */
function parseLod2Record(buffer, byteOffset = 0, byteLength = buffer.byteLength - byteOffset) {
  const view = new DataView(buffer, byteOffset, byteLength);
  const ox = view.getFloat32(0, true);
  const oy = view.getFloat32(4, true);
  const oz = view.getFloat32(8, true);
  const nV = view.getUint16(12, true);
  const nT = view.getUint16(14, true);
  const nE = view.getUint16(16, true);
  let o = 18;
  const i16 = (count) => {
    const out = new Int16Array(count);
    for (let i = 0; i < count; i++) out[i] = view.getInt16(o + 2 * i, true);
    o += 2 * count;
    return out;
  };
  const raw = i16(3 * nV);
  const pos = new Float32Array(3 * nV);
  for (let i = 0; i < nV; i++) {
    pos[3 * i] = ox + raw[3 * i] / 100;
    pos[3 * i + 1] = oy + raw[3 * i + 1] / 100;
    pos[3 * i + 2] = oz + raw[3 * i + 2] / 100;
  }
  const idx = new Uint16Array(3 * nT);
  for (let i = 0; i < 3 * nT; i++) idx[i] = view.getUint16(o + 2 * i, true);
  o += 6 * nT;
  const kind = new Uint8Array(nT);
  for (let i = 0; i < nT; i++) kind[i] = view.getUint8(o + i);
  o += nT;
  const edge = i16(nT);
  const topRaw = i16(nE);
  const top = new Float32Array(nE);
  for (let i = 0; i < nE; i++) top[i] = topRaw[i] === LOD2_NO_TOP ? NaN : topRaw[i] / 100;
  return { origin: [ox, oy, oz], nV, nT, nE, pos, idx, kind, edge, top };
}

/**
 * Loads data/lod2/index.json and lazily the tile binaries. Returns null when the index is absent or not lod2/1, so the
 * engine falls back to flat roofs. `get(id)` resolves to a parsed record for a building with `conf: "measured"`, else null.
 */
async function loadLod2(baseUrl = './data/lod2', fetchImpl = globalThis.fetch) {
  let index;
  try {
    const response = await fetchImpl(`${baseUrl}/index.json`, { cache: 'no-cache' });
    if (!response.ok) return null;
    index = await response.json();
  } catch (error) {
    console.info('[cph] no LoD2 roofs loaded:', error?.message || error);
    return null;
  }
  if (!index?.version?.startsWith('lod2/') || !index.buildings) return null;
  const tiles = new Map();
  const tile = (name) => {
    if (!tiles.has(name)) {
      const file = index.tiles?.[name]?.file || `${name}.bin`;
      tiles.set(name, fetchImpl(`${baseUrl}/${file}`).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null));
    }
    return tiles.get(name);
  };
  const records = new Map();
  /** Fetches every tile that has a mesh, then parses the records on demand (cached). */
  async function prefetch() { await Promise.all([...new Set(Object.values(index.buildings).filter((e) => e.offset !== undefined).map((e) => e.tile))].map(tile)); }
  async function ready(id) {
    const e = index.buildings[id];
    if (!e || e.conf !== 'measured' || e.offset === undefined) return null;
    if (records.has(id)) return records.get(id);
    const buf = await tile(e.tile);
    const rec = buf && e.offset + e.length <= buf.byteLength ? parseLod2Record(buf, e.offset, e.length) : null;
    records.set(id, rec);
    return rec;
  }
  return { index, prefetch, ready, get: (id) => records.get(id) || null, entry: (id) => index.buildings[id] || null };
}

/** [{x0, z0, x1, z1}] for the geodata building's outer ring then holes: the indexing of the record's `edge` / `top`. */
function rawEdges(b) {
  const out = [];
  for (const ring of [b.ring, ...(b.holes || [])]) {
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      out.push({ x0: ring[2 * i], z0: ring[2 * i + 1], x1: ring[2 * j], z1: ring[2 * j + 1] });
    }
  }
  return out;
}

function distToSegment(px, pz, x0, z0, x1, z1) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (pz - z0) * dz) / l2));
  return Math.hypot(x0 + dx * t - px, z0 + dz * t - pz);
}

/**
 * Per cleaned-ring edge (flat index over the cleaned rings, in build order) the roofer eave `top`, and the map from the
 * record's raw edge index to that cleaned edge. cleanRing() merges collinear and duplicate vertices, so one cleaned edge
 * may cover several raw edges: its top is the lowest top among them (higher parts are filled by wall pieces above it).
 * Edges the roofer did not match keep `fallback` (the DSM eave).
 */
function lod2EdgeTops(rec, b, cleanRings, fallback, minTop, triangles = null) {
  const cleaned = [];
  for (const ring of cleanRings) {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      cleaned.push([p[0], p[1], q[0], q[1]]);
    }
  }
  const raw = rawEdges(b);
  const rawToClean = new Int32Array(raw.length).fill(-1);
  const tops = new Float32Array(cleaned.length).fill(NaN);
  raw.forEach((e, k) => {
    const mx = (e.x0 + e.x1) / 2;
    const mz = (e.z0 + e.z1) / 2;
    let best = -1;
    let bd = 0.12;
    cleaned.forEach((c, ci) => {
      const d = distToSegment(mx, mz, c[0], c[1], c[2], c[3]);
      if (d < bd) { bd = d; best = ci; }
    });
    rawToClean[k] = best;
    if (best >= 0 && k < rec.nE && Number.isFinite(rec.top[k]) && rec.top[k] >= minTop) {
      tops[best] = Number.isFinite(tops[best]) ? Math.min(tops[best], rec.top[k]) : rec.top[k];
    }
  });
  // an edge the roofer did not match ends at the lowest roof over it (lod2ClosingWalls goes on from there); the generic eave could stand
  // above the roof, its back open to whoever looks across it, or end short of it
  const read = triangles ? roofReader(triangles) : null;
  for (let i = 0; i < tops.length; i++) {
    if (Number.isFinite(tops[i])) continue;
    tops[i] = fallback;
    if (!read) continue;
    const [x0, z0, x1, z1] = cleaned[i];
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 0.05) continue;
    const nx = -(z1 - z0) / len, nz = (x1 - x0) / len;
    let low = Infinity;
    for (let k = 0; k <= 4; k++) {
      const f = 0.02 + 0.96 * k / 4;
      const y = roofAboveWall(read, x0 + (x1 - x0) * f, z0 + (z1 - z0) * f, nx, nz);
      if (y !== null) low = Math.min(low, y);
    }
    if (low < Infinity && low >= minTop) tops[i] = low;
  }
  return { tops, rawToClean, cleaned };
}

const MIN_ROOF_COVER = 0.6; // of the footprint: a record whose roof covers less is no building's roof (the shell would stand open)
const CLOSE_STEP = 3; // m between the points along a wall where the roof above it is read
const GAP_GRID = 16; // points across a footprint where the roof is looked for
const GAP_MIN_STEP = 1; // m
const CLOSE_MIN = 0.05; // m: a gap this small between a wall and the roof is left

function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) a += r[j] * r[i + 1] - r[i] * r[j + 1];
  return Math.abs(a / 2);
}

/** The share of the footprint a record's drawn roof covers in plan. */
function lod2RoofCover(b, triangles) {
  let roof = 0;
  for (const [a, c, d] of triangles) roof += Math.abs((c[0] - a[0]) * (d[2] - a[2]) - (c[2] - a[2]) * (d[0] - a[0])) / 2;
  const foot = ringArea(b.ring) - (b.holes || []).reduce((s, h) => s + ringArea(h), 0);
  return foot > 0 ? roof / foot : 1;
}

/** Is this record's roof a roof for this footprint? A bad fit leaves a shell open to the sky, its walls culled from behind: it looks transparent. */
function lod2Usable(rec, b, triangles = lod2RoofTriangles(rec)) {
  return triangles.length > 0 && lod2RoofCover(b, triangles) >= MIN_ROOF_COVER;
}

/** Reads the height of a set of roof triangles [[x, y, z] x 3] under points; null where none is. */
function roofReader(triangles) {
  const items = [];
  for (const tri of triangles) {
    const [a, c, d] = tri;
    const area = (c[0] - a[0]) * (d[2] - a[2]) - (c[2] - a[2]) * (d[0] - a[0]);
    if (Math.abs(area) < 1e-6) continue;
    items.push({ a, c, d, area, x0: Math.min(a[0], c[0], d[0]), x1: Math.max(a[0], c[0], d[0]), z0: Math.min(a[2], c[2], d[2]), z1: Math.max(a[2], c[2], d[2]) });
  }
  return (x, z) => {
    let top = null;
    for (const { a, c, d, area, x0, x1, z0, z1 } of items) {
      if (x < x0 || x > x1 || z < z0 || z > z1) continue;
      const u = ((c[0] - x) * (d[2] - z) - (c[2] - z) * (d[0] - x)) / area;
      const v = ((d[0] - x) * (a[2] - z) - (d[2] - z) * (a[0] - x)) / area;
      const w = 1 - u - v;
      if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
      const y = u * a[1] + v * c[1] + w * d[1];
      if (top === null || y > top) top = y;
    }
    return top;
  };
}

/** Does the roof leave part of the footprint open? Read on a grid over the footprint (rings flat [x0, z0, ...]). */
function lod2RoofHasGaps(b, triangles) {
  const read = roofReader(triangles);
  const inRing = (r, x, z) => {
    let c = false;
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) if ((r[i + 1] > z) !== (r[j + 1] > z) && x < ((r[j] - r[i]) * (z - r[i + 1])) / (r[j + 1] - r[i + 1]) + r[i]) c = !c;
    return c;
  };
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < b.ring.length; i += 2) { x0 = Math.min(x0, b.ring[i]); x1 = Math.max(x1, b.ring[i]); z0 = Math.min(z0, b.ring[i + 1]); z1 = Math.max(z1, b.ring[i + 1]); }
  const step = Math.max(GAP_MIN_STEP, Math.max(x1 - x0, z1 - z0) / GAP_GRID);
  for (let x = x0 + step / 2; x < x1; x += step) {
    for (let z = z0 + step / 2; z < z1; z += step) {
      if (inRing(b.ring, x, z) && !(b.holes || []).some((h) => inRing(h, x, z)) && read(x, z) === null) return true;
    }
  }
  return false;
}

/** The roof over the wall at (x, z), looked for a little way in from the wall (`nx`, `nz` its outward normal). */
function roofAboveWall(read, x, z, nx, nz) {
  for (const inset of [0.15, 0.5, 1.0, 2.0]) {
    const y = read(x - nx * inset, z - nz * inset);
    if (y !== null) return y;
  }
  return null;
}

/**
 * Closes the shell between the walls and a roofer roof: for each cleaned edge, wall above its eave (and above what the roofer's own wall
 * pieces reach) up to the roof read over it, where a gap would leave the facade open. Returns [{ edge, tri }] as lod2WallPieces does.
 */
function lod2ClosingWalls(lod, pieces, triangles) {
  const read = roofReader(triangles);
  const byEdge = new Map();
  for (const { edge, tri } of pieces) {
    if (edge < 0) continue;
    if (!byEdge.has(edge)) byEdge.set(edge, []);
    byEdge.get(edge).push(tri);
  }
  const out = [];
  lod.cleaned.forEach(([x0, z0, x1, z1], edge) => {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 0.05) return;
    const nx = -dz / len, nz = dx / len;
    const own = byEdge.get(edge) || [];
    const reach = (s) => { // the highest the wall stands at s metres along the edge
      let y = lod.tops[edge];
      for (const tri of own) {
        const u = tri.map((q) => ((q[0] - x0) * dx + (q[2] - z0) * dz) / len);
        for (let k = 0; k < 3; k++) {
          const m = (k + 1) % 3;
          const lo = Math.min(u[k], u[m]), hi = Math.max(u[k], u[m]);
          if (s < lo - 1e-3 || s > hi + 1e-3) continue;
          const f = hi - lo < 1e-6 ? 0 : (s - u[k]) / (u[m] - u[k]);
          y = Math.max(y, tri[k][1] + (tri[m][1] - tri[k][1]) * f);
        }
      }
      return y;
    };
    const n = Math.max(1, Math.ceil(len / CLOSE_STEP));
    const st = [];
    for (let k = 0; k <= n; k++) {
      const s = Math.min(len - 0.02, Math.max(0.02, len * k / n));
      const x = x0 + dx / len * s, z = z0 + dz / len * s;
      const roof = roofAboveWall(read, x, z, nx, nz);
      st.push({ x, z, roof, wall: reach(s) });
    }
    // stations in line with their neighbours are dropped: a straight eave under a straight roof edge is one quad, not one per CLOSE_STEP
    const straight = (a, m, b, key) => {
      const f = (m.x - a.x) / ((b.x - a.x) || 1e-9) || (m.z - a.z) / ((b.z - a.z) || 1e-9);
      return Math.abs(a[key] + (b[key] - a[key]) * f - m[key]) < 0.02;
    };
    const kept = st.filter((m, k) => k === 0 || k === n || m.roof === null || st[k - 1].roof === null || st[k + 1].roof === null || !(straight(st[k - 1], m, st[k + 1], 'roof') && straight(st[k - 1], m, st[k + 1], 'wall')));
    for (let k = 1; k < kept.length; k++) {
      const a = kept[k - 1], b = kept[k];
      if (a.roof === null || b.roof === null) continue;
      const ga = a.roof - a.wall, gb = b.roof - b.wall;
      if (ga < CLOSE_MIN && gb < CLOSE_MIN) continue;
      // from the wall's top to the roof, counter-clockwise from outside (as the facade quads are)
      const a0 = [a.x, a.wall, a.z], b0 = [b.x, b.wall, b.z], b1 = [b.x, Math.max(b.roof, b.wall), b.z], a1 = [a.x, Math.max(a.roof, a.wall), a.z];
      if (gb >= CLOSE_MIN) out.push({ edge, tri: [a0, b0, b1] });
      if (ga >= CLOSE_MIN) out.push({ edge, tri: [a0, b1, a1] });
    }
  });
  return out;
}

const FRAGMENT_MIN_AREA = 2.0; // m2 of connected roof surface below which a piece is roofer debris
const FRAGMENT_MIN_WIDTH = 0.3; // m: area / longest extent of a small piece; thinner ones are slivers
const FRAGMENT_SLIVER_MAX_AREA = 12.0; // slivers are only dropped below this area (long thin real roofs stay)

/**
 * Roof triangles worth drawing as [[x, y, z] x3] indices into `rec.idx` order: roofer meshes carry small disconnected
 * fragments and thin slivers (point-cloud noise: chimneys, antennas, cars at the edge) that show up as spikes near streets.
 * Triangles are grouped into connected pieces (vertices welded at 1 cm); a piece is dropped when its area is under
 * `minArea`, or when it is a thin sliver (area / longest extent under `minWidth`, area under `sliverMaxArea`). The largest
 * piece is always kept, so a roof never vanishes. Returns { keep: Uint8Array per triangle (1 = keep), pieces, dropped }.
 */
function roofFragmentMask(rec, { minArea = FRAGMENT_MIN_AREA, minWidth = FRAGMENT_MIN_WIDTH, sliverMaxArea = FRAGMENT_SLIVER_MAX_AREA } = {}) {
  const tris = [];
  for (let t = 0; t < rec.nT; t++) if (rec.kind[t] === ROOF) tris.push(t);
  const weld = new Map();
  const vid = (v) => {
    const key = `${Math.round(rec.pos[3 * v] * 100)},${Math.round(rec.pos[3 * v + 1] * 100)},${Math.round(rec.pos[3 * v + 2] * 100)}`;
    if (!weld.has(key)) weld.set(key, weld.size);
    return weld.get(key);
  };
  const parent = [];
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const ids = tris.map((t) => [0, 1, 2].map((k) => vid(rec.idx[3 * t + k])));
  for (let i = 0; i < weld.size; i++) parent.push(i);
  for (const [a, b, c] of ids) { parent[find(a)] = find(b); parent[find(b)] = find(c); }
  const pieces = new Map();
  tris.forEach((t, i) => {
    const root = find(ids[i][0]);
    const v = [0, 1, 2].map((k) => rec.idx[3 * t + k]);
    const P = v.map((q) => [rec.pos[3 * q], rec.pos[3 * q + 1], rec.pos[3 * q + 2]]);
    const area = triArea2(P) / 2;
    let piece = pieces.get(root);
    if (!piece) { piece = { area: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], tris: [] }; pieces.set(root, piece); }
    piece.area += area;
    piece.tris.push(t);
    for (const p of P) for (let k = 0; k < 3; k++) { piece.min[k] = Math.min(piece.min[k], p[k]); piece.max[k] = Math.max(piece.max[k], p[k]); }
  });
  const keep = new Uint8Array(rec.nT);
  let biggest = null;
  for (const piece of pieces.values()) if (!biggest || piece.area > biggest.area) biggest = piece;
  let dropped = 0;
  for (const piece of pieces.values()) {
    const extent = Math.max(Math.hypot(piece.max[0] - piece.min[0], piece.max[2] - piece.min[2]), 1e-6);
    const sliver = piece.area < sliverMaxArea && piece.area / extent < minWidth;
    const drop = piece !== biggest && (piece.area < minArea || sliver);
    if (drop) { dropped += piece.tris.length; continue; }
    for (const t of piece.tris) keep[t] = 1;
  }
  return { keep, pieces: pieces.size, dropped };
}

/** Roof triangles as [[x, y, z] x3] (counter-clockwise from above) from the record, fragments filtered (`filter: false` keeps all). */
function lod2RoofTriangles(rec, { filter = true } = {}) {
  const mask = filter ? roofFragmentMask(rec).keep : null;
  const out = [];
  for (let t = 0; t < rec.nT; t++) {
    if (rec.kind[t] !== ROOF || (mask && !mask[t])) continue;
    out.push([0, 1, 2].map((k) => { const v = rec.idx[3 * t + k]; return [rec.pos[3 * v], rec.pos[3 * v + 1], rec.pos[3 * v + 2]]; }));
  }
  return out;
}

/**
 * The height of a building's LoD2 roof under a point: `sampler(id, x, z)` -> the highest roof triangle over (x, z), or null (no
 * parsed record for the id, or the point is not under its roof). `getRecord(id)` returns a parsed record or null (js/tile-store.js
 * createTileLod2 `get`); each record's roof triangles are flattened once, with their bounds, and kept while the record lives.
 */
function roofHeightSampler(getRecord) {
  const cache = new WeakMap();
  const trianglesOf = (rec) => {
    let t = cache.get(rec);
    if (!t) {
      const tris = lod2RoofTriangles(rec);
      t = new Float64Array(tris.length * 9);
      tris.forEach((tri, i) => tri.forEach((p, k) => t.set(p, i * 9 + k * 3)));
      cache.set(rec, t);
    }
    return t;
  };
  const sampler = (id, x, z) => {
    const rec = getRecord(id);
    if (!rec) return null;
    const t = trianglesOf(rec);
    let best = null;
    for (let i = 0; i < t.length; i += 9) {
      const ax = t[i], ay = t[i + 1], az = t[i + 2], bx = t[i + 3], by = t[i + 4], bz = t[i + 5], cx = t[i + 6], cy = t[i + 7], cz = t[i + 8];
      if (x < Math.min(ax, bx, cx) || x > Math.max(ax, bx, cx) || z < Math.min(az, bz, cz) || z > Math.max(az, bz, cz)) continue;
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-12) continue; // a vertical (or degenerate) triangle has no height over a point
      const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) continue;
      const y = u * ay + v * by + (1 - u - v) * cy;
      if (best === null || y > best) best = y;
    }
    return best;
  };
  /** True when the building has a parsed LoD2 record (its roof is what `sampler` measures). */
  sampler.has = (id) => !!getRecord(id);
  return sampler;
}

/** Keeps the part of a triangle at or above y = yMin; returns 0 to 2 triangles (the clip polygon fanned). */
function clipAbove(tri, yMin) {
  const poly = [];
  for (let i = 0; i < 3; i++) {
    const a = tri[i];
    const b = tri[(i + 1) % 3];
    const ain = a[1] >= yMin;
    const bin = b[1] >= yMin;
    if (ain) poly.push(a);
    if (ain !== bin) {
      const t = (yMin - a[1]) / (b[1] - a[1]);
      poly.push([a[0] + (b[0] - a[0]) * t, yMin, a[2] + (b[2] - a[2]) * t]);
    }
  }
  const out = [];
  for (let i = 1; i < poly.length - 1; i++) out.push([poly[0], poly[i], poly[i + 1]]);
  return out;
}

function triArea2(t) {
  const ux = t[1][0] - t[0][0], uy = t[1][1] - t[0][1], uz = t[1][2] - t[0][2];
  const vx = t[2][0] - t[0][0], vy = t[2][1] - t[0][1], vz = t[2][2] - t[0][2];
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

/**
 * Roofer wall triangles worth drawing on top of the extruded walls: outer-wall triangles clipped to above the cleaned
 * edge's top (snapped onto that edge's line), and inner step walls whole. Each is { edge, tri } with `edge` the flat
 * cleaned-edge index or -1.
 */
function lod2WallPieces(rec, lod) {
  const out = [];
  for (let t = 0; t < rec.nT; t++) {
    if (rec.kind[t] !== WALL) continue;
    const tri = [0, 1, 2].map((k) => { const v = rec.idx[3 * t + k]; return [rec.pos[3 * v], rec.pos[3 * v + 1], rec.pos[3 * v + 2]]; });
    const raw = rec.edge[t];
    if (raw < 0) {
      if (triArea2(tri) > 1e-4) out.push({ edge: -1, tri });
      continue;
    }
    const ci = lod.rawToClean[raw] ?? -1;
    if (ci < 0) continue;
    const [x0, z0, x1, z1] = lod.cleaned[ci];
    const dx = x1 - x0;
    const dz = z1 - z0;
    const l2 = dx * dx + dz * dz || 1;
    for (const piece of clipAbove(tri, lod.tops[ci] - 1e-4)) {
      const snapped = piece.map(([x, y, z]) => {
        const t2 = ((x - x0) * dx + (z - z0) * dz) / l2;
        return [x0 + dx * t2, y, z0 + dz * t2];
      });
      if (triArea2(snapped) > 1e-4) out.push({ edge: ci, tri: snapped });
    }
  }
  return out;
}

export { LOD2_NO_TOP, ROOF, WALL, MIN_ROOF_COVER, parseLod2Record, loadLod2, rawEdges, lod2EdgeTops, lod2RoofTriangles, roofHeightSampler, roofFragmentMask, lod2WallPieces, lod2ClosingWalls, lod2RoofCover, lod2RoofHasGaps, lod2Usable, clipAbove };
