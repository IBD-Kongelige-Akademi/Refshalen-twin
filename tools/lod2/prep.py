#!/usr/bin/env python3
"""Per 1 km cell: footprints from the compiled tiles, a class 2+6 crop of the point cloud (+25 m margin), roofer.toml.

Writes data/raw/lod2-out/<cell>/{footprints.geojson, cropped.laz, roofer.toml, manifest.json}: the work layout that
`build_city.py --stage lod2` (city_layers2.lod2_cell_job -> convert.py) reads once run.py has put roofer's CityJSONSeq in
<cell>/out/. `manifest.json` records, per own building, the BBR year and whether it post-dates the scan (those roofs are
marked `inferred` and get no mesh: the point cloud cannot contain them).

Restored from the Copenhagen twin's tools/lod2/prep.py (the Aalborg twin took its roofs from a ready-made CityJSON) with two
changes: the buildings come from data/tiles/<id>/buildings.json (the tiled compiler) instead of data/cph-geodata.json, and the
crop is done with laspy when PDAL is not installed.

    uv run --project tools/lod2 python tools/lod2/prep.py [--cells 6176_725 ...] [--force]
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

import importlib.util

import common

# tools/lod2/fetch.py by path: common puts tools/geodata (which has its own fetch.py) first on sys.path
_spec = importlib.util.spec_from_file_location("lod2_fetch", Path(__file__).resolve().parent / "fetch.py")
fetch = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fetch)

sys.path.insert(0, str(common.ROOT / "tools" / "geodata"))
import frame  # noqa: E402

TILES = common.ROOT / "data" / "tiles"
LOD2_OUT = common.ROOT / "data" / "raw" / "lod2-out"


def load_buildings() -> list[dict]:
    out = []
    for p in sorted(TILES.glob("*/buildings.json")):
        out += json.loads(p.read_text(encoding="utf-8"))["buildings"]
    return out


def cell_footprints(buildings: list[dict], cell: str, margin: float, scan_year: int | None) -> tuple[dict, dict]:
    """GeoJSON FeatureCollection (EPSG:25832) for the cell + margin, and the per-building manifest of own buildings."""
    e0, n0, e1, n1 = common.tile_bounds(cell)
    feats, manifest = [], {}
    for b in buildings:
        ring = common.ring_to_en(b["ring"])
        if len(ring) < 3:
            continue
        ce = sum(p[0] for p in ring) / len(ring)
        cn = sum(p[1] for p in ring) / len(ring)
        own = e0 <= ce < e1 and n0 <= cn < n1
        near = e0 - margin <= ce < e1 + margin and n0 - margin <= cn < n1 + margin
        if not (own or near):
            continue
        rings = [ring] + [common.ring_to_en(h) for h in b.get("holes", [])]
        coords = [[[round(p[0], 3), round(p[1], 3)] for p in r] + [[round(r[0][0], 3), round(r[0][1], 3)]] for r in rings]
        year = b.get("year")
        post_scan = bool(own and scan_year and isinstance(year, int) and year > scan_year)
        feats.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": coords}, "properties": {
            "id": common.bare_id(b["id"]),
            "yoc": year if isinstance(year, int) else 0,
            "ground": round(b["ground"] + common.ORIGIN[2], 3),
            # margin neighbours only give the cropper context: cheap LoD1.1 extrusion, discarded by convert.py
            "force_lod11": (not own) or post_scan,
        }})
        if own:
            manifest[b["id"]] = {"year": year, "year_conf": (b.get("conf_fields") or {}).get("year", b.get("conf")),
                                 "post_scan": post_scan, "year_eq_scan": bool(scan_year and year == scan_year)}
    fc = {"type": "FeatureCollection", "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::25832"}}, "features": feats}
    return fc, manifest


def neighbours(cell: str) -> list[str]:
    n_km, e_km = (int(v) for v in cell.split("_"))
    return [t for dn in (-1, 0, 1) for de in (-1, 0, 1) if common.tile_file(t := common.tile_id(n_km + dn, e_km + de)).exists()]


def crop(cell: str, margin: float, out: Path) -> list[str]:
    """The cell and its neighbours, cropped to the cell grown by margin, classes 2 (ground) and 6 (building) only."""
    e0, n0, e1, n1 = common.tile_bounds(cell)
    used = neighbours(cell)
    if shutil.which("pdal"):
        stages = [{"type": "readers.las", "filename": str(common.tile_file(t)), "tag": f"r{i}"} for i, t in enumerate(used)]
        pipeline = stages + ([{"type": "filters.merge", "inputs": [s["tag"] for s in stages]}] if len(stages) > 1 else []) + [
            {"type": "filters.range", "limits": "Classification[2:2],Classification[6:6]"},
            {"type": "filters.crop", "bounds": f"([{e0 - margin},{e1 + margin}],[{n0 - margin},{n1 + margin}])"},
            {"type": "writers.las", "filename": str(out), "compression": "laszip"}]
        cfg = out.parent / "crop.json"
        cfg.write_text(json.dumps(pipeline))
        subprocess.run(["pdal", "pipeline", str(cfg)], check=True, capture_output=True)
        return used
    import laspy
    import numpy as np

    header = None
    writer = None
    try:
        for t in used:
            with laspy.open(str(common.tile_file(t))) as f:
                if writer is None:
                    header = laspy.LasHeader(point_format=f.header.point_format, version=f.header.version)
                    header.offsets, header.scales = f.header.offsets, f.header.scales
                    header.vlrs = f.header.vlrs  # the CRS records as they are (no pyproj needed)
                    writer = laspy.open(str(out), mode="w", header=header, do_compress=True)
                for ch in f.chunk_iterator(5_000_000):
                    keep = (((ch.classification == 2) | (ch.classification == 6))
                            & (ch.x >= e0 - margin) & (ch.x <= e1 + margin) & (ch.y >= n0 - margin) & (ch.y <= n1 + margin))
                    if np.any(keep):
                        pts = ch[keep]
                        rec = laspy.ScaleAwarePointRecord.zeros(len(pts), header=header)
                        for dim in pts.point_format.dimension_names:
                            if dim in rec.point_format.dimension_names:
                                rec[dim] = pts[dim]
                        rec.x, rec.y, rec.z = pts.x, pts.y, pts.z
                        writer.write_points(rec)
    finally:
        if writer is not None:
            writer.close()
    return used


ROOFER_TOML = """[input]
polygon-source = "/data/footprints.geojson"
id-attribute = "id"
yoc-attribute = "yoc"
force-lod11-attribute = "force_lod11"
h-terrain-attribute = "ground"

