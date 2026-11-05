# Bridges, railways and watercourses

Three kinds of geodata the twin was missing: watercourses (GeoDanmark vandløbsmidte and vandløbskant), railways and bridges (OSM).

```sh
uv run tools/geodata/city_water.py --fetch      # the GeoDanmark layers, watercourses included (once), then the water build
PYTHONUTF8=1 uv run tools/geodata/city_structures.py      # bridges, underpasses, railways; the terrain and water under the decks (after the water)
uv run tools/geodata/build_city.py --osm-source api --stage furniture --stage index --force furniture   # trees off the decks, lamps under them
```

`city_structures.py` edits the tiles' terrain layers, so the index stage runs after it. It keeps each tile's original terrain in
`data/city/work/terrain_orig/` and always starts from that, so a rerun gives the same terrain. After a terrain rebuild (`--stage cells`),
delete that folder and run it again. It also adds water under the decks over the water to the tiles' water layers (marked `deck`), so
it runs after `city_water.py` every time.

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
Over water that ground is the bed, 1 m under the water level. Cells are only ever lowered: 5,484 of them under the decks.

**The terrain in the water.** The ridges the compiled terrain carries across the fjord are wider than the bridge outlines. So all the
terrain under the sea and the rivers goes down to the bed wherever it stands higher: 196,541 cells in 14 tiles. The terrain under the
water added beneath the decks goes down too. Streams and ponds keep their ground, since they lie on it with no shore walls. The bridges
keep their heights: the decks are measured on the terrain as compiled, before any cut.

**Water under a deck.** The water build leaves a bridge's strip out of the water. Under a deck over the water, the strip (the footprint
within 3 m of the water, less the water) is added to the water body beside it: 695 m², so the bed under the bridge no longer shows as
green ground at the waterline.

**Underpasses.** Every road, path or railway that passes under a deck has its ground lowered for clearance, ramped back along the way and
the ways it runs on into (turning under 50°), with 1:1 banks at the sides.

| What passes under | Clearance under the soffit | Ramp grade |
| --- | --- | --- |
| Road | 4.2 m | 6 % |
| Railway | 4.6 m | 2.5 % |
| Path, cycleway, steps | 2.5 m | 8 % |

- **Soffit.** The deck top less the deck's thickness (1.0 m road, 1.2 m rail, 0.45 m foot).
- **Passing under.** A way counts as passing under where the deck stands at least 1.5 m over it, so a path that joins a bridge at its
  end is not dug out. The ways the deck carries are never lowered. Covered ways count too: Strandvejen is `covered=yes` under
  Limfjordsbroen.
- **Limits.** The ground is lowered by at most 4 m, never to less than 0.3 m over the sea, and only ever lowered.
- **Result.** 67 ways under 13 decks, lowered in 4,891 cells. Strandvejen under Limfjordsbroen now has 3.1 m (it had 0.5 m; the sea limit
  stops it there), Kastetvej 4.2 m, Reberbansgade 3.6 m, the tracks under Østre Allé and Vesterbro 4.6 m.

**Tunnel decks.** Some underpasses are mapped only as a short tunnel (under 80 m), with the road over it not tagged a bridge. The road
over the tunnel gets a deck as wide as the tunnel's corridor (the road plus 4 m of pavement), its top on the road's surface, and the
tunnel is lowered under it. A tunnel deck is kept only where the tunnel can reach 80 % of its clearance. That leaves 4 of 9: Kærlundsvej
under Østre Allé, the footways under Postmestervej and Vesterbro, and the service road under Søndre Skovvej. The other 5 are car-park
ramps near Nytorv and Rendsburggade, where the ground is too close to the sea; tunnels inside a building are left alone.

**Result:** 38 structures, 3 ha; 18 stand more than 2.5 m over the ground (Limfjordsbroen up to 12 m over the fjord, Østre Allé 8 m
over the railway, Vesterbro 4 m over the tracks).

**Engine** (`js/structures.js`, `js/structures-geometry.js`, `js/deck-field.js`):
- **Geometry.** A deck has its top, a soffit and fascia where it stands clear, and concrete parapets on road and rail decks (railings on
  foot bridges) where it stands more than 0.8 m up. Piers stand every 24 m under the axes where the deck is more than 3 m up.
