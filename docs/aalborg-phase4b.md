# Phase 4b notes: overview map

The radar minimap (bottom left) and the full-screen map ([M] or the Map button), ported from the upstream `js/nyc-map.js` that
copenhagen-twin removed with New York, as `js/overview-map.js`.

## What it draws, and from where

| Layer | Source |
|---|---|
| Building footprints, three tones by height above the ground (≤ 10 m, ≤ 20 m, taller) | `data/city/map.json` (`tools/geodata/city_map.py`, from the tiles' `buildings.json`) |
| The Limfjord, lakes and ponds; parks; green ground | `map.json`, from the tiles' `water.json` and `roads.json` |
| Streets by class (primary to footway), street names along their course | `data/city/roadgraph.json`, which the engine already loads |
| Water and park names | `map.json` `labels` (named bodies and parks ≥ 4,000 m², at the centre of their largest piece) |
| Place pins, search | `TELEPORT_LOCATIONS` (js/city-config.js) |

`map.json` (0.48 MB, 3,340 footprints, 20 water pieces, 47 parks, 173 green areas, 11 labels) is written by `build_city.py`'s
`index` stage and named in `data/tiles/index.json` (`city.map`), so `tools/hosting/build_packs.py` packs it with the other city files.
The map reads it through the tile store (`world.fetchCityJson`), so it is complete before any tile streams in.

The map is drawn grid north up; the compass needle shows true north 0.77° to its left (`GRID_CONVERGENCE_DEGREES`, js/sun-position.js).

## Changes from the original

- **Routing**: the GPS route is a shortest path (Dijkstra) on the road graph instead of the Manhattan "x first, then z" line. Driving
  keeps to the carriageways and their one-way direction (`lanesFwd` / `lanesBack`); walking and cycling use every link both ways. It
  is recomputed at most every 400 ms, and only once the player has moved 15 m or changed mode.
- **Click** teleports; **shift-click or right-click** sets the waypoint instead (the original teleported and set the waypoint on the
  same spot, so its route was always empty). A search's best hit becomes the waypoint on Enter.
- **Search** folds æ ø å to ae oe aa and drops accents, so "Osteraagade" finds Østerågade; an exact street name wins over substrings.
- No borough polygons, Central Park, bridges or highways layers; the land is the extent of the data, outside it the map is dark.
- The water is not outlined: its pieces are cut at the 500 m tile edges, and an outline drew those cuts across the fjord.

## Acceptance

- The radar shows in the bottom-left corner and turns with the camera (`docs/phase4b/radar.png`).
- M opens the full map; a search for "Jomfru Ane Gade" highlights the street and frames it (`docs/phase4b/map-jomfru.jpg`); Enter
  routes there from Gammel Torv along the streets (`docs/phase4b/map-route.jpg`).
- A click near the Utzon Center pin teleported the walker to (151, −157), beside the preset at (158, −166).
- Frame cost, measured in the browser pane on this machine: the open full map draws in 0.04 ms a frame and the radar in 0.07 ms
  per redraw (15 a second), both from cached ground layers; a full re-render (about 10 ms) happens only while panning or zooming,
  and a radar cache rebuild (about 4 ms) when the player nears its edge. Median frame time with the map open and closed: 49.9 vs
  49.8 ms. `tools/perf/frame-budget.py` was not run (it needs a headless WebGPU browser).
- Tests: `tests/overview-map.test.cjs` (click ↔ world mapping at three pixel ratios, pointer handling, chains, labels, one-way
  routing, the route cache, the Jomfru Ane Gade search on the built road graph) and `tools/geodata/tests/test_city_map.py`.

## Also in this change

- `city_water.py` names the sea body "Limfjorden" (`SEA_NAME`) instead of the basin it absorbed ("Østre Havnebasin").
- `world.fetchCityJson` and `__twin.mapSystem` (with `?hooks`) for checks.
