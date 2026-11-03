# Aalborg Twin

A walkable, drivable and bikeable real-time 3D twin of central Aalborg on the Limfjord (Budolfi, Jomfru Ane Gade, Aalborghus, the harbour front, Utzon Center and Limfjordsbroen), built with [three.js](https://threejs.org/) WebGPURenderer and TSL.

Forked from [copenhagen-twin](https://github.com/martincollignon/copenhagen-twin) by Martin Collignon at `1b1316a` (28 Oct 2026), itself based on Slop New York by mrdoob; both MIT. The upstream repository stays the `upstream` git remote for engine fixes.

**Status: phase 1 of the Aalborg plan.** The Copenhagen data is gone and the frame is Aalborg's (origin E 556000, N 6323100, EPSG:25832; district E 555000–557000, N 6322000–6324000), so the viewer boots to an empty ground plane at Gammel Torv. Buildings, terrain and roads arrive in phases 2–3. The engine tests still run on Copenhagen data kept as fixtures under `tests/fixtures/cph/`. The rest of this README describes the upstream engine and is rewritten for Aalborg in phase 4.

Data format: [docs/cph-geodata-schema.md](docs/cph-geodata-schema.md).

## Run it

You need a browser with WebGPU (current Chrome or Edge) and Python 3 for a static file server.

```sh
python3 -m http.server           # then open http://localhost:8000/
```

Build scripts read their credentials from the environment or from a `.env` file in the repo root (gitignored): copy `.env.example` and fill in the Dataforsyningen token and the Datafordeler API key. Nothing is printed.

Useful query parameters: `?debug=footprints` draws the geodata's buildings, water and parks as flat polygons, `?debug=nobuildings` and `?debug=noroads` skip those layers, `?hooks` exposes the running scene as `globalThis.__twin` for headless checks.

`?water=simple` drops the planar reflection pass of the lakes (sky reflection only), `?debug=nowater` shows the plain ground, `?debug=nocal` the uncalibrated facade tones.

Lighting uses 26 October 2026 in Europe/Copenhagen: Golden Hour at 16:10, Midday at 12:00, Blue Hour at 17:20, and Night at 23:00. The solar position follows NOAA equations with the local UTM grid correction; the sun switches off below the horizon. AgX tone mapping and restrained saturation keep the sky and water pale.

| Query | Behaviour |
|---|---|
| `?date=2026-06-21` | Changes the scene date, retaining each preset's local clock time; CET/CEST is handled automatically. |
| `?time=12:00` | Overrides the solar clock time; the selected preset still supplies its lighting mood. |
| `?sky=overcast` | Broken overcast clouds, reduced sunlight, more daylight sky fill, and wetness 0.35. Clear remains the default. |
| `?wet=0.7` | Overrides ground wetness from 0 to 1; clear presets default to dry. |
| `?ao=1` | Enables half-resolution GTAO at 0.6 strength. It remains opt-in pending a GPU cost measurement. |

Citywide (the streamed tile index): every harbour basin, canal, lake and pond that is not one of the Soerne is generic water, a post-process like the far layer: `uv run tools/geodata/city_water.py --fetch` (GeoDanmark soe / bassin / rekreativtomraade / begravelsesomraade / skov and OSM landuse into `data/raw/city/water/`, once) and `uv run tools/geodata/city_water.py` write `data/city/water.json` and a `water` layer per tile (surface, quay walls or banks, the ground cut under the water, parks as grass). The Soerne stay the district's hand-made lakes. Details and limits: `docs/citywide-plan.md` (C4). `?water=simple` drops the planar reflection here too, `?debug=nowater` shows the ground without any water.

Water levels come from the DTM over the lakes. `data/cph-lakes.json` stores basin polygons and their measured levels, allowing basins separated by bridges to keep distinct elevations while nearby levels snap together. Lake outlines cut through the terrain or ground mesh; developed shores use quay walls and coping, while natural shores use bank geometry. A shared ground-field shader shades fine gravel along the lake edge and grass over measured park areas.

Capture and benchmark the atmospheric changes on a machine that permits a local browser/server:

```sh
uv run --with playwright python tools/shoot-m2.py --water --out .context/after-water
uv run --with playwright python tools/shoot-m2.py --water --query 'sky=overcast&wet=0.35' --out .context/after-overcast
uv run --with playwright python tools/shoot-m2.py --audit-sweep --out .context/after-atmos-sweep
uv run --with playwright python tools/shoot-m2.py --perf --query 'ao=0'
uv run --with playwright python tools/shoot-m2.py --perf --query 'ao=1'
```

The lead supplied browser captures for visual review: the lake benchmark recorded 37.7 FPS with planar reflection and 47.3 FPS with sky-only water. These measurements precede the subsequent shader, haze and coping-join corrections. This implementation sandbox still denies the screenshot server's localhost socket bind, so those corrections need a fresh browser capture. GTAO cost remains unmeasured: compare the two unthrottled `--perf` runs at 1440×900 before enabling it by default; its additional frame cost must stay below 2 ms. The water captures preserve `--query` overrides and switch the lighting and colour grade together through the preset UI.

Wet ground supplies its SSR weight through material context, which only the main scene MRT consumes. Material-level MRT overrides cannot be used here: the planar reflection target has an unnamed colour attachment and would produce an empty WGSL output structure. `tools/shader-pass-matrix.mjs` checks canvas, planar reflection, main MRT, partial normal/depth output, and Three's shadow-map override, including contact effects and colour-write/output overrides. With the matching Three bundles and loader cached locally:

```sh
node --experimental-loader /private/tmp/dlb-three/loader.mjs tools/shader-pass-matrix.mjs
```

Clear midday haze uses density 0.00013 (about 12% attenuation at 1 km) and caps fog in-scatter luminance at 0.48 scene-linear to prevent the HDR sun lobe from washing out buildings.

Tests (Node 20+, no dependencies):

```sh
node --test tests/*.cjs tests/*.mjs
```

Ground actors share a collision pass before their render batches are written: people, city and cargo bikes, cars and buses separate from one another and from buildings, parked vehicles and solid street furniture. Building footprints preserve courtyards and concave recesses; tree and lamp collisions use trunks and poles. Player movement also sweeps its path to stop fast crossings through thin obstacles. Nearby spatial queries bound the contact work.

The required CI check includes collision geometry and actor regressions. On a WebGPU machine, exercise the real controller, NPC routes and rendered positions with:

```sh
uv run --with playwright python tools/check-collisions.py --out .context/collisions.json
```

Add `--perf` for paired CPU timings with the collision stage enabled and disabled. This comparison pauses the animation loop while updating simulations and render batches; it does not measure frame rate.

## Performance budget check

Every pull request runs the required `texture-memory-budget` check. It replays the committed camera route against the real facade-atlas dimensions and fails if the selected facade textures exceed 48 MiB or 224 residents, if any building in the photo band (a photo wall nearer than 150 m and one beyond 45 m) is left without its atlas, or if atlases stay resident from the air. The atlas resolution follows the on-screen texel density where each photo is seen (`js/facade-lod.js`): every plan picks the highest density at which the whole band fits the 48 MiB:

```sh
node --test tests/texture-memory-budget.test.mjs
```

The same required check tests building-batch picking and streaming visibility, preserves the sun shadow depth target, and checks module loading. Static building cells share material batches while retaining their geometry and individual culling. On WebGPU, the sun cascades use their original depth maps without allocating an unused colour attachment; at 3072 pixels per cascade this saves 72 MiB without changing shadow resolution.

The [rendering measurements](docs/research/rendering-optimization.md) record the allocation and frame-time comparisons, verification and remaining limits.

On a WebGPU machine, the local browser harness samples the live resident and in-flight facade estimate while moving through that route, fails on rendering errors, and prints the renderer's texture estimate for context. That estimate excludes some backing allocations, including multisampled colour textures; it is not a physical GPU memory reading:

```sh
uv run --with playwright python tools/shoot-m2.py --perf
```

Headless browser check (Playwright; boots the twin, asserts the HUD and console, writes screenshots to `docs/cleanup/`):

```sh
uv run --with playwright python tools/shoot-m2.py --verify --query hooks --out docs/cleanup
```

Facade look: photo walls are on by default between about 14 m and 150 m of the camera (procedural brick, plaster and windows closer, tone + procedural beyond; `?tex=0` turns the photos off). They need `data/tex/` (photo atlases) and the processed `data/tex-look/` (`uv run --with pillow --with numpy --with scipy python tools/geodata/facade_look.py`); without them the twin falls back to the procedural facades. Ground-floor shopfronts come from `data/cph-groundfloor.json` (`uv run --with requests --with pyproj python tools/geodata/groundfloor.py`). Facade shots: `uv run --with playwright python tools/shoot-look.py --out docs/look/facades/x [--perf]`.

## Rebuild the data

`data/cph-geodata.json` is generated and never edited by hand:

```sh
uv run tools/geodata/build.py --env-file <path>   # a .env with DHM_TERRAIN_TOKEN (or GSEARCH_TOKEN) for DHM heights
```

Raw downloads are cached under `data/raw/`, so reruns are offline. See `tools/geodata/build.py` for options. `tools/geodata/frame.py` is the one place for the origin, the district bbox and the 500 m tile grid; compiler steps accept `--bbox` / `--tile` for another area.

The twin loads per-tile layers when `data/tiles/index.json` exists (generated, gitignored, otherwise the files above are used):

```sh
uv run tools/geodata/tile_split.py   # data/cph-*.json + data/lod2 -> data/tiles/<e500>_<n500>/, data/city/ (format: docs/cph-geodata-schema.md)
```

The whole of Københavns + Frederiksberg Kommune (496 tiles, `data/city/tiles.json`) is compiled by one resumable script that writes the same tile format directly:

```sh
uv run tools/geodata/build_city.py --workers 4            # all stages; secrets come from the environment or .env (never printed)
uv run tools/geodata/build_city.py --stage cells --cells 6176_723   # one 1 km cell; every stage and cell has a done-marker under data/city/work/state/
uv run tools/geodata/build_city.py --stage vegetation --veg-limit 20 --veg-workers 6   # LiDAR + CIR streamed per cell, then deleted
```

Stages: `fetch fetch2` (citywide sources, cached in `data/raw/city/`), `buildings0`, `geo` (roads, one connected road graph, points), `cells` (DHM heights and terrain per 1 km cell), `surfaces furniture groundfloor streets entrances vegetation`, `index`, `report` (`data/city/coverage.md`: coverage, sources, Frederiksberg substitutions, what is still queued). Raw data stays under `data/raw/` and is never committed; keep an eye on `df -h`: the script stops below 5 GB free.

With tiles the engine **streams** (`js/tile-streamer.js`, milestone C2): it keeps the tiles around the camera resident in rings,
**near** (750 m: buildings with facades, LoD2 roofs and doors, road surfaces, furniture, trees, grass, ground floor) and **mid**
(1.25 km: buildings and roads), loads nearest first under a concurrency cap, aborts stale requests, and unloads a tile beyond its
ring + 250 m (disposing its geometries, materials and photo textures). `?stream=<near m>` (and `&streammid=<m>`) shrinks the rings
so streaming is visible inside the 2 km district; `?tiles=<url>` reads another tile index; `?debug=notiles` is the monolithic
fallback (whole district built once). With `?hooks`, `__twin.stream.snapshot()` reports resident tiles per ring, loads, unloads,
aborts and bytes. `uv run --with playwright python tools/shoot-stream.py` flies the district three times at `?stream=300`,
and checks the console, the unloads and that the JS heap stays flat.

Beyond the mid ring, the existing far layer keeps the city skyline visible out to 9 km. `?stream=750&streammid=2500`
restores the former detail radius at a higher CPU and memory cost. Road surfaces use camera-frustum culling in both the
main view and water reflections; rigid parts of the cargo bike and GoBoats share meshes while their animated pivots remain separate.
Facade-photo tone, brick and floor-layout parameters are uniforms, so newly arriving buildings reuse compiled GPU programs.

Measure the full city against the committed baseline at 1920×1080 (Playwright and WebGPU; localhost:8000 must be free):

```sh
uv run --with playwright python tools/perf/frame-budget.py --baseline-ref a58e9d3 --out .context/fps/before
uv run --with playwright python tools/perf/frame-budget.py --out .context/fps/after
```

The check waits for tiles and facade photos to settle, samples street, cargo-bike, lake and aerial views, saves screenshots
and JSON under `.context/`, and fails below 30 FPS or on rendering/streaming errors. `--scenes drive` also exercises driving.
It requires the streamed city and fails if it falls back to the smaller district; use `--data` for another packed city host.

`data/cph-surfaces.json` (ground-material polygons and road markings, M4) is a separate generated file:

```sh
uv run tools/geodata/surfaces.py   # KK dp_belaegninger + afmaerkning_total + blaa_cykelfelt, OSM squares
```

It carries classes `kbh_fortov, raadhus, asphalt_road, asphalt_cycle, cobbles, setts, gravel, grass, other` per surface
(with `src`/`conf`) and marking `kind`s `white, crossing, arrow, symbol, bay, bump, bluecycle, yellow, service, ramp, red`.
The twin renders Københavnerfortov (slab rows with a sett line between, parallel to the kerb), Rådhusbelægning, cobbles
and setts procedurally (`js/surface-materials.js`); pavements are the Københavnerfortov unless the register or a
plaza-sized polygon says otherwise. Without the file the twin still boots (pavements and lane paint only).

`data/cph-vegetation.json` (lawns and planting) is measured, not taken from a register: the colour-infrared orthophoto gives
NDVI and the DHM point cloud gives what stands above the ground (class 5 crowns, class 3/4 shrubs); the ground under park
crowns is lawn by the KK park register. The twin appends these polygons to the surfaces as `grass` ground and grows tufts
on them around the camera (`js/grass.js`: one instanced draw call, 49 tiles of 8 m refilled as you move, wind and
fade in the shader; `?debug=nograss` switches both off). Method, thresholds and QA: `tools/geodata/vegetation.py`.

```sh
python3 tools/geodata/vegetation_rasters.py   # DHM Punktsky class counts at 1 m (pdal; tiles from tools/lod2/fetch.py)
uv run tools/geodata/vegetation_cir.py        # CIR orthophoto -> NDVI (Dataforsyningen token from ADC `gsearch-token`)
uv run tools/geodata/vegetation.py
uv run --with playwright python tools/shoot-grass.py   # shots and cost into docs/grass/
```

`data/cph-furniture.json` (street furniture, M4) is another separate generated file:

```sh
uv run tools/geodata/furniture.py   # KK WFS + Citelum lamp GPKGs + Movia stops; `?debug=nofurniture` skips it in the viewer
uv run --with playwright python tools/shoot-m2.py --furniture   # shots + fps into docs/m4-furniture
uv run --with playwright python tools/shoot-m2.py --oneway      # traffic direction: live car check + contraflow / track / arrow-overlay shots into docs/oneway
node tools/audit/oneway.mjs                                     # cars and cyclists against the one-way / bicycle-direction data (10 simulated minutes)
```

Look shots for lakes, trees and night lighting: `uv run --with playwright python tools/shoot-look.py --tag after` (docs/look/lakes-trees).
`uv run tools/geodata/basins.py` adds the per-basin water levels to `data/cph-lakes.json` (after `lakes.py`).

## Hosting the citywide data

The app (index.html, css, js) is deployed by GitHub Pages; the citywide data is too big for Pages (1 GB limit) and for git, so it sits on a static host with HTTP Range: a Cloudflare R2 bucket (`R2_BUCKET`) behind a custom domain (`R2_PUBLIC_URL`, the repository variable `DATA_URL`), set up in phase 7. It is **packed**: a visit used to cost 1.5 to 5k requests (about 12 files per tile plus one webp per facade atlas), more than hosts with per-IP or per-bucket request limits allow (r2.dev, a Hugging Face dataset with 3,000 resolve requests per 5 minutes per IP). Packed, the same visit costs about 170.

```
<base>/manifest.json       the root, served no-cache: which pack holds which file, the packs of every tile
<base>/c/<hash>.pack       city packs: tiles/index.json + the city files (meta, roadgraph, post, far, water, ...); city/streets.json alone
<base>/t/<hash>.pack       core layers (what a mid-ring tile needs: js/tile-rings.js RING_LAYERS.mid + lod2.bin) and the atlas index, per 2 x 2 tiles
<base>/d/<hash>.pack       detail layers (what only the near ring adds: surfaces, vegetation, furniture, entrances, ground floor), per 2 x 2 tiles
<base>/a/<hash>.pack       the facade atlases of one tile, cut into spatially compact chunks of at most 1 MB, read with one HTTP Range request per chunk
```

A pack is `CPHPACK1`, a u32 header length, a JSON header (entry name, type, encoding, offset, length, size) and the payloads; JSON and binary entries are gzip'd inside the pack, so the host needs no Content-Encoding (the browser inflates them with DecompressionStream, which every WebGPU-capable browser has), atlases are stored as they are. Names are content hashes, so packs are immutable (`Cache-Control: public, max-age=31536000, immutable`) and republishing replaces only manifest.json; unchanged packs keep their names. A host that ignores Range (answers 200) is detected on the first atlas request: the client then fetches whole atlas packs (at most 6 MB) and slices every chunk out of them.

**Engine.** `js/data-config.js` holds the data base (`BUILD_DATA_BASE`, default `./data`; `?data=<url>` overrides it for one session). The tile store (`js/tile-store.js`) reads `<base>/manifest.json` first for any base but the repo's own `./data` (`?packs=0` / `?packs=1` force it) and falls back to the unpacked layout (`<base>/tiles/index.json`, `<base>/tiles/<id>/<layer>.json`, `<base>/tex-look/<id>.webp`) when there is none, so **local dev stays unpacked** (`./data` as before, no extra request). `js/data-packs.js` holds the container, the pack and atlas clients (byte-bounded caches of the compressed packs and chunks, one shared request per pack) and the manifest; the layer API of the tile store and the streamer callers is unchanged. The streamer caps concurrent requests (one per pack) instead of concurrent layers.

**Building and publishing.** Two steps:

1. `python3 tools/hosting/build_packs.py [--out .context/packs/<v>]` packs data/tiles, data/city and the facade atlases (only the atlases the tiles describe: from the local `data/tex-look`, or from gs://`$TWIN_GCS_BUCKET`/skraafoto/tex-look when that is set, cached in `~/.cache/cph-twin/tex-look`; ADC token over REST, never the gcloud CLI) into a directory: about 740 files, 1 GB. `--core-block` / `--detail-block` (default 2) and `--groups single` trade requests for bytes, `--chunk` sizes the atlas chunks.
2. Upload the directory to any static host (packs immutable, manifest.json no-cache, ideally with Range). For R2: `python3 tools/hosting/upload_packs.py --dir .context/packs/<v>` (wrangler with `XDG_CONFIG_HOME=~/.config/wrangler-personal`, the personal account; packs first, the manifest last, packs the bucket already holds are skipped). `tools/hosting/serve_range.py` serves a pack directory locally with Range (`--no-range` to test the fallback), and `tools/hosting/measure_visit.py` counts the requests and bytes of a scripted visit against any data base.

**Pages build.** `.github/workflows/pages.yml` publishes only index.html, css and js and rewrites `BUILD_DATA_BASE` to the repository variable `DATA_URL`; it does not deploy until that variable is set. The r2.dev endpoint is rate limited and not CDN-cached, so put a custom domain on the bucket and use that as `DATA_URL`.

**Bucket setup** (phase 7, wrangler with `XDG_CONFIG_HOME=~/.config/wrangler-personal`): `wrangler r2 bucket create $R2_BUCKET`, `wrangler r2 bucket cors set $R2_BUCKET --file tools/hosting/cors.json` (edit its allowed origins to your Pages domain first), then a custom domain on the bucket.

## Detail overrides

Hand-guided or semi-automatic building reconstructions can take the place of generated buildings in the live twin; for Aalborg, detailed landmark models (Utzon Center, Budolfi) go in this way (phase 2b). Upstream's Nyhavn set and its builder were removed in phase 1. The format (`cph-detail/1`: per-tile layer, compact GLBs, parametric openings, cornices, dormers and chimneys), the mapping to GeoDanmark ids, the engine rules and the licences are in [docs/detail-overrides.md](docs/detail-overrides.md). The near ring draws the overrides. Mid and far keep the generated building with its measured tones. `?overrides=0` switches them off.

```sh
python3 tools/overrides/publish.py install        # a set under ~/.local/share/cph-twin/overrides into the local unpacked ./data (uninstall to remove)
python3 tools/hosting/build_packs.py --offline    # packs every set under ~/.local/share/cph-twin/overrides (--no-overrides to skip)
uv run --with playwright --with pillow python tools/shoot-overrides.py --data <base>   # before / after, fps, memory
```

## Licence and attributions

The project code is available under the [MIT License](LICENSE).

Forked from [copenhagen-twin](https://github.com/martincollignon/copenhagen-twin) by Martin Collignon (MIT), which is based on [Slop New York](https://github.com/mrdoob/slop-newyork/) by mrdoob (MIT): the renderer, post-processing, controls, cameras, audio, traffic and pedestrian engine come from those projects.

The Aalborg data is built in phases 2–6; its sources and licences are listed here as they arrive. Until then the repository holds upstream's Copenhagen district data as test fixtures (`tests/fixtures/cph/`), a derived database that carries the licences of its sources:

- © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the Open Database License (ODbL). The OSM-derived parts of the bundle, and anything derived from them, stay under the ODbL (attribution, share-alike).
- Indeholder data fra Klimadatastyrelsen / GeoDanmark (Bygning), BBR og Københavns Kommune (kbhkort, CC BY 4.0 / Open Data DK licens).
- Facade photos use Skråfoto 2023 and 2025 from Styrelsen for Dataforsyning og Infrastruktur (retrieved October 2026); the processed atlases are derived from those photos. [Terms for free geographic data](https://dataforsyningen.dk/asset/PDF/rettigheder_vilkaar/Vilk%C3%A5r%20for%20frie%20geografiske%20data%20og%20CC%20BY%204_0%20licens.pdf).
- Københavns Kommune open data: trae_basis, cykelsti, cykelstativ, trafiksignal_oversigt, fortovsmatrikel, parkregister, and for `cph-surfaces.json` dp_belaegninger, afmaerkning_total, blaa_cykelfelt (plus OSM squares, ODbL).

The map and facade sources are credited in the loading screen and their data files. Third-party data and dependencies retain their respective licences.
