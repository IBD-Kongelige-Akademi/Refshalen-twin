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

import base64
import glob
import json
import math
import os
import sys
import time
from pathlib import Path

import numpy as np
import shapely
import shapely.ops
from shapely import STRtree
from shapely.geometry import LineString, Polygon, box
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).resolve().parent))
import frame  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
RAW_OSM = ROOT / "data" / "raw" / "city" / "osm_api"
VEG = ROOT / "data" / "raw" / "veg"
TERRAIN_ORIG = ROOT / "data" / "city" / "work" / "terrain_orig"  # each tile's terrain layer as the compiler wrote it
UNDER_REACH_M = 2.5  # the ground beside a deck is sampled this far out from its edge
CUT_KINDS = ("sea", "river")  # the water bodies the terrain is cut under (they have shore walls; streams and ponds lie on the ground)
SINK_M = 1.0  # the ground under a bridge over water lies this far under the water level
UNDER_MIN_DROP_M = 0.3  # a terrain cell under a deck is lowered when the ground beside it lies this much lower
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
# ---- what passes under a deck: its ground is lowered to the deck's soffit less the clearance, ramped back to the terrain at a grade
UNDER_CLEAR_M = {"road": 4.2, "rail": 4.6, "foot": 2.5}  # soffit over the way
UNDER_GRADE = {"road": 0.06, "rail": 0.025, "foot": 0.08}  # the ramps down to it
DECK_THICK_M = {"road": 1.0, "rail": 1.2, "foot": 0.45}  # js/structures-geometry.js DECK.thick
DECK_LIFT_M = 0.03  # js/structures-geometry.js DECK.lift
UNDER_MIN_CLEAR_M = 1.5  # a way under a deck that stands less over it than this is not passing under (it joins the bridge at its end)
UNDER_MAX_DROP_M = 4.0  # the most an underpass is lowered
UNDER_FLOOR_M = 0.3  # an underpass stays this far over the sea
BANK_SLOPE = 1.0  # the side of a lowered underpass: 1:1 up to the terrain
CHAIN_TURN_DEG = 50.0  # a ramp runs on along the way's continuation where it turns less than this
TUNNEL_MAX_M = 80.0  # a tunnel way this short under a road or railway that is not tagged a bridge is an underpass: the road gets a deck
TUNNEL_FEASIBLE = 0.8  # a tunnel deck is kept where its tunnel can be lowered to this share of its clearance
TUNNEL_DECK_PAD_M = {"road": 4.0, "rail": 1.0, "foot": 1.0}  # a tunnel deck is this much wider than the way it carries (the pavements)
FOOT = ("footway", "cycleway", "path", "steps", "pedestrian", "bridleway", "track", "corridor")
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
        # the terrain as the compiler made it: a rerun reads the tiles' originals (write_terrain keeps them), not its own edits
        for bp in sorted(TERRAIN_ORIG.glob("*.json")):
            c = (read_json(bp) or {}).get("chunk")
            if c:
                a = np.frombuffer(base64.b64decode(c["data"]), dtype="<i2").reshape(c["h"], c["w"]).astype(np.float32) / 100.0
                i0 = round((c["x0"] - self.dtm.x0) / self.dtm.cell)
                j0 = round((c["z0"] - self.dtm.z0) / self.dtm.cell)
                self.dtm.grid[j0:j0 + c["h"], i0:i0 + c["w"]] = a
        self.orig = self.dtm.grid.copy()
        # the water the water build made (city_water.py): under a bridge over it the ground is the water, not the terrain (the compiled
        # terrain carries the fjord bridges' decks across the water)
        self.water, self.levels, self.raw, self.bodies, self.kinds = [], [], [], [], []
        for wp in sorted(tiles_dir.glob("*/water.json")):
            for body in (read_json(wp) or {}).get("bodies") or []:
                for poly in body.get("polys") or []:
                    if poly.get("deck"):  # the water this build added under a deck (water_under_decks)
                        continue
                    r = poly.get("ring") or []
                    if len(r) >= 6:
                        g = Polygon(list(zip(r[0::2], r[1::2])), [list(zip(h[0::2], h[1::2])) for h in poly.get("holes") or [] if len(h) >= 6]).buffer(0)
                        if not g.is_empty:
                            # grown: the water build leaves the bridge strip out, so a deck's outline runs along the water's edge
                            self.water.append(g.buffer(WATER_REACH_M))
                            self.levels.append(float(body["level"]))
                            self.raw.append(g)
                            self.bodies.append(body["id"])
                            self.kinds.append(body.get("kind"))
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


