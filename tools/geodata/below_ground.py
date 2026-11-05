#!/usr/bin/env python3
"""Footprints with nothing standing on them -> `below_ground: 1` in the tile's buildings.json.

GeoDanmark registers some underground structures as buildings: the 2,716 m2 footprint under Budolfi Plads is most likely its car park.
The surface model finds next to nothing there, so such a footprint has a LoD2 record whose roof covers a fraction of it and an eave barely
over the ground. The engine, the far ring and the overview map drop a marked building altogether: it is not drawn, and people walk and
drive where it lay (js/world.js dropBuilding). The furniture stage leaves them out too, so trees and lamps can stand there.

A footprint is below ground when its record's roof covers under MAX_COVER of it, it stands under MAX_HEIGHT and it is at least MIN_AREA:
low sheds with a bad record are real, and all under 40 m2.

build_city.py runs it in the `canopies` stage (after lod2, before index); idempotent. Standalone:

    uv run --no-project python -X utf8 tools/geodata/below_ground.py
"""
from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TILES = ROOT / "data" / "tiles"
MAX_COVER = 0.6  # js/lod2-geometry.js MIN_ROOF_COVER
MAX_HEIGHT = 2.5  # m, eave over ground
MIN_AREA = 100.0  # m2
ROOF = 0


def ring_area(r: list) -> float:
    n = len(r) // 2
    return abs(sum(r[2 * i] * r[2 * ((i + 1) % n) + 1] - r[2 * ((i + 1) % n)] * r[2 * i + 1] for i in range(n))) / 2


def roof_plan_area(buf: bytes, offset: int) -> float:
    """The plan area of a record's roof triangles (layout: tools/lod2/convert.py): header, int16 cm vertices, uint16 triangles, uint8 kinds."""
    _, _, _, nv, nt, _ = struct.unpack_from("<3f3H", buf, offset)
    at = offset + 18
    pos = struct.unpack_from(f"<{3 * nv}h", buf, at)
    at += 6 * nv
    tri = struct.unpack_from(f"<{3 * nt}H", buf, at)
    at += 6 * nt
    kind = struct.unpack_from(f"<{nt}B", buf, at)
    area = 0.0
    for t in range(nt):
        if kind[t] != ROOF:
            continue
        a, b, c = tri[3 * t], tri[3 * t + 1], tri[3 * t + 2]
        ax, az = pos[3 * a] / 100, pos[3 * a + 2] / 100
        area += abs((pos[3 * b] / 100 - ax) * (pos[3 * c + 2] / 100 - az) - (pos[3 * b + 2] / 100 - az) * (pos[3 * c] / 100 - ax)) / 2
    return area


def is_below_ground(b: dict, entry: dict | None, buf: bytes | None) -> bool:
    if not entry or entry.get("offset") is None or buf is None or not b.get("ring"):
        return False
    foot = ring_area(b["ring"]) - sum(ring_area(h) for h in b.get("holes") or [])
    if foot < MIN_AREA or b["eave"] - b["ground"] >= MAX_HEIGHT:
        return False
    return roof_plan_area(buf, entry["offset"]) < MAX_COVER * foot


def apply(tiles_dir: Path = TILES, write=None) -> list[tuple[str, str]]:
    """Set (or clear) `below_ground` on every tile's buildings; returns [(tile, id)] of those marked."""
    found = []
    for d in sorted(p for p in tiles_dir.iterdir() if p.is_dir()):
        path = d / "buildings.json"
        if not path.exists():
            continue
        doc = json.loads(path.read_text(encoding="utf-8"))
        index = json.loads((d / "lod2.json").read_text(encoding="utf-8")).get("buildings", {}) if (d / "lod2.json").exists() else {}
        buf = (d / "lod2.bin").read_bytes() if (d / "lod2.bin").exists() else None
        changed = False
        for b in doc.get("buildings", []):
            below = is_below_ground(b, index.get(b["id"]), buf)
            if below:
                found.append((d.name, b["id"]))
            if below != bool(b.get("below_ground")):
                changed = True
                if below:
                    b["below_ground"] = 1
                else:
                    del b["below_ground"]
        if changed:
            txt = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
            (write or (lambda p, t: p.write_text(t, encoding="utf-8")))(path, txt)
    return found


def main() -> None:
    for tile, bid in apply():
        print(f"[below ground] {tile} {bid}", file=sys.stderr)


if __name__ == "__main__":
    main()
