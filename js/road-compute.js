// js/road-compute.js
// The CPU half of a streamed tile's road surfaces (js/road-surfaces.js createRoadSurfaceLayer): the carriageway, kerb, cycle,
// paint, pavement and register-ground meshes as typed arrays, and the 0.5 m ground-height grid. Pure: runs in a Web Worker
// (js/tile-worker.js) or on the main thread. The job carries what the build reads (the roads, pavements and cycle tracks of the tile
// and its neighbours, the footprints, the surface register, the terrain chunks around) and which items the tile owns, as indices:
// object identity does not survive the trip to a worker (js/tile-own.js `own` sets).

import { computeSurfaceMeshes, buildGroundHeightGrid } from './road-surfaces.js';
import { createChunkSampler } from './terrain.js';
import { createDeckField, deckGround } from './deck-field.js';

const HEIGHT_MARGIN = 20;
const DROP = new Set(['src', 'ptsSurvey', 'conf_fields', 'conf']);
const slimRecord = (o) => {
  const out = {};
  for (const k of Object.keys(o)) if (!DROP.has(k)) out[k] = o[k];
  return out;
};
const indicesOf = (list, set) => {
  const out = [];
  if (set) list.forEach((it, i) => { if (set.has(it)) out.push(i); });
  return out;
};

/**
 * The job of a tile build (main thread). `ctx` = a tile context (js/tile-data.js), `terrain` = the stream terrain (chunkOf).
 */
export function makeRoadJob(ctx, { near, terrain, decks = null }) {
  const g = ctx.geo;
  const own = g.own || {};
  const sf = near ? ctx.surfaces : null;
  const chunks = [];
  if (terrain && !terrain.flat && terrain.chunkOf) for (const id of ctx.neighbours) { const c = terrain.chunkOf(id); if (c) chunks.push([id, c]); }
  return {
    near, bounds: ctx.bounds,
    geo: {
      roads: g.roads.map(slimRecord), sidewalks: g.sidewalks, cycleTracks: g.cycleTracks,
      buildings: (g.buildings || []).map((b) => ({ id: b.id, ring: b.ring, holes: b.holes }))
    },
    own: { roads: indicesOf(g.roads, own.roads), sidewalks: indicesOf(g.sidewalks, own.sidewalks), cycleTracks: indicesOf(g.cycleTracks, own.cycleTracks) },
    surfaces: sf ? { ...sf, own: undefined, surfaces: sf.surfaces, markings: sf.markings } : null,
    surfacesOwn: sf?.own ? { surfaces: indicesOf(sf.surfaces, sf.own.surfaces), markings: indicesOf(sf.markings, sf.own.markings) } : null,
    terrain: chunks.length ? { header: { width: terrain.header.width, height: terrain.header.height, cell: terrain.header.cell, bbox: terrain.header.bbox }, chunks } : null,
    // the bridge decks that stand clear of the ground: the road surfaces are sorted onto and under them (settleOnDecks)
    decks: (decks || []).filter((d) => d.clear > DECK_CLEAR).map((d) => ({ id: d.id, ring: d.ring, holes: d.holes, axes: d.axes }))
  };
}

const DECK_CLEAR = 0.4; // m: where a deck stands this far over the ground the road surfaces there are sorted onto or under it
const SKIRT_REACH = 3.0; // m round a steep triangle that a deck is looked for
const ON_DECK_LIFT = 0.06; // m: a surface lifted onto a deck lies this much over the deck's measured top (the deck top is drawn 0.03 up)
const JOIN_REACH = 1.5; // m between a road's end and a deck way's end that make it one road
const MIXED_STEP = 0.6; // m: a triangle part on a deck, part off it, that spans more height than this is dropped
const OWN_REACH = 6.0; // m past its half width that a deck's own way claims the surfaces (its pavements, kerbs and cycle lanes)

/**
 * The road centrelines a vertex is sorted by: every road, pavement line and cycle track of the job with its id and half width, and
 * a bounding box to skip the far ones.
 */
function centrelines(geo) {
  const out = [];
  for (const list of [geo.roads, geo.cycleTracks]) {
    for (const r of list || []) {
      const p = r?.pts;
      if (!r?.id || !p || p.length < 4) continue;
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); z0 = Math.min(z0, p[i + 1]); z1 = Math.max(z1, p[i + 1]); }
      out.push({ id: r.id, pts: p, half: (r.width || 3) / 2, box: [x0, z0, x1, z1] });
    }
  }
  return out;
}