def terrain_under_decks(decks, H) -> int:
    """The compiled terrain carries many bridges (a ridge across the fjord, a mound over the railway): under every deck the terrain is
    set to the ground beside the bridge, what the deck spans. A cell's ground is interpolated between the two points UNDER_REACH_M
    outside the deck's edge across the nearest carried way (the water level where that point is over water); a cell is only lowered.
    Works on H.dtm.grid in place (H.orig is the terrain as compiled); returns the number of cells lowered."""
    grid, orig = H.dtm.grid, H.orig
    x0, z0, cell = H.dtm.x0, H.dtm.z0, H.dtm.cell

    def beside(x, z):
        """Ground at (x, z) in the original terrain; over water the bed, SINK_M under the water level (the ground cut under a bridge
        over water must not show through the water surface)."""
        i = int(math.floor((x - x0) / cell))
        j = int(math.floor((z - z0) / cell))
        g = float(orig[j, i]) if 0 <= j < orig.shape[0] and 0 <= i < orig.shape[1] else float("nan")
        if H.wtree is not None:
            for k in H.wtree.query(shapely.points(x, z), predicate="within"):
                bed = H.levels[k] - SINK_M
                g = min(g, bed) if math.isfinite(g) else bed
        return g

    changed = 0
    for d in decks:
        g = d["_g"]
        segs = []
        for a in d["axes"]:
            p = a["pts"]
            for m in range(4, len(p), 4):
                segs.append((p[m - 4], p[m - 3], p[m], p[m + 1]))
        if not segs:
            continue
        edge = g.boundary
        bx0, bz0, bx1, bz1 = g.bounds
        i0, i1 = int(math.floor((bx0 - x0) / cell)), int(math.ceil((bx1 - x0) / cell))
        j0, j1 = int(math.floor((bz0 - z0) / cell)), int(math.ceil((bz1 - z0) / cell))
        for j in range(max(0, j0), min(grid.shape[0], j1 + 1)):
            for i in range(max(0, i0), min(grid.shape[1], i1 + 1)):
                cx, cz = x0 + (i + 0.5) * cell, z0 + (j + 0.5) * cell
                if not shapely.contains_xy(g, cx, cz):
                    continue
                # the nearest carried way: across it is what the deck spans
                best, tx, tz = float("inf"), 1.0, 0.0
                for ax, az, bx, bz in segs:
                    dx, dz = bx - ax, bz - az
                    l2 = dx * dx + dz * dz or 1e-9
                    s = max(0.0, min(1.0, ((cx - ax) * dx + (cz - az) * dz) / l2))
                    dd = (ax + dx * s - cx) ** 2 + (az + dz * s - cz) ** 2
                    if dd < best:
                        l = math.sqrt(l2)
                        best, tx, tz = dd, dx / l, dz / l
                nx, nz = -tz, tx
                samples = []
                for sgn in (1.0, -1.0):
                    ray = LineString([(cx, cz), (cx + sgn * nx * 80.0, cz + sgn * nz * 80.0)])
                    hit = ray.intersection(edge)
                    pts = [hit] if hit.geom_type == "Point" else [q for q in getattr(hit, "geoms", []) if q.geom_type == "Point"]
                    if not pts:
                        continue
                    dist = min(math.hypot(q.x - cx, q.y - cz) for q in pts) + UNDER_REACH_M
                    h = beside(cx + sgn * nx * dist, cz + sgn * nz * dist)
                    if math.isfinite(h):
                        samples.append((dist, h))
                if not samples:
                    continue
                if len(samples) == 2:
                    (d1, h1), (d2, h2) = samples
                    under = (h1 * d2 + h2 * d1) / (d1 + d2)
                else:
                    under = samples[0][1]
                if math.isfinite(orig[j, i]) and orig[j, i] - under > UNDER_MIN_DROP_M:
                    grid[j, i] = under
                    changed += 1
    return changed


