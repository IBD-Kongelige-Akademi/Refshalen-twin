"""Hand-traced park trees (tools/geodata/park_trees.json) -> the `trees` of the tiles' furniture layer.

Operaparken's young trees are too new and too small for GeoDanmark's tree register and the laser-detected crowns, so their positions
were traced from a vertical aerial photograph and kept here. Applied after the furniture stage (build_city.py) and on demand:

    python3 tools/geodata/park_trees.py            # re-apply to data/tiles (idempotent: earlier traced trees are replaced)
"""
from __future__ import annotations

import json
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "park_trees.json"
ORIGIN = (727000.0, 6177500.0)
TILE = 500.0
ORD_BASE = 9_000_000  # the traced trees' places in the citywide order: after every built tree


def _tile(x, z):
    return f"{int(math.floor((x + ORIGIN[0]) / TILE))}_{int(math.floor((ORIGIN[1] - z) / TILE))}"


def apply(tiles_dir: Path, write=None):
    doc = json.loads(SRC.read_text(encoding="utf-8"))
    sid = doc["source"]["id"]
    by_tile = {}
    for t in doc["trees"]:
        by_tile.setdefault(_tile(t["x"], t["z"]), []).append(t)
    done = []
    for path in sorted(Path(tiles_dir).glob("*/furniture.json")):
        tid = path.parent.name
        layer = json.loads(path.read_text(encoding="utf-8"))
        old = layer.get("trees", [])
        old_ord = list((layer.get("ord") or {}).get("trees") or range(len(old)))
        keep = [(t, o) for t, o in zip(old, old_ord) if sid not in " ".join(t.get("src", []))]
        add = by_tile.get(tid, [])
        if len(keep) == len(old) and not add:
            continue
        trees = [t for t, _ in keep]
        ords = [o for _, o in keep]
        for t in add:
            ords.append(ORD_BASE + doc["trees"].index(t))
            trees.append({"x": t["x"], "z": t["z"], "height": t["height"], "crown_radius": t["crown_radius"], "genus": t["genus"],
                          "species": None, "name": None, "age": None, "category": "park", "src": [f"{sid}"], "conf": "inferred",
                          "conf_fields": {"height": "inferred", "crown_radius": "inferred", "genus": "inferred"}, "licence": doc["source"]["licence"]})
        layer["trees"] = trees
        layer.setdefault("ord", {})["trees"] = ords
        txt = json.dumps(layer, separators=(",", ":"), ensure_ascii=False)
        (write or (lambda p, s: p.write_text(s, encoding="utf-8")))(path, txt)
        done.append((tid, len(add)))
    return done


if __name__ == "__main__":
    for tid, n in apply(HERE.parents[1] / "data" / "tiles"):
        print(f"{tid}: {n} traced trees")
