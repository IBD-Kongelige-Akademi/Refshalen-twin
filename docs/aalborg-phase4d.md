# Phase 4d notes: the drone

The sightseeing helicopter is gone; the fly mode (key 4, the gamepad's mode cycle, the touch layout's Ascend / Descend buttons) is
now an X-frame quadcopter. `git grep -i helicopter` finds it only in these notes and upstream's Copenhagen test fixture.

| | Helicopter (before) | Drone (now) |
|---|---|---|
| Model | lofted fuselage, rotors, skids (actor-models.js) | `createDroneModel`: rounded body under a light cover, four arms at 45°, motors, counter-rotating two-blade props with a blur disc, landing legs, gimbal camera under the nose, white front / red rear LEDs; 0.62 m across the prop tips |
| Flight | pitch to move, yaw on A / D | the same keys; the velocity follows the nose (no momentum lost in a turn), brakes to a level hover on release, tilts towards its travel up to 25° |
| Speed | 187 km/h | 60 km/h, 75 km/h with Shift (sport) |
| Height | 380 m absolute, teleports at 92 m | at most 120 m over the ground; teleports arrive 40 m over it; the HUD altitude counts over the ground |
| Body | 4.5 m radius, 3.2 m tall | 0.4 m radius, 0.3 m tall, origin at the feet |
| Cameras | chase 11.4 m back, 3.3 m up | chase 4 m back, 1.5 m up; the POV camera (7) is the gimbal's FPV view |
| Sound | rotor slap + turbine, 500 m | a baked four-prop buzz (blade-pass tones at ~200 Hz beating, motor whine); its pitch and level follow the motor load; 120 m |

All in `js/controllers.js` (`DRONE_FLIGHT`, `createDroneEntity`, `updateDrone`), `js/actor-models.js`, `js/cameras.js`,
`js/audio-synthesis.js` / `audio-sources.js` / `audio-system.js`, `js/collision-shapes.js`, `js/touch-controls.js`,
`js/gamepad-controls.js`, `js/main.js`, `index.html` and the CSS.

## Roofs and walls

- It stands on the terrain or on a roof: `droneSupportAt` takes the highest top under it that is no more than 0.35 m above it (it
  settles onto a roof from above; a wall it meets sideways stops it). Landed, it does not slide and the props idle; a climb takes off.
- Buildings with a loaded LoD2 record are **heightfields** for the drone: solid up to the roof as drawn at each point
  (`roofHeightSampler` in js/lod2-geometry.js over the record's roof triangles, exposed as `world.roofHeightAt`). The collision
  block of a building is one extrusion to the eave + 0.45 m, so on it the drone hovered over lower wings and sank into ridges; the
  heightfield follows the roof's steps and slopes. Where a record has no roof triangle over its footprint the block's top stands in.
  `droneBlockedAt` stops it at the wall of a higher part and lets it slide along on the free axis.
- Every other solid (poles, shelters, buildings without LoD2) stays a block, through the usual swept collision. Both the controller's
  sweep and the city collision stage skip the heightfield buildings for the drone (`staticSkip` on the entity, `skipStatic` on its
  collision actor), or they pushed it off a lower roof wing.

## Acceptance (in the viewer, `?hooks`)

- Teleported to Jomfru Ane Gade it arrived 40 m over the street (HUD 40; `docs/phase4d/drone-40m.jpg`).
- Flown 51 m down Jomfru Ane Gade at 3–4 m: 60 km/h, at most 18° of tilt, never below 1.9 m, and in none of 62 samples inside a
  building (`drone-jomfru.jpg`).
- Landed on a roof wing of gdk:1066940448 exactly on its LoD2 roof (15.40 m, the block's top is 17.8 m), motors off, not moved;
  a climb took off again (`drone-roof.jpg`, the gimbal view `drone-fpv.jpg`).
- The 120 m ceiling, sport speed, turns without momentum loss, roof landings (slopes, a lower wing, a strip without roof
  triangles), sliding along a heightfield wall and flying low down a street are unit tests in `tests/controllers.test.cjs`;
  `roofHeightSampler` and `colliderContainsPoint` have their own. The texture-budget and touch / collision tests pass.

Open: a roof slope higher than a step above the drone, inside the block's height range, is not a wall for it sideways (only the
rim samples at the body's radius see it), so flying low across a steep ridge it can clip the roof's upper part.
