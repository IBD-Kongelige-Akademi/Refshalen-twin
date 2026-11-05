"""below_ground: a large, low footprint whose LoD2 roof covers little of it has nothing standing on it."""
import json
import struct

import below_ground as BG


def record(tris):
    """A LoD2 record of roof triangles [(x, z) x 3] at 5 m (layout: tools/lod2/convert.py)."""
    pts = [p for t in tris for p in t]
    body = struct.pack("<3f3H", 0.0, 0.0, 0.0, len(pts), len(tris), 0)
    for x, z in pts:
        body += struct.pack("<3h", round(x * 100), 500, round(z * 100))
    for k in range(len(tris)):
        body += struct.pack("<3H", 3 * k, 3 * k + 1, 3 * k + 2)
    body += bytes(len(tris))  # kinds: all roof
    body += b"\0\0" * len(tris)  # edges
    return body


SQUARE = [0, 0, 30, 0, 30, 30, 0, 30]  # 900 m2
SCRAP = [[(1, 1), (2, 1), (2, 2)]]  # 0.5 m2
FULL = [[(0, 0), (30, 0), (30, 30)], [(0, 0), (30, 30), (0, 30)]]


def test_a_large_low_footprint_with_a_scrap_of_roof_is_below_ground():
    b = {"ring": SQUARE, "ground": 5.0, "eave": 5.6}
    assert BG.is_below_ground(b, {"offset": 0}, record(SCRAP))


def test_what_stands_is_not():
    entry = {"offset": 0}
    assert not BG.is_below_ground({"ring": SQUARE, "ground": 5.0, "eave": 5.6}, entry, record(FULL)), "a roof covers it"
    assert not BG.is_below_ground({"ring": SQUARE, "ground": 5.0, "eave": 12.0}, entry, record(SCRAP)), "tall: a building with a bad record"
    shed = {"ring": [0, 0, 5, 0, 5, 5, 0, 5], "ground": 5.0, "eave": 7.0}
    assert not BG.is_below_ground(shed, entry, record(SCRAP)), "a low shed: small"
    assert not BG.is_below_ground({"ring": SQUARE, "ground": 5.0, "eave": 5.6}, None, None), "no record: nothing says so"


def test_apply_marks_clears_and_is_idempotent(tmp_path):
    d = tmp_path / "1111_12646"
    d.mkdir()
    (d / "lod2.bin").write_bytes(record(SCRAP))
    (d / "lod2.json").write_text(json.dumps({"buildings": {"gdk:1": {"offset": 0}}}))
    other = {"id": "gdk:2", "ring": SQUARE, "ground": 0, "eave": 9, "below_ground": 1}  # marked by an earlier run, no longer so
    (d / "buildings.json").write_text(json.dumps({"buildings": [{"id": "gdk:1", "ring": SQUARE, "ground": 5.0, "eave": 5.6}, other]}))
    assert BG.apply(tmp_path) == [("1111_12646", "gdk:1")]
    doc = json.loads((d / "buildings.json").read_text())
    assert doc["buildings"][0]["below_ground"] == 1 and "below_ground" not in doc["buildings"][1]
    before = (d / "buildings.json").read_text()
    assert BG.apply(tmp_path) == [("1111_12646", "gdk:1")]
    assert (d / "buildings.json").read_text() == before
