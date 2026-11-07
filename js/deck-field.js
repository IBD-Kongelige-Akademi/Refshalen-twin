// js/deck-field.js
// Bridge decks as a height field (pure, no three.js: the road worker and the tests use it too). The decks come from the `structures` tile
// layer (tools/geodata/city_structures.py): an outline (ring + holes, x east, z south) and the ways it carries, each a centreline with the
// deck top every 2 m (`axes[].pts` flat [x, z, deck y, ground y, ...]). A deck is listed whole by every tile it touches; the field keeps one copy per id
// while any of those tiles is resident.
//
// deckAt(x, z)          the deck top over (x, z), or null off every deck (the nearest point of the deck's axes, interpolated)
// withDecks(field, g)   a ground model (heightAt / terrainAt) that stands on the decks: what static things drape on and the agents walk
// levelAt(x, z, y)      the ground for something now at height y: the deck when it is at or above the deck's level (DECK_REACH under
//                       it at most), else the ground under the deck, so what drives onto a bridge stays on it and what passes under
//                       stays under; a deck marked `solid` (an override's terrace, walled to the ground) carries whatever is inside its outline

export const DECK_REACH = 0.8; // m: something this far under a deck top (or higher) is on the deck: a deck end is tied to its road
const CELL = 32;
const EDGE_PROBES = [[2.5, 0], [-2.5, 0], [0, 2.5], [0, -2.5], [1.8, 1.8], [-1.8, 1.8], [1.8, -1.8], [-1.8, -1.8]]; // m round a point just off a deck
const LEVEL_STEP = 2; // m between the points levelAlong walks through

export function pointInRings(x, z, ring, holes = []) {
  let inside = false;
  for (const r of [ring, ...holes]) {
    for (let i = 0, k = r.length - 2; i < r.length; k = i, i += 2) {
      const zi = r[i + 1];
      const zk = r[k + 1];
      if ((zi > z) !== (zk > z) && x < r[i] + ((z - zi) / (zk - zi)) * (r[k] - r[i])) inside = !inside;
    }
  }
  return inside;
}

/** The deck top of deck d at (x, z): the height of the nearest point of its axes (`pts` flat [x, z, deck y, ground y, ...]). */
export function deckHeight(d, x, z) {
  let best = Infinity;
  let y = null;
  for (const a of d.axes || []) {
    const p = a.pts;
    if (p.length === 4) {
      const dd = (p[0] - x) ** 2 + (p[1] - z) ** 2;
      if (dd < best) { best = dd; y = p[2]; }
      continue;
    }
    for (let i = 4; i < p.length; i += 4) {
      const ax = p[i - 4], az = p[i - 3], ay = p[i - 2], bx = p[i], bz = p[i + 1], by = p[i + 2];
      const dx = bx - ax, dz = bz - az;
      const l2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      const ex = ax + dx * t - x, ez = az + dz * t - z;
      const dd = ex * ex + ez * ez;
      if (dd < best) { best = dd; y = ay + (by - ay) * t; }
    }
  }
  return y;
}

/** The ground under deck d at (x, z) (what the build found there: the terrain, or the water under a bridge over it), from its axes. */
export function deckGround(d, x, z) {
  let best = Infinity;
  let g = null;
  for (const a of d.axes || []) {
    const p = a.pts;
    for (let i = 0; i < p.length; i += 4) {
      const dd = (p[i] - x) ** 2 + (p[i + 1] - z) ** 2;
      if (dd < best) { best = dd; g = p[i + 3]; }
    }
  }
  return g;
}

const LEVEL_REACH = 5; // m: ways this much further off than the nearest may be the one something at a known height is on

/** The deck top of d at (x, z) for something at height y: of the ways nearby, the one closest to y (a ramp beside the flat deck stays the ramp). */
export function deckHeightNear(d, x, z, y) {
  let bestAll = Infinity;
  const found = [];
  for (const a of d.axes || []) {
    const p = a.pts;
    let best = Infinity, h = null;
    for (let i = 4; i < p.length; i += 4) {
      const ax = p[i - 4], az = p[i - 3], dx = p[i] - ax, dz = p[i + 1] - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1e-9)));
      const dd = (ax + dx * t - x) ** 2 + (az + dz * t - z) ** 2;
      if (dd < best) { best = dd; h = p[i - 2] + (p[i + 2] - p[i - 2]) * t; }
    }
    if (h === null) continue;
    best = Math.sqrt(best);
    bestAll = Math.min(bestAll, best);
    found.push([best, h]);
  }
  let out = null;
  for (const [dist, h] of found) if (dist <= bestAll + LEVEL_REACH && (out === null || Math.abs(h - y) < Math.abs(out - y))) out = h;
  return out;
}

