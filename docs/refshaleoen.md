# Refshaleøen: from the Aalborg twin to Copenhagen (phase R1)

The engine is unchanged; the frame, the data pipeline and the Aalborg-specific content were moved to Copenhagen.

## Frame

- Origin E 727000, N 6177500 (on Refshaleøen by the B&W halls), DVR90 2.0 m (the DHM median within 10 m of it is 2.2 m).
- District: the 2 × 2 km box E 726000–728000, N 6176500–6178500 = 16 tiles `1452_12353` .. `1455_12356`, six 1 km cells.
- Kommune 0101 (København) for BBR, DAGI and the address fetchers.
- Sun: 55.693 N, 12.614 E, UTM grid convergence 2.99°.
- Kept in step: `tools/geodata/frame.py`, `js/tile-grid.js`, `js/city-config.js`, `js/sun-position.js`, `tools/geodata/appearance.py`, `tools/geodata/city_layers2.py`.

## Pipeline fixes (needed in Nov 2026, also useful upstream)

- **datagrundlag.dk dropped the FlatGeobuf files.** `datagrundlag.fetch_features` now falls back to the GeoParquet (GeoParquet 1.1 with a bbox covering column): pyarrow over HTTP range requests reads only the row groups whose bbox statistics touch the area. `fetch_bbr_bygning` reads the BBR GeoParquet with pyarrow too, so DuckDB's httpfs extension is no longer needed.
- **No Overpass:** with `OSM_SOURCE=api` in the environment every OSM fetch (city_tiles, build_city, city_water) uses the OSM API map of the area (`osm_api.py`), which now also emulates the `coastline` and `water` queries. Use it when the Overpass servers are unreachable.

Build (same order as the README):

```sh
export OSM_SOURCE=api            # only if Overpass is unreachable
uv run tools/geodata/city_tiles.py
uv run tools/geodata/build_city.py --osm-source api --stage fetch --stage buildings0
uv run tools/geodata/build_city.py --osm-source api --stage geo --stage cells --stage streets
uv run tools/geodata/city_water.py --fetch
PYTHONUTF8=1 uv run tools/geodata/city_structures.py
PYTHONUTF8=1 uv run tools/geodata/far_lod.py
uv run tools/geodata/build_city.py --stage index --stage report
```

Result (snapshot 2026-11-22): 1,325 buildings in 16 tiles, 362 roads, 21 water bodies with 19.1 km of quay, 32 bridge decks (Nyholmsbroen, Kvintus, Gefionbroen ...).

## Content

- Teleports and scenic cameras: Reffen (start), Operaen, Det Kongelige Akademi, Mastekranen, B&W Hallerne, Copenhagen Contemporary, La Banchina. Each stands on a road-graph link 30–60 m from the landmark's OSM position and faces it.
- Tour (`js/tour-script.js`): Reffen → B&W → CC → La Banchina → Mastekranen → Akademiet → Operaen → Reffen; the start scene drives up Refshalevej. Danish captions in `js/i18n.js`.
- Race: Reffen → Akademiet; the finish is Danneskiold-Samsøes Allé within 60 m of the Akademiet teleport.
- UI texts: Aalborg → Refshaleøen, Limfjorden → havnen.

## Not done yet

- **No LoD2 roofs**: the Aalborg roofs came from Ramboll's CityJSON; Copenhagen needs another LoD2 source (or roofs from the DHM point cloud).
- No Skråfoto facades, entrances, trees/furniture, nightlife or photo appearance yet (the README stages after `streets`).
- The Plusbus still wears Aalborg's colours and runs no line here; the detail overrides (Utzon, Budolfi ...) are Aalborg's and simply absent.
- Tiles with bridges keep small slivers of ground (up to ~150 m²) under the decks over the water.
- 521 of the 1,325 footprints have no BBR record (mostly Holmen's and the Navy's buildings): they get default use and year.
- credits.html, the start-screen copy and the docs of the Aalborg phases still describe Aalborg.
