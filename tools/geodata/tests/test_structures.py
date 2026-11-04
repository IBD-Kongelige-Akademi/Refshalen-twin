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
