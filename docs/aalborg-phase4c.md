# Phase 4c notes: the drivable Plusbus

A fifth player mode, **Bus** (key `5`, the bus button, gamepad / touch like the car): a Solaris Urbino 24 electric, the
double-articulated bus of Aalborg's Plusbus line. It starts parked on Vesterbro.

## The bus

| | |
|---|---|
| Length, width (no mirrors), height | 24.7 m, 2.55 m, 3.3 m |
| Modules (from the nose) | front 0–10.0 m, middle 10.7–17.7 m, rear 18.4–24.7 m; bellows 0.7 m |
| Axles | 2.7, 8.6, 16.55, 22.35 m; axle 1 steers, the others do not |
| Doors (curb side, double leaf, 1.2 m) | centres 1.15, 6.6, 14.15, 19.4, 23.65 m |
| Joints | at most 38° |

The module split, axle and door positions are inferred from the published length and from photos (Solaris publishes neither).
`js/articulated-bus.js` holds the layout (`URBINO_24`) and the kinematics. `js/actor-models.js` `URBINO_24_SPECS` builds one lofted
body per module from the city-bus loft:

- MetroStyle front with a deep windshield on the front module, tail lamps on the rear module, flat black joint faces between them.
- Battery pods on all three roofs.
- A per-module door list.
- A ribbed bellows sleeve (`createBusBellows`) bent between the two faces every frame.

**The livery** follows a photo of an Aalborg Plusbus:

- a white lower body with a yellow stripe under the black window band;
- a light-blue roof line, roof and roof pods;
- silver bellows.

The destination sign reads `+ PLUSBUS · CENTRUM`; no line number is shown. Shot: `docs/phase4c/plusbus-livery.jpg`.

## Driving

- **Speed.** 70 km/h top speed with an electric pull-away: 1.6 m/s² up to about 30 km/h, then limited by power. Braking is 3.5 m/s²;
  reverse is 2.8 m/s. There is no boost.
- **Steering.**
  - The front module is a bicycle model on the 5.9 m first wheelbase, steered at the front axle.
  - The lock is 24°, rate-limited at the wheel and narrowed with speed (2.5 m/s² sideways).
  - **Why 24° and not more.** The trailing axles are unsteered, so a steady turn folds the first joint to 38° at 26° of lock. At
    24° the joints reach 35° and 28°.
  - The front axle turns on a circle of about 29 m.
- **Trailers.** Each trailing module turns about the hitch behind the module ahead and follows its path. Its joint is clamped to 38°.
- **Collisions.**
  - The front module collides like a car, a 10 m box.
  - The middle and rear modules are oriented boxes checked against the buildings every frame. A move that would put one into a
    building is undone and the bus stops, so no module cuts a corner.
  - A head-on hit stops the bus; a glancing one scrubs speed.
  - Traffic and the city collision stage see the front module's box, with a mass of 28 t.
- **Doors.** After 1.2 s standing still with no throttle the five doors open, taking 1 s; the doorways show the floor, the saloon and
  the grab poles. The throttle closes them, and the bus moves off once they are shut (the door interlock).
- **Cameras.**
  - Chase: 24 m behind and 7.5 m above the middle module, so the whole bus stays in frame through a turn (about 12 m behind the tail).
  - Cab: the driver's eye behind the windshield (POV).
  - Action: a low side view.

## Acceptance

- `tests/articulated-bus.test.mjs`:
  - the layout;
  - the straight placement;
  - the clamp at 38° even past full lock;
  - at full lock the joints stay under 38° unclamped and the trailers off-track inside the front axle;
  - the bus straightens out after a turn;
  - reversing is clamped;
  - save and restore undo a move exactly.
- In the viewer, an automatic driver followed car routes from Budolfi and Boulevarden through the old town (Algade, Christiansgade).
  - The joints peaked at 24°.
  - No module entered a building.
  - On the tight old-town corners the rear module's guard stopped the bus. A 24.7 m bus cannot make those turns, and the driver has
    to back up and swing wide.
  - The run along the car route to Jomfru Ane Gade (via Bispensgade) was cut short and is still to do.
- The doors opened on all three modules at a stop. The chase camera kept every corner of the bus inside the frame (|NDC| ≤ 0.8)
  while driving straight and in a full turn.
- The livery shot is `docs/phase4c/plusbus-livery.jpg`. A shot of the open doors is still to take.

## AI Plusbuses on line 2

The Plusbus runs only on NT line 2. OSM maps it as two route relations, "Bybus 2: Væddeløbsbanen => Hospitalsbyen" and back
(`loc_name` "Plusbussen").

**The route data.** `tools/geodata/bus_lines.py` writes `data/city/bus-lines.json`:

- It reads the OSM API cache (`data/raw/city/osm_api/`).
- It chains each direction's route ways in relation order and keeps the longest run inside the district, 3.4 km each way.
- It projects the stops onto that path. 4 stops each way are within the district, among them Jomfru Ane Gade (Borgergade) and
  Jyllandsgade.
- build_city's `index` stage writes the file and names it in `data/tiles/index.json` (`city.busLines`), so the hosting packs carry it.

**In traffic** (`js/traffic.js`, section 2b), four AI Plusbuses run the route:

- **Spawning.** A Plusbus spawns in the curb lane of a route edge: an edge within 14 m of a direction's path, running its way. It may
  spawn on a short old-town edge with its tail over the edge before.
- **Following the route.** At every junction it takes the move onto the next route edge. One that strays off the route (the line
  leaves the network) is retired out of sight and placed again.
- **Driving.** The traffic model drives it as a 24.7 m vehicle, so cars keep their distance behind the tail. Its front module follows
  the lane path and the trailing modules follow their hitches, as on the player's bus.
- **Stops.** It pulls up with its nose at each stop and stands 14 s with the doors open. The doors shut before it moves off.
- **Collisions.** It collides as its front module, with a mass of 28 t.
- **Rendering.** Instanced: three module bodies, the front one under its direction's sign (2 HOSPITALSBYEN or 2 VÆDDELØBSBANEN);
  straight bellows sleeves turned and stretched between the faces; four axles of wheels.

**The regular AI buses** (12 m and 18 m) now wear the same NT colours. Their signs show lines that run through the district in OSM:
12 GISTRUP and 16 CITY SYD. Shot of an AI Plusbus on Boulevarden: `docs/phase4c/plusbus-line2.jpg`.

**Tests.** `tests/plusbus-traffic.test.cjs` checks:

- route edges, against the oncoming carriageway and parallel and cross streets;
- the move choice and going off route;
- the next stop from the front bumper, with passed stops counted as served;
- the dwell: the doors open for 14 s and shut before moving off.

`tools/geodata/tests/test_bus_lines.py` checks the way chaining, gaps and clipping.

**In the viewer**, AI Plusbuses spawned on Boulevarden and drove the route in both directions. A stop with the doors open was not
seen there: the page ran at about 1 fps while the window was in the background.

## Not done

- **Perf.** The perf target "0.5 ms extra with four AI Plusbuses" was not measured; the browser pane's frame rate is not reliable
  enough for it.
- **Bellows.** The AI buses' bellows are straight sleeves, so the outside of a tight bend shows a gap.
- **Network swaps.** A streamed network swap retires the AI Plusbuses with the rest of the traffic, and they are placed again out of
  sight.
- **Bus headlight beams.** The bus has no headlight spotlights: two more lights would recompile every material. Its lamps glow at night.
- **Sound.** The bus uses the street-bus motor voice, not an electric whine.
- **Body.** No pitch on slopes. The modules ride level at their own ground height.
- **Traffic.** Traffic does not see the trailing modules.