def regrounded(d, H):
    """The deck's ground (ringG, holesG, the axes' ground y) and clearance from the terrain as it now is under it."""
    def again(ring, before):
        # off the compiled terrain (a deck running out of the district) the earlier ground stands
        g = H.ground(np.array(ring[0::2]), np.array(ring[1::2]))
        return [round(float(v), 2) if np.isfinite(v) else b for v, b in zip(g, before)]

    d["ringG"] = again(d["ring"], d["ringG"])
    d["holesG"] = [again(h, hg) for h, hg in zip(d["holes"], d["holesG"])]
    clear = 0.0
    for a in d["axes"]:
        p = a["pts"]
        gs = H.ground(np.array(p[0::4]), np.array(p[1::4]))
        for k, gv in enumerate(gs):
            if np.isfinite(gv):
                p[4 * k + 3] = round(float(gv), 2)
            clear = max(clear, p[4 * k + 2] - p[4 * k + 3])
    d["clear"] = round(clear, 2)


def terrain_in_water(H, gaps) -> int:
    """The terrain under the sea and the rivers (CUT_KINDS), and under the water added beneath the decks (`gaps`), goes down to the bed
    (SINK_M under the water level) wherever it stands higher: the compiled terrain carries the fjord bridges as ridges across the water,
    wider than their outlines. The bridges keep their heights (the decks are measured on the terrain as compiled). Only ever lowered;
    returns the number of cells."""
    grid = H.dtm.grid
    x0, z0, cell = H.dtm.x0, H.dtm.z0, H.dtm.cell
    level_of = dict(zip(H.bodies, H.levels))
    kind_of = dict(zip(H.bodies, H.kinds))
    polys = [(g, lv) for g, lv, k in zip(H.raw, H.levels, H.kinds) if k in CUT_KINDS]
    polys += [(g, level_of[b]) for b, pieces in gaps.items() for g in pieces if kind_of.get(b) in CUT_KINDS]
    n = 0
    for g, level in polys:
        bx0, bz0, bx1, bz1 = g.bounds
        i0, i1 = max(0, int(math.floor((bx0 - x0) / cell))), min(grid.shape[1] - 1, int(math.ceil((bx1 - x0) / cell)))
        j0, j1 = max(0, int(math.floor((bz0 - z0) / cell))), min(grid.shape[0] - 1, int(math.ceil((bz1 - z0) / cell)))
        if i1 < i0 or j1 < j0:
            continue
        ii, jj = np.meshgrid(np.arange(i0, i1 + 1), np.arange(j0, j1 + 1))
        inside = shapely.contains_xy(g, x0 + (ii + 0.5) * cell, z0 + (jj + 0.5) * cell)
        sub = grid[j0:j1 + 1, i0:i1 + 1]
        bed = level - SINK_M
        hit = inside & np.isfinite(sub) & (sub - bed > UNDER_MIN_DROP_M)
        if hit.any():
            sub[hit] = bed
            n += int(hit.sum())
    return n


def water_gaps(decks, H) -> dict:
    """The water build leaves a bridge's strip out of the water: under a deck over the water, the strip (the deck's footprint within
    WATER_REACH_M of the water, less the water), by the id of the water body beside it."""
    if not H.raw:
        return {}
    rtree = STRtree(H.raw)
    gaps = {}  # body id -> [polygon]
    for d in decks:
        g = d["_g"]
        near = [k for k in rtree.query(g.buffer(WATER_REACH_M))]
        if not near:
            continue
        wet = unary_union([H.raw[k] for k in near])
        gap = g.intersection(wet.buffer(WATER_REACH_M)).difference(wet)
        for piece in getattr(gap, "geoms", [gap]):
            if piece.geom_type != "Polygon" or piece.area < 0.5:
                continue
            k = min(near, key=lambda k: H.raw[k].distance(piece))
            gaps.setdefault(H.bodies[k], []).append(piece)
    return gaps


