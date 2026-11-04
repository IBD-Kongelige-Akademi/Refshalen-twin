# Bridges, railways and watercourses

Three kinds of geodata the twin was missing: watercourses (GeoDanmark vandløbsmidte and vandløbskant), railways and bridges (OSM).

```sh
uv run tools/geodata/city_water.py --fetch      # the GeoDanmark layers, watercourses included (once), then the water build
PYTHONUTF8=1 uv run tools/geodata/city_structures.py      # bridges and railways, and the terrain cut under the decks (after the water)
uv run tools/geodata/build_city.py --osm-source api --stage furniture --stage index --force furniture   # trees off the decks and the water
```

`city_structures.py` edits the tiles' terrain layers, so the index stage runs after it. It keeps each tile's original terrain in
`data/city/work/terrain_orig/` and always starts from that, so a rerun gives the same terrain. After a terrain rebuild (`--stage cells`),
delete that folder and run it again.

```sh
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

**The terrain under a deck.** The compiled terrain carried many bridges: a ridge across the fjord along Limfjordsbroen, a mound
over the railway at Vesterbro. Under every deck, the terrain is now set to the ground beside the bridge. Each cell takes a value between
the two points 2.5 m outside the deck's edge, across the nearest carried way, so a railway cutting or a road runs on under the bridge.
Over water that ground is the bed, 1 m under the water level. Cells are only ever lowered: 5,341 of them in 11 tiles. Deck heights are
measured on the terrain as compiled, before the cut.

**Result:** 34 structures, 3 ha; 13 stand more than 2.5 m over the ground (Limfjordsbroen up to 12 m over the fjord, Østre Allé 8 m
over the railway, Vesterbro 4 m over the tracks).

**Engine** (`js/structures.js`, `js/structures-geometry.js`, `js/deck-field.js`):
- **Geometry.** A deck has its top, a soffit and fascia where it stands clear, and concrete parapets on road and rail decks (railings on
  foot bridges) where it stands more than 0.8 m up. Piers stand every 24 m under the axes where the deck is more than 3 m up.
- **Ground model.** It stands on the decks (`withDecks`), and `levelAt(x, z, y)` picks the deck or the ground under it from where
  something is now. The player (`getGroundHeight` with the current height), the traffic (each vehicle's `gy`) and the AI pedestrians
  and cyclists (`agentLevel`: each one's last ground, reset by a jump of more than 5 m, a respawn) use it: what drives or walks onto a
  bridge stays on, what passes under stays under. Near Østre Allé, 9 of 10 pedestrians seen in a raised deck's footprint walked under
  it, and the cyclists on the cycle bridges rode on them.
- **Road surfaces.** The road worker drops the draped surface triangles under a deck that stands clear of the terrain, so no lane
  marking, kerb or cycle lane lies on or under a raised deck; the deck draws its own plain top. Steep triangles (kerb skirts) within
  3 m of a deck over its ground go too.
- **Furniture** stands on the decks, so the lamps on a bridge stay on it now that the terrain under it is cut away. No tree stands in
  a deck's footprint: the tree build masks the decks for detected crowns (the DSM over a deck is the deck) and drops any tree inside one.

## Railways

OSM `railway=rail` and disused tracks, not in tunnels: 69 tracks, 13.7 km (main, branch, siding, yard; 8 disused).
- Each track is a ballast bed with concrete sleepers painted on it and two rails at the standard gauge (1435 mm). A disused track has
  dark, rusty rails.
- Tracks lie at the terrain height (cut under the decks, so a track passes under a bridge), or on their deck where they are tagged a
  bridge. The build stores the heights every 4 m.

## Not done

- **Waterline fragments.** A few small green ground pieces still show at the waterline under Limfjordsbroen, where the water outline
  leaves gaps along the bridge.
- **Under a bridge.** A road under a bridge has no surface for the bridge's width (the deck above, the bare ground under it), and a lamp
  in a deck's footprint stands on the deck even when it is under it.
- **Bridge shapes.** Every bridge has the same section: no bascule span on Limfjordsbroen, no truss on Jernbanebroen, no stairs or ramps
  modelled apart from the terrain.
- **The deck top.** A raised deck's top is plain (asphalt, paving or ballast): the road markings are not redrawn on it.
- **Trains.** None run.
- **Platforms.** `railway=platform` and the station are not modelled.
- **Watercourse levels.** They are a stand-in (the terrain percentile), not a surveyed water level.

Shots: `docs/structures/limfjordsbroen.jpg` (the deck on its piers over the fjord, traffic and Plusbuses on it),
`docs/structures/vesterbro-bridge.jpg` (the railway running under Vesterbro),
`docs/structures/railway.jpg` (two tracks by the harbour). `?debug=nostructures` switches the layer off.
