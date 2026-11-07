"""nightlife.py: bars, pubs and nightclubs moved to the street-facing wall of their building, others dropped."""
import nightlife

# a street along x = 0 (z 0..100); a building west of it, its east wall at x = -5 (the street front)
STREET = {"name": "Jomfru Ane Gade", "class": "footway", "width": 2, "pts": [0, 0, 0, 100]}
BUILDING = [(-15, 40, -5, 40), (-5, 40, -5, 60), (-5, 60, -15, 60), (-15, 60, -15, 40)]


def test_kinds_and_duplicates():
    els = [
        {"type": "node", "id": 1, "lon": -10, "lat": 50, "tags": {"amenity": "nightclub", "name": "Club"}},
        {"type": "node", "id": 2, "lon": -10, "lat": 50, "tags": {"amenity": "bar", "name": "Same spot"}},
        {"type": "way", "id": 3, "center": {"lon": 0, "lat": 0}, "tags": {"amenity": "restaurant"}},
        {"type": "node", "id": 4, "lon": 3, "lat": 20, "tags": {"amenity": "pub", "name": "Pub", "opening_hours": "Fr-Sa 18:00-02:00"}},
    ]
    vs = nightlife.venues_from(els, lambda lon, lat: (lon, lat))
    assert [v["name"] for v in vs] == ["Club", "Pub"]
    assert vs[1]["hours"] == "Fr-Sa 18:00-02:00" and vs[0]["src"] == "osm:node/1"


def test_front_is_the_street_wall_with_its_outward_normal():
    out = nightlife.place([{"name": "Club", "kind": "nightclub", "x": -10, "z": 50, "hours": None, "src": "osm:node/1"}], [STREET], BUILDING)
    assert len(out) == 1
    v = out[0]
    assert abs(v["x"] + 5) < 1e-6 and abs(v["z"] - 50) < 1e-6
    assert v["nx"] == 1 and v["nz"] == 0  # facing the street (east)
    assert v["street"] == "Jomfru Ane Gade"


def test_a_point_drawn_outside_finds_the_wall_and_far_venues_are_dropped():
    # drawn on the pavement in front of the building: the ray starts behind it and still meets the east wall
    out = nightlife.place([{"name": "Bar", "kind": "bar", "x": -2, "z": 45, "hours": None, "src": "s"}], [STREET], BUILDING)
    assert abs(out[0]["x"] + 5) < 1e-6
    # no building: the front is put a little back from the street
    out = nightlife.place([{"name": "Kiosk", "kind": "bar", "x": 6, "z": 10, "hours": None, "src": "s"}], [STREET], [])
    assert 0 < out[0]["x"] < 6 and out[0]["nx"] < 0
    # 60 m from any street: no front
    assert nightlife.place([{"name": "Far", "kind": "pub", "x": 60, "z": 50, "hours": None, "src": "s"}], [STREET], BUILDING) == []
