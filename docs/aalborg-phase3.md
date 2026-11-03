# Phase 3 notes: roads and traffic

## Rebuild

```sh
uv run tools/geodata/build_city.py --stage fetch                 # Overpass, falling back to the OSM API (--osm-source auto|overpass|api)
uv run tools/geodata/build_city.py --stage geo                   # OSM roads, road graph, signals, lamps, water, parks
uv run tools/geodata/build_city.py --stage cells --force cells   # terrain smoothed along the new streets
uv run tools/geodata/build_city.py --stage streets --stage lod2 --force lod2 --stage index --stage report
node tools/audit/oneway.mjs --minutes 10                         # reads the tiled build when data/cph-geodata.json is absent
```

## Results (3 Nov 2026)

| | |
|---|---|
| OSM (API fallback; every Overpass server answered 502/504 or timed out) | 5,296 highway ways, 98 water/park features, 1,411 signal and lamp nodes |
| Road graph | 8,350 nodes, 10,269 links; 95.3 % of nodes in one component |
| Carriageways only | 95.7 % in one component; the next two (83 and 65 nodes) are at the box edge and connect outside it |
| Street layout (GeoDanmark Vejkant ray casting) | 2,054 roads measured, 405 with cycle strips, 1,532 derived pavement pieces |
| Signals / street lamps | 586 / 786 |
| Cyclist simulation, 10 min, 96 riders | 575,013 rider-steps, **0 wrong-way** |
| Car network, static check | 2 of 3,206 edges flagged against a one-way road (below) |
| Viewer | 120 cars, 12 buses, 96 cyclists, 340 pedestrians; no console errors (`docs/phase3/jomfru-ane-gade.jpg`) |

## Open: two flagged car edges

Both sit on the district's southern edge, not in the old town. Upstream's Copenhagen data gives 0 on the same check.

- **Vesterbro (x −723, z 656):** a divided secondary road that OSM maps as two one-way carriageways. A southbound 3-lane edge has its samples matched to the northbound carriageway and a wide one-way service road.
- **Car park at Godsbanen (x −244, z 752):** a one-lane edge over a two-way service road crosses one-way parking aisles. Only 2 samples were judged.

Both look like the static check sampling a divided road and a car park, not cars driving the wrong way, but that is not proven. The live check (`tools/shoot-m2.py --oneway`, Playwright with WebGPU) has not been run.

## What changed

- **No municipal layers.** `geo` passes `None` where upstream passed KK layers. Roads, one-way, speed, lanes, cycle lanes and signals come from OSM; kerbs and cycle strips from GeoDanmark Vejkant (`type` field, same value domain as KK `vejtype`). Trees, racks and benches wait for phase 6.
- **Derived pavements.** Aalborg has no pavement register, so `streets.derive_sidewalks` buffers every carriageway by its measured half width, its cycle strip and 3 m. Holes are kept so block interiors stay out. The usual cleaning cuts the result back to the kerb and the building line; the pieces are marked `conf: inferred`.
- **OSM API fallback.** `tools/geodata/osm_api.py` fetches the box in 3 × 3 `api/0.6/map` requests and rebuilds the three Overpass answers. It is for district-sized areas only; phase 8 (the whole kommune) needs Overpass or a Geofabrik extract.
- **UTF-8 on Windows.** Upstream ran on macOS, and every `read_text()` / `write_text()` without an encoding used cp1252 here. That broke æ/ø/å in `buildings.json` and stopped a cp1252 `meta.json` from being read back. `atomic_write` now writes UTF-8, and `build_city.py` / `city_tiles.py` rerun themselves with `-X utf8`. Run other tools/geodata scripts directly with `python -X utf8`.
- **Teleports.** The plan's landmark table was off by up to 400 m (Limfjordsbroen). The presets now sit on road-graph links next to each landmark's OSM position, with deliberate headings; the Auto-Director drone orbits (−120, −250).
