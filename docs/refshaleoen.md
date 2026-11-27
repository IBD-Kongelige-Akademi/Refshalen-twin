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
python3 tools/hosting/build_packs.py --out site-data --no-atlases --offline --no-overrides   # optional: 22 files instead of ~330
```

`vegetation` downloads the DHM point cloud (Datafordeler key) and takes ~25 min for the nine cells.

Result (snapshot 2026-11-22): 5,820 buildings in 30 tiles, 1,153 roads, 26 water bodies with 29.9 km of quay, 62 bridge decks, 4,913
entrances, ~12,000 trees (GeoDanmark, OSM and crowns detected in the point cloud, heights from the point cloud), 2,087 lamps, benches,
bins, bollards, bike racks, bus stops and monuments, 90 nightlife venues (Nyhavn, Gothersgade, Reffen ...).

Photo facades (the March/August 2021 Skråfoto flight; skraafoto-cdn.dataforsyningen.dk must be reachable):

```sh
export APPEARANCE_WORK=data/raw/appearance-2021
uv run tools/geodata/appearance_city.py tones all --workers 3
uv run tools/geodata/appearance_city_final.py calibrate
uv run tools/geodata/appearance_city_final.py finalize --workers 3
uv run tools/geodata/appearance_city_final.py register
uv run tools/geodata/appearance_city_atlas.py atlas all --workers 3
uv run --with pillow --with numpy --with scipy python tools/geodata/facade_layout.py run all --workers 4
uv run tools/geodata/far_lod.py && uv run tools/geodata/build_city.py --stage index --stage report
python3 tools/hosting/build_packs.py --out site-data --offline --no-overrides
```

Result: observed wall and roof tones for the nine cells, 3,186 facade atlases (53 MB webp), measured window grids on 3,559 walls;
the packed data is 52 files, 55 MB.

LoD2 roofs with [roofer](https://github.com/3DBAG/roofer) 1.1.0-beta.1 (Docker image `3dgi/roofer`, from Docker Hub) from the DHM
Punktsky (scanned 2019-04-07): `tools/lod2/prep.py` and `run.py` are restored from the Copenhagen twin, reading the tiled buildings and
cropping with laspy when PDAL is missing.

```sh
uv run --project tools/lod2 python tools/lod2/fetch.py        # 1 km LAZ tiles of the district + neighbours (Datafordeler key)
uv run --project tools/lod2 python tools/lod2/prep.py         # per cell: footprints, class 2+6 crop, roofer.toml -> data/raw/lod2-out/<cell>/
uv run --project tools/lod2 python tools/lod2/run.py --workers 1 --jobs-per-tile 2
uv run tools/geodata/build_city.py --stage lod2 --stage canopies --force furniture --stage furniture
uv run tools/geodata/far_lod.py && uv run tools/geodata/build_city.py --stage index --stage report
```

Result: 4,772 of 5,819 buildings (82 %) with a measured LoD2.2 roof and walls (median fit 0.88 m); 1,038 rejected by the quality gate
(no usable points, footprint not covered, 108 built after the 2019 scan) keep the extruded roof. 12 minutes of roofer on two cores.

Run locally with the packed data: `python tools/hosting/serve_range.py --port 8010`, then http://127.0.0.1:8010/?data=./site-data

## Content

- Teleports and scenic cameras: Reffen (start), Operaen, Det Kongelige Akademi, Mastekranen, B&W Hallerne, Copenhagen Contemporary,
  Marmorkirken (seen along Frederiksgade from Amalienborg), Operaparken, KAI (Papirøen's swimming hall, still `building=construction` in
  OSM and not in GeoDanmark: there is no building to see yet), La Banchina. Each stands on a road-graph link 30–60 m from the landmark's OSM position and faces it.
- Tour (`js/tour-script.js`): Reffen → B&W → CC → La Banchina → Mastekranen → Akademiet → Operaen → Operaparken → KAI → Marmorkirken → Reffen; the start scene drives up Refshalevej. Danish captions in `js/i18n.js`.
- Race: Reffen → Akademiet; the finish is Danneskiold-Samsøes Allé within 60 m of the Akademiet teleport.
- UI texts: Aalborg → Refshaleøen, Limfjorden → havnen.

## Not done yet

- BBR: GeoDanmark names a BBR building through `bbruuid` on 3,788 of the 5,820 footprints. `build_city.merge_building_features` now also
  joins a BBR building whose coordinate (byg404) lies inside an unnamed footprint (9) and gives a footprint still without BBR the record
  of the footprint it shares the longest wall (>= 2 m) with (1,175: GeoDanmark splits one BBR building into several parts). 848 remain
  without BBR (most have no BBR building at all: sheds, pontoons, the Navy's).
- `DHM_SOURCE=laz` makes the cells stage rasterise DSM and DTM from the Punktsky tiles instead of the WCS (when Dataforsyningen refuses the
  token). The point cloud is from 2019, so buildings built since come out flat: the published data keeps the WCS heights.
- The tile list's land share (`city_tiles.py`) is wrong for the larger box (the OSM-API coastline is cut at the request edges); nothing
  else reads it.
- credits.html, the start-screen copy and the docs of the Aalborg phases still describe Aalborg.
