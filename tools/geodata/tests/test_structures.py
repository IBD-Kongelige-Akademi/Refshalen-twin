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
    inside = H.dtm.grid[23:27, 16:34]  # the cells in the deck's middle, past the fades to its ends
    assert float(inside.max()) < 0.5, inside.max()  # down to the cutting's floor
    # towards the ends the ground rises back: the road meets the deck, and the mesh does not dip beside the joint
    assert float(H.dtm.grid[25, 11]) > 3.0, H.dtm.grid[25, 11]
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


def _settle_h():
    H = types.SimpleNamespace(wtree=None, levels=[])
    H.ndsm = lambda x, z: np.full(np.shape(x), 5.0)
    H.terrain = lambda x, z: np.zeros(np.shape(np.atleast_1d(x)))
    return H


def _axis(y, way="osm:way/1", kind="road", z=0.0):
    return {"way": way, "kind": kind, "pts": [v for i, h in enumerate(y) for v in (i * 2.0, z, float(h), 0.0)]}


def _ground_way(pts, nodes):
    from shapely.geometry import LineString
    return {"id": "osm:way/9", "tags": {}, "nodes": nodes, "pts": pts, "line": LineString(pts), "kind": "road", "width": 8.0, "layer": 0, "name": "", "tunnel": False}


def test_a_deck_ends_at_the_road_height_and_climbs_no_steeper_than_the_grade():
    H = _settle_h()
    H.terrain = lambda x, z: np.full(np.shape(np.atleast_1d(x)), 1.0)  # the road off the deck at 1 m
    a = _axis([6.0] * 41)  # 80 m at 6 m on a road at 1 m at both ends: a step of 5 m as measured
    d = {"id": "d", "kind": "road", "axes": [a]}
    roads = [_ground_way([(0, 0), (-20, 0)], [1, 2]), _ground_way([(80, 0), (100, 0)], [3, 4])]
    CS.settle_deck_heights([d], {"osm:way/1": [1, 3]}, roads, H)
    y = a["pts"][2::4]
    assert abs(y[0] - 1.0) < 0.05 and abs(y[-1] - 1.0) < 0.05, (y[0], y[-1])
    assert max(abs(y[i + 1] - y[i]) for i in range(40)) / 2.0 <= CS.DECK_GRADE["road"] + 0.02
    assert max(y) > 2.0, "it still climbs"


def test_a_height_read_from_a_roof_is_replaced_by_the_readings_beside_it():
    H = _settle_h()
    building = Polygon([(37, -5), (43, -5), (43, 5), (37, 5)])
    a = _axis([6.0] * 19 + [20.0] * 3 + [6.0] * 19)
    CS.settle_deck_heights([{"id": "d", "kind": "road", "axes": [a]}], {}, [], H, [building])
    assert max(a["pts"][2::4]) < 6.5, max(a["pts"][2::4])


def test_a_footway_on_a_road_deck_takes_the_road_height():
    H = _settle_h()
    road = _axis([6.0] * 21)
    foot = _axis([4.5] * 21, way="osm:way/2", kind="foot", z=5.0)
    CS.settle_deck_heights([{"id": "d", "kind": "road", "axes": [road, foot]}], {}, [], H)
    assert abs(foot["pts"][2 + 4 * 10] - road["pts"][2 + 4 * 10]) < 0.1


def test_no_terrain_stands_through_a_deck():
    grid = np.full((50, 50), 6.0, np.float32)  # the ground as high as the deck, as at a deck's end
    H = types.SimpleNamespace(dtm=types.SimpleNamespace(grid=grid, x0=0.0, z0=0.0, cell=2.0))
    d = {"_g": Polygon([(20, 40), (80, 40), (80, 60), (20, 60)]), "axes": [{"pts": [20, 50, 6, 0, 80, 50, 6, 0]}]}
    assert CS.terrain_below_decks([d], H) > 0
    assert float(grid[25, 25]) == 6.0 - CS.UNDER_DECK_M
    assert float(grid[25, 2]) == 6.0, "outside the deck the ground stays"


