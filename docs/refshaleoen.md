# Refshaleøen: from the Aalborg twin to Copenhagen (phases R1–R2)

The engine is unchanged; the frame, the data pipeline and the Aalborg-specific content were moved to Copenhagen.

## Frame

- Origin E 727000, N 6177500 (on Refshaleøen by the B&W halls), DVR90 2.0 m (the DHM median within 10 m of it is 2.2 m).
- District (R2): the 3 × 2.5 km box E 725000–728000, N 6176000–6178500 = 30 tiles `1450_12352` .. `1455_12356`, nine 1 km cells:
  Refshaleøen, Holmen, Operaen and Operaparken, Papirøen, Christianshavn's north end, Frederiksstaden with Amalienborg and Marmorkirken,
  Kastellet's south edge. (R1 was the 2 × 2 km box E 726000–728000, N 6176500–6178500.)
- Kommune 0101 (København) for BBR, DAGI and the address fetchers.
- Sun: 55.693 N, 12.614 E, UTM grid convergence 2.99°.
- Kept in step: `tools/geodata/frame.py`, `js/tile-grid.js`, `js/city-config.js`, `js/sun-position.js`, `tools/geodata/appearance.py`, `tools/geodata/city_layers2.py`.

## Pipeline fixes (needed in Nov 2026, also useful upstream)

- **datagrundlag.dk dropped the FlatGeobuf files.** `datagrundlag.fetch_features` now falls back to the GeoParquet (GeoParquet 1.1 with a bbox covering column): pyarrow over HTTP range requests reads only the row groups whose bbox statistics touch the area. `fetch_bbr_bygning` reads the BBR GeoParquet with pyarrow too, so DuckDB's httpfs extension is no longer needed.
- **DuckDB without httpfs:** `datagrundlag.duck_connect()` / `parquet_src()` fall back to pyarrow datasets registered as DuckDB views when the
  httpfs extension cannot be downloaded (entrances.py, addresses.py).
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

Then the realism layers (phases 5–6 of the Aalborg plan):

```sh
uv run tools/geodata/build_city.py --osm-source api --stage fetch2 --stage surfaces --stage groundfloor --stage entrances --stage vegetation --stage furniture
uv run --no-project --with pyproj python -X utf8 tools/geodata/nightlife.py
uv run tools/geodata/far_lod.py
uv run tools/geodata/build_city.py --stage index --stage report
python3 tools/hosting/build_packs.py --out data-packs --no-atlases --offline --no-overrides   # optional: 22 files instead of ~330
```

`vegetation` downloads the DHM point cloud (Datafordeler key) and takes ~25 min for the nine cells.

Result (snapshot 2026-11-22): 5,820 buildings in 30 tiles, 1,153 roads, 26 water bodies with 29.9 km of quay, 62 bridge decks, 4,913
entrances, ~12,000 trees (GeoDanmark, OSM and crowns detected in the point cloud, heights from the point cloud), 2,087 lamps, benches,
bins, bollards, bike racks, bus stops and monuments, 90 nightlife venues (Nyhavn, Gothersgade, Reffen ...).

Run locally with the packed data: `python tools/hosting/serve_range.py --port 8010`, then http://127.0.0.1:8010/?data=./data-packs

## Content

- Teleports and scenic cameras: Reffen (start), Operaen, Det Kongelige Akademi, Mastekranen, B&W Hallerne, Copenhagen Contemporary,
  Marmorkirken (seen along Frederiksgade from Amalienborg), Operaparken, KAI (Papirøen's swimming hall, still `building=construction` in
  OSM and not in GeoDanmark: there is no building to see yet), La Banchina. Each stands on a road-graph link 30–60 m from the landmark's OSM position and faces it.
- Tour (`js/tour-script.js`): Reffen → B&W → CC → La Banchina → Mastekranen → Akademiet → Operaen → Operaparken → KAI → Marmorkirken → Reffen; the start scene drives up Refshalevej. Danish captions in `js/i18n.js`.
- Race: Reffen → Akademiet; the finish is Danneskiold-Samsøes Allé within 60 m of the Akademiet teleport.
- UI texts: Aalborg → Refshaleøen, Limfjorden → havnen.

## Not done yet

- **No LoD2 roofs**: the Aalborg roofs came from Ramboll's CityJSON; Copenhagen needs another LoD2 source (or roofs from the DHM point cloud).
- **No Skråfoto facades** (photo colours, facade atlases, measured windows): the appearance pipeline (`appearance_city.py` ...) reads the
  obliques from skraafoto-cdn.dataforsyningen.dk, which the cloud build environment cannot reach. It runs as is on a laptop with the
  Dataforsyningen token in `.env`; until then the walls use the BBR-material tones and procedural windows.
- The Plusbus still wears Aalborg's colours and runs no line here; the detail overrides (Utzon, Budolfi ...) are Aalborg's and simply absent.
- Tiles with bridges keep small slivers of ground (up to ~150 m²) under the decks over the water.
- 2,032 of the 5,820 footprints have no BBR record through `bbruuid` (Holmen, the Navy, many in Frederiksstaden): they get default use and
  year. A spatial join to BBR's building points would recover most.
- The tile list's land share (`city_tiles.py`) is wrong for the larger box (the OSM-API coastline is cut at the request edges); nothing
  else reads it.
- credits.html, the start-screen copy and the docs of the Aalborg phases still describe Aalborg.
