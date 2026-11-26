import test from 'node:test';
import assert from 'node:assert/strict';
import { CPH_FRAME } from '../js/city-config.js';
import { ORIGIN_E, ORIGIN_N, tileOfPoint, tileOfLocal, tileBoundsUtm, tileBoundsLocal, tilesForBbox, tilesForLocalBbox, lod2CellOfTile, parseTileId } from '../js/tile-grid.js';

test('origin constants match city-config', () => {
  assert.deepEqual([ORIGIN_E, ORIGIN_N], [CPH_FRAME.origin[0], CPH_FRAME.origin[1]]);
});

test('tile ids and bounds (same numbers as tools/geodata/tests/test_frame.py)', () => {
  assert.equal(tileOfPoint(727000, 6177500), '1454_12355');
  assert.deepEqual(tileBoundsUtm('1454_12355'), [727000, 6177500, 727500, 6178000]);
  assert.deepEqual(tileBoundsLocal('1454_12355'), [0, -500, 500, 0]);
  assert.equal(tileOfLocal(0, 0), '1454_12355');
  assert.equal(tileOfLocal(-0.01, 0), '1453_12355'); // a hair west of the origin
  assert.throws(() => parseTileId('x_y'));
});

test('four tiles fill one LoD2 cell', () => {
  const cells = new Map();
  for (const ie of [1110, 1111]) for (const n of [12646, 12647]) {
    const c = lod2CellOfTile(`${ie}_${n}`);
    cells.set(c, (cells.get(c) || 0) + 1);
  }
  assert.deepEqual([...cells], [['6323_555', 4]]);
});

test('the district touches 4x4 tiles; edge contact does not leak', () => {
  const [x0, z0, x1, z1] = CPH_FRAME.bbox;
  const ids = tilesForLocalBbox([x0, z0, x1, z1]);
  assert.equal(ids.length, 16);
  assert.ok(ids.includes('1452_12353') && ids.includes('1455_12356'));
  assert.deepEqual(tilesForBbox([727000, 6177500, 727500, 6178000]), ['1454_12355']);
  assert.equal(tilesForBbox([727000, 6177500, 727500, 6178000], 1).length, 9);
});