function distToLine(p, x, z) {
  let best = Infinity;
  for (let i = 2; i < p.length; i += 2) {
    const ax = p[i - 2], az = p[i - 1], dx = p[i] - ax, dz = p[i + 1] - az;
    const l2 = dx * dx + dz * dz || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    best = Math.min(best, (ax + dx * t - x) ** 2 + (az + dz * t - z) ** 2);
  }
  return Math.sqrt(best);
}

/**
 * Sort the road surfaces onto and under the decks (in place). Where a deck stands clear of the ground, a vertex belongs to the way it
 * was drawn for (the mesh's `owner`, js/road-surfaces.js), else (the pavement and register ground) to the nearest way (its distance
 * past the way's half width): the deck's own ways (the bridge road, its pavements and cycle lanes, within OWN_REACH)
 * are lifted onto the deck top, keeping their height over the ground (paint over asphalt, a kerb's rise), so the bridge keeps its lane
 * markings; anything else (a road passing under, the paving round it) stays on the ground under the deck. A triangle that would join
 * the deck to the ground under it is dropped, as are the steep triangles (kerb skirts) within SKIRT_REACH of a deck over the water
 * that are not on it. Returns { lifted, dropped }.
 */
export function settleOnDecks(meshes, decks, terrain, geo = {}) {
  if (!decks?.length) return { lifted: 0, dropped: 0 };
  const field = createDeckField();
  field.add('job', decks);
  const own = new Map(decks.map((d) => [d.id, new Set((d.axes || []).map((a) => a.way))]));
  const lines = centrelines(geo);
  // a road that ends where a way of the deck ends comes onto the deck: its last metres in the footprint lie on it, not on the ground under it
  for (const d of decks) {
    const mine = own.get(d.id);
    const ends = [];
    for (const a of d.axes || []) {
      if (a.kind === 'foot' || !a.pts || a.pts.length < 8) continue;
      ends.push([a.pts[0], a.pts[1]], [a.pts[a.pts.length - 4], a.pts[a.pts.length - 3]]);
    }
    for (const l of lines) {
      const p = l.pts, n = p.length;
      for (const [x, z] of ends) {
        if (Math.hypot(p[0] - x, p[1] - z) < JOIN_REACH || Math.hypot(p[n - 2] - x, p[n - 1] - z) < JOIN_REACH) { mine.add(l.id); break; }
      }
    }
  }
  const ground = (x, z) => (terrain ? terrain.heightAt(x, z) : 0);
  const OUT = 0, ON = 1, UNDER = 2;
  /** { cls, y }: the vertex's class and, on a deck, its height there; `way` = the way the vertex was drawn for, when known */
  const sort = (x, y, z, way = null) => {
    const info = field.deckInfo(x, z);
    if (!info) return { cls: OUT, y };
    const g = ground(x, z);
    const low = info.y - g <= DECK_CLEAR; // the deck barely over the ground here: what is not the deck's stays where it is
    const mine = own.get(info.deck.id);
    // (the deck's own way always lies on it: draped on ground just under the deck it would hide under the deck's top)
    const lift = { cls: ON, y: Math.max(info.y, g) + ON_DECK_LIFT + Math.max(0, y - g) };
    if (way !== null) return mine.has(way) ? lift : low ? { cls: OUT, y } : { cls: UNDER, y };
    let best = Infinity, bestOwn = false;
    for (const l of lines) {
      const b = l.box;
      if (x < b[0] - 30 || x > b[2] + 30 || z < b[1] - 30 || z > b[3] + 30) continue;
      const d = distToLine(l.pts, x, z) - l.half;
      if (d < best - 1e-6 || (Math.abs(d - best) <= 1e-6 && mine.has(l.id))) { best = d; bestOwn = mine.has(l.id); }
    }
    // no way near (a fjord bridge's register surfaces): the deck's
    if (bestOwn ? best <= OWN_REACH : !low && best > OWN_REACH) return lift;
    if (low) return { cls: OUT, y };
    return { cls: UNDER, y };
  };
  const overWater = (x, z) => {
    const info = field.deckInfo(x, z);
    if (!info) return false;
    const under = deckGround(info.deck, x, z);
    return under !== null && info.y - under > DECK_CLEAR;
  };
  const skirt = (x, z) => overWater(x, z) || overWater(x + SKIRT_REACH, z) || overWater(x - SKIRT_REACH, z) || overWater(x, z + SKIRT_REACH) || overWater(x, z - SKIRT_REACH);
  const normalY = (p, a, b, c) => {
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    return ny / (Math.hypot(nx, ny, nz) || 1);
  };
  // a triangle (vertex offsets a, b, c into pos, classes ca, cb, cc) after the vertices are settled: keep it?
  const keepTri = (pos, a, b, c, ca, cb, cc) => {
    const on = (ca === ON) + (cb === ON) + (cc === ON);
    const under = (ca === UNDER) + (cb === UNDER) + (cc === UNDER);
    if (on && under) return false; // it would hang from the deck to the ground
    if (on && on < 3) {
      // on the deck and off it: fine at a bridge end where the deck meets the ground, a curtain where the surface runs past the outline
      const ya = pos[a + 1], yb = pos[b + 1], yc = pos[c + 1];
      if (Math.max(ya, yb, yc) - Math.min(ya, yb, yc) > MIXED_STEP) return false;
    }
    if (on || under) return true;
    if (Math.abs(normalY(pos, a, b, c)) >= 0.6) return true;
    return !skirt((pos[a] + pos[b] + pos[c]) / 3, (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3);
  };
  let lifted = 0, dropped = 0;
  for (const m of meshes) {
    const pos = m.position;
    const n = pos.length / 3;
    const cls = new Uint8Array(n);
    const owner = m.owner && m.owner.length === n ? m.owner : null;
    for (let v = 0; v < n; v++) {
      const o = v * 3;
      const s = sort(pos[o], pos[o + 1], pos[o + 2], owner && owner[v] >= 0 ? m.owners[owner[v]] : null);
      cls[v] = s.cls;
      if (s.cls === ON) { pos[o + 1] = s.y; lifted++; }
    }
    if (m.index) {
      const keep = [];
      for (let t = 0; t < m.index.length; t += 3) {
        const ia = m.index[t], ib = m.index[t + 1], ic = m.index[t + 2];
        if (!keepTri(pos, ia * 3, ib * 3, ic * 3, cls[ia], cls[ib], cls[ic])) { dropped++; continue; }
        keep.push(ia, ib, ic);
      }
      if (keep.length !== m.index.length) m.index = new Uint32Array(keep);
    } else {
      // non-indexed (the ground-surface meshes): drop whole triangles from every per-vertex attribute
      const nt = n / 3;
      const kept = [];
      for (let t = 0; t < nt; t++) {
        const o = t * 9;
        if (keepTri(pos, o, o + 3, o + 6, cls[t * 3], cls[t * 3 + 1], cls[t * 3 + 2])) kept.push(t);
        else dropped++;
      }
      if (kept.length !== nt) {
        for (const key of Object.keys(m)) {
          const arr = m[key];
          if (!ArrayBuffer.isView(arr) || arr.length % (nt * 3) !== 0 || arr.length === 0) continue;
          const per = arr.length / (nt * 3); // components per vertex
          const out = new arr.constructor(kept.length * 3 * per);
          kept.forEach((t, k) => out.set(arr.subarray(t * 3 * per, (t + 1) * 3 * per), k * 3 * per));
          m[key] = out;
        }
      }
    }
  }
  return { lifted, dropped };
}

/** @returns {{ meshes: object[], heightGrid: { bbox, cell, data }|null }} */
export function computeRoadSurfaces(job) {
  const { geo: g, surfaces: sf, own: o, surfacesOwn, near, bounds } = job;
  let terrain = null;
  if (job.terrain) {
    const sampler = createChunkSampler(job.terrain.header);
    for (const [id, c] of job.terrain.chunks) sampler.set(id, c);
    terrain = { flat: false, heightAt: sampler.heightAt };
  }
  const geo = { roads: g.roads, sidewalks: g.sidewalks, cycleTracks: g.cycleTracks, buildings: g.buildings };
  geo.own = { roads: new Set(o.roads.map((i) => g.roads[i])), sidewalks: new Set(o.sidewalks.map((i) => g.sidewalks[i])), cycleTracks: new Set(o.cycleTracks.map((i) => g.cycleTracks[i])) };
  let surfaces = null;
  if (sf) {
    surfaces = { ...sf };
    if (surfacesOwn) surfaces.own = { surfaces: new Set(surfacesOwn.surfaces.map((i) => sf.surfaces[i])), markings: new Set(surfacesOwn.markings.map((i) => sf.markings[i])) };
  }
  const meshes = computeSurfaceMeshes(geo, near ? surfaces : null, terrain, { lite: !near });
  settleOnDecks(meshes, job.decks, terrain, geo);
  for (const m of meshes) { delete m.owner; delete m.owners; } // only the sorting needs them
  let heightGrid = null;
  if (near && bounds) {
    const grid = buildGroundHeightGrid(geo, surfaces, [bounds[0] - HEIGHT_MARGIN, bounds[1] - HEIGHT_MARGIN, bounds[2] + HEIGHT_MARGIN, bounds[3] + HEIGHT_MARGIN]);
    if (grid) heightGrid = { bbox: grid.bbox, cell: grid.cell, data: grid.data };
  }
  return { meshes, heightGrid };
}
