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
    // the bridge decks that stand clear of the ground: the road surfaces under and on them are left to the deck (js/structures.js)
    decks: (decks || []).filter((d) => d.clear > DECK_CLEAR).map((d) => ({ id: d.id, ring: d.ring, holes: d.holes, axes: d.axes }))
  };
}

const DECK_CLEAR = 0.4; // m: a road surface triangle where a deck stands this far over the ground is the deck's
const SKIRT_REACH = 3.0; // m round a steep triangle that a deck is looked for

/**
 * Hand the road surfaces over to the decks (in place): a triangle under a deck that stands clear of the terrain there (a road passing under
 * a bridge, a bridge the terrain does not carry) is dropped, the deck is drawn instead; where the terrain carries a bridge (the fjord
 * bridges: the surfaces lie on the deck), only the steep triangles go, the kerb skirts that would hang from the deck to the water.
 */
function clipToDecks(meshes, decks, terrain) {
  if (!decks?.length) return 0;
  const field = createDeckField();
  field.add('job', decks);
  const ground = (x, z) => (terrain ? terrain.heightAt(x, z) : 0);
  // a deck that stands over what the build found under it (the water under a fjord bridge)
  const overGround = (x, z) => {
    const info = field.deckInfo(x, z);
    if (!info) return false;
    const under = deckGround(info.deck, x, z);
    return under !== null && info.y - under > DECK_CLEAR;
  };
  const raised = (x, z, ny) => {
    const info = field.deckInfo(x, z);
    if (info && info.y - ground(x, z) > DECK_CLEAR) return true;
    if (Math.abs(ny) >= 0.6) return false;
    // a steep triangle (a kerb skirt) on or along such a deck: the register's surfaces reach a few metres past the bridge outline
    return overGround(x, z) || overGround(x + SKIRT_REACH, z) || overGround(x - SKIRT_REACH, z) || overGround(x, z + SKIRT_REACH) || overGround(x, z - SKIRT_REACH);
  };
  const normalY = (p, a, b, c) => {
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    return ny / (Math.hypot(nx, ny, nz) || 1);
  };
  let dropped = 0;
  for (const m of meshes) {
    const pos = m.position;
    if (m.index) {
      const keep = [];
      for (let t = 0; t < m.index.length; t += 3) {
        const a = m.index[t] * 3, b = m.index[t + 1] * 3, c = m.index[t + 2] * 3;
        if (raised((pos[a] + pos[b] + pos[c]) / 3, (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3, normalY(pos, a, b, c))) { dropped++; continue; }
        keep.push(m.index[t], m.index[t + 1], m.index[t + 2]);
      }
      if (keep.length !== m.index.length) m.index = new Uint32Array(keep);
    } else {
      // non-indexed (the ground-surface meshes): drop whole triangles from every per-vertex attribute
      const n = pos.length / 9;
      const keepTri = [];
      for (let t = 0; t < n; t++) {
        const o = t * 9;
        if (raised((pos[o] + pos[o + 3] + pos[o + 6]) / 3, (pos[o + 2] + pos[o + 5] + pos[o + 8]) / 3, normalY(pos, o, o + 3, o + 6))) dropped++;
        else keepTri.push(t);
      }
      if (keepTri.length !== n) {
        for (const key of Object.keys(m)) {
          const arr = m[key];
          if (!ArrayBuffer.isView(arr) || arr.length % (n * 3) !== 0 || arr.length === 0) continue;
          const per = arr.length / (n * 3); // components per vertex
          const out = new arr.constructor(keepTri.length * 3 * per);
          keepTri.forEach((t, k) => out.set(arr.subarray(t * 3 * per, (t + 1) * 3 * per), k * 3 * per));
          m[key] = out;
        }
      }
    }
  }
  return dropped;
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
  clipToDecks(meshes, job.decks, terrain);
  let heightGrid = null;
  if (near && bounds) {
    const grid = buildGroundHeightGrid(geo, surfaces, [bounds[0] - HEIGHT_MARGIN, bounds[1] - HEIGHT_MARGIN, bounds[2] + HEIGHT_MARGIN, bounds[3] + HEIGHT_MARGIN]);
    if (grid) heightGrid = { bbox: grid.bbox, cell: grid.cell, data: grid.data };
  }
  return { meshes, heightGrid };
}
