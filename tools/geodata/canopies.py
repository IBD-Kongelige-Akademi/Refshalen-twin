#!/usr/bin/env python3
"""Open canopies: GeoDanmark buildings that are a roof on pillars, not a closed building -> a `base` in the tile's buildings.json.

GeoDanmark registers the roof outline of a canopy (the J.F. Kennedys Plads bus terminal, petrol station roofs) as a Bygning
standing on the ground, so the twin draws and collides it as a solid block across the busway under it. A building counts as a
canopy when it has no BBR record, an OSM building=roof covers at least half of it, and it stands at least MIN_HEIGHT tall (smaller
roofs are bike and bin shelters, solid enough). Its `base` is the underside of the roof deck: DECK below the eave, at least
MIN_CLEARANCE above the ground. The engine starts the walls and the collider there (js/building-geometry.js, js/static-colliders.js)
and draws it without its LoD2 record (whose walls reach the ground). The pillars are not modelled.

build_city.py runs it as the `canopies` stage (after lod2, before index); idempotent. Standalone:

    uv run --no-project --with pyproj --with shapely python -X utf8 tools/geodata/canopies.py

Map data © OpenStreetMap contributors (ODbL); the OSM API cache is data/raw/city/osm_api/ (osm_api.py).
"""
from __future__ import annotations

import glob
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import frame  # noqa: E402

RAW = ROOT / "data" / "raw" / "city" / "osm_api"
TILES = ROOT / "data" / "tiles"
MIN_COVER = 0.5  # share of the building's footprint under an OSM building=roof
MIN_HEIGHT = 3.5  # m eave over ground: lower roofs (bike shelters) stay solid
DECK = 0.8  # m from the eave down to the underside of the roof
MIN_CLEARANCE = 2.6  # m: the underside is never lower than this over the ground


def osm_roofs(raw: Path) -> list:
    """OSM building=roof outlines in the local frame, as shapely polygons."""
    from pyproj import Transformer
    from shapely.geometry import Polygon

    els = {}
    for p in sorted(glob.glob(str(raw / "map_*.json"))):
        for el in json.loads(Path(p).read_text(encoding="utf-8"))["elements"]:
            els[(el["type"], el["id"])] = el
    tr = Transformer.from_crs(4326, 25832, always_xy=True)
    out = []
    for (t, _), w in els.items():
        if t != "way" or w.get("tags", {}).get("building") != "roof" or len(w.get("nodes", [])) < 4:
            continue
        pts = [frame.to_local(*tr.transform(els[("node", n)]["lon"], els[("node", n)]["lat"])) for n in w["nodes"] if ("node", n) in els]
        if len(pts) >= 4:
            poly = Polygon(pts)
            out.append(poly if poly.is_valid else poly.buffer(0))
    return out


def canopy_base(b: dict, roofs: list) -> float | None:
    """The underside height for building b if it is a canopy, else None."""
    from shapely.geometry import Polygon

    if b.get("bbr_id") or not b.get("ring"):
        return None
    if b["eave"] - b["ground"] < MIN_HEIGHT:
        return None
    r = b["ring"]
    poly = Polygon(list(zip(r[0::2], r[1::2])))
    if not poly.is_valid:
        poly = poly.buffer(0)
    if poly.area <= 0:
        return None
    cover = max((poly.intersection(q).area / poly.area for q in roofs if q.intersects(poly)), default=0.0)
    if cover < MIN_COVER:
        return None
    return round(max(b["ground"] + MIN_CLEARANCE, b["eave"] - DECK), 2)


def apply(tiles_dir: Path = TILES, raw: Path = RAW, write=None) -> list[tuple[str, str, float]]:
    """Set (or clear) `base` on every tile's buildings; returns [(tile, id, base)] of the canopies."""
    roofs = osm_roofs(raw)
    found = []
    for d in sorted(p for p in tiles_dir.iterdir() if p.is_dir()):
        path = d / "buildings.json"
        if not path.exists():
            continue
        doc = json.loads(path.read_text(encoding="utf-8"))
        changed = False
        for b in doc.get("buildings", []):
            base = canopy_base(b, roofs)
            if base is None and "base" in b:
                del b["base"]
                changed = True
            elif base is not None:
                found.append((d.name, b["id"], base))
                if b.get("base") != base:
                    b["base"] = base
                    changed = True
        if changed:
            txt = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
            (write or (lambda p, t: p.write_text(t, encoding="utf-8")))(path, txt)
    return found


def main() -> None:
    for tile, bid, base in apply():
        print(f"[canopies] {tile} {bid}: underside at {base} m", file=sys.stderr)


if __name__ == "__main__":
    main()
