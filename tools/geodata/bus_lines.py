#!/usr/bin/env python3
"""Bus lines the engine runs on fixed routes -> data/city/bus-lines.json (aalborg-bus-lines/1).

Today one line: the Plusbus, NT line 2 (OSM route relations "Bybus 2: Væddeløbsbanen => Hospitalsbyen" and back, loc_name
"Plusbussen"). Each direction's route ways are chained in relation order into one path (gaps where a member way is outside the
cached OSM area split it; the longest piece inside the district is kept), its stops are the relation's stop / stop_entry_only nodes
projected onto that path. js/traffic.js runs the AI Plusbuses along the paths (docs/aalborg-phase4c.md).

Read from the OSM API cache the furniture stages fetched (data/raw/city/osm_api/, osm_api.py); coordinates are the local frame
(frame.py) rounded to 0.1 m, paths flat [x0, z0, x1, z1, ...], stops { name, s } with s metres along the path.

    uv run --no-project --with pyproj python -X utf8 tools/geodata/bus_lines.py [--out data/city/bus-lines.json]

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

VERSION = "aalborg-bus-lines/1"
RAW = ROOT / "data" / "raw" / "city" / "osm_api"
LINES = [{"ref": "2", "network": "Nordjyllands Trafikselskab", "name": "Plusbus", "vehicle": "urbino24"}]
STOP_ROLES = {"stop", "stop_entry_only", "stop_exit_only"}
STOP_SNAP = 25.0  # m: a stop node further than this from its direction's path is left out


def load_elements(raw: Path) -> dict:
    els = {}
    for p in sorted(glob.glob(str(raw / "map_*.json"))):
        for el in json.loads(Path(p).read_text(encoding="utf-8"))["elements"]:
            els[(el["type"], el["id"])] = el
    return els


def chain(relation: dict, els: dict, to_local) -> list[list[tuple[float, float]]]:
    """The route ways in relation order, each oriented to continue the previous one; a missing or unconnected way starts a new piece."""
    pieces: list[list[int]] = []
    cur: list[int] = []
    single = False  # cur is one way so far: it may still need flipping to meet the next
    for m in relation["members"]:
        if m["type"] != "way" or m["role"] not in ("", "forward", "backward"):
            continue
        w = els.get(("way", m["ref"]))
        if not w:
            if cur:
                pieces.append(cur)
            cur, single = [], False
            continue
        nodes = list(w["nodes"])
        if cur and single and cur[0] in (nodes[0], nodes[-1]) and cur[-1] not in (nodes[0], nodes[-1]):
            cur.reverse()
        if not cur:
            cur, single = nodes, True
        elif cur[-1] == nodes[0]:
            cur += nodes[1:]
            single = False
        elif cur[-1] == nodes[-1]:
            cur += nodes[::-1][1:]
            single = False
        else:
            pieces.append(cur)
            cur, single = nodes, True
    if cur:
        pieces.append(cur)
    out = []
    for ids in pieces:
        pts = []
        for nid in ids:
            n = els.get(("node", nid))
            if n:
                pts.append(to_local(n["lon"], n["lat"]))
        if len(pts) > 1:
            out.append(pts)
    return out


def clip_to_area(pts, bbox) -> list[list[tuple[float, float]]]:
    """Runs of the path inside the local bbox (a point outside ends a run)."""
    x0, z0, x1, z1 = bbox
    runs, cur = [], []
    for p in pts:
        if x0 <= p[0] <= x1 and z0 <= p[1] <= z1:
            cur.append(p)
        else:
            if len(cur) > 1:
                runs.append(cur)
            cur = []
    if len(cur) > 1:
        runs.append(cur)
    return runs


def length(pts) -> float:
    return sum(math.dist(pts[i - 1], pts[i]) for i in range(1, len(pts)))


def project(pts, q) -> tuple[float, float]:
    """(s along the path, distance) of the path's nearest point to q."""
    best, s0, bs = float("inf"), 0.0, 0.0
    for i in range(1, len(pts)):
        ax, az = pts[i - 1]
        bx, bz = pts[i]
        dx, dz = bx - ax, bz - az
        L2 = dx * dx + dz * dz
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((q[0] - ax) * dx + (q[1] - az) * dz) / L2))
        d = math.hypot(ax + dx * t - q[0], az + dz * t - q[1])
        if d < best:
            best, bs = d, s0 + math.sqrt(L2) * t
        s0 += math.sqrt(L2)
    return bs, best


def build(els: dict, bbox) -> dict:
    from pyproj import Transformer

    tr = Transformer.from_crs(4326, 25832, always_xy=True)

    def to_local(lon, lat):
        e, n = tr.transform(lon, lat)
        return frame.to_local(e, n)

    lines = []
    for spec in LINES:
        rels = [el for (t, _), el in els.items() if t == "relation" and el.get("tags", {}).get("route") == "bus"
                and el["tags"].get("ref") == spec["ref"] and el["tags"].get("network") == spec["network"]]
        dirs = []
        for rel in sorted(rels, key=lambda r: r["id"]):
            runs = [run for piece in chain(rel, els, to_local) for run in clip_to_area(piece, bbox)]
            if not runs:
                continue
            path = max(runs, key=length)
            stops = []
            for m in rel["members"]:
                if m["type"] != "node" or m["role"] not in STOP_ROLES:
                    continue
                n = els.get(("node", m["ref"]))
                if not n:
                    continue
                s, d = project(path, to_local(n["lon"], n["lat"]))
                if d <= STOP_SNAP and 15.0 < s < length(path) - 15.0:
                    stops.append({"name": n.get("tags", {}).get("name", ""), "s": round(s, 1)})
            stops.sort(key=lambda st: st["s"])
            t = rel["tags"]
            dirs.append({"osm": rel["id"], "from": t.get("from", ""), "to": t.get("to", ""), "length": round(length(path), 1),
                         "path": [round(v, 1) for p in path for v in p], "stops": stops})
        lines.append({**spec, "directions": dirs})
    return {"version": VERSION, "frame": "local (frame.py)", "attribution": "© OpenStreetMap contributors (ODbL)", "lines": lines}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default=str(ROOT / "data" / "city" / "bus-lines.json"))
    ap.add_argument("--raw", default=str(RAW))
    a = ap.parse_args()
    doc = build(load_elements(Path(a.raw)), frame.LOCAL_BBOX)
    Path(a.out).write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    for line in doc["lines"]:
        for d in line["directions"]:
            print(f"[bus-lines] {line['ref']} {d['from']} -> {d['to']}: {d['length']:.0f} m in the district, {len(d['stops'])} stops "
                  f"({', '.join(s['name'] for s in d['stops'])})", file=sys.stderr)


if __name__ == "__main__":
    main()