def write_water_gaps(tiles_dir: Path, gaps) -> float:
    """The gaps (water_gaps) added to the water bodies in each tile's water layer, marked `deck` (a rerun takes those out first).
    Returns the area added (m2)."""
    area = 0.0
    for wp in sorted(tiles_dir.glob("*/water.json")):
        doc = read_json(wp) or {}
        tb = box(*frame.tile_bounds_local(wp.parent.name))
        dirty = False
        for body in doc.get("bodies") or []:
            polys = [q for q in body.get("polys") or [] if not q.get("deck")]
            dirty |= len(polys) != len(body.get("polys") or [])
            for piece in gaps.get(body.get("id"), []):
                part = piece.intersection(tb)
                for q in getattr(part, "geoms", [part]):
                    if q.geom_type != "Polygon" or q.area < 0.5:
                        continue
                    q = q.simplify(0.1, preserve_topology=True)
                    polys.append({"ring": [round(v, 2) for c in list(q.exterior.coords)[:-1] for v in c],
                                  "holes": [[round(v, 2) for c in list(h.coords)[:-1] for v in c] for h in q.interiors], "deck": 1})
                    area += q.area
                    dirty = True
            body["polys"] = polys
        if dirty:
            wp.write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    return area


def write_terrain(tiles_dir: Path, H, ids) -> int:
    """Each tile's terrain chunk from H.dtm.grid; the compiler's original goes to TERRAIN_ORIG once. A tile where no cell changed gets its
    original back. Returns the number of tiles written with lowered cells."""
    TERRAIN_ORIG.mkdir(parents=True, exist_ok=True)
    n = 0
    for tid in ids:
        path = tiles_dir / tid / "terrain.json"
        backup = TERRAIN_ORIG / f"{tid}.json"
        doc = read_json(backup) if backup.exists() else read_json(path)
        c = (doc or {}).get("chunk")
        if not c:
            continue
        i0 = round((c["x0"] - H.dtm.x0) / H.dtm.cell)
        j0 = round((c["z0"] - H.dtm.z0) / H.dtm.cell)
        new = H.dtm.grid[j0:j0 + c["h"], i0:i0 + c["w"]]
        old = H.orig[j0:j0 + c["h"], i0:i0 + c["w"]]
        if np.allclose(np.nan_to_num(new), np.nan_to_num(old)):
            if backup.exists():  # no deck over this tile any more: the original back
                path.write_text(backup.read_text(encoding="utf-8"), encoding="utf-8")
                backup.unlink()
            continue
        if not backup.exists():
            backup.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
        cm = np.round(np.nan_to_num(new, nan=0.0) * 100).astype("<i2")
        out = dict(doc)
        out["chunk"] = {**c, "data": base64.b64encode(cm.tobytes()).decode("ascii")}
        path.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
        n += 1
    return n


def kind_of(tags) -> str:
    return "rail" if "railway" in tags else "foot" if tags.get("highway") in FOOT else "road"


def ground_ways(els, tr, area):
    """Every highway / railway way that is not a bridge (tunnels and covered ways too): what can pass under a deck."""
    out = []
    for (t, i), w in els.items():
        if t != "way":
            continue
        tags = w.get("tags", {})
        if tags.get("bridge") not in (None, "no") or tags.get("area") == "yes":
            continue
        if not (("highway" in tags and tags["highway"] not in ("platform", "construction", "proposed", "elevator"))
                or tags.get("railway") in RAILWAYS):
            continue
        pts = to_local_line(w, els, tr)
        if len(pts) < 2:
            continue
        line = LineString(pts)
        if line.length < 0.5 or not line.intersects(area):
            continue
        try:
            layer = int(str(tags.get("layer", "0")).split(";")[0])
        except ValueError:
            layer = 0
        out.append({"id": f"osm:way/{i}", "tags": tags, "nodes": w["nodes"], "pts": pts, "line": line, "kind": kind_of(tags),
                    "width": width_of(tags), "layer": layer, "name": tags.get("name", ""),
                    "tunnel": tags.get("tunnel") not in (None, "no", "building_passage", "culvert")})
    return out


