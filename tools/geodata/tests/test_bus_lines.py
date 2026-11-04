"""bus_lines.py: route ways chained in relation order whichever way each is drawn, stops projected onto the path."""
import bus_lines


def _els(ways, nodes, members):
    els = {("node", i): {"type": "node", "id": i, "lon": x, "lat": z, "tags": tags} for i, (x, z, tags) in nodes.items()}
    for wid, nds in ways.items():
        els[("way", wid)] = {"type": "way", "id": wid, "nodes": nds}
    rel = {"type": "relation", "id": 1, "members": members,
           "tags": {"route": "bus", "ref": "2", "network": "Nordjyllands Trafikselskab", "from": "A", "to": "Hospitalsbyen"}}
    els[("relation", 1)] = rel
    return els, rel


def test_chain_flips_ways_and_keeps_order():
    nodes = {i: (i * 10.0, 0.0, {}) for i in range(1, 7)}
    # way 10 is drawn backwards relative to the route, way 11 too; way 12 forwards
    ways = {10: [2, 1], 11: [4, 3, 2], 12: [4, 5, 6]}
    members = [{"type": "way", "ref": r, "role": ""} for r in (10, 11, 12)]
    els, rel = _els(ways, nodes, members)
    (piece,) = bus_lines.chain(rel, els, lambda lon, lat: (lon, lat))
    assert [p[0] for p in piece] == [10, 20, 30, 40, 50, 60]


def test_missing_way_splits_the_path():
    nodes = {i: (i * 10.0, 0.0, {}) for i in range(1, 6)}
    ways = {10: [1, 2], 12: [4, 5]}
    members = [{"type": "way", "ref": r, "role": ""} for r in (10, 11, 12)]
    els, rel = _els(ways, nodes, members)
    pieces = bus_lines.chain(rel, els, lambda lon, lat: (lon, lat))
    assert [[p[0] for p in piece] for piece in pieces] == [[10, 20], [40, 50]]


def test_project_and_clip():
    path = [(0.0, 0.0), (100.0, 0.0), (100.0, 100.0)]
    s, d = bus_lines.project(path, (100.0, 40.0))
    assert abs(s - 140.0) < 1e-9 and d < 1e-9
    s, d = bus_lines.project(path, (50.0, 3.0))
    assert abs(s - 50.0) < 1e-9 and abs(d - 3.0) < 1e-9
    runs = bus_lines.clip_to_area([(-5, 0), (1, 0), (2, 0), (9, 0), (3, 0), (4, 0)], (0, -1, 5, 1))
    assert runs == [[(1, 0), (2, 0)], [(3, 0), (4, 0)]]
