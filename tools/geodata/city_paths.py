#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["shapely>=2"]
# ///
"""Gravel paths in the green areas: a post-process of the tile layers (after city_water.py, whose `green` polygons it reads).

Every OSM footway / path / pedestrian way (the `footway` class of the tiles' roads layer) is buffered to its width, at least MIN_WIDTH_M, and
the part inside the green ground (parks, grass, cemeteries, forest) becomes a `gravel` surface polygon in the tile's surfaces layer, marked
`path: 1` and with src `derived:park-path` (a rerun takes those out first). Run the build's index stage afterwards: a tile may get a
surfaces layer it did not have.

    uv run tools/geodata/city_paths.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from shapely.geometry import LineString, Polygon, box
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).resolve().parent))
import frame  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
MIN_WIDTH_M = 1.8
MIN_AREA_M2 = 1.0
ORD_BASE = 1_000_000  # the path polygons' place in the source list, after every register polygon


def read(p: Path):
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def ring_of(coords):
    return [round(v, 2) for c in list(coords)[:-1] for v in c]


def path_strips(roads, green):
    """The green part of the footways, as one (multi)polygon."""
    strips = []
    for r in roads:
        p = r.get("pts") or []
        if r.get("class") != "footway" or len(p) < 4:
            continue
        line = LineString(list(zip(p[0::2], p[1::2])))
        if line.length > 0.5:
            strips.append(line.buffer(max(r.get("width") or 0, MIN_WIDTH_M) / 2, join_style="round"))
    if not strips or green.is_empty:
        return Polygon()
    return unary_union(strips).intersection(green)


def polys_for_tile(strips, bounds):
    out = []
    part = strips.intersection(box(*bounds))
    for q in getattr(part, "geoms", [part]):
        if q.geom_type != "Polygon" or q.area < MIN_AREA_M2:
            continue
        q = q.simplify(0.1, preserve_topology=True)
        doc = {"cls": "gravel", "material": "fine_gravel", "space": "path", "src": ["derived:park-path"], "conf": "inferred", "path": 1, "ring": ring_of(q.exterior.coords)}
        if q.interiors:
            doc["holes"] = [ring_of(h.coords) for h in q.interiors]
        out.append(doc)
    return out


def write_tile(tiles_dir: Path, tid: str, polys) -> None:
    path = tiles_dir / tid / "surfaces.json"
    doc = read(path) or {"tile": tid, "ord": {}, "surfaces": []}
    ord_ = list((doc.get("ord") or {}).get("surfaces") or range(len(doc["surfaces"])))
    keep = [(s, o) for s, o in zip(doc["surfaces"], ord_) if not s.get("path")]
    surfaces = [s for s, _ in keep] + polys
    if not surfaces and not doc.get("markings"):
        if path.exists():
            path.unlink()
        return
    for i, s in enumerate(polys):
        s["id"] = f"path:{tid}:{i}"
    doc["surfaces"] = surfaces
    doc.setdefault("ord", {})["surfaces"] = [o for _, o in keep] + [ORD_BASE + i for i in range(len(polys))]
    path.write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")


def main() -> int:
    tiles_dir = ROOT / "data" / "tiles"
    ids = sorted(read(tiles_dir / "index.json")["tiles"])
    roads, green = [], []
    for tid in ids:
        roads += (read(tiles_dir / tid / "roads.json") or {}).get("roads") or []
        for g in (read(tiles_dir / tid / "water.json") or {}).get("green") or []:
            r = g["ring"]
            poly = Polygon(list(zip(r[0::2], r[1::2])), [list(zip(h[0::2], h[1::2])) for h in g.get("holes") or []]).buffer(0)
            if not poly.is_empty:
                green.append(poly)
    strips = path_strips(roads, unary_union(green) if green else Polygon())
    n = 0
    for tid in ids:
        polys = polys_for_tile(strips, frame.tile_bounds_local(tid))
        write_tile(tiles_dir, tid, polys)
        n += len(polys)
    print(f"park paths: {n} gravel polygons, {strips.area / 1e4:.2f} ha")
    return 0


if __name__ == "__main__":
    sys.exit(main())
