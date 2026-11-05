# Phase 5 notes: national realism layers

Photo facades, measured windows, entrances, shopfronts, vegetation and square paving, from national data only. Coverage per layer:
`data/city/coverage.md` (stage `report`).

## How to rebuild

```sh
uv run tools/geodata/build_city.py --osm-source api --stage fetch2 --stage surfaces --stage groundfloor --stage entrances --stage vegetation
APPEARANCE_WORK=data/raw/appearance-2021 uv run tools/geodata/appearance_city.py tones all --workers 2
APPEARANCE_WORK=data/raw/appearance-2021 uv run tools/geodata/appearance_city_final.py calibrate
APPEARANCE_WORK=data/raw/appearance-2021 uv run tools/geodata/appearance_city_final.py finalize --workers 2
APPEARANCE_WORK=data/raw/appearance-2021 uv run tools/geodata/appearance_city_final.py register
APPEARANCE_WORK=data/raw/appearance-2021 uv run tools/geodata/appearance_city_atlas.py atlas all --workers 2
uv run tools/geodata/far_lod.py
uv run --with pillow --with numpy --with scipy python tools/geodata/facade_layout.py run all
uv run tools/geodata/build_city.py --stage index --stage report
```

`APPEARANCE_WORK` keeps the Skråfoto work files under the gitignored `data/raw/` (upstream's default is a folder in the author's home).
`finalize` drops the atlas descriptors and `atlas` skips a building whose `data/tex-look/<id>.webp` exists, so empty that folder before redoing
the atlases.

## The 2021 flight

The colours now come from the March 2021 Skråfoto flight alone. The 2025 flight is overexposed and its colours faded. The earlier run (2025 and
2023) is kept in `data/city/work/appearance_2025/` and `data/city/work/tex-look_2025/`.

| OKLab, median | 2025 + 2023 | 2021 |
| --- | --- | --- |
| Facade chroma | 0.014 | 0.032 |
| Tegl roof chroma, as measured | 0.022 | 0.036 |
| Tegl roof chroma, final | | 0.123 |
| Tegl roof lightness, final | 0.713 | 0.454 |

With one flight, fewer walls are seen: 20,626 against 21,970. Those fall back on their neighbours' tones. 2,244 buildings have photo atlases
(2,247 before). The measured windows (`windows` layer) were not redone and still come from the 2025 and 2023 atlases.

**Tegl roofs.** Even in 2021 a red tile roof is seen through haze, at a third of its chroma and too light. On a BBR `tegl` roof
(`tegl_roof` in `appearance_calibrate.py`), the measured tone says where the roof lies in the range of red tile: lightness and chroma are mapped
to 0.40-0.60 and 0.10-0.15, and the hue is drawn to terracotta (38°), so roofs stay different from each other. Not touched: black glazed tile (dark,
no chroma), a clearly different colour, solar panels and green roofs. 742 of the 815 observed tegl roofs became `tile`.

**Skylight cast on roofs.** Without tile's rule, shadowed views leave roofs plum. `roof_cast` cuts the chroma of hues 230° through 25° to 30 %,
except on `tile`. This also damped up to 18 roofs of other materials that may be really red.

**The tile pattern** (`js/roof-tile-material.js`). Pitched `tegl` and `betontagsten` roofs get courses (30 cm) and tiles (21 cm) in the plane of each
roof face: the overlap's shadow, the curve across a tile, a tone per tile. Up close it shows as tile; further off it fades to its mean with a
large-scale weathering, so distant roofs do not shimmer. It is a colour pattern only, with no bump in the lighting. The mark is the roof's
roughness + 2 in the `roofMat` attribute, so it needs no new vertex data.
`GSEARCH_TOKEN` (the Dataforsyningen token in `.env`) is needed by the Skråfoto, CIR and DHM steps; `--osm-source api` skips Overpass,
which was still failing (502s, timeouts) on 2026-11-03.

## Layers

| Layer | Result |
|---|---|
| Photo tones (`appearance`) | all 3,340 buildings; 20,626 walls seen in a photo (the 2021 flight, 337 views calibrated) |
| Photo atlases (`data/tex-look`) | 2,244 buildings (67 %), 34 MB WebP |
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
| `budolfi.jpg` | the whitewashed cathedral's shadow-side walls, light grey (they drew bright blue before the fix below) |
| `utzon.jpg` | grass slopes on the harbour front, photo tones on the old-town houses |

**Blue walls (fixed).** The chroma restore of `appearance_calibrate` (`CHROMA_GAIN` 2.2 on every hue) turned the faint skylight cast
of shadow views into strong blue: 2,081 of 29,310 walls (7 %) were blue after `tone_cal`, against 981 in the raw tones, Budolfi the
visible case. Blue to purple hues (`COOL_HUES`, OKLab 200–320°) are now damped (`COOL_GAIN` 0.5) instead, unless a sunlit wall is
clearly blue (C ≥ 0.06: a painted facade keeps its colour). After `finalize` and `atlas --force`: 38 blue walls; windows
`regress` 8 of 3,043.

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
