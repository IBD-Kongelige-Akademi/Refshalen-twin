// js/walk-limits.js
// Where pedestrians may not walk, per streamed tile: the carriageways (roadAt), and the water and the railway (hazardAt: the tracks' corridor
// and the OSM landuse=railway areas). A bridge deck is exempt: what is on it is over the water, the road or the tracks, not in them.
// js/pedestrian-routes.js lays its walking lines and corners by these; the crosswalks at the intersections are the only way over a road.
// parkPaths(): the footways that run mostly through the green ground, which pedestrians walk as well.

import { createCarriagewayIndex, createSegmentIndex } from './road-surfaces.js';
import { pointInRings } from './deck-field.js';

const RAIL_CORRIDOR = 2.5; // m either side of a track's centreline
const PATH_GREEN_SHARE = 0.5; // a footway with this share of its length in the green ground is a park path
const PATH_SAMPLE = 5; // m between the samples of that share

function polyOf(ring, holes = []) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]);
    z0 = Math.min(z0, ring[i + 1]); z1 = Math.max(z1, ring[i + 1]);
  }
  return { ring, holes, x0, z0, x1, z1 };
}

const inPoly = (p, x, z) => x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1 && pointInRings(x, z, p.ring, p.holes);

export function createWalkLimits({ deckAt = null } = {}) {
  const tiles = new Map(); // tag -> { roads, rails, polys }
  const onDeck = (x, z) => !!deckAt && deckAt(x, z) !== null;

  /**
   * `roads` the road records around the tile, `rails` its tracks (pts flat [x, z, y, ...]), `railAreas` flat rings, `water` its water
   * bodies, `footways` the footway records the tile owns, `green` its green polygons ({ ring, holes }).
   */
  function add(tag, { roads = [], rails = [], railAreas = [], water = [], footways = [], green = [] } = {}) {
    const railIndex = createSegmentIndex();
    for (const r of rails) {
      const line = [];
      for (let i = 0; i < r.pts.length; i += 3) line.push(r.pts[i], r.pts[i + 1]);
      railIndex.addPolyline(line, RAIL_CORRIDOR);
    }
    const polys = railAreas.filter((r) => r?.length >= 6).map((r) => polyOf(r));
    for (const b of water) for (const p of b.polys || []) if (p.ring?.length >= 6) polys.push(polyOf(p.ring, p.holes || []));
    tiles.set(tag, { roads: createCarriagewayIndex(roads), rails: railIndex, polys, footways, green: green.filter((g) => g.ring?.length >= 6).map((g) => polyOf(g.ring, g.holes || [])) });
  }

  const inGreen = (x, z) => {
    for (const t of tiles.values()) if (t.green.some((p) => inPoly(p, x, z))) return true;
    return false;
  };

  /** The resident footways that run mostly through the green ground: [{ id, pts }]. */
  function parkPaths() {
    const out = [];
    const seen = new Set();
    for (const t of tiles.values()) {
      for (const r of t.footways) {
        if (seen.has(r.id) || !r.pts || r.pts.length < 4) continue;
        seen.add(r.id);
        let inside = 0, all = 0;
        for (let i = 2; i < r.pts.length; i += 2) {
          const ax = r.pts[i - 2], az = r.pts[i - 1], bx = r.pts[i], bz = r.pts[i + 1];
          const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / PATH_SAMPLE));
          for (let k = 0; k < n; k++, all++) if (inGreen(ax + (bx - ax) * (k + 0.5) / n, az + (bz - az) * (k + 0.5) / n)) inside++;
        }
        if (all && inside / all >= PATH_GREEN_SHARE) out.push({ id: r.id, pts: r.pts });
      }
    }
    return out;
  }

  /** The road record whose carriageway (x, z) lies on, or null. */
  function roadAt(x, z) {
    let found = null;
    for (const t of tiles.values()) {
      const r = t.roads.at(x, z);
      if (r.depth > 0.02) { found = r.road; break; }
    }
    return found && !onDeck(x, z) ? found : null;
  }

  /** Is (x, z) in the water or on the railway? */
  function hazardAt(x, z) {
    for (const t of tiles.values()) {
      if (t.rails.near(x, z) || t.polys.some((p) => inPoly(p, x, z))) return !onDeck(x, z);
    }
    return false;
  }

  return { add, remove: (tag) => tiles.delete(tag), has: (tag) => tiles.has(tag), roadAt, hazardAt, parkPaths };
}
