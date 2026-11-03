# Test baseline at upstream 1b1316a

Phase 0 of the Aalborg plan: the test results of the unmodified fork, recorded before any Copenhagen code is removed, so later failures can be told apart from the environment's.

Run on 2026-11-03, Windows 11, Node 26.13, Python 3.12.10 (uv 0.13.7).

| Suite | Command | Pass | Fail | Skip |
|---|---|---|---|---|
| JS (incl. texture-memory budget) | `node --test tests/*.cjs tests/*.mjs` | 546 | 2 | 18 |
| Python, tools/cph-geodata | `cd tools/cph-geodata; uv run --no-project --with pytest,numpy,scipy,pillow,rasterio,pyproj,requests,"shapely>=2","laspy[lazrs]",pyshp,numba python -m pytest tests test_bikedir.py` | 123 | 0 | 1 |
| Python, tools/lod2 | `cd tools/lod2; uv run --no-project --with pytest,numpy,"shapely>=2",pyproj,mapbox-earcut python -m pytest tests` | 9 | 0 | 0 |

The texture-memory budget test (`tests/texture-memory-budget.test.mjs`) passes.

## Failing (Windows only)

Both are in `tests/cph-boot.test.cjs` and come from path separators, not the engine: `reachable()` stores `normalize(join('js', …))`, which gives `js\world.js` on Windows, while the assertions look up `js/world.js`.

- Copenhagen is the only city: no New York modules exist, are imported or are preloaded
- every module in js/ is reachable from main.js (no dead modules)

## Skipped

The 18 JS skips need built data that a fresh clone does not have (`data/tiles`, `data/city/roadgraph.json`, the outputs of `tile_split.py`, `tile_streets.py`, `far_lod.py`, `city_water.py`), plus one that looks for `python3`, which Windows does not provide. They should start running once phase 2 builds Aalborg's tiles.

Not covered here: `tools/cloud/roofer/tests` (removed in phase 2b) and the `.claude/skills/building-case-to-3d` tests (removed in phase 1).
