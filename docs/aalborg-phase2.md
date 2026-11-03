# Phase 2 and 2b notes: buildings, terrain, LoD2

## Rebuild the district

```sh
uv run tools/geodata/city_tiles.py                                   # boundary + 16 district tiles (--area kommune: all)
uv run tools/geodata/build_city.py --stage fetch --stage buildings0  # datagrundlag.dk + Overpass; GeoDanmark x BBR
uv run tools/geodata/build_city.py --stage cells                     # DHM heights + terrain (needs GSEARCH_TOKEN in .env)
uv run --no-project --with numpy,shapely python tools/lod2/from_cityjson.py D:\aalborg.city.jsonl
uv run tools/geodata/build_city.py --stage lod2 --stage index --stage report
```

`data/city/coverage.md` then lists the snapshot date of every source, building and height coverage, and LoD2 coverage.

## Results (3 Nov 2026)

| | Result | Target |
|---|---|---|
| GeoDanmark footprints in the tiles | 3,337 / 3,337 (100 %) | ≥ 98 % |
| DHM-measured heights | 3,272 / 3,340 (98.0 %) | ≥ 90 % |
| Measured LoD2.2 roofs and walls | 3,042 / 3,340 (91.1 %) | |
| Footprint edges with a LoD2 wall within 0.30 m | 24,620 / 27,206 (90.5 %) | |
| LoD2 roof fit (mesh error) | median 0.07 m, p90 0.21 m | |

Evidence: `docs/phase2/footprints-oldtown.jpg` (footprints over the spring orthophoto) and `docs/phase2/lod2-budolfi.jpg`.

## The CityJSON model

`D:\aalborg.city.jsonl`: CityJSON 1.1 sequence, EPSG:25832, DVR90 heights, made by Geoflow from the GeoDanmark footprints. 3,288 Buildings with BuildingParts at LoD 1.2 / 1.3 / 2.2 (Solid, semantic roof / wall / ground surfaces).

- **Ids.** Every feature and object id in the file is `"1"`, so `tools/lod2/from_cityjson.py` matches buildings by footprint overlap: 3,201 matched (3,159 at IoU ≥ 0.95), 81 without a compiled counterpart. 6 were skipped for vertices at the no-data height (z ≈ −2,147,483 m). `OGRLoader.Reference`, the BBR building uuid, is kept as `src_bbr_uuid` for checking.
- **Quality.** Geoflow's attributes stand in for roofer's: ground from `LASInPolygons.ground_elevations`, fit from `PC2MeshQuality-LoD22.mesh_error_f`, no-data share from `DataCoverageCalc.data_coverage`. The converter's gate rejects roofs where more than 30 % of the footprint has no points (159 buildings). Those keep the extruded roof.
- **Not covered by the model:** 139 compiled buildings, mostly small sheds and buildings newer than the model.
- **Open:** where the model comes from, its licence, and the point-cloud date. The tiles credit it as "Geoflow LoD2.2 CityJSON (user supplied)" until that is known.

## Changes to the upstream pipeline

- `tools/lod2/run.py`, `prep.py`, the `cellsinput` stage and the roofer Cloud Run job are gone. `tools/lod2/fetch.py` stays for the vegetation point cloud.
- The Google Cloud helpers the Skråfoto job uses moved from the roofer job to `tools/cloud/gcp.py`.
- `convert.py` is unchanged: `from_cityjson.py` writes `data/raw/lod2-out/<cell>/` in the layout it already reads.
