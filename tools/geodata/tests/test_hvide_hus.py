"""Hotel Hvide Hus, built from its drawings (tools/overrides/hvide_hus.py, docs/hvide-hus.md)."""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "overrides"))
import hvide_hus as H  # noqa: E402


@pytest.fixture(scope="module")
def parts():
    return H.build(-3.0).to_arrays()


def test_the_tower_has_the_measures_of_the_1967_sheets(parts):
    p = parts["concrete"]["p"]
    assert p[:, 0].max() - p[:, 0].min() == pytest.approx(19.05)
    assert p[:, 2].max() - p[:, 2].min() == pytest.approx(42.6)
    assert p[:, 1].max() == pytest.approx(H.PLANT[4])
    # twelve floors of balconies, one storey of 2.82 m apart, and the closed top over them
    assert H.FIRST_SLAB + H.STOREY * H.FLOORS == pytest.approx(H.TOP_FASCIA[0])
    tops = np.unique(np.round(p[(np.abs(p[:, 0] - H.TW) < 1e-6) & (p[:, 1] < H.TOP_FASCIA[0]) & (p[:, 1] > H.FIRST_SLAB + .5)][:, 1], 2))
    assert len(tops) >= H.FLOORS


def test_the_piers_keep_the_bays_of_5_1_and_3_6_m():
    assert np.round(np.diff(H.PIERS), 1).tolist() == [5.1, 3.6, 5.1, 3.6, 5.1, 3.6, 5.1, 3.6, 5.0]


def test_the_parts_lie_on_the_geodanmark_footprint():
    # the fascias' north and south edges and the east block's reach, against the footprint's box, 48.11 m by 49.18 m in this frame
    assert H.PS == pytest.approx(49.18, abs=0.01)
    assert H.PE == pytest.approx(37.83, abs=0.3)
    assert H.BLOCK_E == pytest.approx(43.79, abs=0.3)
    assert H.APSE[0] + H.APSE[2] == pytest.approx(48.11, abs=0.1)


def test_the_terrace_keeps_the_koter_of_the_landscape_plans(parts):
    pave = parts["paving"]["p"]
    assert (np.abs(pave[:, 1] - 0.02) < 1e-6).sum() >= 18, "the terrace at kote 8.83"
    assert pave[:, 1].min() <= H.K(4.70) + 0.01, "the stairs reach the park"
    hedge = parts["hedge"]["p"]
    assert hedge[:, 1].max() == pytest.approx(1.0)
    assert hedge[:, 1].min() == pytest.approx(6.64 - 8.83)


def test_the_terrace_can_only_be_left_by_its_stairs():
    """Walk the surfaces from the terrace's middle, stopped by the solids: the way out is the stairs' feet, or a wall of the hotel itself."""
    from shapely import contains_xy
    from shapely.geometry import Polygon
    from shapely.ops import unary_union

    decks = unary_union([Polygon(ring).buffer(0.001) for _, ring, _ in H.walk_surfaces()])
    solids = H.walk_solids()
    step = 0.13  # under a wall's thickness
    solid = lambda u, v: any(u0 < u < u1 and v0 < v < v1 for u0, u1, v0, v1, _ in solids)
    start = (int(50.0 / step), int(25.0 / step))
    assert contains_xy(decks, start[0] * step, start[1] * step)
    seen = {start}
    todo = [start]
    exits = set()
    while todo:
        i, j = todo.pop()
        for a, b in ((i + 1, j), (i - 1, j), (i, j + 1), (i, j - 1)):
            if (a, b) in seen:
                continue
            seen.add((a, b))
            u, v = a * step, b * step
            if solid(u, v):
                continue
            if contains_xy(decks, u, v):
                todo.append((a, b))
            else:
                exits.add((u, v))
    assert len(seen) > 30000, "the walk covers the terrace"
    feet = [(u, v) for u, v in exits if u >= H.TERR_E + H.STAIR_RUN - .2]
    assert any(v < 10 for _, v in feet) and any(v > 40 for _, v in feet), "both stairs reach the park"
    hotel = [(u, v) for u, v in exits if (u <= H.BLOCK_E + .2 and H.BLOCK_N - .2 <= v <= H.BLOCK_S + .2) or (u <= H.PE and H.GN - .2 <= v <= H.GS + .2)]
    assert sorted(exits - set(feet) - set(hotel)) == []


def test_the_walk_has_no_step_a_person_could_not_take():
    from shapely.geometry import Point, Polygon

    surfaces = [(Polygon(ring), axis) for _, ring, axis in H.walk_surfaces()]

    def height(u, v):
        for poly, axis in surfaces:
            if poly.intersects(Point(u, v)):
                best, y = 1e9, None
                for (au, av, ah), (bu, bv, bh) in zip(axis, axis[1:]):
                    du, dv = bu - au, bv - av
                    t = max(0.0, min(1.0, ((u - au) * du + (v - av) * dv) / (du * du + dv * dv)))
                    d = (au + du * t - u) ** 2 + (av + dv * t - v) ** 2
                    if d < best:
                        best, y = d, ah + (bh - ah) * t
                return y
        return None

    # down the north stair and down the south one, from the terrace to the foot
    for route in (((50.3, 20.0), (50.3, 1.0), (58.0, 1.0)), ((50.3, 30.0), (50.3, 47.5), (58.0, 47.5))):
        last = None
        for (u0, v0), (u1, v1) in zip(route, route[1:]):
            for t in np.linspace(0, 1, 120):
                y = height(u0 + (u1 - u0) * t, v0 + (v1 - v0) * t)
                assert y is not None
                if last is not None:
                    assert abs(y - last) < 0.25
                last = y
        assert last == pytest.approx(H.PARK, abs=0.01)


def test_the_stair_wells_are_open_to_the_sky(parts):
    pave = parts["paving"]["p"].reshape(-1, 3, 3)
    flat = pave[np.ptp(pave[:, :, 1], axis=1) < 1e-6]
    at_deck = flat[np.abs(flat[:, 0, 1] - 0.02) < 1e-6]
    centre = at_deck.mean(axis=1)
    for v0, v1 in ((H.TERR_N, H.STAIRS[0][0]), (H.STAIRS[1][0], H.TERR_S)):
        inside = (centre[:, 0] > H.WELL_U) & (centre[:, 0] < H.TERR_E) & (centre[:, 2] > v0) & (centre[:, 2] < v1)
        assert not inside.any(), "no paving over the well"


def test_every_face_looks_the_way_its_normal_says(parts):
    for name, q in parts.items():
        p = q["p"].reshape(-1, 3, 3)
        n = q["n"].reshape(-1, 3, 3).mean(1)
        cross = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
        assert (np.einsum("ij,ij->i", cross, n) > 0).all(), name


def test_the_textures_are_what_the_materials_say():
    for name, spec in H.MATERIALS.items():
        if spec["tile"] is not None:
            assert spec.get("texture", name) in H.TEXTURES, name
    rooms = np.asarray(H.rooms_texture(), float).mean(axis=2)
    assert rooms.min() < 60 and rooms.max() > 150, "dark glass and white panels"
    assert np.asarray(H.clad_texture(), float).mean() < np.asarray(H.concrete_texture(), float).mean() / 2, "the podium is dark, the tower pale"
