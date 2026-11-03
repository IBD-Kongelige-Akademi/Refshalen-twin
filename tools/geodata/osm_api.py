"""OSM data for a small area from the main OpenStreetMap API (api/0.6/map), shaped like the Overpass answers build_city.py caches.

A fallback for days when every public Overpass server fails. The bbox is fetched in GRID x GRID requests (each far below the API's
0.25 deg2 / 50,000-node limits; the API is meant for editor-sized areas, so use this for a district, not a kommune), merged, and
the answers to build_city.OSM_QUERIES and OSM_QUERIES2 are rebuilt from it with Overpass's `out geom` layout:

    roads        way["highway"]                                                  -> ways with tags and geometry
    water_parks  natural=water and leisure=park|garden ways and relations        -> ways with geometry, relations with member geometry
    nodes        highway=traffic_signals | street_lamp, crossing=traffic_signals -> nodes with tags
    squares      place=square, pedestrian areas                                  -> ways with geometry, relations with member geometry
    groundfloor  shops, venues, crafts, offices, hotels (groundfloor.QUERY)      -> nodes, ways and relations with a `center` (out center)
    street_nodes benches, bins, bollards, racks, bus stops                       -> nodes with tags

Raw API answers are cached under data/raw/city/osm_api/. Map data © OpenStreetMap contributors (ODbL).
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "city" / "osm_api"
API = "https://api.openstreetmap.org/api/0.6/map.json"
UA = "aalborg-twin-geodata/0.1 (open-data compiler; small-area map requests)"
GRID = 3


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def fetch_map(s: float, w: float, n: float, e: float, force: bool = False) -> list[dict]:
    """All elements in the bbox (lat/lon), fetched in GRID x GRID cached requests and deduped by (type, id)."""
    RAW.mkdir(parents=True, exist_ok=True)
    seen, out = set(), []
    for i in range(GRID):
        for j in range(GRID):
            b = (w + (e - w) * j / GRID, s + (n - s) * i / GRID, w + (e - w) * (j + 1) / GRID, s + (n - s) * (i + 1) / GRID)
            p = RAW / ("map_" + "_".join(f"{v:.5f}" for v in b) + ".json")
            if p.exists() and not force:
                data = json.loads(p.read_text(encoding="utf-8"))
            else:
                for attempt in range(4):
                    r = requests.get(API, params={"bbox": ",".join(f"{v:.6f}" for v in b)}, headers={"User-Agent": UA}, timeout=180)
                    if r.status_code == 200:
                        break
                    log(f"[osm-api] http {r.status_code}, retry {attempt + 1}")
                    time.sleep(10 * (attempt + 1))
                r.raise_for_status()
                data = r.json()
                p.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
                time.sleep(1.0)  # be gentle with the API
            for el in data.get("elements", []):
                k = (el["type"], el["id"])
                if k not in seen:
                    seen.add(k)
                    out.append(el)
    log(f"[osm-api] {len(out)} elements in {GRID * GRID} requests")
    return out


def _index(elements):
    nodes = {el["id"]: el for el in elements if el["type"] == "node"}
    ways = {el["id"]: el for el in elements if el["type"] == "way"}
    return nodes, ways


def _geom(way, nodes):
    return [{"lat": nodes[nd]["lat"], "lon": nodes[nd]["lon"]} for nd in way.get("nodes", []) if nd in nodes]


def _way_out(way, nodes):
    return {"type": "way", "id": way["id"], "tags": way.get("tags", {}), "geometry": _geom(way, nodes)}


def _center(pts):
    """Overpass `out center`: the middle of the bounding box."""
    if not pts:
        return None
    lats, lons = [p["lat"] for p in pts], [p["lon"] for p in pts]
    return {"lat": (min(lats) + max(lats)) / 2, "lon": (min(lons) + max(lons)) / 2}


def select(elements: list[dict], way=None, relation=None, node=None, center: bool = False) -> dict:
    """An Overpass `out geom` answer with the ways / relations / nodes whose tags pass the given predicates (None: none of that kind);
    `center`: an `out center tags` answer instead (ways and relations carry a `center`, no geometry)."""
    nodes, ways = _index(elements)
    out = []
    if way:
        for w in ways.values():
            if way(w.get("tags", {})):
                o = _way_out(w, nodes)
                if center:
                    o["center"] = _center(o.pop("geometry"))
                out.append(o)
    if relation:
        for el in elements:
            if el["type"] == "relation" and relation(el.get("tags", {})):
                members = []
                for m in el.get("members", []):
                    mm = {"type": m["type"], "ref": m["ref"], "role": m.get("role", "")}
                    if m["type"] == "way" and m["ref"] in ways:
                        mm["geometry"] = _geom(ways[m["ref"]], nodes)
                    members.append(mm)
                if center:
                    out.append({"type": "relation", "id": el["id"], "tags": el.get("tags", {}),
                                "center": _center([p for m in members for p in m.get("geometry", [])])})
                else:
                    out.append({"type": "relation", "id": el["id"], "tags": el.get("tags", {}), "members": members})
    if node:
        out += [{"type": "node", "id": nd["id"], "lat": nd["lat"], "lon": nd["lon"], "tags": nd.get("tags", {})}
                for nd in nodes.values() if nd.get("tags") and node(nd["tags"])]
    return {"version": 0.6, "generator": "osm_api.py (api/0.6/map, Overpass-shaped)", "elements": out}


def _water_park(t):
    return t.get("natural") == "water" or t.get("leisure") in ("park", "garden")


def _signal_lamp(t):
    return t.get("highway") in ("traffic_signals", "street_lamp") or (t.get("highway") == "crossing" and t.get("crossing") == "traffic_signals")


def _square(t):  # build_city.OSM_QUERIES2["squares"]
    return (t.get("place") == "square" or (t.get("highway") == "pedestrian" and t.get("area") == "yes")
            or t.get("area:highway") in ("pedestrian", "footway", "living_street") or t.get("landuse") == "pedestrian")


def _square_rel(t):
    return t.get("place") == "square" or t.get("highway") == "pedestrian"


GF_AMENITY = {"cafe", "restaurant", "bar", "pub", "fast_food", "ice_cream", "bakery", "biergarten", "nightclub", "pharmacy",
              "bank", "post_office", "dentist", "doctors", "veterinary", "driving_school", "marketplace", "food_court"}  # groundfloor.AMENITY


def _venue(t):  # groundfloor.QUERY
    return ("shop" in t or t.get("amenity") in GF_AMENITY or "craft" in t or ("office" in t and "addr:housenumber" in t)
            or t.get("tourism") in ("hotel", "hostel", "gallery"))


def _street_node(t):  # build_city.OSM_QUERIES2["street_nodes"]
    return (t.get("amenity") in ("bench", "waste_basket", "recycling", "bicycle_parking") or t.get("leisure") == "picnic_table"
            or t.get("barrier") == "bollard" or t.get("highway") == "bus_stop"
            or (t.get("amenity") == "shelter" and t.get("shelter_type") == "public_transport"))


QUERIES = {  # build_city.OSM_QUERIES / OSM_QUERIES2 as select() arguments
    "roads": {"way": lambda t: "highway" in t},
    "water_parks": {"way": _water_park, "relation": _water_park},
    "nodes": {"node": _signal_lamp},
    "squares": {"way": _square, "relation": _square_rel},
    "groundfloor": {"way": _venue, "relation": _venue, "node": _venue, "center": True},
    "street_nodes": {"node": _street_node},
}


def emulate(key: str, elements: list[dict]) -> dict:
    """The Overpass `out geom` answer to build_city.OSM_QUERIES[key], rebuilt from map elements."""
    if key not in QUERIES:
        raise KeyError(f"no emulation for {key!r}")
    return select(elements, **QUERIES[key])
