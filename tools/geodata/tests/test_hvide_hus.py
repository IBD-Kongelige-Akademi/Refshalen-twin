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
