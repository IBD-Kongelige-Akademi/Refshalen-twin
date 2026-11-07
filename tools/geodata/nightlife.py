#!/usr/bin/env python3
"""Nightlife venues (bars, pubs, nightclubs) at their street fronts -> data/city/nightlife.json (aalborg-nightlife/1).

The engine (js/nightlife.js, js/nightlife-scene.js, js/nightlife-audio.js) lights their fronts with neon and coloured spill and
plays muffled beats from them after dark, and clusters them into strips (Jomfru Ane Gade) where the evening crowd gathers.

Source: the cached OSM ground-floor layer (data/raw/city/osm_groundfloor.json, written by groundfloor.py): amenity = bar, pub,
nightclub, biergarten. An OSM point usually sits inside its building; its FRONT is where the line from the point to the nearest
named street leaves the building (the street-facing wall), with the wall's outward normal. Venues further than FRONT_REACH from a
street are left out. Coordinates are the local frame (frame.py), rounded to 0.01 m.

    uv run --no-project --with pyproj python -X utf8 tools/geodata/nightlife.py [--out data/city/nightlife.json]

The tile index (data/tiles/index.json, build_city.py) names the file as city.nightlife, so the packed data carries it.
Map data © OpenStreetMap contributors (ODbL).
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import frame  # noqa: E402

VERSION = "aalborg-nightlife/1"
RAW = ROOT / "data" / "raw" / "city" / "osm_groundfloor.json"
TILES = ROOT / "data" / "tiles"
OUT = ROOT / "data" / "city" / "nightlife.json"
KINDS = ("nightclub", "bar", "pub", "biergarten")
STREET_SKIP = {"service", "track", "motorway", "motorway_link", "trunk", "trunk_link"}
STREET_REACH = 40.0  # m from the OSM point to the street centreline it may face
FRONT_REACH = 25.0  # m from the front to that street: further and the venue is not on a street
BACK = 20.0  # m behind the OSM point the ray starts (a point drawn outside its building still finds the wall)


def closest(px: float, pz: float, x0: float, z0: float, x1: float, z1: float) -> tuple[float, float, float]:
    dx, dz = x1 - x0, z1 - z0
    l2 = dx * dx + dz * dz or 1.0
    t = max(0.0, min(1.0, ((px - x0) * dx + (pz - z0) * dz) / l2))
    cx, cz = x0 + dx * t, z0 + dz * t
    return cx, cz, math.hypot(cx - px, cz - pz)


def nearest_street(x: float, z: float, roads: list[dict]) -> tuple[dict, float, float, float] | None:
    best = None
    for r in roads:
        p = r["pts"]
        for i in range(0, len(p) - 3, 2):
            cx, cz, d = closest(x, z, p[i], p[i + 1], p[i + 2], p[i + 3])
            if d <= STREET_REACH and (best is None or d < best[3]):
                best = (r, cx, cz, d)
    return best


def seg_hit(ax, az, bx, bz, cx, cz, dx, dz):
    """Parameter t along a->b where it crosses c->d, or None."""
    rx, rz, sx, sz = bx - ax, bz - az, dx - cx, dz - cz
    den = rx * sz - rz * sx
    if abs(den) < 1e-9:
        return None
    t = ((cx - ax) * sz - (cz - az) * sx) / den
    u = ((cx - ax) * rz - (cz - az) * rx) / den
    return t if 0.0 <= t <= 1.0 and 0.0 <= u <= 1.0 else None


def front_of(x: float, z: float, sx: float, sz: float, walls: list[tuple[float, float, float, float]]):
    """The street-facing wall crossing on the ray from behind (x, z) to the street point (sx, sz): (fx, fz, nx, nz) or None."""
    d = math.hypot(sx - x, sz - z)
    if d < 1e-6:
        return None
    ux, uz = (sx - x) / d, (sz - z) / d
    ax, az = x - ux * BACK, z - uz * BACK
    best = None
    for w in walls:
        t = seg_hit(ax, az, sx, sz, *w)
        if t is not None and (best is None or t > best[0]):
            best = (t, w)
    if best is None:
        return None
    t, (x0, z0, x1, z1) = best
    fx, fz = ax + (sx - ax) * t, az + (sz - az) * t
    wl = math.hypot(x1 - x0, z1 - z0) or 1.0
    nx, nz = -(z1 - z0) / wl, (x1 - x0) / wl
    if nx * ux + nz * uz < 0:
        nx, nz = -nx, -nz
    return fx, fz, nx, nz


def venues_from(elements: list[dict], to_local) -> list[dict]:
    out, seen = [], set()
    for el in elements:
        tags = el.get("tags") or {}
        kind = tags.get("amenity")
        if kind not in KINDS:
            continue
        lon = el.get("lon", (el.get("center") or {}).get("lon"))
        lat = el.get("lat", (el.get("center") or {}).get("lat"))
        if lon is None or lat is None:
            continue
        x, z = to_local(lon, lat)
        key = (round(x, 1), round(z, 1))
        if key in seen:
            continue
        seen.add(key)
        out.append({"name": tags.get("name"), "kind": kind, "x": x, "z": z, "hours": tags.get("opening_hours"),
                    "src": f"osm:{el['type']}/{el['id']}"})
    return out


def place(venues: list[dict], roads: list[dict], walls: list[tuple[float, float, float, float]]) -> list[dict]:
    """Each venue at its street front: { name, kind, x, z, nx, nz, street, hours, src }; venues off the streets are dropped."""
    out = []
    for v in venues:
        hit = nearest_street(v["x"], v["z"], roads)
        if not hit:
            continue
        road, sx, sz, _ = hit
        f = front_of(v["x"], v["z"], sx, sz, walls)
        if f is None:
            d = math.hypot(sx - v["x"], sz - v["z"]) or 1.0
            nx, nz = (sx - v["x"]) / d, (sz - v["z"]) / d
            back = min(d, 3.0 + (road.get("width") or 6) / 2)
            f = (sx - nx * back, sz - nz * back, nx, nz)
        fx, fz, nx, nz = f
        if math.hypot(sx - fx, sz - fz) > FRONT_REACH:
            continue
        out.append({"name": v["name"], "kind": v["kind"], "x": round(fx, 2), "z": round(fz, 2), "nx": round(nx, 3), "nz": round(nz, 3),
                    "street": road.get("name"), "hours": v["hours"], "src": v["src"]})
    return out


def load_tiles(bbox: tuple[float, float, float, float]):
    """Named streets and building walls of the tiles that overlap bbox (x0, z0, x1, z1)."""
    roads, walls, ids = [], [], set()
    for d in sorted(glob.glob(str(TILES / "*" / "roads.json"))):
        tile = Path(d).parent
        idx = json.loads((TILES / "index.json").read_text(encoding="utf-8"))["tiles"].get(tile.name)
        if idx:
            lx0, lz0, lx1, lz1 = idx["local"]
            if lx1 < bbox[0] or lx0 > bbox[2] or lz1 < bbox[1] or lz0 > bbox[3]:
                continue
        for r in json.loads(Path(d).read_text(encoding="utf-8")).get("roads", []):
            if r.get("name") and r.get("class") not in STREET_SKIP and len(r.get("pts") or []) >= 4:
                roads.append(r)
        bpath = tile / "buildings.json"
        if bpath.exists():
            for b in json.loads(bpath.read_text(encoding="utf-8")).get("buildings", []):
                if b["id"] in ids:
                    continue
                ids.add(b["id"])
                ring = b["ring"]
                n = len(ring) // 2
                for i in range(n):
                    j = (i + 1) % n
                    walls.append((ring[2 * i], ring[2 * i + 1], ring[2 * j], ring[2 * j + 1]))
    return roads, walls


def register_in_index(rel: str = "../city/nightlife.json") -> None:
    """Names the file in data/tiles/index.json (city.nightlife) so the tile store and the packs find it."""
    p = TILES / "index.json"
    if not p.exists():
        return
    idx = json.loads(p.read_text(encoding="utf-8"))
    if idx.get("city", {}).get("nightlife") == rel:
        return
    idx.setdefault("city", {})["nightlife"] = rel
    p.write_text(json.dumps(idx, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args()
    from pyproj import Transformer

    wgs = Transformer.from_crs(4326, 25832, always_xy=True)
    raw = json.loads(RAW.read_text(encoding="utf-8"))
    venues = venues_from(raw.get("elements", []), lambda lon, lat: frame.to_local(*wgs.transform(lon, lat)))
    if not venues:
        sys.exit("no bars, pubs or nightclubs in the cached ground-floor layer (run groundfloor.py)")
    pad = STREET_REACH + BACK
    bbox = (min(v["x"] for v in venues) - pad, min(v["z"] for v in venues) - pad, max(v["x"] for v in venues) + pad, max(v["z"] for v in venues) + pad)
    roads, walls = load_tiles(bbox)
    placed = place(venues, roads, walls)
    doc = {"version": VERSION, "frame": "cph-geodata local (x east, z south)", "attribution": ["© OpenStreetMap contributors (ODbL)"],
           "venues": placed}
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    if out.resolve() == OUT.resolve():
        register_in_index()
    streets: dict[str, int] = {}
    for v in placed:
        streets[v["street"]] = streets.get(v["street"], 0) + 1
    top = sorted(streets.items(), key=lambda kv: -kv[1])[:4]
    print(f"nightlife: {len(placed)} of {len(venues)} venues at a street front -> {out}; " + ", ".join(f"{k} {n}" for k, n in top))


if __name__ == "__main__":
    main()
