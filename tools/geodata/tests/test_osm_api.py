import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import osm_api  # noqa: E402

NODES = [{"type": "node", "id": i, "lat": 57.0 + i * 0.001, "lon": 9.9 + i * 0.001} for i in range(1, 5)]
ELEMENTS = NODES + [
    {"type": "node", "id": 10, "lat": 57.01, "lon": 9.91, "tags": {"shop": "bakery", "name": "Bager"}},
    {"type": "node", "id": 11, "lat": 57.02, "lon": 9.92, "tags": {"amenity": "bench"}},
    {"type": "way", "id": 20, "nodes": [1, 2, 3, 1], "tags": {"amenity": "restaurant"}},
    {"type": "way", "id": 21, "nodes": [1, 2, 4, 1], "tags": {"place": "square", "surface": "sett"}},
    {"type": "way", "id": 22, "nodes": [1, 2], "tags": {"highway": "residential"}},
]


def test_groundfloor_is_out_center():
    out = osm_api.emulate("groundfloor", ELEMENTS)["elements"]
    by = {(e["type"], e["id"]): e for e in out}
    assert set(by) == {("node", 10), ("way", 20)}
    way = by[("way", 20)]
    assert "geometry" not in way
    assert way["center"] == {"lat": (57.001 + 57.003) / 2, "lon": (9.901 + 9.903) / 2}


def test_squares_keep_geometry_and_street_nodes_are_nodes():
    sq = osm_api.emulate("squares", ELEMENTS)["elements"]
    assert [e["id"] for e in sq] == [21] and len(sq[0]["geometry"]) == 4
    assert [e["id"] for e in osm_api.emulate("street_nodes", ELEMENTS)["elements"]] == [11]
