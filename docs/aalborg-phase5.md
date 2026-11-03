# Phase 5 notes: national realism layers

Photo facades, measured windows, entrances, shopfronts, vegetation and square paving, from national data only. Coverage per layer:
`data/city/coverage.md` (stage `report`).

## How to rebuild

```sh
uv run tools/geodata/build_city.py --osm-source api --stage fetch2 --stage surfaces --stage groundfloor --stage entrances --stage vegetation
APPEARANCE_WORK=data/raw/appearance-city uv run tools/geodata/appearance_city.py tones all --workers 3
APPEARANCE_WORK=data/raw/appearance-city uv run tools/geodata/appearance_city_final.py calibrate
APPEARANCE_WORK=data/raw/appearance-city uv run tools/geodata/appearance_city_final.py finalize --workers 4
APPEARANCE_WORK=data/raw/appearance-city uv run tools/geodata/appearance_city_final.py register
APPEARANCE_WORK=data/raw/appearance-city uv run tools/geodata/appearance_city_atlas.py atlas all --workers 3
uv run --with pillow --with numpy --with scipy python tools/geodata/facade_layout.py run all
uv run tools/geodata/build_city.py --stage index --stage report
```

`APPEARANCE_WORK` keeps the Skråfoto work files under the gitignored `data/raw/` (upstream's default is a folder in the author's home).
`GSEARCH_TOKEN` (the Dataforsyningen token in `.env`) is needed by the Skråfoto, CIR and DHM steps; `--osm-source api` skips Overpass,
which was still failing (502s, timeouts) on 2026-11-03.

## Layers

| Layer | Result |
|---|---|
| Photo tones (`appearance`) | all 3,340 buildings; 22,954 of 29,310 walls seen in a photo (513 Skråfoto views, 2025 + 2023) |
| Photo atlases (`data/tex-look`) | 2,247 buildings (67 %), 29 MB WebP |
| Measured windows (`windows`) | 3,031 walls on 1,342 buildings, 40,410 windows; `facade_layout_check.py regress`: 6 walls (0.2 %) |
| Entrances | 3,611 on 2,014 of 2,755 buildings ≥ 20 m²; most DAR points lie inside the footprint, so 1,800 are `inferred` (door side guessed) |
| Shopfronts (`groundfloor`) | 944 OSM venues |
| Surfaces | 44 OSM squares and pedestrian areas; no road markings |
| Vegetation | lawn 30 ha, park floor 10 ha, planting 0.4 ha, canopy 37 ha, from DSM − DTM (no point-cloud key) |

Texture budget: `tests/texture-memory-budget-city.test.mjs` replays the facade loader over the built tiles along `cityCameraRoute`
(the teleports): peak 48.0 MiB (the cap), largest photo band 171 (cap 224), nothing resident from the air.

Observed brick walls come out near-neutral and light (median sRGB 0.81 grey), so the citywide brick reference falls back to its
default; `tone_cal` (appearance_calibrate.py) restores chroma as upstream does for Copenhagen. Worth checking on screenshots.

## Screenshots (midday, 21 June; `docs/phase5/`)

| Place | What it shows |
|---|---|
| `jomfru-ane-gade.jpg` | photo atlases on the near facades (133 resident at this spot), entrances and shopfronts at street level |
| `gammel-torv.jpg` | the square's slab paving, photo tones on the surrounding walls |
| `aalborghus.jpg` | measured lawn around the castle; its yellow and white walls come out right |
| `budolfi.jpg` | **a defect**: the cathedral's shadow-side walls draw blue (see below) |
| `utzon.jpg` | grass slopes on the harbour front, photo tones on the old-town houses |

**Blue walls.** `appearance_calibrate` turns shadow views' faint skylight cast into strong blue: 2,081 of 29,310 walls (7 %)
are blue after `tone_cal` against 981 before, also on sunlit walls (route `none`), so the chroma restore (`CHROMA_GAIN`) amplifies
the cast. Budolfi (whitewashed) is the visible case. A tuning fix for Aalborg's light is open.

Viewing locally: `.claude/launch.json` now serves with `tools/hosting/serve_range.py` on port 8010, which keeps connections
alive (HTTP/1.1) and has a 128-deep listen backlog. Python's `http.server` closed every connection and had a backlog of 5; on this
Windows machine that left thousands of loopback sockets in TIME_WAIT that never expired and made the page stall on port 8000.
Open the viewer at `http://127.0.0.1:8010/`: `localhost` tries IPv6 first, and the server only listens on IPv4.

## Source changes for Aalborg

- **Entrances** (`entrances.py`): `--source datagrundlag` (default) reads DAR `adressepunkt` (FlatGeobuf, bbox), the gældende `husnummer` rows whose
  adgangspunkt is one of them, their `navngivenvej` names and the kommune's BBR `opgang` (GeoParquet through DuckDB). No Datafordeler account.
  Upstream's DAR REST + BBR GraphQL path stays behind `--source dar-rest`.
- **Shopfronts** (`groundfloor.py`): OSM only; the KK serving-permit layer is behind `--kk`.
- **Surfaces** (`surfaces.py`): OSM squares and pedestrian areas only; the KK paving and road-marking registers are behind `--kk`. An unlabelled
  square is slab paving (`raadhus`, inferred) instead of Copenhagen's granite cobbles; `asphalt`, gravel and `concrete` squares keep their material.
- **OSM fallback** (`osm_api.py`): the `squares`, `groundfloor` (`out center`) and `street_nodes` answers are rebuilt from the API map as well;
  `build_city.fetch_osm` is the one Overpass-else-API routine for both fetch stages.
- **Vegetation** (`city_layers2.py`, `vegetation.py`): with `DATAFORDELER_GRAPHQL_API_KEY` set the stage downloads the DHM point cloud per 1 km
  cell and derives the class rasters locally (upstream synced them from a cloud job). Without the key (the case now) it uses the DHM height
  models instead: DSM − DTM ≥ 2.5 m is crown, 0.3–2.5 m low planting, under a footprint building; the CIR NDVI still decides what is green. The
  sources say which (`dhm:ndsm…` vs `dhm:class…`), and planting from the height models is `inferred`.
- **Coverage report** (`city_report.py`): sections for photo facades, windows, entrances and vegetation; the "Frederiksberg substitutions"
  table is now "Source substitutions".
- **shoot-windows.py** stops are Aalborg streets.
