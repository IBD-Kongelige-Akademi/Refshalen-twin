# Phase 6 notes: street detail

Trees and street furniture for the district from national data and OSM (`tools/geodata/furniture_dk.py`, run by
`build_city.py --stage furniture`; the OSM nodes come from `--stage fetch2`). Aalborg publishes no tree, lamp, bench or parking
register, so every list says where it comes from (`src`, `conf`, `licence` on each item) and the coverage report's "Source
substitutions" table repeats it.

```sh
uv run tools/geodata/build_city.py --osm-source api --stage fetch2 --stage furniture --stage index --stage report
```

## Sources and results (district, 16 tiles)

| List | Source | Built |
|---|---|---|
| trees | GeoDanmark Træ (4,195) + Trægruppe (88), OSM natural=tree where neither has one (1,121), crowns detected in the DSM − DTM where no tree is registered (2,670) | 8,074 (7,258 inside the tiles); 6,233 with a measured height |
| lamps | OSM highway=street_lamp (784) + GeoDanmark Mast within 18 m of a carriageway (1,948), none inside a footprint or at a signal | 2,732 |
| parking bays | GeoDanmark Parkering: closed car-park outlines (39; 5 under buildings skipped) | 1,188 |
| benches, bins, bollards, bike racks, glass containers | OSM nodes outside buildings | 332, 217, 120, 164, 60 |
| bus stops | OSM highway=bus_stop (shelter / bench / bin tags, a shelter node within 15 m) | 38 |
| monuments | OSM tourism=artwork, historic=memorial / monument | 96 |
| parking meters, bin stands, rescue posts, lake lights | none open | 0 |

- **Heights and crowns.** The DSM − DTM at 1 m (`data/raw/veg/ndsm_<cell>.tif`, fetched once through the WCS) gives each tree its
  height: the highest canopy within 2 m, buildings left out, at most 35 m. A canopy patch's area is shared among the trees standing
  in it for their crown radii (at most 9 m and 0.55 × the height). Trees without canopy keep an inferred height and crown.
- **Detected crowns** (`dhm:ndsm:crown`, `conf: inferred`, `canopy_added`) are canopy peaks above 4 m, 4 m apart, more than 3.5 m
  from a registered tree: mostly park and courtyard trees, which GeoDanmark (solitary trees only) does not register.
  Since phase 4c, a peak within half a road's width of a car-road centreline is dropped (77 of them): it is a crown reaching over
  the street from the pavement, not a trunk in the road. 2,593 detected crowns remain; 7,997 trees in all.
- **Genus.** No species register: OSM's `genus` / `species` where a tree is tagged, else `generic`, which js/tree-species.js turns
  into its context mix. With the point cloud (a Datafordeler key) the detected crowns could take class-5 shapes instead.
- **Lamps.** GeoDanmark masts are untyped; a mast near a carriageway that no OSM lamp or signal stands at is taken as a lighting
  column (tube pole, 8 m on wide roads, else 6 m, LED 3000 K, all inferred). No wire-suspended lamps.
- **GeoFA** holds only leisure facilities in the district (toilets, playgrounds, bike pumps, fitness: 37 points) that the engine
  has no models for; Aalborg publishes no GeoFA road inventory, parking or recycling tables.

## Engine change

`js/placement.js` knew only kerbside bays (snapped into a street's parking lane), so every car-park bay was dropped as
`off-carriageway`. Bays of kind `lot` now keep their pose wherever the car is clear of buildings, water, the moving lanes, cycle
tracks and other cars. In the viewer: 283 car-park bays kept, 543 dropped over buildings or mapped service lanes, 119 blocked.

## Acceptance

- `tests/street-furniture-city.test.mjs` (on the built Aalborg tiles): the documents map to a plan; every item has src / conf /
  licence; tree heights 2–45 m with crowns within the caps, > 70 % measured, < 1 % inside a building footprint, < 0.5 % in the
  water; lamps, bays and small furniture outside buildings. `tests/placement.test.mjs` covers the lot bays; the upstream
  street-furniture tests still pass on their Copenhagen fixture.
- In the viewer (9 near tiles): 3,329 trees, 1,060 lamps, 154 benches, 112 bins, 32 rack rows with 587 bikes, 19 bus stops
  (8 shelters), 23 monuments placed. Shots: `docs/phase6/furniture-torv.jpg` (Gammel Torv: a street tree, racks with bikes,
  bollards, lamp posts), `docs/phase6/furniture-kildeparken.jpg` (detected park trees in the context mix, a statue, a bench).

Open: street parking (no kerb-side register), wire-suspended lamps, species. The plan's "ask Aalborg Kommune for trees, signals,
cycle tracks and pavements" is still the way to better data.
