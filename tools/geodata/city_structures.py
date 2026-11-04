#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "shapely>=2", "pyproj", "rasterio"]
# ///
"""Bridges and railways -> the post layer `structures` (aalborg-structures/1): a post-process of the tile compiler, like city_water.py.

    data/tiles/<id>/structures.json   per tile: `decks` (every bridge structure touching the tile, whole) and `rails` (every track
                                      touching it, whole; the engine dedupes both by id)
    data/city/structures.json         header: counts, sources, method
    data/city/post.json               registers the layer under `structures`

**Decks.** OSM ways with bridge=* (roads, paths, busways and railways; not tunnels) and the OSM man_made=bridge outlines. A structure is
the union of the outlines and of the bridge ways' strips (the way buffered to its width, flat ends) where no outline covers them; the
ways it carries are its `axes`, each a centreline with the deck top every DECK_STEP_M (`pts` flat [x, z, deck y, ground y, ...]). The deck
top is the DHM surface model (compiled terrain + the DSM - DTM rasters furniture_dk.py caches, data/raw/veg/ndsm_<cell>.tif) across the
way at each station (median), smoothed, never under the terrain. The outline (`ring`, `holes`) is densified to RING_STEP_M with the ground
under every vertex (`ringG`, `holesG`), so the engine draws a deck without waiting for the terrain of every tile it spans. `clear` is the
most the deck stands over the ground (0 for a deck on the ground).

**Rails.** OSM railway=rail / light_rail / narrow_gauge / preserved / tram and disused tracks (not abandoned, razed, platforms; not in
tunnels): one track per way, `kind` main / branch / siding / yard / spur / disused, `bridge` 1 where the way is tagged a bridge (the
engine lays it on the deck there; elsewhere on the terrain); `pts` flat [x, z, y, ...] with the height the track lies at.

    uv run tools/geodata/city_structures.py

Map data © OpenStreetMap contributors (ODbL); DHM © Klimadatastyrelsen (CC BY 4.0).
"""
from __future__ import annotations

import glob
import json
import math
import os
import sys
import time
from pathlib import Path

import numpy as np
import shapely
from shapely import STRtree
from shapely.geometry import LineString, Polygon, box
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).resolve().parent))
import frame  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
RAW_OSM = ROOT / "data" / "raw" / "city" / "osm_api"
VEG = ROOT / "data" / "raw" / "veg"
VERSION = "aalborg-structures/1"
DECK_STEP_M = 2.0
RING_STEP_M = 3.0
RAIL_STEP_M = 4.0
# deck width by what the bridge carries (OSM width wins): carriageway + pavements for roads, a track bed per track for railways
ROAD_W = {"motorway": 16.0, "trunk": 14.0, "primary": 14.0, "secondary": 12.0, "tertiary": 10.0, "residential": 8.0, "unclassified": 8.0,
          "living_street": 7.0, "service": 5.0, "busway": 8.0, "cycleway": 3.0, "footway": 3.0, "path": 2.5, "pedestrian": 5.0, "steps": 2.5,
          "track": 3.5, "bridleway": 3.0}
RAIL_W = 4.6  # m of deck per track
RAILWAYS = ("rail", "light_rail", "narrow_gauge", "preserved", "tram", "disused")
OUTLINE_GROW_M = 0.5  # a bridge way within this of an outline belongs to it
MAX_DECK_OVER_M = 30.0
WATER_REACH_M = 3.0  # a deck point this close to the water stands over the water  # a DSM sample this far over the terrain is not a deck (a crane, a building edge)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


def read_json(p: Path):
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def load_osm(raw: Path = RAW_OSM) -> dict:
    els = {}
    for p in sorted(glob.glob(str(raw / "map_*.json"))):
        for el in json.loads(Path(p).read_text(encoding="utf-8"))["elements"]:
            els[(el["type"], el["id"])] = el
    return els


