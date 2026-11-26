// js/city-config.js
// Refshaleøen spatial configuration: the local frame, the playable bounds and the teleport presets the engine core
// (controllers, cameras, materials, gamepad) relies on. The frame follows docs/cph-geodata-schema.md and mirrors
// tools/geodata/frame.py (keep the two in step).
//
// Local frame: 1 unit = 1 m, x = east, z = south (north = -z), y up. Source CRS EPSG:25832, vertical DVR90.
//   x = E - origin[0];  z = -(N - origin[1]);  y = DVR90 - origin[2]

import { ORIGIN_E, ORIGIN_N, ORIGIN_H } from './tile-grid.js';

export const CPH_FRAME = Object.freeze({
  epsg: 25832,
  vertical: 'DVR90',
  origin: Object.freeze([ORIGIN_E, ORIGIN_N, ORIGIN_H]), // Refshaleøen (js/tile-grid.js)
  axes: 'x=east, z=south, y=up',
  bbox: Object.freeze([-2000, -1000, 1000, 1500]) // [minX, minZ, maxX, maxZ]: E 725000-728000, N 6176000-6178500
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

// Teleport presets (local frame; forward is (sin h, cos h)). Each stands on a link of the road graph (data/city/roadgraph.json)
// 30-60 m from the landmark's OSM position and faces it; the scenic cameras (cameras.js) frame the same places.
// pin: the landmark's OSM position, where the map puts its marker. reffen is where the player starts.
const TELEPORT_LOCATIONS = {
  reffen: { name: 'Reffen', sub: 'Refshaleøen · street food · start', x: -174.6, z: -417.8, heading: -0.29, pin: { x: -187.2, z: -376.1 } },
  operaen: { name: 'Operaen', sub: 'Holmen · the opera house', x: -653.3, z: 983.8, heading: 2.76, pin: { x: -641.3, z: 953.7 } },
  akademiet: { name: 'Det Kongelige Akademi', sub: 'Holmen · architecture school', x: -364.4, z: 939.9, heading: -1.97, pin: { x: -388.3, z: 929.8 } },
  mastekranen: { name: 'Mastekranen', sub: 'Nyholm · the mast crane', x: -313.2, z: 234.2, heading: -1.49, pin: { x: -351.6, z: 237.3 } },
  bw: { name: 'B&W Hallerne', sub: 'Refshaleøen · the shipyard halls', x: 206.3, z: -349.5, heading: -0.25, pin: { x: 191.8, z: -293.1 } },
  cc: { name: 'Copenhagen Contemporary', sub: 'Refshaleøen · art hall', x: 74.3, z: -346.4, heading: 2.47, pin: { x: 98.2, z: -376.8 } },
  marmorkirken: { name: 'Marmorkirken', sub: 'Frederiksstaden · from Amalienborg', x: -1260.0, z: 683.0, heading: -1.96, pin: { x: -1364.6, z: 640.1 } },
  operaparken: { name: 'Operaparken', sub: 'Holmen · the park by the opera', x: -618.1, z: 1107.7, heading: -0.78, pin: { x: -640.0, z: 1130.0 } },
  kai: { name: 'KAI', sub: 'Papirøen · the new swimming hall', x: -833.1, z: 1221.8, heading: 2.17, pin: { x: -800.0, z: 1199.0 } },
  banchina: { name: 'La Banchina', sub: 'Refshaleøen · harbour bath', x: -48.3, z: 49.5, heading: -0.28, pin: { x: -57.0, z: 80.0 } }
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
