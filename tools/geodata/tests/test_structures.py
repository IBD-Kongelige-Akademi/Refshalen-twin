"""city_structures.terrain_under_decks: under a bridge the terrain becomes the ground beside it, so what the bridge spans runs under it."""
import types

import numpy as np
from shapely.geometry import Polygon

import city_structures as CS


def test_a_deck_on_flat_ground_changes_nothing():
    grid = np.zeros((50, 50), np.float32)
    H = types.SimpleNamespace(dtm=types.SimpleNamespace(grid=grid, x0=0.0, z0=0.0, cell=2.0), orig=grid.copy(), wtree=None, levels=[])
    d = {"_g": Polygon([(20, 45), (80, 45), (80, 55), (20, 55)]), "axes": [{"pts": [20, 50, 0.5, 0, 80, 50, 0.5, 0]}]}
    assert CS.terrain_under_decks([d], H) == 0
    assert np.array_equal(H.dtm.grid, H.orig)


def test_a_deck_across_a_cutting_lowers_the_terrain_to_the_cutting():
    # the terrain carries the deck (6 m over z 45..55) across a cutting at 0 m: beside the deck across its way (z < 45, z > 55) is 0 m
    grid = np.zeros((50, 50), np.float32)
    grid[22:28, :] = 6.0  # the deck's ridge, z 44..56
    H = types.SimpleNamespace(dtm=types.SimpleNamespace(grid=grid, x0=0.0, z0=0.0, cell=2.0), orig=grid.copy(), wtree=None, levels=[])
    d = {"_g": Polygon([(20, 45), (80, 45), (80, 55), (20, 55)]), "axes": [{"pts": [20, 50, 6, 6, 80, 50, 6, 6]}]}
    changed = CS.terrain_under_decks([d], H)
    assert changed > 0
    inside = H.dtm.grid[23:27, 11:39]  # cells whose centres lie in the deck
    assert float(inside.max()) < 0.5, inside.max()  # down to the cutting's floor
    assert float(H.dtm.grid[22:28, :8].min()) == 6.0, "outside the deck the ridge stays"
    # only ever lowered
    assert (H.dtm.grid <= H.orig + 1e-6).all()


def _flat(n=100, h=0.0):
    grid = np.full((n, n), h, np.float32)
    H = types.SimpleNamespace(dtm=types.SimpleNamespace(grid=grid, x0=0.0, z0=0.0, cell=2.0), orig=grid.copy(), wtree=None, levels=[])
    H.ground = lambda x, z: grid[np.clip((np.asarray(z) / 2).astype(int), 0, n - 1), np.clip((np.asarray(x) / 2).astype(int), 0, n - 1)].astype(float)
    return H


def test_a_road_under_a_low_bridge_is_lowered_to_its_clearance_and_ramped_back():
    from shapely.geometry import LineString
    H = _flat()
    # a road deck 3 m over the ground along x (z 95..105), a road passing under it along z at x = 100 on ground 0
    d = {"id": "deck:0", "name": "", "kind": "road", "_g": Polygon([(60, 95), (140, 95), (140, 105), (60, 105)]),
         "axes": [{"way": "osm:way/1", "pts": [60, 100, 3.0, 0, 140, 100, 3.0, 0]}]}
    w = {"id": "osm:way/2", "tags": {}, "nodes": [1, 2], "pts": [(100, 0), (100, 199)], "line": LineString([(100, 0), (100, 199)]),
         "kind": "road", "width": 8.0, "layer": 0, "name": "", "tunnel": False}
    changed, rows = CS.lower_underpasses([d], [w], H)
    assert changed > 0 and len(rows) == 1
    soffit = 3.0 + CS.DECK_LIFT_M - CS.DECK_THICK_M["road"]
    under = float(H.dtm.grid[50, 50])  # the cell at (101, 101): under the deck
    assert abs(soffit - under - CS.UNDER_CLEAR_M["road"]) < 0.1, under
    ramp = (CS.UNDER_CLEAR_M["road"] - soffit) / CS.UNDER_GRADE["road"]
    assert float(H.dtm.grid[int((100 - ramp - 6) / 2), 50]) == 0.0, "past the ramp the ground is as it was"
    j = int((95 - ramp / 2) / 2)  # half way up the ramp from the deck's edge
    expect = under + CS.UNDER_GRADE["road"] * (95 - (j + 0.5) * 2)
    assert abs(float(H.dtm.grid[j, 50]) - expect) < 0.25, (float(H.dtm.grid[j, 50]), expect)
    assert float(H.dtm.grid[50, 5]) == 0.0, "away from the road the ground stays"
    assert (H.dtm.grid <= H.orig + 1e-6).all()


def test_the_bridge_road_itself_and_a_way_that_joins_it_at_grade_are_not_lowered():
    from shapely.geometry import LineString
    H = _flat()
    d = {"id": "deck:0", "name": "", "kind": "road", "_g": Polygon([(60, 95), (140, 95), (140, 105), (60, 105)]),
         "axes": [{"way": "osm:way/1", "pts": [60, 100, 0.5, 0, 140, 100, 0.5, 0]}]}
    own = {"id": "osm:way/1", "tags": {}, "nodes": [1, 2], "pts": [(60, 100), (140, 100)], "line": LineString([(60, 100), (140, 100)]),
           "kind": "road", "width": 8.0, "layer": 0, "name": "", "tunnel": False}
    low = {**own, "id": "osm:way/3", "nodes": [3, 4], "pts": [(100, 0), (100, 199)], "line": LineString([(100, 0), (100, 199)])}
    changed, rows = CS.lower_underpasses([d], [own, low], H)
    assert changed == 0 and rows == []
    assert np.array_equal(H.dtm.grid, H.orig)


def test_the_terrain_under_the_sea_goes_to_the_bed_and_a_stream_keeps_its_ground():
    H = _flat(h=-4.8)
    H.dtm.grid[40:60, :] = 6.0  # a bridge ridge across both
    sea = Polygon([(0, 0), (100, 0), (100, 200), (0, 200)])
    stream = Polygon([(120, 0), (180, 0), (180, 200), (120, 200)])
    H.raw, H.levels, H.bodies, H.kinds = [sea, stream], [-3.85, -2.0], ["w:0", "w:1"], ["sea", "stream"]
    n = CS.terrain_in_water(H, {})
    assert n > 0
    assert float(H.dtm.grid[50, 25]) == np.float32(-3.85 - CS.SINK_M), "the ridge in the sea is cut to the bed"
    assert float(H.dtm.grid[50, 75]) == 6.0, "the ridge over the stream stays"
    assert float(H.dtm.grid[10, 25]) == np.float32(-4.8), "the sea floor within 0.3 m of the bed stays"
