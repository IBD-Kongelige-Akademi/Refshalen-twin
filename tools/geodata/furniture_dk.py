"""Street furniture and street trees from national data and OSM, for a kommune without open registers of its own (Aalborg).

The lists are the ones of tile_split.FURNITURE_LISTS in the item shape furniture.py writes (src / conf / licence on every item):

  trees        GeoDanmark Træ (solitary trees, points) and Trægruppe (tree groups, points), OSM natural=tree where neither has one,
               plus crowns found in the DHM height models (DSM - DTM, the Dataforsyningen WCS) where no tree is registered: park
               and courtyard trees. Heights are the nDSM over each tree; crown radii share the canopy patch a tree stands in
               among the trees in it. Genus from OSM's genus / species tags, else `generic` (js/tree-species.js gives a context mix).
  lamps        OSM highway=street_lamp, plus GeoDanmark Mast points within 18 m of a carriageway that OSM lacks (most masts in a
               town are lighting columns); pole height 8 m on wide roads, 6 m elsewhere; LED 3000 K. Fixture details inferred.
  parkingBays  GeoDanmark Parkering outlines (closed rings: car parks), filled with bays (furniture.bays_in_polygon).
  benches, bins, bollards, bikeRacks, glassContainers, busStops, monuments
               OSM nodes: amenity=bench / waste_basket / bicycle_parking / recycling (glass), barrier=bollard, highway=bus_stop
               (shelter / bench / bin tags; a public-transport shelter node within 15 m counts), tourism=artwork,
               historic=memorial|monument.
  parkMeters, binStands, rescuePosts, lakeLights
               none (no open source).

GeoFA (the national facility register) holds only leisure facilities in the district (toilets, playgrounds, bike pumps) that
the engine has no models for, and Aalborg publishes no GeoFA road inventory, parking or recycling tables.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import build_city as BC
import datagrundlag as DG
import frame
import furniture as F
from frame import to_local

LIC_GDK = "CC-BY-4.0"
LIC_OSM = "ODbL"
NDSM_TREE = 2.5  # m above the terrain: canopy
MAX_TREE_H = 35.0  # m: Denmark's tallest street and park trees; anything above is a mast, crane or roof edge in the DSM
TREE_MATCH_M = 2.5  # an OSM tree this close to a GeoDanmark tree is the same tree
DETECT_MIN_H = 4.0  # m: a detected crown's peak
DETECT_SPACING = 4.0  # m between detected crowns
DETECT_FAR_M = 3.5  # a detected crown this close to a registered tree is that tree
LAMP_ROAD_M = 18.0
LAMP_DUP_M = 3.0
SIGNAL_CLEAR_M = 5.0


def log(*a):
    print("[furniture]", *a, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------------------------------------------- inputs

_WGS = None


def _wgs_local(lon, lat):
    global _WGS
    if _WGS is None:
        from pyproj import Transformer

        _WGS = Transformer.from_crs(4326, 25832, always_xy=True)
    return to_local(*_WGS.transform(lon, lat))


def osm_nodes(name: str):
    """(x, z, tags, id) of the nodes of data/raw/city/osm_<name>.json (fetch / fetch2 stages), in the local frame."""
    p = BC.RAW_CITY / f"osm_{name}.json"
    if not p.exists():
        log(f"no {p.name}: run --stage fetch2")
        return []
    out = []
    for el in json.loads(p.read_text(encoding="utf-8")).get("elements", []):
        if el.get("type") == "node" and "lat" in el:
            x, z = _wgs_local(el["lon"], el["lat"])
            out.append((x, z, el.get("tags") or {}, el["id"]))
    return out


def gdk_points(table: str, bbox) -> list[tuple[float, float, str]]:
    """(x, z, id) of the points of a GeoDanmark table (datagrundlag.dk FlatGeobuf, cached) in the local frame."""
    fc = DG.fetch_features("geodanmark", table, bbox=bbox)
    out = []
    for f in fc["features"]:
        g = f.get("geometry") or {}
        coords = [g["coordinates"]] if g.get("type") == "Point" else g.get("coordinates", []) if g.get("type") == "MultiPoint" else []
        for c in coords:
            x, z = to_local(c[0], c[1])
            out.append((x, z, str(f["properties"].get("id_lokalid"))))
    return out


class Grid:
    """Points in 8 m buckets, for 'anything within r' queries."""

    def __init__(self, pts=(), cell=8.0):
        self.cell, self.b = cell, {}
        for p in pts:
            self.add(p[0], p[1])

    def add(self, x, z):
        self.b.setdefault((int(x // self.cell), int(z // self.cell)), []).append((x, z))

    def near(self, x, z, r) -> bool:
        cx, cz, k = int(x // self.cell), int(z // self.cell), int(r // self.cell) + 1
        for i in range(cx - k, cx + k + 1):
            for j in range(cz - k, cz + k + 1):
                for px, pz in self.b.get((i, j), ()):
                    if (px - x) ** 2 + (pz - z) ** 2 <= r * r:
                        return True
        return False


# --------------------------------------------------------------------------------------------------------------- heights

def ndsm_grid(cells: dict, token: str):
    """The DSM - DTM over the cells at 1 m as (array, e0, n1): fetched per cell through build_city.dhm_cell and cached as
    data/raw/veg/ndsm_<cell>.tif, so a rerun reads the cache."""
    import numpy as np
    import rasterio
    from rasterio.transform import from_origin

    veg = BC.DATA / "raw" / "veg"
    veg.mkdir(parents=True, exist_ok=True)
    boxes = {c: BC.cell_bbox_utm(c) for c in cells}
    e0 = int(min(b[0] for b in boxes.values()))
    n0 = int(min(b[1] for b in boxes.values()))
    e1 = int(max(b[2] for b in boxes.values()))
    n1 = int(max(b[3] for b in boxes.values()))
    grid = np.zeros((n1 - n0, e1 - e0), "float32")
    for c, (ce0, cn0, ce1, cn1) in boxes.items():
        p = veg / f"ndsm_{c}.tif"
        if not p.exists():
            import shutil

            work = veg / f"dhm_ndsm_{c}"
            work.mkdir(parents=True, exist_ok=True)
            rasters, _ = BC.dhm_cell(work, (ce0, cn0, ce1, cn1), token)
            size = int(ce1 - ce0)

            def cut(r):
                r0, c0 = int(round(r.t.f - cn1)), int(round(ce0 - r.t.c))
                return r.arr[r0:r0 + size, c0:c0 + size].astype("float32")

            nd = np.nan_to_num(cut(rasters["dsm"]) - cut(rasters["dtm"]), nan=0.0)
            with rasterio.open(p, "w", driver="GTiff", height=size, width=size, count=1, dtype="float32", crs="EPSG:25832",
                               transform=from_origin(ce0, cn1, 1.0, 1.0), compress="deflate") as d:
                d.write(nd, 1)
            shutil.rmtree(work, ignore_errors=True)
        with rasterio.open(p) as s:
            a = s.read(1)
        r0, c0 = int(n1 - cn1), int(ce0 - e0)
        grid[r0:r0 + a.shape[0], c0:c0 + a.shape[1]] = a
    return grid, e0, n1


# --------------------------------------------------------------------------------------------------------------- trees

def build_trees(cells, bbox, buildings, water, token, roads=None):
    """Registered trees (GeoDanmark, then OSM) with measured heights and shared crowns, plus detected crowns where none is."""
    import numpy as np
    from rasterio.features import geometry_mask
    from rasterio.transform import from_origin
    from scipy import ndimage
    from shapely.geometry import Polygon

    nd, e0, n1 = ndsm_grid(cells, token)
    H, W = nd.shape
    T = from_origin(e0, n1, 1.0, 1.0)

    def utm_ring(r):
        return [frame.to_utm(r[i], r[i + 1]) for i in range(0, len(r), 2)]

    solid = [Polygon(utm_ring(b["ring"])).buffer(0.5) for b in buildings if len(b["ring"]) >= 6]
    solid += [Polygon(utm_ring(w["ring"])).buffer(0) for w in water if len(w.get("ring", [])) >= 6]
    # and the water the water build made (city_water.py: the fjord, the harbour, lakes and the streams), where it has run
    for wp in sorted(BC.TILES_DIR.glob("*/water.json")):
        for body in (json.loads(wp.read_text(encoding="utf-8")).get("bodies") or []):
            for poly in body.get("polys") or []:
                if len(poly.get("ring", [])) >= 6:
                    solid.append(Polygon(utm_ring(poly["ring"])).buffer(0))
    # and the bridge decks (city_structures.py): the DSM over a deck is the deck, not a crown
    for sp in sorted(BC.TILES_DIR.glob("*/structures.json")):
        for deck in (json.loads(sp.read_text(encoding="utf-8")).get("decks") or []):
            if len(deck.get("ring", [])) >= 6:
                solid.append(Polygon(utm_ring(deck["ring"])).buffer(0.5))
    blocked = geometry_mask([g for g in solid if not g.is_empty], (H, W), T, invert=True) if solid else np.zeros((H, W), bool)
    canopy = (nd > NDSM_TREE) & ~blocked
    canopy = ndimage.binary_opening(canopy, np.ones((2, 2), bool))
    labels, _ = ndimage.label(canopy)

    def rc(x, z):
        e, n = frame.to_utm(x, z)
        return int(n1 - n), int(e - e0)

    def height_at(x, z):
        # the crown top over the tree: the highest nDSM within 2 m, buildings (and their 0.5 m margin) left out, so a tree by a
        # facade does not take the roof's height
        r, c = rc(x, z)
        if not (0 <= r < H and 0 <= c < W):
            return None
        sl = (slice(max(0, r - 2), r + 3), slice(max(0, c - 2), c + 3))
        win = nd[sl][~blocked[sl]]
        return min(float(win.max()), MAX_TREE_H) if win.size else None

    def label_at(x, z):
        r, c = rc(x, z)
        if not (0 <= r < H and 0 <= c < W):
            return 0
        win = labels[max(0, r - 1):r + 2, max(0, c - 1):c + 2]
        vals = win[win > 0]
        return int(np.bincount(vals).argmax()) if vals.size else 0

    trees = []  # (x, z, record without crown, label)
    for x, z, tid in gdk_points("trae", bbox):
        trees.append([x, z, {"genus": "generic", "species": None, "name": None, "src": [f"geodanmark:trae:{tid}"], "licence": LIC_GDK}])
    for x, z, tid in gdk_points("traegruppe", bbox):
        trees.append([x, z, {"genus": "generic", "species": None, "name": None, "category": "group",
                             "src": [f"geodanmark:traegruppe:{tid}"], "licence": LIC_GDK}])
    have = Grid(trees)
    n_osm = 0
    for x, z, t, oid in osm_nodes("trees_art"):
        if t.get("natural") != "tree":
            continue
        genus = F.genus_key(t.get("genus"), t.get("species") or t.get("taxon"), t.get("species:da") or t.get("name"))
        rec = {"genus": genus, "species": t.get("species") or None, "name": t.get("species:da") or None, "src": [f"osm:node/{oid}"],
               "licence": LIC_OSM, "osm_height": F.num(t.get("height"))}
        if have.near(x, z, TREE_MATCH_M):
            # the same tree as a GeoDanmark one: OSM only adds its genus
            for tr in trees:
                if (tr[0] - x) ** 2 + (tr[1] - z) ** 2 <= TREE_MATCH_M ** 2 and tr[2]["genus"] == "generic" and genus != "generic":
                    tr[2].update(genus=genus, species=rec["species"], name=rec["name"])
                    tr[2]["src"].append(f"osm:node/{oid}")
                    break
            continue
        trees.append([x, z, rec])
        have.add(x, z)
        n_osm += 1

    # detected crowns: canopy peaks no registered tree accounts for
    peaks = (nd == ndimage.maximum_filter(nd, size=7)) & canopy & (nd > DETECT_MIN_H)
    rows, cols = np.nonzero(peaks)
    order = np.argsort(-nd[rows, cols])
    taken = Grid()
    n_det = n_road = 0
    for k in order:
        r, c = int(rows[k]), int(cols[k])
        x, z = to_local(e0 + c + 0.5, n1 - r - 0.5)
        if have.near(x, z, DETECT_FAR_M) or taken.near(x, z, DETECT_SPACING):
            continue
        # a peak over a carriageway is a crown reaching over the street from the pavement, not a trunk in the road
        nr = roads.nearest(x, z, 20.0) if roads else None
        if nr and nr[0] < nr[5] / 2 + 0.3:
            n_road += 1
            continue
        taken.add(x, z)
        trees.append([x, z, {"genus": "generic", "species": None, "name": None, "src": ["dhm:ndsm:crown"], "licence": LIC_GDK, "detected": True}])
        n_det += 1

    # crowns: a canopy patch's area shared among the trees standing in it
    for tr in trees:
        tr.append(label_at(tr[0], tr[1]))
    per_label = {}
    for tr in trees:
        if tr[3]:
            per_label[tr[3]] = per_label.get(tr[3], 0) + 1
    areas = np.bincount(labels.ravel())
    out = []
    for x, z, rec, lab in trees:
        h = height_at(x, z)
        cf = {}
        if h is not None and h >= 3.0:
            height = round(h, 1)
            cf["height"] = "measured"
        else:
            height = rec.get("osm_height") or F.height_from_age(None, rec["genus"])
            cf["height"] = "inferred"
        if lab:
            r = math.sqrt(areas[lab] / per_label[lab] / math.pi)
            crown = round(max(1.2, min(9.0, 0.55 * height, r)), 1)
            cf["crown_radius"] = "measured"
        else:
            crown = round(min(9.0, max(1.2, height * 0.3)), 1)
            cf["crown_radius"] = "inferred"
        if rec["genus"] == "generic":
            cf["genus"] = "inferred"
        item = {"x": F.r2(x), "z": F.r2(z), "height": float(height), "crown_radius": crown, "genus": rec["genus"], "species": rec["species"],
                "name": rec["name"], "age": None, "category": rec.get("category"), "src": rec["src"],
                "conf": "inferred" if rec.get("detected") else "observed", "conf_fields": cf, "licence": rec["licence"]}
        if rec.get("detected"):
            item["canopy_added"] = True
        out.append(item)
    stats = {"geodanmark": sum(1 for t in out if t["src"][0].startswith("geodanmark")), "osm": n_osm, "detected": n_det, "detected_over_road": n_road,
             "measured_height": sum(1 for t in out if t["conf_fields"].get("height") == "measured")}
    log(f"trees {len(out)}: {stats}")
    return out, stats


# --------------------------------------------------------------------------------------------------------------- the rest

def footprint_test(buildings):
    """(x, z) -> True inside a building footprint (local frame)."""
    from shapely import STRtree
    from shapely.geometry import Point, Polygon

    polys = [Polygon([(b["ring"][i], b["ring"][i + 1]) for i in range(0, len(b["ring"]), 2)]).buffer(0) for b in buildings if len(b["ring"]) >= 6]
    tree = STRtree(polys)
    return lambda x, z: any(polys[int(i)].contains(Point(x, z)) for i in tree.query(Point(x, z)))


def build_lamps(roads: F.RoadIndex, bbox, buildings):
    """OSM street lamps, then GeoDanmark masts near a carriageway that no OSM lamp or signal stands at; none inside a building
    footprint (masts on roofs, wall lamps: the engine draws a pole on the ground)."""
    out = []
    lamps = Grid()
    signals = Grid()
    inside = footprint_test(buildings)
    for x, z, t, oid in osm_nodes("nodes"):
        if t.get("highway") == "traffic_signals" or t.get("crossing") == "traffic_signals":
            signals.add(x, z)

    def lamp(x, z, src, licence, conf):
        nr = roads.nearest(x, z, LAMP_ROAD_M)
        h = 8.0 if nr and nr[5] >= 10 else 6.0
        out.append({"x": F.r2(x), "z": F.r2(z), "yaw": F.face_road(roads, x, z), "mount": "mast", "pole": "tube", "pole_h": h, "arm": None,
                    "pole_text": None, "fixture": None, "source_text": None, "light": "led", "cct": 3000, "watt": None, "led": True,
                    "installed": None, "src": src, "conf": conf,
                    "conf_fields": {"pole": "inferred", "pole_h": "inferred", "light": "inferred", "cct": "inferred"}, "licence": licence})
        lamps.add(x, z)

    for x, z, t, oid in osm_nodes("nodes"):
        if t.get("highway") == "street_lamp" and not inside(x, z):
            lamp(x, z, [f"osm:node/{oid}"], LIC_OSM, "observed")
    n_osm = len(out)
    for x, z, mid in gdk_points("mast", bbox):
        nr = roads.nearest(x, z, LAMP_ROAD_M)
        if not nr or nr[0] > LAMP_ROAD_M or lamps.near(x, z, LAMP_DUP_M) or signals.near(x, z, SIGNAL_CLEAR_M) or inside(x, z):
            continue
        lamp(x, z, [f"geodanmark:mast:{mid}"], LIC_GDK, "inferred")  # a mast by a street: most likely a lighting column
    log(f"lamps {len(out)}: {n_osm} OSM, {len(out) - n_osm} GeoDanmark masts")
    return out


def build_parking(bbox, buildings):
    """Bays in the closed GeoDanmark Parkering outlines (car parks). An outline more than 30 % under buildings is a parking garage or
    a deck over a courtyard and gets none; a bay that still lands in a footprint is dropped."""
    from shapely import STRtree
    from shapely.geometry import Polygon
    from shapely.ops import unary_union

    fc = DG.fetch_features("geodanmark", "parkering", bbox=bbox)
    inside = footprint_test(buildings)
    utm = [Polygon([frame.to_utm(b["ring"][i], b["ring"][i + 1]) for i in range(0, len(b["ring"]), 2)]).buffer(0)
           for b in buildings if len(b["ring"]) >= 6]
    btree = STRtree(utm)
    out = []
    n_lots = n_garage = 0
    for f in fc["features"]:
        g = f.get("geometry") or {}
        lines = [g["coordinates"]] if g.get("type") == "LineString" else g.get("coordinates", []) if g.get("type") == "MultiLineString" else []
        for line in lines:
            if len(line) < 4 or math.hypot(line[0][0] - line[-1][0], line[0][1] - line[-1][1]) > 0.5:
                continue
            poly = Polygon([c[:2] for c in line]).buffer(0)
            if poly.is_empty or poly.area < 25:
                continue
            near = [utm[int(i)] for i in btree.query(poly)]
            covered = unary_union(near).intersection(poly).area if near else 0.0
            if covered > 0.3 * poly.area:
                n_garage += 1
                continue
            n_lots += 1
            for x, z, yaw in F.bays_in_polygon(poly, None, "perp"):
                if inside(x, z):
                    continue
                # kind 'lot': an off-street bay, kept where it is by js/placement.js (on-street bays are moved into the parking lane)
                out.append({"x": F.r2(x), "z": F.r2(z), "yaw": round(yaw, 3), "kind": "lot", "ordning": None,
                            "src": [f"geodanmark:parkering:{f['properties'].get('id_lokalid')}"], "conf": "inferred",
                            "conf_fields": {"kind": "inferred", "yaw": "inferred"}, "licence": LIC_GDK})
    log(f"parking: {len(out)} bays in {n_lots} car parks ({n_garage} outlines under buildings skipped)")
    return out


def yes(v) -> bool:
    return str(v).lower() in ("yes", "true", "1", "designated")


def build_osm_lists(roads: F.RoadIndex, buildings):
    """The OSM street nodes as furniture lists; nodes inside a building footprint (indoor benches and bins of shopping centres,
    stations) are left out."""
    inside = footprint_test(buildings)
    nodes = [n for n in osm_nodes("street_nodes") if not inside(n[0], n[1])]
    shelters = Grid((x, z) for x, z, t, _ in nodes if t.get("amenity") == "shelter")
    out = {k: [] for k in ("benches", "bins", "bollards", "bikeRacks", "glassContainers", "busStops", "monuments")}
    for x, z, t, oid in nodes:
        src = [f"osm:node/{oid}"]
        base = {"src": src, "conf": "observed", "licence": LIC_OSM}
        if t.get("amenity") == "bench":
            out["benches"].append({"x": F.r2(x), "z": F.r2(z), "yaw": F.face_road(roads, x, z), "length": 1.8, **base,
                                   "conf_fields": {"yaw": "inferred", "length": "inferred"}})
        elif t.get("amenity") == "waste_basket":
            out["bins"].append({"x": F.r2(x), "z": F.r2(z), "kind": "litter", "model": None, "yaw": F.face_road(roads, x, z), **base,
                                "conf_fields": {"model": "inferred"}})
        elif t.get("barrier") == "bollard":
            m = (t.get("material") or "").lower()
            mat = "granite" if m in ("stone", "granite") else "galvanised" if m in ("metal", "steel") else "other"
            out["bollards"].append({"x": F.r2(x), "z": F.r2(z), "material": mat, "colour": "raw", "mount": None, "type": t.get("bollard"), **base,
                                    "conf_fields": {"colour": "inferred"}})
        elif t.get("amenity") == "bicycle_parking":
            s = F.side_to_road(roads, x, z)
            cap = F.num(t.get("capacity"))
            out["bikeRacks"].append({"x": F.r2(x), "z": F.r2(z), "yaw": round(math.atan2(s[2], s[3]), 3) if s else 0.0,
                                     "capacity": int(cap) if cap else 6, **base,
                                     "conf_fields": {"yaw": "inferred", **({} if cap else {"capacity": "inferred"})}})
        elif t.get("amenity") == "recycling" and (yes(t.get("recycling:glass_bottles")) or yes(t.get("recycling:glass"))):
            out["glassContainers"].append({"x": F.r2(x), "z": F.r2(z), "yaw": F.face_road(roads, x, z), "address": t.get("addr:street"), **base})
        elif t.get("highway") == "bus_stop":
            s = F.side_to_road(roads, x, z)
            out["busStops"].append({"x": F.r2(x), "z": F.r2(z), "yaw": round(math.atan2(s[0], s[1]), 3) if s else 0.0,
                                    "tangent": [round(s[2], 3), round(s[3], 3)] if s else [1.0, 0.0], "name": t.get("name"),
                                    "lines": t.get("route_ref"), "shelter": yes(t.get("shelter")) or shelters.near(x, z, 15.0),
                                    "bench": yes(t.get("bench")), "bin": yes(t.get("bin")), "cycle_parking": False, "countdown": False,
                                    "length": None, **base, "conf_fields": {"yaw": "inferred"}})
    for x, z, t, oid in osm_nodes("trees_art"):
        if t.get("tourism") == "artwork" or t.get("historic") in ("memorial", "monument"):
            out["monuments"].append({"x": F.r2(x), "z": F.r2(z), "name": t.get("name"), "src": [f"osm:node/{oid}"], "conf": "observed", "licence": LIC_OSM})
    log("osm: " + ", ".join(f"{k} {len(v)}" for k, v in out.items()))
    return out