def chain_line(w, gways, by_node, reach):
    """The way's centreline run on at both ends along its continuations (the way sharing the end node that turns least, under
    CHAIN_TURN_DEG; a road continues on roads, a path on paths, a track on tracks) for up to `reach` m: the ramps of an underpass
    reach past a short way under a bridge."""
    def heading(a, b):
        return math.atan2(b[1] - a[1], b[0] - a[0])

    def grow(pts, nodes, end):
        # pts / nodes: the chain so far, extended at its end `end` (1 = the last point, 0 = the first)
        got, seen = 0.0, {w["id"]}
        while got < reach:
            nid = nodes[-1] if end else nodes[0]
            a, b = (pts[-2], pts[-1]) if end else (pts[1], pts[0])
            h0 = heading(a, b)
            best = None
            for j in by_node.get(nid, ()):
                o = gways[j]
                if o["id"] in seen or o["kind"] != w["kind"]:
                    continue
                if o["nodes"][0] == nid:
                    op, on = o["pts"], o["nodes"]
                elif o["nodes"][-1] == nid:
                    op, on = o["pts"][::-1], o["nodes"][::-1]
                else:
                    continue
                if len(op) < 2:
                    continue
                turn = abs((heading(op[0], op[1]) - h0 + math.pi) % (2 * math.pi) - math.pi)
                if turn < math.radians(CHAIN_TURN_DEG) and (best is None or turn < best[0]):
                    best = (turn, o, op, on)
            if best is None:
                break
            _, o, op, on = best
            seen.add(o["id"])
            got += LineString(op).length
            if end:
                pts, nodes = pts + list(op[1:]), nodes + list(on[1:])
            else:
                pts, nodes = list(op[::-1][:-1]) + pts, list(on[::-1][:-1]) + nodes
        return pts, nodes

    pts, nodes = list(w["pts"]), list(w["nodes"])
    if len(nodes) != len(pts):  # nodes outside the extract: no continuation
        return LineString(pts)
    pts, nodes = grow(pts, nodes, 1)
    pts, nodes = grow(pts, nodes, 0)
    return LineString(pts)


def tunnel_decks(gways, buildings, H, first_id):
    """Short tunnels (TUNNEL_MAX_M) under a road or railway that is not tagged a bridge (a footway under Vesterbro, Kærlundsvej under
    Østre Allé): the way over the tunnel gets a deck as wide as the tunnel's corridor, its top on the way's surface, so the tunnel can
    be lowered under it. Tunnels inside a building (car park ramps, passages) are left alone."""
    lines = [w["line"] for w in gways]
    tree = STRtree(lines)
    btree = STRtree(buildings) if buildings else None
    pieces = []  # (polygon, upper way index)
    tunnels = []
    for k, tw in enumerate(gways):
        if not tw["tunnel"] or tw["line"].length > TUNNEL_MAX_M:
            continue
        if btree is not None and len(btree.query(tw["line"].interpolate(0.5, normalized=True), predicate="within")):
            continue
        corridor = tw["line"].buffer(tw["width"] / 2 + 1.5, cap_style="flat")
        hit = False
        for j in tree.query(tw["line"], predicate="crosses"):
            up = gways[j]
            if up["tunnel"] or up["layer"] < tw["layer"] or set(up["nodes"]) & set(tw["nodes"]):
                continue
            q = tw["line"].intersection(up["line"])
            if q.is_empty or (btree is not None and len(btree.query(q, predicate="within"))):
                continue
            strip = up["line"].buffer(up["width"] / 2 + TUNNEL_DECK_PAD_M[up["kind"]], cap_style="flat").intersection(corridor)
            if strip.area > 2.0:
                pieces.append((strip, j))
                hit = True
        if hit:
            tunnels.append(k)
    if not pieces:
        return [], []
    merged = unary_union([p.buffer(0.15) for p, _ in pieces]).buffer(-0.15)
    groups = list(merged.geoms) if hasattr(merged, "geoms") else [merged]
    decks = []
    for g in groups:
        if g.is_empty or g.area < 4.0:
            continue
        members = sorted({j for p, j in pieces if p.intersects(g)})
        axes = []
        for j in members:
            part = gways[j]["line"].intersection(g.buffer(2.0))
            segs = [part] if part.geom_type == "LineString" else [s for s in getattr(part, "geoms", []) if s.geom_type == "LineString"]
            for s in segs:
                if s.length < 1.0:
                    continue
                prof, _ = deck_profile(list(s.coords), gways[j]["width"], H, narrow=gways[j]["width"] < 5)
                axes.append({"way": gways[j]["id"], "kind": gways[j]["kind"], "pts": [v for pp in prof for v in pp]})
        if not axes:
            continue
        kinds = {a["kind"] for a in axes}
        kind = "rail" if kinds == {"rail"} else "road" if "road" in kinds or "rail" in kinds else "foot"
        g = g.simplify(0.25, preserve_topology=True)
        ext, ext_g = ring_with_ground(list(g.exterior.coords)[:-1], H)
        names = [gways[j]["name"] for j in members if gways[j]["name"]]
        decks.append({"id": f"deck:{first_id + len(decks)}", "name": names[0] if names else "", "kind": kind, "ring": ext, "ringG": ext_g,
                      "holes": [], "holesG": [], "axes": axes, "clear": 0.0, "tunnel": 1, "_g": g})
    return decks, [gways[k]["id"] for k in tunnels]