export function createDeckField() {
  const decks = new Map(); // id -> { deck, tiles: Set, cells: [] }
  const grid = new Map(); // cell key -> Set of ids
  const byTile = new Map(); // tile id -> [deck ids]
  const key = (i, j) => `${i},${j}`;

  function bounds(d) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < d.ring.length; i += 2) {
      x0 = Math.min(x0, d.ring[i]); x1 = Math.max(x1, d.ring[i]);
      z0 = Math.min(z0, d.ring[i + 1]); z1 = Math.max(z1, d.ring[i + 1]);
    }
    return [x0, z0, x1, z1];
  }

  function add(tile, list) {
    remove(tile);
    const ids = [];
    for (const d of list || []) {
      if (!d?.ring || d.ring.length < 6) continue;
      ids.push(d.id);
      let rec = decks.get(d.id);
      if (!rec) {
        const [x0, z0, x1, z1] = bounds(d);
        rec = { deck: d, tiles: new Set(), cells: [], bbox: [x0, z0, x1, z1] };
        for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) {
          for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
            const k = key(i, j);
            if (!grid.has(k)) grid.set(k, new Set());
            grid.get(k).add(d.id);
            rec.cells.push(k);
          }
        }
        decks.set(d.id, rec);
      }
      rec.tiles.add(tile);
    }
    byTile.set(tile, ids);
    return ids;
  }

  function remove(tile) {
    const ids = byTile.get(tile);
    if (!ids) return [];
    byTile.delete(tile);
    const gone = [];
    for (const id of ids) {
      const rec = decks.get(id);
      if (!rec) continue;
      rec.tiles.delete(tile);
      if (rec.tiles.size) continue;
      for (const k of rec.cells) {
        const s = grid.get(k);
        s?.delete(id);
        if (s && !s.size) grid.delete(k);
      }
      decks.delete(id);
      gone.push(id);
    }
    return gone;
  }

  /** The deck under / over (x, z): { y, deck } or null. */
  function deckInfo(x, z) {
    const s = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!s) return null;
    for (const id of s) {
      const rec = decks.get(id);
      const b = rec.bbox;
      if (x < b[0] || x > b[2] || z < b[1] || z > b[3]) continue;
      if (!pointInRings(x, z, rec.deck.ring, rec.deck.holes)) continue;
      const y = deckHeight(rec.deck, x, z);
      if (y !== null) return { y, deck: rec.deck };
    }
    return null;
  }

  /** The deck top over (x, z) for something at height y (deckHeightNear), or null off every deck. */
  function deckAtLevel(x, z, y) {
    const s = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!s) return null;
    let out = null;
    for (const id of s) {
      const rec = decks.get(id);
      const b = rec.bbox;
      if (x < b[0] || x > b[2] || z < b[1] || z > b[3] || !pointInRings(x, z, rec.deck.ring, rec.deck.holes)) continue;
      const h = deckHeightNear(rec.deck, x, z, y);
      if (h !== null && (out === null || Math.abs(h - y) < Math.abs(out - y))) out = h;
    }
    return out;
  }

  return {
    add,
    remove,
    deckInfo,
    deckAtLevel,
    deckAt: (x, z) => deckInfo(x, z)?.y ?? null,
    has: (id) => decks.has(id),
    get size() { return decks.size; },
    decks: () => [...decks.values()].map((r) => r.deck)
  };
}

/**
 * A ground model on the decks. `ground` is { heightAt, terrainAt?, ... } (js/ground-height.js); the result keeps its other members.
 * heightAt / terrainAt stand on a deck wherever one is over the ground (a deck sunk under the ground, as the DSM can put a bridge end,
 * loses to the ground); levelAt(x, z, y) chooses between the deck and the ground under it for something at height y.
 */
export function withDecks(field, ground) {
  if (!ground) return ground;
  const terrain = (x, z) => (ground.terrainAt ? ground.terrainAt(x, z) : ground.heightAt(x, z));
  const onDeck = (base, x, z) => {
    const d = field.deckAt(x, z);
    return d !== null && d > base ? d : base;
  };
  return {
    ...ground,
    deckAt: field.deckAt,
    baseHeightAt: (x, z) => ground.heightAt(x, z),
    baseTerrainAt: terrain,
    heightAt: (x, z) => onDeck(ground.heightAt(x, z), x, z),
    terrainAt: (x, z) => onDeck(terrain(x, z), x, z),
    levelAt(x, z, y, walk = false) {
      const base = walk ? ground.heightAt(x, z) : terrain(x, z);
      const d = Number.isFinite(y) && field.deckAtLevel ? field.deckAtLevel(x, z, y) : field.deckAt(x, z);
      if (d === null && Number.isFinite(y) && y - base > DECK_REACH && field.deckAtLevel) {
        // on a deck and just past its edge (a lane wider than the outline): still on it, not down in what the deck spans
        for (const [ox, oz] of EDGE_PROBES) {
          const near = field.deckAtLevel(x + ox, z + oz, y);
          if (near !== null && Math.abs(near - y) < DECK_REACH) return near;
        }
      }
      if (d === null || d <= base) return base;
      if (!Number.isFinite(y) || y >= d - DECK_REACH) return d;
      // a solid deck (a terrace on its walls) has no underneath: what finds itself below it, as its tile came in late, stands on it
      return field.deckInfo?.(x, z)?.deck.solid ? d : base;
    },
    /**
     * The level at distance s along a straight way (x0, z0) + (ux, uz) * s of length len, for something placed there: walked out from an
     * end of the way that is off the decks, so a car or person placed on a road under a bridge is under it, one on the bridge on it.
     */
    levelAlong(x0, z0, ux, uz, len, s, walk = false) {
      const at = (d) => [x0 + ux * d, z0 + uz * d];
      // from the point of the way nearest to s that is off the decks: its ends first, as a way usually leaves a deck there
      let from = field.deckAt(...at(0)) === null ? 0 : field.deckAt(...at(len)) === null ? len : null;
      if (from !== null || len > LEVEL_STEP) {
        let best = from === null ? Infinity : Math.abs(s - from);
        for (let d = LEVEL_STEP; d < len; d += LEVEL_STEP) {
          if (Math.abs(s - d) < best && field.deckAt(...at(d)) === null) { from = d; best = Math.abs(s - d); }
        }
      }
      if (from === null) return this.levelAt(...at(s), NaN, walk);
      let y = this.levelAt(...at(from), NaN, walk);
      const dist = Math.abs(s - from), step = Math.sign(s - from) * LEVEL_STEP;
      for (let i = 1; i * LEVEL_STEP < dist; i++) y = this.levelAt(...at(from + step * i), y, walk);
      return this.levelAt(...at(s), y, walk);
    }
  };
}