[[input.pointclouds]]
name = "punktsky"
quality = 1
date = {year}  # acquisition year (roofer: buildings built after it are flagged mutated)
source = ["/data/cropped.laz"]
building_class = 6
ground_class = 2

[crop]
ceil-point-density = 20
min-building-density = 1
clear-insufficient = true

[reconstruction]
lod12 = false
lod22 = true

[output]
output-directory = "/data/out"
"""


def prep_cell(cell: str, buildings: list[dict], margin: float, force: bool) -> dict:
    wd = LOD2_OUT / cell
    wd.mkdir(parents=True, exist_ok=True)
    meta = fetch.scan_meta(cell)
    scan_year = int(meta["scan_date_max"][:4])
    fc, manifest = cell_footprints(buildings, cell, margin, scan_year)
    (wd / "footprints.geojson").write_text(json.dumps(fc))
    cropped = wd / "cropped.laz"
    used = []
    if force or not cropped.exists():
        used = crop(cell, margin, cropped)
    (wd / "roofer.toml").write_text(ROOFER_TOML.format(year=scan_year))
    man = {"tile": cell, "scan": meta, "buildings": manifest, "footprints": len(fc["features"]), "neighbour_tiles_read": used}
    (wd / "manifest.json").write_text(json.dumps(man))
    return man


def district_cells() -> list[str]:
    return sorted({frame.lod2_cell_of_tile(t) for t in frame.tiles_for_bbox(frame.DISTRICT_UTM_BBOX)})


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cells", nargs="*")
    ap.add_argument("--margin", type=float, default=common.MARGIN_M)
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    buildings = load_buildings()
    for cell in a.cells or district_cells():
        if not common.tile_file(cell).exists():
            print(f"{cell}: no LAZ (run fetch.py)")
            continue
        m = prep_cell(cell, buildings, a.margin, a.force)
        print(f"{cell}: {len(m['buildings'])} own buildings, {m['footprints']} footprints, scan {m['scan']['scan_date']}, "
              f"{sum(v['post_scan'] for v in m['buildings'].values())} post-scan", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