def lower_underpasses(decks, gways, H, tunnel_ids=(), dry=False):
    """Under every deck, the ways that pass under it (not the ways it carries) get their ground lowered to the deck's soffit less
    UNDER_CLEAR_M, ramped back up to the terrain at UNDER_GRADE along the way and its continuations, with 1:1 banks at the sides; never
    more than UNDER_MAX_DROP_M, never under the sea, only ever lowered. A way counts as passing under where the deck stands
    UNDER_MIN_CLEAR_M over it (or it is one of `tunnel_ids`, a tunnel under a tunnel deck). Works on H.dtm.grid in place (not when
    `dry`); returns (cells lowered, report rows (deck id, deck name, way id, way name, kind, clearance before, after, depth))."""
    grid = H.dtm.grid
    x0, z0, cell = H.dtm.x0, H.dtm.z0, H.dtm.cell
    floor = -frame.ORIGIN[2] + UNDER_FLOOR_M
    tunnel_ids = set(tunnel_ids)
    tree = STRtree([w["line"] for w in gways])
    by_node = {}
    for j, w in enumerate(gways):
        for nid in (w["nodes"][0], w["nodes"][-1]):
            by_node.setdefault(nid, []).append(j)
    changed, rows = 0, []
    for d in decks:
        g = d["_g"]
        carried = {a["way"] for a in d["axes"]}
        thick = DECK_THICK_M[d["kind"]]
        axpts = np.array([a["pts"][m:m + 3] for a in d["axes"] for m in range(0, len(a["pts"]), 4)], float)
        for j in tree.query(g, predicate="intersects"):
            w = gways[j]
            if w["id"] in carried or w["line"].intersection(g).length < 0.5:
                continue
            reach = UNDER_MAX_DROP_M / UNDER_GRADE[w["kind"]] + 10.0
            line = chain_line(w, gways, by_node, reach)
            n = max(2, int(math.ceil(line.length)) + 1)
            s = np.linspace(0.0, line.length, n)
            st = shapely.line_interpolate_point(line, s)
            xs, zs = shapely.get_x(st), shapely.get_y(st)
            gr = H.ground(xs, zs)
            ok = np.isfinite(gr)
            inside = shapely.contains_xy(g, xs, zs) & ok
            if not inside.any():
                continue
            # the soffit over each station inside the deck: the nearest axis point's deck top
            dd = (axpts[None, :, 0] - xs[inside, None]) ** 2 + (axpts[None, :, 1] - zs[inside, None]) ** 2
            soffit = axpts[np.argmin(dd, axis=1), 2] + DECK_LIFT_M - thick
            over = soffit - gr[inside]
            under = over > UNDER_MIN_CLEAR_M - thick if w["id"] not in tunnel_ids else np.ones(len(over), bool)
            # stations over the water need nothing (the ground there is the water)
            if H.wtree is not None:
                wet = np.array([len(H.wtree.query(shapely.points(x, z), predicate="within")) > 0 for x, z in zip(xs[inside], zs[inside])])
                under &= ~wet
            if not under.any():
                continue
            target = soffit - UNDER_CLEAR_M[w["kind"]]
            si = s[inside][under]
            ti = np.maximum(target[under], np.maximum(gr[inside][under] - UNDER_MAX_DROP_M, floor))
            need = gr[inside][under] - ti
            if float(need.max()) < 0.05:
                rows.append((d["id"], d["name"], w["id"], w["name"], w["kind"], round(float(over[under].min()), 2), round(float(over[under].min()), 2), 0.0))
                continue
            grade = UNDER_GRADE[w["kind"]]
            cap = np.min(ti[None, :] + grade * np.abs(s[:, None] - si[None, :]), axis=1)
            prof = np.where(ok, np.minimum(np.where(ok, gr, np.inf), cap), np.nan)
            low = ok & (prof < gr - 0.02)
            if not low.any():
                continue
            # the cells along the lowered stretch: the profile at their projection, the bank beyond the way's half width
            after = soffit[under] - np.interp(si, s, prof)
            row = (d["id"], d["name"], w["id"], w["name"], w["kind"], round(float(over[under].min()), 2), round(float(after.min()), 2),
                   round(float(np.nanmax(gr[low] - prof[low])), 2))
            if dry:
                rows.append(row)
                continue
            k0, k1 = int(np.argmax(low)), int(len(low) - np.argmax(low[::-1]) - 1)
            part = shapely.ops.substring(line, s[k0], s[k1]) if k1 > k0 else line
            depth = float(np.nanmax(gr[low] - prof[low]))
            half = w["width"] / 2
            pad = half + depth / BANK_SLOPE + cell
            bx0, bz0, bx1, bz1 = part.buffer(pad).bounds
            i0, i1 = max(0, int(math.floor((bx0 - x0) / cell))), min(grid.shape[1] - 1, int(math.ceil((bx1 - x0) / cell)))
            j0, j1 = max(0, int(math.floor((bz0 - z0) / cell))), min(grid.shape[0] - 1, int(math.ceil((bz1 - z0) / cell)))
            if i1 < i0 or j1 < j0:
                continue
            ii, jj = np.meshgrid(np.arange(i0, i1 + 1), np.arange(j0, j1 + 1))
            cx, cz = x0 + (ii + 0.5) * cell, z0 + (jj + 0.5) * cell
            pts = shapely.points(cx.ravel(), cz.ravel())
            dist = shapely.distance(part, pts)
            sp = shapely.line_locate_point(line, pts)
            pv = np.interp(sp, s, np.where(np.isfinite(prof), prof, gr if np.isfinite(gr).all() else 0.0))
            v = pv + np.maximum(0.0, dist - half) * BANK_SLOPE
            sub = grid[j0:j1 + 1, i0:i1 + 1].ravel()
            hit = (dist <= pad) & np.isfinite(sub) & (v < sub - 0.02)
            if hit.any():
                sub = sub.copy()
                sub[hit] = v[hit]
                grid[j0:j1 + 1, i0:i1 + 1] = sub.reshape(ii.shape)
                changed += int(hit.sum())
            rows.append(row)
    return changed, rows


