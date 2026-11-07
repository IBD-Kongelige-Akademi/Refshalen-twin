"""Budolfi Kirke built from the 2000 facades and the 1934 survey of its spire (tools/overrides/budolfi.py, docs/budolfi.md)."""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "overrides"))
import budolfi as B  # noqa: E402


@pytest.fixture(scope="module")
def parts():
    return B.build(1.0).to_arrays()


def test_the_heights_of_the_sheets_hold(parts):
    roof = parts["roof"]["p"]
    assert roof[:, 1].max() == pytest.approx(B.TOWER_TOP), "the tower's top, under the spire"
    nave = roof[(roof[:, 0] > 9) & (np.abs(roof[:, 2] - 22.06) < 0.01)]
    assert nave[:, 1].max() == pytest.approx(B.RIDGE), "the nave's ridge"
    walls = parts["wall"]["p"]
    east = walls[np.abs(walls[:, 0] - B.EAST_END) < 0.6]
    assert east[:, 1].max() == pytest.approx(B.EAST_GABLE), "the east gable's crest"
    # the roof over the east end stands on its walls: its eaves are the walls' line, at the walls' head
    east_roof = roof[(roof[:, 0] > B.NAVE[1] + 0.1) & (roof[:, 1] > B.EAVE - 1e-6)]  # the buttresses' caps aside
    assert east_roof[:, 2].min() == pytest.approx(B.NAVE[2]) and east_roof[:, 2].max() == pytest.approx(B.NAVE[3])
    assert east_roof[(east_roof[:, 2] < B.NAVE[2] + 0.01), 1].min() == pytest.approx(B.EAVE)


def test_the_spire_follows_the_survey(parts):
    spire = parts["spire"]["p"]
    assert spire[:, 1].max() == pytest.approx(B.TOWER_TOP + B.UPPER_BELL[-1][1]), "the needle's tip"
    r = np.hypot(spire[:, 0] - B.SPIRE_C[0], spire[:, 2] - B.SPIRE_C[1])
    widest = r[spire[:, 1] < B.TOWER_TOP + 6].max()
    assert widest == pytest.approx(B.LOWER_BELL[0][0] / np.cos(np.pi / 8)), "the lower bell starts at the cornice, an octagon"
    allp = np.concatenate([q["p"] for q in parts.values()])
    assert allp[:, 1].max() == pytest.approx(B.TOWER_TOP + B.VANE + 0.12), "the ball on the rod's head"


def test_the_walls_stand_on_the_geodanmark_footprint(parts):
    walls = parts["wall"]["p"]
    low = walls[walls[:, 1] < 2.0]
    assert low[:, 0].min() == pytest.approx(B.ANNEX[0], abs=0.05) and low[:, 0].max() < 57.74 + 1.7, "west front to the east front's diagonal buttresses"
    assert low[:, 2].min() == pytest.approx(0.0, abs=0.05) and low[:, 2].max() == pytest.approx(39.8, abs=0.05), "the north chapel's room to the south porch"


def test_the_stepped_gables_rise_over_their_roofs(parts):
    walls = parts["wall"]["p"]
    for (u0, u1, v0, v1), crest, ridge in ((B.CHAPEL, B.CHAPEL_GABLE, B.CHAPEL_RIDGE), (B.PORCH, B.PORCH_GABLE, B.PORCH_RIDGE), (B.ANNEX, B.ANNEX_GABLE, B.ANNEX_RIDGE)):
        inside = walls[(walls[:, 0] > u0 - 0.1) & (walls[:, 0] < u1 + 0.1) & (walls[:, 2] > v0 + 0.1) & (walls[:, 2] < v1 + 0.7)]
        assert inside[:, 1].max() == pytest.approx(crest)
        assert crest > ridge + 1.5


def test_every_face_looks_the_way_its_normal_says(parts):
    for name, q in parts.items():
        p = q["p"].reshape(-1, 3, 3)
        n = q["n"].reshape(-1, 3, 3).mean(1)
        cross = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
        assert (np.einsum("ij,ij->i", cross, n) > 0).all(), name


def test_the_pointed_arch_closes_at_its_apex():
    o = B.pointed(2.0, 6.0, 2.0)
    assert o[0] == (2.0, 1.0) and o[-1][0] == pytest.approx(6.0) and o[-1][1] == pytest.approx(0.0)
    assert all(b[0] >= a[0] and b[1] <= a[1] + 1e-9 for a, b in zip(o, o[1:])), "rising and narrowing"


def test_the_textures_fit_beside_the_other_overrides():
    from overrides_lib import texture_bytes

    total = sum(texture_bytes(*f().size) for f in B.TEXTURES.values())
    assert total < 4e6, "with Ansgars Kirke (13.7 MB) and the hotel (11.2 MB) under the 32 MiB budget"
    wall = np.asarray(B.wall_texture(), float).mean()
    roof = np.asarray(B.roof_texture(), float).mean()
    assert wall > 170 and wall > roof + 50, "whitewashed walls, grey lead"
