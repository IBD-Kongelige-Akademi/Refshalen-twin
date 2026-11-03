# Phase 1 notes: what changed, what is left

Phase 1 of the Aalborg plan: Copenhagen removed, Aalborg frame set. The viewer boots to an empty ground plane at Gammel Torv. The only console errors are the two expected 404s for `data/tiles/index.json` and `data/cph-geodata.json`, which no longer exist.

## The frame

| | Value | Where |
|---|---|---|
| Origin | E 556000, N 6323100 (EPSG:25832) | `tools/geodata/frame.py` `ORIGIN`, `js/tile-grid.js` `ORIGIN_E/N` |
| Origin height | 3.85 m DVR90, the median DHM terrain within 10 m of the origin (set in phase 2) | `frame.py` `ORIGIN[2]`, `js/tile-grid.js` `ORIGIN_H` |
| District | E 555000–557000, N 6322000–6324000; local x −1000…1000, z −900…1100 | `frame.py` `LOCAL_BBOX`, `js/city-config.js` `CPH_FRAME.bbox` |
| Tiles | 1110_12644 … 1113_12647 (16) | from the bbox |
| Sun | 57.048 N, 9.919 E; grid convergence 0.77° | `js/sun-position.js`, `tools/geodata/appearance.py` |

Everything else imports these values: `terrain.py`, `streets.py`, `appearance.py`, `tree_canopy.py`, `skraafoto_prefetch.py`, `far_lod.py`, `city_water.py`, `ortho.py` and `vegetation_cir.py` in Python, and `city-config.js` plus the water and far-LoD modules in JS. The sea level follows the origin height (`SEA = -ORIGIN[2]`, `SEA_LEVEL_LOCAL`). To change it, edit `frame.py` and `js/tile-grid.js` and nothing else, then rerun `build_city.py --stage cells --force cells`.

Teleports (`js/city-config.js`, `index.html`, `js/cameras.js`, `tools/check-collisions.py`) were snapped to the road graph in phase 3 (docs/aalborg-phase3.md).

## Tests

- The monolithic Copenhagen data moved to `tests/fixtures/cph/`. 28 engine test files (controllers, texture-memory budget, traffic, collisions…) use it as input. Replace it with Aalborg fixtures once phase 2–3 data exists, then delete it, and its attribution in the README with it.
- Three tests are skipped because their Copenhagen water fixtures sit at the Copenhagen sea level: two in `goboat-harbour.test.mjs` and one in `lakes.test.mjs`. Their modules go in phase 4.
- `teleports.test.cjs` "street teleports land on the street they name" runs once `data/city/roadgraph.json` exists.

## Credentials and hosting

- `tools/adc-secret.sh` is gone. Every fetcher calls `tools/geodata/envsecret.py`, which reads the environment first, then `.env` (template: `.env.example`).
- Pages deploys only when the repository variable `DATA_URL` is set.
- The hosting and cloud tools take `R2_BUCKET`, `R2_ACCOUNT_ID`, `R2_PUBLIC_URL`, `TWIN_GCS_BUCKET`, `TWIN_GCP_PROJECT` and `TWIN_GCP_PROJECT_NUMBER` from the environment.

## Copenhagen left in the code, and when it goes

A case-insensitive grep for `copenhagen` still finds about 80 files. These are kept on purpose:

| What | Goes in |
|---|---|
| KK / Frederiksberg fetchers and KK WFS layers in `tools/geodata` (`build_city.py`, `city_sources.py`, `city_layers*.py`, `furniture.py`, `surfaces.py`, `entrances.py`, `city_tiles.py` DAGI) | phases 2, 3, 5 and 6 (datagrundlag.dk) |
| ~~roofer / point-cloud LoD2 path~~ | done in phase 2b (docs/aalborg-phase2.md) |
| Copenhagen-only scenery: `bridge-dlb*`, `goboat*`, `swan-*`, Irma sign, `lake-furniture.js`, Søerne lakes and water override, Københavnerfortov paving, hero loader (`hero-cache.js`, `heroesEnabled`) | phase 4 |
| `index.html` credits, the rest of the README, `tools/shoot-m2.py` camera views, `CITY_TELEPORT_LOCATIONS` | phase 4 |
| Comments ("Copenhagen's short links…") and identifiers (`CPH_FRAME`, `CopenhagenGround`, `cph-*` data format ids) | kept: renaming them buys nothing and makes upstream cherry-picks harder |
| `Europe/Copenhagen` time zone, `copenhagenLocalDateTimeToUtc` | kept: it is Denmark's time zone |
| `docs/research`, `docs/PLAN.md`, `docs/citywide-*.md` | upstream reference, kept as is |

`r2.dev` still appears in comments that explain why the data is packed. None of the author's bucket URLs, account ids or GCP project names remain outside `docs/research`.