def test_a_footway_tied_to_low_ground_at_the_deck_end_does_not_pull_the_road_edge_down():
    H = _settle_h()
    H.terrain = lambda x, z: np.where(np.atleast_1d(z) > 2, 0.5, 3.0)  # the road's ground at 3 m, the ground beside it at 0.5 m
    road = _axis([6.0] * 31)
    foot = _axis([5.5] * 31, way="osm:way/2", kind="foot", z=5.0)
    d = {"id": "d", "kind": "road", "axes": [road, foot]}
    roads = [_ground_way([(0, 0), (-20, 0)], [1, 2])]
    side = {**_ground_way([(0, 5), (-20, 5)], [5, 6]), "kind": "foot"}
    CS.settle_deck_heights([d], {"osm:way/1": [1, 3], "osm:way/2": [5, 7]}, roads + [side], H)
    assert abs(road["pts"][2] - 3.0) < 0.05
    assert abs(foot["pts"][2] - road["pts"][2]) < 0.05, (foot["pts"][2], road["pts"][2])


def test_the_road_before_a_deck_stands_on_an_embankment_across_its_width():
    grid = np.zeros((60, 60), np.float32)
    grid[:, 24:26] = 3.0  # the compiled ridge: 4 m wide, at x 48..52, under a road 12 m wide
    H = types.SimpleNamespace(dtm=types.SimpleNamespace(grid=grid, x0=0.0, z0=0.0, cell=2.0), raw=[], levels=[])
    H.terrain = lambda x, z: np.full(np.shape(np.atleast_1d(x)), 3.0)
    d = {"id": "d", "kind": "road", "_g": Polygon([(40, 60), (60, 60), (60, 90), (40, 90)]), "axes": [{"way": "osm:way/1", "kind": "road", "pts": [50, 60, 3, 0, 50, 90, 3, 0]}]}
    road = _ground_way([(50, 60), (50, 0)], [1, 2])
    road["width"] = 12.0
    assert CS.approach_embankments([d], {"osm:way/1": [1, 5]}, [road], H) > 0
    assert float(grid[25, 21]) == 3.0, "the road's edge at x 43: raised to the centreline"
    assert float(grid[5, 21]) == 0.0, "past the embankment the ground stays"
    assert float(grid[35, 21]) == 0.0, "in the deck's footprint the ground stays"


def test_a_road_under_a_short_deck_is_dug_through_the_approaches_and_the_embankment_keeps_off_it():
    from shapely.geometry import LineString
    grid = np.full((100, 100), 5.0, np.float32)  # a broad embankment at 5 m
    H = types.SimpleNamespace(dtm=types.SimpleNamespace(grid=grid, x0=0.0, z0=0.0, cell=2.0), orig=grid.copy(), wtree=None, levels=[], raw=[])
    H.ground = lambda x, z: grid[np.clip((np.asarray(z) / 2).astype(int), 0, 99), np.clip((np.asarray(x) / 2).astype(int), 0, 99)].astype(float)
    H.terrain = lambda x, z: np.ravel(H.ground(np.atleast_1d(x), np.atleast_1d(z)))
    # a deck 12 m long at 10 m, with its approach on either side (kept), and a road across it right past the deck's ends
    d = {"id": "d", "name": "", "kind": "road", "_g": Polygon([(94, 90), (106, 90), (106, 110), (94, 110)]), "axes": [{"way": "osm:way/1", "kind": "road", "pts": [94, 100, 7.0, 5.0, 106, 100, 7.0, 5.0]}]}
    under = _ground_way([(100, 0), (100, 199)], [7, 8])
    under["id"] = "osm:way/2"
    keep = Polygon([(60, 90), (140, 90), (140, 110), (60, 110)]).difference(d["_g"])
    corridors = []
    CS.lower_underpasses([d], [under], H, keep=keep, corridors=corridors)
    assert corridors, "the corridor is recorded"
    assert float(grid[50, 50]) < 5.0 - 3.0, ("under the deck", float(grid[50, 50]))
    assert float(grid[50, 35]) == 5.0, "the approach's ground beyond the corridor stays"
    low = float(grid[60, 50])
    road = _ground_way([(94, 100), (40, 100)], [1, 2])
    CS.approach_embankments([d], {"osm:way/1": [1, 3]}, [road], H, corridors)
    assert float(grid[50, 50]) < 5.0 - 3.0 and float(grid[60, 50]) == low, "the embankment does not fill the corridor"