class Heights:
    """Terrain (the compiled tiles) and the DHM surface model (terrain + DSM - DTM at 1 m) at local x / z."""

    def __init__(self, tiles_dir: Path, meta: dict):
        import city_water as CW
        import rasterio

        self.dtm = CW.Dtm(tiles_dir, meta["terrain"])
        # the water the water build made (city_water.py): under a bridge over it the ground is the water, not the terrain (the compiled
        # terrain carries the fjord bridges' decks across the water)
        self.water, self.levels = [], []
        for wp in sorted(tiles_dir.glob("*/water.json")):
            for body in (read_json(wp) or {}).get("bodies") or []:
                for poly in body.get("polys") or []:
                    r = poly.get("ring") or []
                    if len(r) >= 6:
                        g = Polygon(list(zip(r[0::2], r[1::2])), [list(zip(h[0::2], h[1::2])) for h in poly.get("holes") or [] if len(h) >= 6]).buffer(0)
                        if not g.is_empty:
                            # grown: the water build leaves the bridge strip out, so a deck's outline runs along the water's edge
                            self.water.append(g.buffer(WATER_REACH_M))
                            self.levels.append(float(body["level"]))
        self.wtree = STRtree(self.water) if self.water else None
        self.nd = []
        for p in sorted(VEG.glob("ndsm_*.tif")):
            with rasterio.open(p) as r:
                self.nd.append((r.read(1).astype(np.float32), r.transform))

    def terrain(self, x, z):
        return self.dtm.at(x, z)

    def ground(self, x, z):
        """What lies under a deck: the water level over the water, else the terrain."""
        x = np.atleast_1d(np.asarray(x, float))
        z = np.atleast_1d(np.asarray(z, float))
        g = self.dtm.at(x, z)
        if self.wtree is not None:
            pts = shapely.points(x, z)
            hit = self.wtree.query(pts, predicate="within")
            for i, j in zip(hit[0], hit[1]):
                g[i] = min(g[i], self.levels[j]) if np.isfinite(g[i]) else self.levels[j]
        return g

    def ndsm(self, x, z):
        x = np.atleast_1d(np.asarray(x, float))
        z = np.atleast_1d(np.asarray(z, float))
        e = x + frame.ORIGIN[0]
        n = frame.ORIGIN[1] - z
        out = np.full(x.shape, np.nan)
        for a, t in self.nd:
            c = np.floor((e - t.c) / t.a).astype(int)
            r = np.floor((n - t.f) / t.e).astype(int)
            ok = (r >= 0) & (c >= 0) & (r < a.shape[0]) & (c < a.shape[1]) & np.isnan(out)
            out[ok] = a[r[ok], c[ok]]
        return out

    def surface(self, x, z):
        t = self.terrain(x, z)
        d = self.ndsm(x, z)
        return t + np.where(np.isnan(d), 0.0, np.clip(d, 0.0, MAX_DECK_OVER_M))


def to_local_line(w, els, tr):
    pts = []
    for nid in w.get("nodes", []):
        n = els.get(("node", nid))
        if n:
            pts.append(frame.to_local(*tr.transform(n["lon"], n["lat"])))
    return pts


def width_of(tags) -> float:
    try:
        w = float(str(tags.get("width") or tags.get("est_width") or "").split(";")[0].replace(",", "."))
        if w > 0:
            return min(w + (2.0 if "highway" in tags and tags["highway"] not in ("footway", "cycleway", "path", "steps") else 0.6), 40.0)
    except ValueError:
        pass
    if "railway" in tags:
        return RAIL_W * max(1, int(str(tags.get("tracks", "1")).split(";")[0] or 1))
    return ROAD_W.get(tags.get("highway"), 6.0)


