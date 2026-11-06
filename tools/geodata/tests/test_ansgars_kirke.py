"""The church built from the 1925 drawings (tools/overrides/ansgars_kirke.py, docs/ansgars-kirke.md), and the GLB bounds it brought to light."""
import json
import struct
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "overrides"))
import ansgars_kirke as K  # noqa: E402
from overrides_lib import Glb, GlbWriter  # noqa: E402


@pytest.fixture(scope="module")
def parts():
    return K.build(-1.0).to_arrays()


def test_the_measures_of_the_drawings_hold(parts):
    allp = np.concatenate([q["p"] for q in parts.values()])
    assert allp[:, 1].max() == pytest.approx(48.67), "the cross on the spire"
    assert parts["tile"]["p"][:, 1].max() == pytest.approx(K.RIDGE + 0.07), "the ridge with its ridge tiles"
    assert parts["tile"]["p"][:, 1].min() == pytest.approx(K.EAVE - 0.02)
    # the eaves lie on the GeoDanmark footprint: arms 12.6 m wide, 34.6 m north to south, 35.3 m west to east
    roof = parts["tile"]["p"]
    assert roof[:, 2].max() - roof[:, 2].min() == pytest.approx(34.7, abs=0.2)
    assert roof[:, 0].max() - roof[:, 0].min() == pytest.approx(35.2, abs=0.2)
    assert allp[:, 0].max() == pytest.approx(19.85 + 5 * 0.45), "the foot of the stairs"


def test_every_face_looks_the_way_its_normal_says(parts):
    for name, q in parts.items():
        p = q["p"].reshape(-1, 3, 3)
        n = q["n"].reshape(-1, 3, 3).mean(1)
        cross = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
        assert (np.einsum("ij,ij->i", cross, n) > 0).all(), name


def test_the_windows_are_cut_out_of_the_walls_and_glazed():
    with_windows = K.Model()
    w = K.WallFrame((0, 0), (10, 0))
    o = K.arch(4, 9, 2)
    with_windows.wall("wall", w, 0, 12, [(5, o)])
    with_windows.reveal(w, 5, o, 0.3)
    p = np.array(with_windows.parts["wall"]["p"]).reshape(-1, 3, 3)
    area = 0.5 * np.linalg.norm(np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0]), axis=1).sum()
    arch_area = 2 * (8 - 4) + np.pi / 2
    assert area == pytest.approx(120 - arch_area, abs=0.05)
    g = np.array(with_windows.parts["glass"]["p"]).reshape(-1, 3, 3)
    assert (g[:, :, 2] == pytest.approx(0.3)), "the glass stands back in the wall (out of the wall is -v here)"


def test_the_walk_ring_holds_the_portico_and_winds_as_geodanmark_does():
    ring = K.walk_ring()
    assert len(ring) % 2 == 0 and len(ring) // 2 == len(K.WALL_RING) + 4
    # wound as the GeoDanmark rings are: anticlockwise in x, z (z south), so a negative shoelace sum
    pts = np.array(ring).reshape(-1, 2)
    x, z = pts[:, 0], pts[:, 1]
    assert 0.5 * (np.dot(x, np.roll(z, -1)) - np.dot(z, np.roll(x, -1))) < 0


def test_glb_bounds_are_the_accessors_raw_integers(tmp_path):
    # GLTFLoader scales min and max of a normalized accessor by itself: bounds given as 0..1 put the bounding sphere at the mesh's minimum corner,
    # and three then culled whole meshes of the church at some view angles
    w = GlbWriter()
    tris = np.array([[10, 0, 0], [20, 0, 0], [20, 5, 8.0]])
    node, _ = w.mesh("m", tris, np.tile([0, 1, 0], (3, 1)))
    w.root("r", [node])
    path = tmp_path / "t.glb"
    path.write_bytes(w.bytes())
    g = Glb(path)
    a = g.json["accessors"][g.json["meshes"][0]["primitives"][0]["attributes"]["POSITION"]]
    assert a["normalized"] and a["max"] == [65535.0, 65535.0, 65535.0] and a["min"] == [0.0, 0.0, 0.0]
    assert g.accessor(g.json["meshes"][0]["primitives"][0]["attributes"]["POSITION"]).max() == pytest.approx(1.0)
