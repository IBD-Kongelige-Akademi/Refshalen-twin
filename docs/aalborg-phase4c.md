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

The destination sign reads `2 HOSPITALSBYEN` (the AI buses heading the other way show `2 VÆDDELØBSBANEN`). Shot:
`docs/phase4c/plusbus-livery.jpg`.

## Driving

- **Speed.** 70 km/h top speed with an electric pull-away: 1.6 m/s² up to about 30 km/h, then limited by power. Braking is 3.5 m/s²;
  reverse is 2.8 m/s. There is no boost.
- **Steering.**
  - The front module is a bicycle model on the 5.9 m first wheelbase, steered at the front axle.
  - The lock is 30°, rate-limited at the wheel and narrowed with speed (2.5 m/s² sideways). The front axle turns on a circle of
    about 24 m, close to the real bus.
  - **Why 30°.** The trailing axles are unsteered, so above 26° of lock a steady circle folds the first joint to the 38° clamp. The
    first build used 24° to stay under it, but then the front axle needs a 29 m circle and the bus could not take line 2's busway
    corner into the J.F. Kennedys Plads terminal. At 30° a tight 90° corner brings the first joint to the clamp for a moment
    (the trailer scrubs sideways); no axle swings outside the front axle's circle.
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
  - a steady circle under 26° of lock stays under 38° unclamped, the trailers off-tracking inside the front axle;
  - a 90° corner at the 30° lock: a ~24 m front-axle circle, joints at most 38°, no trailing axle outside the front axle's circle;
  - the bus straightens out after a turn;
  - reversing is clamped;
  - save and restore undo a move exactly.
- **Driving line 2 in the viewer.** A test driver (front axle tracking the line's path in the curb lane, braking for the curvature
  ahead) drove the player's bus along line 2 towards Hospitalsbyen:
  - Kastetvej's busway, Borgergade and the Jomfru Ane Gade stop, to Nytorv (s 120–1107). Joints at most 38° (the clamp, in the
    80° corner at Nytorv), no module inside a building, the front axle within 1.2 m of its lane. The run stopped behind a jam of AI
    traffic queued round the bus.
  - Boulevarden through the J.F. Kennedys Plads terminal (under its canopy) and on to the edge of the district at Hospitalsbyen's
    side (s 1700–1890 and 1960–3330). Joints at most 30.5°, no module inside a building, no stalls.
  - **Not passed:** the 130° hairpin loop inside the terminal (s 1880–1900). It is tighter than the bus's 24 m circle on the OSM
    path; the driver runs wide into a lamp post and a tree. Whether the real bus takes that loop on this line is not known.
  - The other direction (towards Væddeløbsbanen) was not driven.
  - An earlier run on the *car* route to Jomfru Ane Gade (through Bispensgade) is not a fair test: that corner is not on line 2.
- **Doors.** The doors open on all three modules at a stop, and the chase camera keeps every corner of the bus inside the frame
  (|NDC| ≤ 0.8) driving straight and in a full turn. Shots:
  - `docs/phase4c/plusbus-doors.jpg`: the player's bus at a stop with the curb-side doors open, and a regular AI bus in the NT colours;
  - `docs/phase4c/plusbus-terminal.jpg`: just out of the terminal canopy;
  - `docs/phase4c/plusbus-livery.jpg`.

### Fixed on the way

The drive found three data problems on line 2's route:

- **The bus terminal was a wall.** GeoDanmark registers the J.F. Kennedys Plads terminal roof (a canopy on pillars) as a 5.4 m
  building standing on the busway.
  - `tools/geodata/canopies.py` (build stage `canopies`, after lod2) marks a building as an open canopy when it has no BBR record,
    is at least half under an OSM `building=roof` and is at least 3.5 m tall. Its `base` is set 0.8 m under the eave.
  - The engine starts its walls and its collider there, draws it without its LoD2 record, and leaves it out of the walk-space
    footprints.
  - 4 canopies in the district: the terminal underside is at 4.4 m, 4.8 m over the road. The pillars are not modelled.
- **The Plusbus's own road was missing.** OSM maps Kastetvej's dedicated Plusbus road (and the terminal lanes) as `highway=busway`,
  a class `roads.py` dropped.
  - Busways are now service-class roads with `busOnly` (7 m wide two-way, 3.5 m one-way). It reaches the road graph as an 11th link
    field and the network edges as `chain.busOnly`.
  - Cars and the regular buses never route onto a busway or spawn on one; the Plusbuses do.
  - 30 road pieces and 63 graph links.
- **Trees in the carriageway.** Without a carriageway there, the Phase 6 crown detection put inferred trees on the busway.
  Inferred crowns are now dropped within half a road's width of a car-road centreline: 77 of them, branches reaching over a street
  from the pavement. Registered trees are unchanged.

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

**In the viewer**, AI Plusbuses spawned on Boulevarden and drove the route in both directions. An AI bus standing at a stop was not
watched there (the stop is covered by the unit test; the player's bus at a stop is in `plusbus-doors.jpg`).

## Not done

- **Perf: the target is not met.** The plan asks for at most 0.5 ms extra with four AI Plusbuses. `traffic.update` was timed in the
  viewer (about 10 fps there, so noisy) with the four buses on Boulevarden and with them removed, in two pairs of 12–15 s windows:
  - median 13.9 vs 11.3 ms, then 11.6 vs 10.6 ms: **+1.0 to +2.6 ms**;
  - the means disagree in sign between the pairs.

  The route code is not where it goes: projecting the four buses onto line 2 is 0.03 ms a frame. Likely suspects are the collision
  stage (four 28 t boxes) and traffic queued behind 24.7 m vehicles. A profiler run is needed.
- **The terminal hairpin.** See the acceptance above.
- **Bellows.** The AI buses' bellows are straight sleeves, so the outside of a tight bend shows a gap.
- **Network swaps.** A streamed network swap retires the AI Plusbuses with the rest of the traffic, and they are placed again out of
  sight.
- **Bus headlight beams.** The bus has no headlight spotlights: two more lights would recompile every material. Its lamps glow at night.
- **Sound.** The bus uses the street-bus motor voice, not an electric whine.
- **Body.** No pitch on slopes. The modules ride level at their own ground height.
- **Traffic.** Traffic does not see the trailing modules.