def deck_profile(pts, width, H, narrow=False):
    """Deck top (y) every DECK_STEP_M along a bridge centreline: the median DHM surface across the deck at each station, smoothed."""
    line = LineString(pts)
    n = max(2, int(math.ceil(line.length / DECK_STEP_M)) + 1)
    st = [line.interpolate(i / (n - 1), normalized=True) for i in range(n)]
    half = max(0.5, width / 2 - 0.8)
    offs = np.arange(-half, half + 0.01, 1.0)
    ys, ts = [], []
    for i, p in enumerate(st):
        a = st[max(0, i - 1)]
        b = st[min(n - 1, i + 1)]
        dx, dz = b.x - a.x, b.y - a.y
        l = math.hypot(dx, dz) or 1.0
        nx, nz = -dz / l, dx / l
        xs, zs = p.x + nx * offs, p.y + nz * offs
        s = H.surface(xs, zs)
        t = H.ground(np.array([p.x]), np.array([p.y]))[0]
        s = s[~np.isnan(s)]
        ys.append(float(np.median(s)) if len(s) else float(t))
        ts.append(float(t) if not np.isnan(t) else ys[-1])
    ys, ts = np.array(ys, float), np.array(ts, float)
    # stations off the compiled terrain (a bridge running out of the district): the rest of the axis stands in
    fill = float(np.nanmedian(ts)) if np.isfinite(ts).any() else -frame.ORIGIN[2]
    ts = np.where(np.isfinite(ts), ts, fill)
    ys = np.where(np.isfinite(ys), ys, ts)
    # a narrow deck (a footway, a cycle path) samples its own railings: a wider window evens it out
    hw, mw = (7, 5) if narrow else (3, 2)
    med = np.array([np.median(ys[max(0, i - hw):i + hw + 1]) for i in range(n)])
    sm = np.array([med[max(0, i - mw):i + mw + 1].mean() for i in range(n)])
    sm = np.maximum(sm, ts)
    return [(round(p.x, 2), round(p.y, 2), round(float(y), 2), round(float(g), 2)) for p, y, g in zip(st, sm, ts)], float(np.max(sm - ts))


def densify_ring(coords, step):
    out = []
    n = len(coords)
    for i in range(n):
        ax, az = coords[i]
        bx, bz = coords[(i + 1) % n]
        k = max(1, int(math.ceil(math.hypot(bx - ax, bz - az) / step)))
        for j in range(k):
            out.append((ax + (bx - ax) * j / k, az + (bz - az) * j / k))
    return out


def ring_with_ground(coords, H):
    pts = densify_ring(coords, RING_STEP_M)
    g = H.ground(np.array([p[0] for p in pts]), np.array([p[1] for p in pts]))
    g = np.where(np.isnan(g), 0.0, g)
    return [round(v, 2) for p in pts for v in p], [round(float(v), 2) for v in g]