- **Ground model.** It stands on the decks (`withDecks`), and `levelAt(x, z, y)` picks the deck or the ground under it from where
  something is now. The player (`getGroundHeight` with the current height), the traffic (each vehicle's `gy`) and the AI pedestrians
  and cyclists (`agentLevel`: each one's last ground, reset by a jump of more than 5 m, a respawn) use it: what drives or walks onto a
  bridge stays on, what passes under stays under. Near Østre Allé, 9 of 10 pedestrians seen in a raised deck's footprint walked under
  it, and the cyclists on the cycle bridges rode on them.
- **Road surfaces** (`settleOnDecks` in `js/road-compute.js`). Where a deck stands clear of the ground, every surface vertex is
  sorted onto or under it.
  - **On the deck:** the vertices of the deck's own ways (the bridge road, its cycle tracks) are lifted onto the deck top, keeping their
    height over the ground. The bridge keeps its lanes, markings and kerbs.
  - **Under it:** the vertices of any other way stay on the ground, so the road under a bridge keeps its surface.
  - **How a vertex is sorted.** Road and cycle-track vertices carry the id of the way they were drawn for (`owner`, from
    `js/road-surfaces.js`). Pavement and register ground go to the nearest way.
  - **Dropped:** a triangle that would join the deck to the ground under it, or to the ground beside it (a surface running past the
    outline).
- **Furniture.** The furniture build marks what stands under a raised deck by the same rule, the nearest way (`under: 1`,
  `furniture_dk.py mark_under_decks`); 11 items. Those stand on the ground under the deck, the rest on it: a lamp beside the road under
  a bridge stays down there, a lamp on the bridge stays on it. No tree stands in a deck's footprint: the tree build masks the decks for
  detected crowns (the DSM over a deck is the deck) and drops any tree inside one.

## Railways

OSM `railway=rail` and disused tracks, not in tunnels: 69 tracks, 13.7 km (main, branch, siding, yard; 8 disused).
- Each track is a ballast bed with concrete sleepers painted on it and two rails at the standard gauge (1435 mm). A disused track has
  dark, rusty rails.
- Tracks lie at the terrain height (cut under the decks, so a track passes under a bridge), or on their deck where they are tagged a
  bridge. The build stores the heights every 4 m.

## Where pedestrians walk

AI pedestrians walk on lines beside the road graph. Those lines used to be tested only against buildings, so many lay on a carriageway the
graph drew narrower than the road surface, on a road beside them, or along the tracks. `js/walk-limits.js` now holds the limits per tile
(from the tile's roads, tracks, railway land and water), and `js/pedestrian-routes.js` lays the lines and corners by them:

- **Water and railway.** A line never runs through water or along a track (2.5 m either side of the centreline) or OSM `landuse=railway`
  (22 ha at the station). It may cross a track straight over, up to 7 m. A bridge deck is exempt: what is on it is over them.
- **Roads.** A line moves out from its road, up to 6 m, until it is off the carriageway. If no position works, that side has no line. It
  may cross a driveway's mouth (a service road, up to 8 m) and clip another carriageway by 2.5 m. Its ends stop at the kerb of the street
  they meet.
- **Intersections.** The crosswalks are the way over at signals. A corner may cross a carriageway only at the mouth of an intersection
  without signals, within 6 m past its widest road.
- **Green areas and pavements** have no limit: anything off these is allowed.

Where 340 pedestrians stand, in 20,400 samples at 6 spots over the district:

| | Before | After |
| --- | --- | --- |
| On a walking line, on a carriageway | 26.6 % | 5.0 % |
| On a walking line, on a track | 2.7 % | 0.1 % |
| In water | 0.05 % | 0 |
| Crossing at a crosswalk, on the road | 10.1 % | 11.2 % |
| On a corner, on a carriageway (at intersections) | counted with the lines | 10.3 % |

The 5 % is mostly driveway mouths and the last metre of a line at a kerb. Every pedestrian still finds a place.

## Paths in the green

`tools/geodata/city_paths.py` (after `city_water.py`, then the index stage) turns the OSM footways, paths and pedestrian ways into gravel:
each is buffered to its width, at least 1.8 m, and the part inside the green ground becomes a `gravel` polygon in the tile's surfaces
layer: 150 polygons, 2.9 ha. They are marked `path: 1`, so a rerun replaces them and they do not repave a pavement they meet.

Pedestrians walk them too. A footway with at least half its length in the green is a park path (`parkPaths` in `js/walk-limits.js`):
straight tracks between its vertices, joined where they share a point. A path's loose end within 12 m of a walking line is a gate: 12 % of
the people passing turn in, and those leaving join the line there. One pedestrian in six starts on a path where there are any nearby. A
path that runs along a carriageway is left out. About 14 % of pedestrians were on a path in the last sample across the 6 spots.

## Not done

- **Underpass walls.** A lowered underpass has earth banks, not retaining walls, and a junction beside it is lowered only along the way
  that passes under (a side street meets the ramp at a step down its bank).
- **Low underpasses near the sea.** Strandvejen under Limfjordsbroen gets 3.1 m, not 4.2 m. The car-park ramps by Nytorv and
  Rendsburggade have no tunnel decks.
- **Bridge shapes.** Every bridge has the same section: no bascule span on Limfjordsbroen, no truss on Jernbanebroen, no stairs or ramps
  modelled apart from the terrain.
- **Yielding at unsignalled corners.** Cars do not yield to someone crossing a side street's mouth; they meet through the collision pass.
- **Trains.** None run.
- **Platforms.** `railway=platform` and the station are not modelled.
- **Watercourse levels.** They are a stand-in (the terrain percentile), not a surveyed water level.

Shots: `docs/structures/limfjordsbroen.jpg` (the deck on its piers over the fjord, traffic and Plusbuses on it),
`docs/structures/vesterbro-bridge.jpg` (the railway running under Vesterbro), `docs/structures/gravel-paths.jpg` (gravel paths in a park),
`docs/structures/strandvejen-under.jpg` (Strandvejen under Limfjordsbroen, the bridge with its lane markings),
`docs/structures/railway.jpg` (two tracks by the harbour). `?debug=nostructures` switches the layer off.
