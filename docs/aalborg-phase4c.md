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

## Not done

- **AI Plusbuses on the real route** (optional in the plan). The perf target "0.5 ms extra with four AI Plusbuses" belongs to them
  and was not measured.
- **Bus headlight beams.** The bus has no headlight spotlights: two more lights would recompile every material. Its lamps glow at night.
- **Sound.** The bus uses the street-bus motor voice, not an electric whine.
- **Body.** No pitch on slopes. The modules ride level at their own ground height.
- **Traffic.** Traffic does not see the trailing modules.
