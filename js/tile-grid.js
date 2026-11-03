// js/tile-grid.js
// The fixed 500 m tile grid in EPSG:25832: the JS mirror of tools/geodata/frame.py (keep the two in step).
// Tile id "<e500>_<n500>" = floor(E / 500), floor(N / 500); four tiles fill one 1 km DHM / LoD2 cell (6323_555).
// Local frame: x = E - origin.E, z = -(N - origin.N). A tile's local bounds are [xmin, zmin, xmax, zmax].

export const TILE_SIZE = 500;
export const ORIGIN_E = 556000; // Aalborg, by Gammel Torv
export const ORIGIN_N = 6323100;
export const ORIGIN_H = 3.85; // DVR90 height of the origin: the median DHM terrain within 10 m of it
/** 0 m DVR90 (the sea) in the local frame. */
export const SEA_LEVEL_LOCAL = -ORIGIN_H;

export const tileId = (ie, in_) => `${ie}_${in_}`;

export function parseTileId(id) {
  const [ie, in_] = String(id).split('_').map(Number);
  if (!Number.isInteger(ie) || !Number.isInteger(in_)) throw new Error(`bad tile id ${id}`);
  return [ie, in_];
}

/** Tile id of a UTM point. */
export const tileOfPoint = (e, n) => tileId(Math.floor(e / TILE_SIZE), Math.floor(n / TILE_SIZE));

/** Tile id of a local point (x east, z south). */
export const tileOfLocal = (x, z) => tileOfPoint(x + ORIGIN_E, ORIGIN_N - z);

/** [minE, minN, maxE, maxN] */
export function tileBoundsUtm(id) {
  const [ie, in_] = parseTileId(id);
  return [ie * TILE_SIZE, in_ * TILE_SIZE, (ie + 1) * TILE_SIZE, (in_ + 1) * TILE_SIZE];
}

/** [xmin, zmin, xmax, zmax] in the local frame. */
export function tileBoundsLocal(id) {
  const [e0, n0, e1, n1] = tileBoundsUtm(id);
  return [e0 - ORIGIN_E, ORIGIN_N - n1, e1 - ORIGIN_E, ORIGIN_N - n0];
}

/** Sorted ids of the tiles a UTM bbox [minE, minN, maxE, maxN], grown by margin, touches (edge contact does not count). */
export function tilesForBbox(bbox, margin = 0) {
  const [e0, n0, e1, n1] = [bbox[0] - margin, bbox[1] - margin, bbox[2] + margin, bbox[3] + margin];
  const out = [];
  for (let ie = Math.floor(e0 / TILE_SIZE); ie < Math.ceil(e1 / TILE_SIZE); ie++) {
    for (let in_ = Math.floor(n0 / TILE_SIZE); in_ < Math.ceil(n1 / TILE_SIZE); in_++) out.push(tileId(ie, in_));
  }
  return out.sort();
}

/** Same, for a local bbox [xmin, zmin, xmax, zmax]. */
export function tilesForLocalBbox(bbox, margin = 0) {
  const [x0, z0, x1, z1] = bbox;
  return tilesForBbox([x0 + ORIGIN_E, ORIGIN_N - z1, x1 + ORIGIN_E, ORIGIN_N - z0], margin);
}

/** The 1 km DHM / LoD2 cell '<N km>_<E km>' that holds a tile. */
export function lod2CellOfTile(id) {
  const [ie, in_] = parseTileId(id);
  return `${Math.floor(in_ / 2)}_${Math.floor(ie / 2)}`;
}
