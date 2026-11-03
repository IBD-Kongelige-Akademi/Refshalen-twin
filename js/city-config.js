// js/city-config.js
// Aalborg spatial configuration: the local frame, the playable bounds and the teleport presets the engine core
// (controllers, cameras, materials, gamepad) relies on. The frame follows docs/cph-geodata-schema.md and mirrors
// tools/geodata/frame.py (keep the two in step).
//
// Local frame: 1 unit = 1 m, x = east, z = south (north = -z), y up. Source CRS EPSG:25832, vertical DVR90.
//   x = E - origin[0];  z = -(N - origin[1]);  y = DVR90 - origin[2]

import { ORIGIN_E, ORIGIN_N, ORIGIN_H } from './tile-grid.js';

export const CPH_FRAME = Object.freeze({
  epsg: 25832,
  vertical: 'DVR90',
  origin: Object.freeze([ORIGIN_E, ORIGIN_N, ORIGIN_H]), // by Gammel Torv (js/tile-grid.js)
  axes: 'x=east, z=south, y=up',
  bbox: Object.freeze([-1000, -900, 1000, 1100]) // [minX, minZ, maxX, maxZ]: E 555000-557000, N 6322000-6324000
});

const [BX0, BZ0, BX1, BZ1] = CPH_FRAME.bbox;

/** EPSG:25832 (E, N, DVR90 height) to the local frame. */
export function toLocal(e, n, h = CPH_FRAME.origin[2]) {
  return { x: e - CPH_FRAME.origin[0], y: h - CPH_FRAME.origin[2], z: -(n - CPH_FRAME.origin[1]) };
}

/** Local frame to EPSG:25832 (E, N, DVR90 height). */
export function toEtrs(x, z, y = 0) {
  return { e: x + CPH_FRAME.origin[0], n: CPH_FRAME.origin[1] - z, h: y + CPH_FRAME.origin[2] };
}

// The playable area. Players may roam a margin beyond it (controllers.js clamps to these bounds). It starts as the
// district frame and is replaced by the extent of the tile index (setCityBounds, called by world.js) so the clamp
// follows the data: the object is mutated in place, every importer sees the new values.
const ISLAND_BOUNDS = { minX: BX0, maxX: BX1, minZ: BZ0, maxZ: BZ1, sidewalkHeight: 0.15, waterLevel: -2.2 };
const getIslandBoundsAtZ = () => ({ westX: ISLAND_BOUNDS.minX, eastX: ISLAND_BOUNDS.maxX });

const checkBbox = (bbox) => {
  const [x0, z0, x1, z1] = bbox;
  if (![x0, z0, x1, z1].every(Number.isFinite) || x1 <= x0 || z1 <= z0) throw new Error(`bad bounds ${bbox}`);
  return [x0, z0, x1, z1];
};

// The extent of the COMPILED data (tile index `frame.bbox`; the district frame until a tile index says otherwise). Water, the
// ground field, placement zones and the lawn mask are rasters / outlines over it, and a lake that reaches its edge is continued
// beyond it, so they take it from here instead of hardcoding the district.
let dataBbox = [...CPH_FRAME.bbox];
export const getDataBbox = () => dataBbox;

/**
 * Sets the playable / loaded extent [minX, minZ, maxX, maxZ] in the local frame (the union of the tile index), and optionally
 * the extent of the compiled data (`frame`).
 */
export function setCityBounds(bbox, { frame = null } = {}) {
  const [x0, z0, x1, z1] = checkBbox(bbox);
  Object.assign(ISLAND_BOUNDS, { minX: x0, minZ: z0, maxX: x1, maxZ: z1 });
  if (frame) dataBbox = checkBbox(frame);
  return ISLAND_BOUNDS;
}

/** The current playable / loaded extent as [minX, minZ, maxX, maxZ]. */
export const getCityBounds = () => [ISLAND_BOUNDS.minX, ISLAND_BOUNDS.minZ, ISLAND_BOUNDS.maxX, ISLAND_BOUNDS.maxZ];

// Teleport presets (local frame; forward is (sin h, cos h), so heading PI faces north towards the Limfjord). Positions are
// converted from approximate map positions: snap them to the road graph centrelines once phase 2 has built the streets.
// The scenic cameras (cameras.js) frame the same places.
const TELEPORT_LOCATIONS = {
  torv: { name: 'Gammel Torv', sub: 'Old town · start', x: -77, z: -73, heading: Math.PI },
  budolfi: { name: 'Budolfi Domkirke', sub: 'Old town · the cathedral', x: -234, z: -49, heading: Math.PI },
  jomfru: { name: 'Jomfru Ane Gade', sub: 'Old town · nightlife street', x: -157, z: -161, heading: Math.PI },
  aalborghus: { name: 'Aalborghus', sub: 'Harbour front · the castle', x: -25, z: -263, heading: Math.PI },
  limfjord: { name: 'Limfjordsbroen', sub: 'Harbour front · the bridge', x: 52, z: -398, heading: Math.PI },
  utzon: { name: 'Utzon Center', sub: 'Harbour front · Limfjord', x: 266, z: -345, heading: Math.PI }
};

function isTypingInField(event) {
  const target = event?.target;
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!target.isContentEditable;
}

export {
  ISLAND_BOUNDS,
  getIslandBoundsAtZ,
  TELEPORT_LOCATIONS,
  isTypingInField
};
