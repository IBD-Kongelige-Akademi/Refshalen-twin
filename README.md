# Aalborg Twin

A walkable, drivable and bikeable real-time 3D twin of central Aalborg on the Limfjord (Budolfi, Jomfru Ane Gade, Aalborghus, the harbour front, Utzon Center and Limfjordsbroen), built with [three.js](https://threejs.org/) WebGPURenderer and TSL.

- 3,340 buildings at their GeoDanmark footprints with DHM-measured heights and BBR use, year and materials; 91 % with measured LoD2.2 roofs and walls.
- Real streets from OpenStreetMap with GeoDanmark kerbs and cycle strips, signals, cars, buses, cyclists and pedestrians on the real road graph; AI Plusbuses on line 2's real route, stopping at its stops.
- The Limfjord at sea level with quay walls along the harbour front, the city's lakes, streams and parks.
- Bridges on piers at their measured deck heights (Limfjordsbroen, Østre Allé, the foot bridges) and the railway tracks.
- Five ways to move: on foot, by car, by bicycle (city or cargo bike), by drone (up to 120 m over the ground, lands on roofs) and by Plusbus (a 24.7 m double-articulated electric bus whose doors open at a stop); seven teleports and scenic cameras (the start is the Kortdage venue, Aalborg Kongres & Kultur Center).
- The Kortdage tour (Tour button): from AKKC round the seven landmarks and back, one feature at each stop. Express (2 min) and Full (6 min) are hands-off; on the drive tour the GPS routes you stop to stop. After 60 s without input the Express tour starts by itself and loops, as an attract mode for the conference stand ([docs/tour.md](docs/tour.md)).
- A radar minimap and a full map ([M]) with street search, click-to-teleport and a GPS route along the streets.
- Nightlife after dark: the bars, pubs and nightclubs of Jomfru Ane Gade (and every other strip of bars) light their fronts with neon and coloured, beat-flashing spill, play muffled beats you hear as you pass, and draw an evening crowd; quiet at Midday, building at Blue Hour, full at Night ([docs/nightlife.md](docs/nightlife.md)).

Forked from [copenhagen-twin](https://github.com/martincollignon/copenhagen-twin) by Martin Collignon at `1b1316a` (28 Oct 2026), itself based on Slop New York by mrdoob; both MIT. The upstream repository stays the `upstream` git remote for engine fixes.

**Status: phases 0–6, 4b, 4c and 4d of the Aalborg plan** (the 2 × 2 km district, E 555000–557000, N 6322000–6324000). Notes per phase: [docs/aalborg-phase1.md](docs/aalborg-phase1.md), [docs/aalborg-phase2.md](docs/aalborg-phase2.md), [docs/aalborg-phase3.md](docs/aalborg-phase3.md), [docs/aalborg-phase4.md](docs/aalborg-phase4.md), [docs/aalborg-phase4b.md](docs/aalborg-phase4b.md) (overview map), [docs/aalborg-phase4c.md](docs/aalborg-phase4c.md) (the Plusbus), [docs/aalborg-phase4d.md](docs/aalborg-phase4d.md) (the drone), [docs/aalborg-phase5.md](docs/aalborg-phase5.md) (photo facades, windows, entrances, shopfronts, vegetation), [docs/aalborg-phase6.md](docs/aalborg-phase6.md) (trees and street furniture), [docs/aalborg-structures.md](docs/aalborg-structures.md) (bridges, railways, watercourses). Still to come: publishing (7), the whole city (8).

## Run it

You need a browser with WebGPU (current Chrome or Edge) and Python 3 for a static file server. The tile data is generated and gitignored: build it first (below).

```sh
python3 tools/hosting/serve_range.py --port 8010   # then open http://127.0.0.1:8010/
```

`serve_range.py` keeps connections alive; `python3 -m http.server` opens one per file and can stall the page load on Windows.

| Query | Behaviour |
|---|---|
| `?hooks` | Exposes the running scene as `globalThis.__twin` for headless checks. |
| `?debug=footprints` | Draws the buildings, water and parks as flat polygons. |
| `?debug=nobuildings`, `?debug=noroads`, `?debug=nowater`, `?debug=nostructures` | Skip those layers. |
| `?stream=<m>&streammid=<m>` | Shrinks (or grows) the near and mid streaming rings. |
| `?water=simple` | Sky reflection only, no planar reflection pass. |
| `?date=2026-06-21`, `?time=12:00` | Scene date and solar clock time (Europe/Copenhagen, the Danish time zone; CET/CEST handled). |
| `?sky=overcast`, `?wet=0.7` | Broken overcast clouds; ground wetness 0–1. |
| `?tour=express`, `full`, `drive`, `loop` | Starts that tour at once (`loop`: the looping Express tour). |
| `?lang=en`, `?lang=da` | UI language (js/i18n.js): Danish by default; the DA / EN button switches it, and the choice is remembered. |
| `?intro=0` | No start screen (docs/start-screen.md); `?tour=` and `?race=1` skip it too. |
| `?idle=<s>` | Seconds without input before the attract loop starts (default 60; `0` turns it off). |
| `?ao=1` | Half-resolution GTAO (opt-in). |
| `?data=<url>` | Reads the data from another base (packed or unpacked). |

The sun follows NOAA equations at Aalborg (57.048 N, 9.919 E) with the UTM grid correction (0.77°).

## Build the data

Credentials come from the environment or a `.env` file in the repo root (gitignored; copy `.env.example`): a Dataforsyningen token for DHM heights, orthophotos and Skråfoto, and later a Datafordeler API key for the point cloud. Nothing is printed. Vector data comes from [datagrundlag.dk](https://datagrundlag.dk/data/) (no account) and OpenStreetMap.

```sh
uv run tools/geodata/city_tiles.py                                   # boundary + 500 m tiles (--area district | kommune)
uv run tools/geodata/build_city.py --stage fetch --stage buildings0  # GeoDanmark x BBR, OSM (Overpass, else the OSM API)
uv run tools/geodata/build_city.py --stage geo --stage cells         # road graph; DHM heights + terrain per 1 km cell
uv run tools/geodata/build_city.py --stage streets                   # kerbs, cycle strips, derived pavements (GeoDanmark Vejkant)
uv run --no-project --with numpy,shapely python tools/lod2/from_cityjson.py <model.city.jsonl>
uv run tools/geodata/build_city.py --stage lod2 --stage index --stage report
uv run tools/geodata/city_water.py --fetch                           # the Limfjord, lakes, streams, quay walls, green ground
PYTHONUTF8=1 uv run tools/geodata/city_structures.py                # bridges and railways (after the water)
PYTHONUTF8=1 uv run tools/geodata/far_lod.py                          # the far ring (on Windows: set PYTHONUTF8=1)
uv run --no-project --with pyproj python -X utf8 tools/geodata/nightlife.py  # bars, pubs and nightclubs at their street fronts
uv run tools/geodata/build_city.py --stage index --stage report
```

Everything is resumable: each stage and 1 km cell writes a done-marker under `data/city/work/state/` (`--force <stage>` redoes it). Raw downloads are cached under `data/raw/`. `data/city/coverage.md` lists the snapshot date of every source and the coverage of each layer. `tools/geodata/frame.py` (and its JS mirror `js/tile-grid.js`) is the one place for the origin, the district and the 500 m tile grid. Data format: [docs/cph-geodata-schema.md](docs/cph-geodata-schema.md).

## Tests

```sh
node --test tests/*.cjs tests/*.mjs                                  # engine (Node 20+, no dependencies)
node tools/audit/oneway.mjs --minutes 10                             # cars and cyclists against one-way and bicycle-direction data
```

The Python compiler tests run with pytest from `tools/geodata` and `tools/lod2` (dependencies: [docs/baseline-1b1316a.md](docs/baseline-1b1316a.md)). Many engine tests still run on upstream's Copenhagen data kept as fixtures under `tests/fixtures/cph/`.

## Streaming and performance

The engine streams the tiles around the camera (`js/tile-streamer.js`): a **near** ring (750 m: buildings with facades, LoD2 roofs and doors, road surfaces, water, furniture) and a **mid** ring (1.25 km: buildings and roads), nearest first; beyond them the far layer (`data/city/far.bin`) keeps the skyline. Every pull request runs the required `texture-memory-budget` check (`node --test tests/texture-memory-budget.test.mjs`): facade textures must stay within 48 MiB and 224 residents along the camera route. On a WebGPU machine, `uv run --with playwright python tools/perf/frame-budget.py` samples street, lake and aerial views and fails below 30 FPS.

## Hosting the data

The app (index.html, css, js) is deployed by GitHub Pages; the tile data is too big for Pages and git, so it sits on a static host with HTTP Range: a Cloudflare R2 bucket (`R2_BUCKET`) behind a custom domain (`R2_PUBLIC_URL`, the repository variable `DATA_URL`), set up in phase 7. It is **packed**: content-hashed packs plus a `manifest.json`, about 170 requests per visit instead of thousands.

1. `python3 tools/hosting/build_packs.py [--out .context/packs/<v>]` packs data/tiles, data/city and the facade atlases.
2. `python3 tools/hosting/upload_packs.py --dir .context/packs/<v>` uploads to R2 (packs first, the manifest last, existing packs skipped); `tools/hosting/serve_range.py` serves a pack directory locally and `tools/hosting/measure_visit.py` counts a visit's requests.
   On Windows: install wrangler with `npm.cmd i -g wrangler` (the execution policy blocks npm.ps1), then in the same PowerShell set `$env:XDG_CONFIG_HOME = "$HOME\.config\wrangler-personal"` and run `wrangler.cmd login` before the uploader, so the login lands where it reads the token. The live bucket is `aalborg-twin`, served at `https://pub-406db8cd2657473e829591c18eb7983b.r2.dev` (r2.dev until a custom domain is set up).
3. Apply `tools/hosting/cors.json` to the bucket once (Cloudflare dashboard, R2 bucket settings, CORS policy); it allows the Pages origin `https://askonring.github.io` and the local dev ports. The Aalborg packed data costs about 40 requests and 15 MB for boot plus the full Kortdage tour (rehearsed locally on 2026-11-12).

`.github/workflows/pages.yml` publishes index.html, credits.html (the in-game Credits link), css and js and points `BUILD_DATA_BASE` (`js/data-config.js`) at `DATA_URL`; it does not deploy until that variable is set. Put a custom domain on the bucket: r2.dev is rate limited and not CDN-cached.

## Detail overrides

Detailed landmark models (Utzon Center, Budolfi) can replace the generated building in the near ring; the format (`cph-detail/1`: per-tile layer, compact GLBs, the mapping to GeoDanmark ids) is in [docs/detail-overrides.md](docs/detail-overrides.md). `?overrides=0` switches them off.

## Licence and attributions

The project code is available under the [MIT License](LICENSE). Forked from [copenhagen-twin](https://github.com/martincollignon/copenhagen-twin) by Martin Collignon (MIT), which is based on [Slop New York](https://github.com/mrdoob/slop-newyork/) by mrdoob (MIT): the renderer, post-processing, controls, cameras, audio, traffic and pedestrian engine come from those projects.

The generated Aalborg data carries the licences of its sources:

- Indeholder data fra Klimadatastyrelsen / Styrelsen for Dataforsyning og Infrastruktur: GeoDanmark (Bygning, Vejkant, Vejmidte, Sø, Kyst, Havn, Bassin, Træ, Trægruppe, Mast, Parkering, Skov, Rekreativt område, Begravelsesområde), DAR, BBR, DAGI and DHM, under the [terms for free geographic data](https://dataforsyningen.dk/asset/PDF/rettigheder_vilkaar/Vilk%C3%A5r%20for%20frie%20geografiske%20data%20og%20CC%20BY%204_0%20licens.pdf) (CC BY 4.0), read through [datagrundlag.dk](https://datagrundlag.dk/om/) (MapCentia's mirror, no licence of its own).
- © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), Open Database License (ODbL): roads, signals, lamps, water, parks. Anything derived from them stays under the ODbL.
- The LoD2.2 building model is a CityJSON made by Ramboll with Geoflow, under the MIT License (docs/aalborg-phase2.md).
- The drawings behind the Ansgars Kirke, Budolfi and Hotel Hvide Hus overrides are from Aalborg Kommune's building archive (byggesagsarkiv) on [weblager.dk](https://weblager.dk); only measurements taken from them are in the models.

The repository also holds upstream's Copenhagen district data as test fixtures (`tests/fixtures/cph/`), under the licences of its sources: GeoDanmark, BBR and DHM (as above), © OpenStreetMap contributors (ODbL), and Københavns Kommune open data (CC BY 4.0 / Open Data DK licens: trae_basis, cykelsti, cykelstativ, trafiksignal_oversigt, fortovsmatrikel, parkregister, dp_belaegninger, afmaerkning_total, blaa_cykelfelt).