def build(tiles_dir: Path, city_dir: Path) -> dict:
    from pyproj import Transformer

    tr = Transformer.from_crs(4326, 25832, always_xy=True)
    els = load_osm()
    meta = read_json(city_dir / "meta.json")
    H = Heights(tiles_dir, meta)
    index = read_json(tiles_dir / "index.json")
    ids = sorted(index["tiles"])
    tboxes = {t: box(*frame.tile_bounds_local(t)) for t in ids}
    area = unary_union(list(tboxes.values())).buffer(60.0)

    # ---- bridge ways and outlines
    ways, outlines = [], []
    for (t, i), w in els.items():
        if t != "way":
            continue
        tags = w.get("tags", {})
        if tags.get("man_made") == "bridge" and w["nodes"][0] == w["nodes"][-1]:
            pts = to_local_line(w, els, tr)
            if len(pts) >= 4:
                g = Polygon(pts).buffer(0)
                if g.intersects(area):
                    outlines.append({"id": f"osm:way/{i}", "name": tags.get("name", ""), "poly": g})
            continue
        if tags.get("bridge") in (None, "no") or tags.get("tunnel") not in (None, "no"):
            continue
        if not ("highway" in tags or tags.get("railway") in RAILWAYS + ("rail",)):
            continue
        pts = to_local_line(w, els, tr)
        if len(pts) < 2 or not LineString(pts).intersects(area):
            continue
        kind = "rail" if "railway" in tags else "foot" if tags.get("highway") in ("footway", "cycleway", "path", "steps", "pedestrian", "bridleway") else "road"
        ways.append({"id": f"osm:way/{i}", "tags": tags, "pts": pts, "kind": kind, "width": width_of(tags), "name": tags.get("name") or tags.get("bridge:name") or ""})
    log(f"bridges: {len(ways)} OSM bridge ways, {len(outlines)} man_made=bridge outlines")

    # ---- structures: outlines + the strips no outline covers, grouped where they touch
    otree = STRtree([o["poly"] for o in outlines]) if outlines else None
    pieces = []  # (polygon, way index or None, outline index or None)
    for k, o in enumerate(outlines):
        pieces.append((o["poly"], None, k))
    for k, w in enumerate(ways):
        strip = LineString(w["pts"]).buffer(w["width"] / 2, cap_style="flat", join_style="mitre", mitre_limit=3.0)
        if otree is not None:
            cover = [outlines[j]["poly"] for j in otree.query(strip, predicate="intersects")]
            if cover:
                strip = strip.difference(unary_union(cover).buffer(OUTLINE_GROW_M))
        if not strip.is_empty and strip.area > 1.0:
            pieces.append((strip, k, None))
    polys = [p for p, _, _ in pieces]
    merged = unary_union([p.buffer(0.15) for p in polys]).buffer(-0.15)
    groups = list(merged.geoms) if hasattr(merged, "geoms") else [merged]
    decks = []
    wtree = STRtree([LineString(w["pts"]) for w in ways])
    for g in groups:
        if g.is_empty or g.area < 4.0:
            continue
        members = [j for j in wtree.query(g.buffer(OUTLINE_GROW_M), predicate="intersects")]
        # a member is a way that runs inside the structure for most of its length (not one that only touches its end)
        members = [j for j in members if LineString(ways[j]["pts"]).intersection(g.buffer(OUTLINE_GROW_M)).length > 0.5 * LineString(ways[j]["pts"]).length]
        if not members:
            continue
        axes, clear = [], 0.0
        for j in members:
            prof, c = deck_profile(ways[j]["pts"], ways[j]["width"], H, narrow=ways[j]["width"] < 5)
            axes.append({"way": ways[j]["id"], "kind": ways[j]["kind"], "pts": [v for p in prof for v in p]})
            clear = max(clear, c)
        names = [outlines[k]["name"] for k in (otree.query(g, predicate="intersects") if otree is not None else []) if outlines[k]["name"]]
        names += [ways[j]["name"] for j in members if ways[j]["name"]]
        kinds = {ways[j]["kind"] for j in members}
        kind = "rail" if kinds == {"rail"} else "road" if "road" in kinds or "rail" in kinds else "foot"
        g = g.simplify(0.25, preserve_topology=True)
        ext, ext_g = ring_with_ground(list(g.exterior.coords)[:-1], H)
        holes, holes_g = [], []
        for h in g.interiors:
            hr, hg = ring_with_ground(list(h.coords)[:-1], H)
            holes.append(hr)
            holes_g.append(hg)
        decks.append({"id": f"deck:{len(decks)}", "name": names[0] if names else "", "kind": kind, "ring": ext, "ringG": ext_g, "holes": holes,
                      "holesG": holes_g, "axes": axes, "clear": round(clear, 2), "_g": g})
    log(f"decks: {len(decks)} structures, {sum(d['_g'].area for d in decks) / 1e4:.2f} ha; {sum(1 for d in decks if d['clear'] > 2.5)} stand over 2.5 m")

    # ---- rails
    rails = []
    for (t, i), w in els.items():
        if t != "way":
            continue
        tags = w.get("tags", {})
        rw = tags.get("railway")
        if rw not in RAILWAYS or tags.get("tunnel") not in (None, "no"):
            continue
        pts = to_local_line(w, els, tr)
        if len(pts) < 2 or not LineString(pts).intersects(area):
            continue
        kind = "disused" if rw == "disused" else tags.get("service") or tags.get("usage") or "main"
        bridge = tags.get("bridge") not in (None, "no")
        line = LineString(pts)
        n = max(2, int(math.ceil(line.length / RAIL_STEP_M)) + 1)
        st = [line.interpolate(k / (n - 1), normalized=True) for k in range(n)]
        xs, zs = np.array([q.x for q in st]), np.array([q.y for q in st])
        ys = H.terrain(xs, zs)
        if bridge:  # on its deck: the deck top of the structure it runs on
            for k, q in enumerate(st):
                for d in decks:
                    if d["_g"].buffer(0.5).contains(q):
                        from_axes = [(a["pts"][m], a["pts"][m + 1], a["pts"][m + 2]) for a in d["axes"] for m in range(0, len(a["pts"]), 4)]
                        best = min(from_axes, key=lambda v: (v[0] - q.x) ** 2 + (v[1] - q.y) ** 2)
                        ys[k] = max(ys[k], best[2])
                        break
        ys = np.where(np.isnan(ys), 0.0, ys)
        rails.append({"id": f"osm:way/{i}", "kind": kind, "bridge": 1 if bridge else 0,
                      "pts": [round(float(v), 2) for q, y in zip(st, ys) for v in (q.x, q.y, y)], "_g": line})
    log(f"rails: {len(rails)} tracks, {sum(r['_g'].length for r in rails) / 1000:.1f} km ({sum(1 for r in rails if r['bridge'])} on bridges)")

    # ---- per tile
    out = {}
    dtree = STRtree([d["_g"] for d in decks]) if decks else None
    rtree = STRtree([r["_g"] for r in rails]) if rails else None
    for tid in ids:
        b = tboxes[tid]
        ds = [decks[j] for j in dtree.query(b, predicate="intersects")] if dtree else []
        rs = [rails[j] for j in rtree.query(b, predicate="intersects")] if rtree else []
        if ds or rs:
            out[tid] = {"tile": tid, "decks": [{k: v for k, v in d.items() if k != "_g"} for d in sorted(ds, key=lambda d: d["id"])],
                        "rails": [{k: v for k, v in r.items() if k != "_g"} for r in sorted(rs, key=lambda r: r["id"])]}
    return {"tiles": out, "stats": {"decks": len(decks), "deck_ha": round(sum(d["_g"].area for d in decks) / 1e4, 2),
                                    "high_decks": sum(1 for d in decks if d["clear"] > 2.5), "rails": len(rails),
                                    "rail_km": round(sum(r["_g"].length for r in rails) / 1000, 2), "tiles": len(out)}}


