#!/usr/bin/env python3
"""The overview map's ground (js/overview-map.js) -> data/city/map.json (aalborg-map/1), one file the map reads at start, before any
tile streams in.

From the compiled tiles (data/tiles/<id>/): building footprints with their height above the ground (buildings.json, the map's three
tones), water bodies (water.json, sea flagged), parks with their names (roads.json) and the green ground (water.json `green`:
GeoDanmark recreation areas, cemeteries, woods), plus labels for the named water bodies and parks at the centre of their largest
piece. The streets and their names come from data/city/roadgraph.json, which the engine already loads.

Coordinates are the twin's local frame (frame.py), rounded to 0.1 m; rings are flat [x0, z0, x1, z1, ...]. build_city.py's `index`
stage writes it (and names it in data/tiles/index.json `city.map`, so the hosting packs carry it); standalone:

    python3 -X utf8 tools/geodata/city_map.py [--tiles data/tiles] [--out data/city/map.json]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERSION = "aalborg-map/1"
LABEL_MIN_M2 = 4000.0  # parks and water smaller than this get no name label
PARK_MIN_M2 = 150.0


def r1(ring):
    return [round(v, 1) for v in ring]


def area(ring) -> float:
    n = len(ring) // 2
    return abs(sum(ring[2 * i] * ring[2 * ((i + 1) % n) + 1] - ring[2 * ((i + 1) % n)] * ring[2 * i + 1] for i in range(n))) / 2


def centroid(ring):
    """Area centroid of a flat ring (vertex mean for a degenerate one)."""
    n = len(ring) // 2
    a = cx = cz = 0.0
    for i in range(n):
        x0, z0, x1, z1 = ring[2 * i], ring[2 * i + 1], ring[2 * ((i + 1) % n)], ring[2 * ((i + 1) % n) + 1]
        c = x0 * z1 - x1 * z0
        a += c
        cx += (x0 + x1) * c
        cz += (z0 + z1) * c
    if abs(a) < 1e-9:
        return sum(ring[0::2]) / n, sum(ring[1::2]) / n
    return cx / (3 * a), cz / (3 * a)


def build(tiles_dir: Path, water_header: dict | None) -> dict:
    buildings, water, parks, green = [], [], [], []
    named: dict[tuple[str, str], tuple[float, list]] = {}  # (kind, name) -> (area, ring) of the largest piece
    seen_parks: set[str] = set()
    sea_ids = {b["id"] for b in (water_header or {}).get("bodies", []) if b.get("sea")}
    names = {b["id"]: b.get("name") or "" for b in (water_header or {}).get("bodies", [])}
    bounds = [float("inf"), float("inf"), float("-inf"), float("-inf")]
    for d in sorted(p for p in tiles_dir.iterdir() if p.is_dir()):
        bp = d / "buildings.json"
        if bp.exists():
            for b in json.loads(bp.read_text(encoding="utf-8"))["buildings"]:
                if b.get("below_ground"):
                    continue
                ring = b.get("ring") or []
                if len(ring) < 6:
                    continue
                h = max(0.0, (b.get("eave") or 0.0) - (b.get("ground") or 0.0))
                buildings.append({"h": round(h, 1), "r": r1(ring)})
                bounds = [min(bounds[0], *ring[0::2]), min(bounds[1], *ring[1::2]), max(bounds[2], *ring[0::2]), max(bounds[3], *ring[1::2])]
        wp = d / "water.json"
        if wp.exists():
            doc = json.loads(wp.read_text(encoding="utf-8"))
            for body in doc.get("bodies", []):
                for q in body.get("polys", []):
                    rec = {"r": r1(q["ring"])}
                    if q.get("holes"):
                        rec["holes"] = [r1(h) for h in q["holes"]]
                    if body.get("id") in sea_ids or body.get("kind") == "sea":
                        rec["sea"] = True
                    water.append(rec)
                    nm = names.get(body.get("id"), "")
                    if nm:
                        a = area(q["ring"])
                        if a > named.get(("water", nm), (0.0,))[0]:
                            named[("water", nm)] = (a, q["ring"])
            for g in doc.get("green", []):
                if len(g.get("ring", [])) >= 6:
                    green.append({"r": r1(g["ring"])})
        rp = d / "roads.json"
        if rp.exists():
            for p in json.loads(rp.read_text(encoding="utf-8")).get("parks", []):
                ring = p.get("ring") or []
                if len(ring) < 6 or p.get("id") in seen_parks or area(ring) < PARK_MIN_M2:
                    continue
                seen_parks.add(p.get("id"))
                parks.append({"r": r1(ring)})
                if p.get("name"):
                    a = area(ring)
                    if a > named.get(("park", p["name"]), (0.0,))[0]:
                        named[("park", p["name"])] = (a, ring)
    labels = []
    for (kind, name), (a, ring) in sorted(named.items(), key=lambda kv: -kv[1][0]):
        if a < LABEL_MIN_M2:
            continue
        x, z = centroid(ring)
        labels.append({"text": name, "x": round(x, 1), "z": round(z, 1), "kind": kind, "area_m2": round(a)})
    return {
        "version": VERSION,
        "frame": "local (frame.py): x east, z south, metres",
        "bbox": [round(v, 1) for v in bounds] if buildings else None,
        "attribution": ["GeoDanmark, BBR (Klimadatastyrelsen / SDFI, via datagrundlag.dk)", "© OpenStreetMap contributors (ODbL)"],
        "buildings": buildings, "water": water, "parks": parks, "green": green, "labels": labels,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--tiles", default=str(ROOT / "data" / "tiles"))
    ap.add_argument("--water", default=str(ROOT / "data" / "city" / "water.json"))
    ap.add_argument("--out", default=str(ROOT / "data" / "city" / "map.json"))
    a = ap.parse_args()
    wp = Path(a.water)
    doc = build(Path(a.tiles), json.loads(wp.read_text(encoding="utf-8")) if wp.exists() else None)
    out = Path(a.out)
    txt = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    tmp = out.with_suffix(".json.tmp")
    tmp.write_text(txt, encoding="utf-8")
    tmp.replace(out)
    print(f"wrote {out}: {len(doc['buildings'])} buildings, {len(doc['water'])} water, {len(doc['parks'])} parks, {len(doc['green'])} green, "
          f"{len(doc['labels'])} labels, {len(txt) / 1e6:.2f} MB", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
