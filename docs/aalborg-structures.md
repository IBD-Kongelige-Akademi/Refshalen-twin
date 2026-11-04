# Bridges, railways and watercourses

Three kinds of geodata the twin was missing: watercourses (GeoDanmark vandløbsmidte and vandløbskant), railways and bridges (OSM).

```sh
uv run tools/geodata/city_water.py --fetch      # the GeoDanmark layers, watercourses included (once), then the water build
PYTHONUTF8=1 uv run tools/geodata/city_structures.py      # bridges and railways (after the water: the ground under a deck over water)
uv run tools/geodata/build_city.py --osm-source api --stage furniture --stage index --force furniture   # trees off the decks and the water
```

## Watercourses

There is no open **vandløbsflade** (watercourse surface): datagrundlag.dk has no such GeoDanmark table, and GeoDanmark's own WFS needs a
Datafordeler key. So `city_water.py` derives the surfaces from the two line layers it does have.

- **Width.** Each open, visible centreline (vandløbsmidte: *Almindelig*, `synligvandloebsmidte` set) is widened to its bank lines
  (vandløbskant within 12 m on each side). Where no bank line is drawn, its width class sets it (0–2.5 m: 1.5 m; 2.5–12 m: 4 m).
- **Pieces.** The stream is cut into 20 m pieces. Each is flat at the 85th percentile of the terrain over it plus 8 cm: the ground mesh
  is coarser than the channel, so at the median the water would sink under it.
- **Left out:** piped (*Rørlagt*) and hidden stretches, and water a lake or the sea already covers.
- **In the engine** the pieces are pond-like bodies: no shore walls, no ground cut.
- **Result:** 127 pieces, 1.6 ha, mostly the Østerå through Åparken.

## Bridges

`city_structures.py` writes the post layer `structures`: `data/tiles/<id>/structures.json` and the header `data/city/structures.json`.

**Footprints.** A deck is the OSM `man_made=bridge` outline where there is one (Limfjordsbroen, Jernbanebroen over Limfjorden,
Kulturbroen and 18 more). Elsewhere it is the strip of the OSM bridge ways: roads, paths, busways and railways tagged `bridge=*`,
buffered to their width.

**Heights.** The deck top along each carried way comes from the DHM surface model: the compiled terrain plus the DSM − DTM rasters the
furniture stage caches.
- It is the median across the deck at each 2 m station, smoothed (more for footways, which pick up their railings).
- The ground under a deck is the water where the deck is over water, else the terrain. The build stores it with every outline vertex
  and axis station, so the engine needs no terrain to draw a deck that spans tiles.

**Result:** 34 structures, 3 ha; 6 stand more than 2.5 m over the ground (Limfjordsbroen up to 8 m over the fjord, Østre Allé 8 m
over the railway).

**Engine** (`js/structures.js`, `js/structures-geometry.js`, `js/deck-field.js`):
- **Geometry.** A deck has its top, a soffit and fascia where it stands clear, and concrete parapets on road and rail decks (railings on
  foot bridges) where it stands more than 0.8 m up. Piers stand every 24 m under the axes where the deck is more than 3 m up.
- **Ground model.** It stands on the decks (`withDecks`), and `levelAt(x, z, y)` picks the deck or the ground under it from where
  something is now. The player (`getGroundHeight` with the current height) and the traffic (each vehicle's `gy`) use it: what drives
  onto a bridge stays on, what passes under stays under.
- **Road surfaces.** The road worker drops the draped surface triangles under a deck that stands clear of the terrain (the deck is drawn
  there). Where the terrain already carries a bridge (the fjord bridges: the compiled terrain runs across the water at deck height), it
  drops only the steep triangles, the kerb skirts that hung from the deck down to the water.
- **Furniture** stands on the ground without the decks: a tree beside or under a bridge is not lifted onto it. The tree build masks
  the decks for detected crowns (the DSM over a deck is the deck).

## Railways

OSM `railway=rail` and disused tracks, not in tunnels: 69 tracks, 13.7 km (main, branch, siding, yard; 8 disused).
- Each track is a ballast bed with concrete sleepers painted on it and two rails at the standard gauge (1435 mm). A disused track has
  dark, rusty rails.
- Tracks lie at the terrain height, or on their deck where they are tagged a bridge. The build stores the heights every 4 m.

## Not done

- **People.** Pedestrians and cyclists (the AI ones) use the deck-aware ground without `levelAt`: one walking under a bridge is lifted
  onto it there.
- **Waterline fragments.** Small green ground pieces are left at the waterline along Limfjordsbroen, where the water's ground cut meets
  the bridge strip.
- **Bridge shapes.** Every bridge has the same section: no bascule span on Limfjordsbroen, no truss on Jernbanebroen, no stairs or ramps
  modelled apart from the terrain.
- **The deck top.** Under a raised deck the deck's own top is plain (asphalt, paving or ballast): the road markings are not redrawn on it.
- **Trains.** None run.
- **Platforms.** `railway=platform` and the station are not modelled.
- **Watercourse levels.** They are a stand-in (the terrain percentile), not a surveyed water level.

Shots: `docs/structures/limfjordsbroen.jpg` (the deck on its piers over the fjord, traffic and Plusbuses on it),
`docs/structures/railway.jpg` (two tracks by the harbour). `?debug=nostructures` switches the layer off.