def feasible_tunnel_decks(tdecks, gways, H, tunnel_ids):
    """The tunnel decks whose tunnel can be lowered to TUNNEL_FEASIBLE of its clearance (the city centre lies so near the sea that a
    car park ramp cannot): the others are dropped, their tunnels left as they are. Judged on the terrain cut under them (the terrain
    often carries the road across the tunnel); H.dtm.grid is left as it was."""
    keep = H.dtm.grid.copy()
    terrain_under_decks(tdecks, H)
    _, rows = lower_underpasses(tdecks, gways, H, tunnel_ids, dry=True)
    H.dtm.grid[...] = keep
    good = {r[0] for r in rows if r[2] in tunnel_ids and r[6] >= TUNNEL_FEASIBLE * UNDER_CLEAR_M[r[4]]}
    return [d for d in tdecks if d["id"] in good]


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
    # ---- underpasses: short tunnels under a road that is not tagged a bridge get a deck; then every way under a deck is lowered
    gways = ground_ways(els, tr, area)
    buildings = []
    for bp in sorted(tiles_dir.glob("*/buildings.json")):
        for b in (read_json(bp) or {}).get("buildings") or []:
            r = b.get("ring") or []
            if len(r) >= 6:
                buildings.append(Polygon(list(zip(r[0::2], r[1::2]))).buffer(0))
    tdecks, tunnel_ids = tunnel_decks(gways, buildings, H, len(decks))
    kept = feasible_tunnel_decks(tdecks, gways, H, set(tunnel_ids))
    log(f"underpasses: {len(tdecks)} tunnel decks over {len(tunnel_ids)} short tunnels; {len(kept)} can be lowered to their clearance: "
        + ", ".join(f"{d['id']} {d['name']}" for d in kept))
    for k, d in enumerate(kept):
        d["id"] = f"deck:{len(decks) + k}"
    tdecks = kept
    decks += tdecks
    changed = terrain_under_decks(decks, H)
    gaps = water_gaps(decks, H)
    wet = terrain_in_water(H, gaps)
    log(f"water: the terrain cut to the bed under the sea and the rivers in {wet} cells")
    lowered, rows = lower_underpasses(decks, gways, H, tunnel_ids)
    for r in rows:
        log("  under", *r)
    for d in decks:
        regrounded(d, H)
    log(f"decks: {len(decks)} structures, {sum(d['_g'].area for d in decks) / 1e4:.2f} ha; {sum(1 for d in decks if d['clear'] > 2.5)} stand over 2.5 m; "
        f"terrain lowered under them in {changed} cells; {len(rows)} ways pass under, lowered in {lowered} cells")

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

    # ---- railway land (OSM landuse=railway): no one walks there
    rail_areas = []
    for (t, i), w in els.items():
        if t == "way" and w.get("tags", {}).get("landuse") == "railway" and w["nodes"][0] == w["nodes"][-1]:
            pts = to_local_line(w, els, tr)
            if len(pts) >= 4:
                g = Polygon(pts).buffer(0)
                if g.intersects(area):
                    rail_areas.append(g)
    log(f"railway land: {len(rail_areas)} areas, {sum(g.area for g in rail_areas) / 1e4:.1f} ha")

    # ---- per tile
    out = {}
    dtree = STRtree([d["_g"] for d in decks]) if decks else None
    rtree = STRtree([r["_g"] for r in rails]) if rails else None
    for tid in ids:
        b = tboxes[tid]
        ds = [decks[j] for j in dtree.query(b, predicate="intersects")] if dtree else []
        rs = [rails[j] for j in rtree.query(b, predicate="intersects")] if rtree else []
        ra = []
        for g in rail_areas:
            part = g.intersection(b)
            for q in getattr(part, "geoms", [part]):
                if q.geom_type == "Polygon" and q.area > 1.0:
                    ra.append([round(v, 2) for c in list(q.exterior.coords)[:-1] for v in c])
        if ds or rs or ra:
            out[tid] = {"tile": tid, "railAreas": ra, "decks": [{k: v for k, v in d.items() if k != "_g"} for d in sorted(ds, key=lambda d: d["id"])],
                        "rails": [{k: v for k, v in r.items() if k != "_g"} for r in sorted(rs, key=lambda r: r["id"])]}
    terrain_tiles = write_terrain(tiles_dir, H, ids)
    log(f"water: {write_water_gaps(tiles_dir, gaps):.0f} m2 added under the decks over the water")
    return {"terrain_tiles": terrain_tiles, "tiles": out, "stats": {"decks": len(decks), "deck_ha": round(sum(d["_g"].area for d in decks) / 1e4, 2),
                                    "high_decks": sum(1 for d in decks if d["clear"] > 2.5), "tunnel_decks": len(tdecks),
                                    "underpasses": len(rows), "rails": len(rails),
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
    log(f"terrain: {res['terrain_tiles']} tiles with the ground cut under their decks")
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
