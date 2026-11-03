# Phase 4 notes: scenery and water

## Removed (Copenhagen-only)

| What | Files |
|---|---|
| Dronning Louises Bro model | `js/bridge-dlb.js`, `js/bridge-dlb-geometry.js`, `tests/bridge-dlb.test.mjs` |
| GoBoat (mode, piers, harbour navigation) | `js/goboat*.js`, `tests/goboat-*.test.mjs`, `tests/fixtures/goboat-harbour.json`, `tools/audit-goboat.mjs` |
| Swan pedal boat (mode 5, moorings on Peblinge Sø) | `js/swan-boat.js`, `js/swan-navigation.js`, their tests in `controllers.test.cjs` and `teleports.test.cjs` |
| Irma neon sign | `js/irma-neon.js`, `js/irma-neon-art.js` (`buildings-real.js` keeps an empty `neon` stub for the stats it reports) |
| Hero-building glTF loader | `js/hero-cache.js`, `loadHero` and `heroesEnabled`; a hero listed in the data is extruded like any building |
| Søerne water override | `soerne_override` in `tools/geodata/city_water.py`; `water.json` has `override: null` |

The HUD now has four modes (walk, drive, cycle, fly) and keys 1–4; the boat button, the boat-type switch, the pier action and their CSS are gone.

## Kept on purpose

- **`js/pavement.js`**, the "Københavnerfortov" class: concrete slabs with granite sett strips is the common Danish pavement and the engine's only pavement material, so Aalborg's derived pavements use it. A distinct Aalborg look would be a phase 5/6 material change.
- **`js/lake-furniture.js`**: turns benches and rescue posts near any water towards it, which suits the Limfjord quay once furniture arrives in phase 6.
- **The generic lake engine** (`js/lakes.js`, `js/water.js`, `js/water-tiles.js`, `js/water-stream.js`) draws every water body, the Limfjord included.

## Water (city_water.py)

- `--fetch` reads GeoDanmark (soe, bassin, rekreativtomraade, begravelsesomraade, skov, kyst, havn) from datagrundlag.dk for the tiles' bbox + 500 m. The OSM shore evidence and land-use extras come from Overpass, or (Overpass down) from the cached OSM API map.
- The coastline is closed against the request's own lat/lon box: upstream's Copenhagen box left Aalborg with no sea.
- Result: the Limfjord as one sea-level body of 1.34 km² plus 5 lakes, 13 ponds and 2 river reaches; 4.3 km of quay wall (GeoDanmark `havn` lines), 0.8 km of natural bank; 0.55 km² of green ground. The sea body takes the name of a basin it absorbs ("Østre Havnebasin"); naming it "Limfjorden" is cosmetic and open.
- The ground-cut lattice stays anchored at −750 m: it is only an anchor, and the tile cuts are keyed by cell, so they work anywhere around it.

## Far ring and teleports

- `far_lod.py`: 2,703 buildings and 15 water polygons in `data/city/far.bin`.
- `city_teleports.py`: the citywide place list is empty until phase 8 (places outside the district are hidden anyway); `js/city-teleports.js` is regenerated from it.

## Acceptance

- Each of the six teleports in each of the four modes (24 runs): arrivals on the ground (the helicopter at 96 m), no script errors.
- The harbour front at Utzon Center reads as quay: a granite wall and coping along the water, paved quayside (`docs/phase4/utzon-quay.jpg`).
- The Python dev server times out under ~100 parallel requests now and then (two `lod2.bin` loads once); this is the local server, not the app.
