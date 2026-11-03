import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import city_map  # noqa: E402

SQUARE = [0, 0, 100, 0, 100, 100, 0, 100]


def write(d: Path, name: str, doc: dict) -> None:
    d.mkdir(parents=True, exist_ok=True)
    (d / name).write_text(json.dumps(doc), encoding="utf-8")


def test_map_doc_from_tiles(tmp_path):
    t = tmp_path / "1110_12644"
    write(t, "buildings.json", {"buildings": [{"id": "gdk:1", "ring": [10, 10, 20, 10, 20, 20], "ground": 1.0, "eave": 13.5},
                                              {"id": "gdk:2", "ring": [0, 0, 1, 0], "ground": 0, "eave": 3}]})
    write(t, "water.json", {"bodies": [{"id": "w:0", "kind": "sea", "polys": [{"ring": SQUARE}]}], "green": [{"ring": SQUARE}]})
    write(t, "roads.json", {"parks": [{"id": "osm:way/1", "name": "Kildeparken", "ring": SQUARE}, {"id": "osm:way/2", "ring": [0, 0, 5, 0, 5, 5]}]})
    # the same park in a neighbouring tile's layer counts once
    write(tmp_path / "1110_12645", "roads.json", {"parks": [{"id": "osm:way/1", "name": "Kildeparken", "ring": SQUARE}]})
    doc = city_map.build(tmp_path, {"bodies": [{"id": "w:0", "name": "Limfjorden", "sea": True}]})
    assert doc["version"] == "aalborg-map/1"
    assert doc["buildings"] == [{"h": 12.5, "r": [10, 10, 20, 10, 20, 20]}], "height above the ground; a two-point ring is dropped"
    assert doc["water"] == [{"r": SQUARE, "sea": True}]
    assert len(doc["parks"]) == 1, "deduplicated by id; the 12.5 m2 park is below the minimum"
    assert len(doc["green"]) == 1
    labels = {(l["kind"], l["text"]): (l["x"], l["z"]) for l in doc["labels"]}
    assert labels == {("water", "Limfjorden"): (50.0, 50.0), ("park", "Kildeparken"): (50.0, 50.0)}
    assert doc["bbox"] == [10, 10, 20, 20]


def test_centroid_and_area():
    assert city_map.area(SQUARE) == 10000
    assert city_map.centroid([0, 0, 30, 0, 0, 30]) == (10.0, 10.0)