def update_manifest(city_dir: Path, key: str, value) -> None:
    p = city_dir / "post.json"
    doc = read_json(p) or {"version": "cph-post/1"}
    doc[key] = value
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, indent=1))
    os.replace(tmp, p)


def main() -> int:
    tiles_dir, city_dir = ROOT / "data" / "tiles", ROOT / "data" / "city"
    res = build(tiles_dir, city_dir)
    sizes = {}
    for tid, lay in res["tiles"].items():
        text = json.dumps(lay, separators=(",", ":"), ensure_ascii=False)
        (tiles_dir / tid / "structures.json").write_text(text, encoding="utf-8")
        sizes[tid] = len(text.encode())
    for p in tiles_dir.glob("*/structures.json"):
        if p.parent.name not in res["tiles"]:
            p.unlink()
    header = {"version": VERSION, "stats": res["stats"],
              "method": "OSM bridge ways and man_made=bridge outlines, deck tops from the DHM surface model; OSM railway tracks; "
                        "tools/geodata/city_structures.py",
              "attribution": "© OpenStreetMap contributors (ODbL); DHM © Klimadatastyrelsen (CC BY 4.0)"}
    text = json.dumps(header, separators=(",", ":"), ensure_ascii=False)
    (city_dir / "structures.json").write_text(text, encoding="utf-8")
    update_manifest(city_dir, "structures", {"header": "structures.json", "bytes": len(text.encode()), "tiles": sizes})
    log(f"wrote {len(sizes)} tile layers; {res['stats']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
