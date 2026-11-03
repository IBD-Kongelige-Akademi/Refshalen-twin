#!/usr/bin/env python3
"""A Geoflow / roofer LoD2.2 CityJSONSeq (one file for the whole area) -> the per-cell layout `build_city.py --stage lod2` converts.

    uv run --no-project --with numpy,shapely python tools/lod2/from_cityjson.py <file.city.jsonl> [--source "<who made it>"]

Writes data/raw/lod2-out/<cell>/manifest.json + out/<cell>.jsonl for every 1 km cell of data/city/tiles.json, so convert.py
reads the model as if roofer had produced it per cell. Run it after the cells stage (it needs data/tiles/*/buildings.json).

Matching. The file's own ids are not usable (Geoflow writes "1" for every feature and object), so each Building is matched to the
compiled GeoDanmark building whose footprint overlaps its LoD0 footprint best (IoU >= MIN_IOU; the model was made from the same
footprints, so most overlaps are ~1); a compiled building is claimed by its best match only. The BBR uuid the model carries
(`OGRLoader.Reference`) is recorded as a cross-check, not used to match. Objects are renamed to the GeoDanmark id (`<fot>`,
children `<fot>-<k>`) because convert.py reads `gdk:<object id>`.

Quality attributes become the roofer ones convert.gate reads: rf_success (no no-data vertices, a LoD2.2 solid), rf_h_ground
(LASInPolygons.ground_elevations), rf_h_roof_max (ArrDissolve-LoD12.global_elevation_max), rf_rmse_lod22
(PC2MeshQuality-LoD22.mesh_error_f), rf_nodata_frac (1 - DataCoverageCalc.data_coverage). Buildings with vertices at the
no-data height (z < -1000 m) are skipped.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter
from pathlib import Path

import numpy as np
from shapely import STRtree
from shapely.geometry import Polygon
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "geodata"))
import frame  # noqa: E402

TILES_DIR = ROOT / "data" / "tiles"
CITY_DIR = ROOT / "data" / "city"
OUT = ROOT / "data" / "raw" / "lod2-out"
MIN_IOU = 0.5
NODATA_Z = -1000.0


def _f(v):
    try:
        x = float(v[0] if isinstance(v, list) else v)
        return x if math.isfinite(x) else None
    except (TypeError, ValueError, IndexError):
        return None


def compiled_buildings(tile_ids):
    out = []
    for tid in tile_ids:
        p = TILES_DIR / tid / "buildings.json"
        if p.exists():
            for b in json.loads(p.read_text())["buildings"]:
                ring = [frame.to_utm(b["ring"][i], b["ring"][i + 1]) for i in range(0, len(b["ring"]), 2)]
                out.append((b["id"], tid, Polygon(ring).buffer(0)))
    return out


def renamed(feature: dict, bid: str, gid: str) -> dict:
    """The feature with building `bid` renamed to the bare GeoDanmark id and its children to <id>-<k>."""
    objs = feature["CityObjects"]
    b = dict(objs[bid])
    new_children = {c: f"{gid}-{k}" for k, c in enumerate(b.get("children", []) or [])}
    out = {gid: {**b, "children": list(new_children.values())}}
    for c, nc in new_children.items():
        out[nc] = {**objs[c], "parents": [gid]}
    return {**feature, "id": gid, "CityObjects": out}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("src", type=Path)
    ap.add_argument("--source", default="Geoflow LoD2.2 CityJSON (user supplied)", help="recorded in each cell manifest")
    a = ap.parse_args()

    tiles = [t["id"] for t in json.loads((CITY_DIR / "tiles.json").read_text())["tiles"]]
    geo = compiled_buildings(tiles)
    if not geo:
        raise SystemExit("no data/tiles/*/buildings.json: run build_city.py --stage cells first")
    polys = [g[2] for g in geo]
    tree = STRtree(polys)

    stats = Counter()
    best: dict[int, tuple[float, dict, str]] = {}  # compiled index -> (iou, feature, building object id)
    with open(a.src, encoding="utf-8") as f:
        header = json.loads(f.readline())
        if header.get("type") != "CityJSON":
            raise SystemExit("the first line is not a CityJSON header")
        crs = (header.get("metadata") or {}).get("referenceSystem", "")
        if not crs.endswith("/25832"):
            raise SystemExit(f"expected EPSG:25832, the file says {crs!r}")
        sc, tr = np.asarray(header["transform"]["scale"]), np.asarray(header["transform"]["translate"])
        for line in f:
            if not line.strip():
                continue
            feat = json.loads(line)
            V = np.asarray(feat["vertices"], dtype=np.float64).reshape(-1, 3) * sc + tr
            for oid, o in feat["CityObjects"].items():
                if o["type"] != "Building":
                    continue
                stats["buildings"] += 1
                if (V[:, 2] < NODATA_Z).any():
                    stats["skipped_nodata_vertices"] += 1
                    continue
                g0 = next((g for g in o.get("geometry", []) if str(g["lod"]) == "0"), None)
                if g0 is None:
                    stats["skipped_no_lod0"] += 1
                    continue
                fp = unary_union([Polygon(V[np.asarray(r[0])][:, :2]).buffer(0) for r in g0["boundaries"]])
                cand = [(polys[i].intersection(fp).area / polys[i].union(fp).area, i) for i in tree.query(fp) if polys[i].intersects(fp)]
                iou, i = max(cand, default=(0.0, -1))
                if iou < MIN_IOU:
                    stats["unmatched"] += 1
                    continue
                if i in best and best[i][0] >= iou:
                    stats["duplicate_lower_iou"] += 1
                    continue
                if i in best:
                    stats["duplicate_lower_iou"] += 1
                best[i] = (iou, feat, oid)

    per_cell: dict[str, list] = {}
    manifests: dict[str, dict] = {}
    bbr_agree = Counter()
    for i, (iou, feat, oid) in best.items():
        gid_full, tid, _ = geo[i]
        gid = gid_full.removeprefix("gdk:")
        cell = frame.lod2_cell_of_tile(tid)
        o = feat["CityObjects"][oid]
        at = o.get("attributes", {})
        cov = _f(at.get("DataCoverageCalc.data_coverage"))
        has22 = any(str(g["lod"]) == "2.2" for c in o.get("children", []) or [] for g in feat["CityObjects"][c].get("geometry", []))
        rf = {"rf_success": has22, "rf_h_ground": _f(at.get("LASInPolygons.ground_elevations")),
              "rf_h_roof_max": _f(at.get("ArrDissolve-LoD12.global_elevation_max")),
              "rf_rmse_lod22": _f(at.get("PC2MeshQuality-LoD22.mesh_error_f")),
              "rf_nodata_frac": None if cov is None else max(0.0, 1.0 - cov),
              "src_bbr_uuid": (at.get("OGRLoader.Reference") or "").lower() or None, "src_iou": round(iou, 3)}
        f2 = renamed(feat, oid, gid)
        f2["CityObjects"][gid]["attributes"] = {**at, **rf}
        per_cell.setdefault(cell, []).append(f2)
        manifests.setdefault(cell, {"buildings": {}, "scan": {"scan_date": None, "source": a.source, "file": a.src.name}})
        manifests[cell]["buildings"][gid_full] = {"post_scan": False, "iou": round(iou, 3)}
        stats["matched"] += 1
        stats["iou>=0.95" if iou >= 0.95 else "iou_0.5-0.95"] += 1
        bbr_agree["with_bbr_uuid" if rf["src_bbr_uuid"] else "no_bbr_uuid"] += 1

    hdr = {"type": "CityJSON", "version": header.get("version", "1.1"), "transform": header["transform"],
           "metadata": {"referenceSystem": crs, "title": header.get("metadata", {}).get("title", "")}, "CityObjects": {}, "vertices": []}
    for cell in sorted({frame.lod2_cell_of_tile(t) for t in tiles}):
        d = OUT / cell
        (d / "out").mkdir(parents=True, exist_ok=True)
        for old in (d / "out").glob("*.jsonl"):
            old.unlink()
        feats = per_cell.get(cell, [])
        with open(d / "out" / f"{cell}.jsonl", "w", encoding="utf-8") as w:
            w.write(json.dumps(hdr, separators=(",", ":")) + "\n")
            for ft in feats:
                w.write(json.dumps(ft, separators=(",", ":"), ensure_ascii=False) + "\n")
        (d / "manifest.json").write_text(json.dumps(manifests.get(cell, {"buildings": {}, "scan": {"scan_date": None, "source": a.source}}), indent=1))
    stats["compiled_geodanmark"] = len(geo)
    stats["compiled_without_model"] = len(geo) - len(best)
    print(json.dumps({**stats, **bbr_agree, "cells": {c: len(v) for c, v in sorted(per_cell.items())}}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
