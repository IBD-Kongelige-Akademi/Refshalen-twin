# The Kortdage tour

A tour of the twin for the Kortdage conference stand at AKKC. It starts at AKKC, visits the seven teleports, comes back to AKKC, and shows one feature of the game at each stop.

| Variant | How it runs |
|---|---|
| **Express** (about 2 min) | Hands-off. It opens with a start scene at AKKC: a director's glide from high over the Limfjord down to AKKC, then the car, the bike and the Plusbus driving down Vesterbro past the venue. After that, at each stop it fades to black, teleports, shows the stop's scenic camera and a caption card, and plays the beats marked `express`. |
| **Full** (about 6 min) | Hands-off, like Express, but plays every beat: an orbit over the whole city before the glide, the skater in the start scene, building levels at Budolfi, the walker at Jomfru Ane Gade, the drone at Utzon Center, traffic and the AI Plusbuses at Musikkens Hus, weather at Karolinelund, the GPS map at Hvide Hus. |
| **Drive** | The visitor drives in their own mode; a drone starts the tour in the car. The map's GPS routes to the next stop. The start scene is skipped (beats marked `guidedOnly`). Arriving plays that stop's express captions, along with the time, weather, building and horn actions. Cameras and modes are left alone, so the visitor keeps control. **Skip leg** teleports to the next stop. |
| **Attract loop** | Starts after 60 s without input and plays the Express tour on a loop. Any key, click, touch, scroll or gamepad press ends it. Mode, time, weather and building level go back to what they were, and the visitor stands at AKKC. Moving the mouse only resets the timer. |

## Starting it

Open the **Tour** button in the toolbar, or use these URL parameters:

| Query | Behaviour |
|---|---|
| `?tour=express` / `full` / `drive` | Starts that tour once the city is on screen. |
| `?tour=loop` | Starts the looping Express tour at once. |
| `?idle=<s>` | Seconds without input before the attract loop starts (default 60; `0` turns it off, which is handy while developing). |

**At the stand:** open `http://127.0.0.1:8010/?tour=loop` in Edge or Chrome and press F11 for fullscreen.

## Controls during a guided tour

| Input | Action |
|---|---|
| → or Space | Next beat, or next stop after the last beat |
| ← | Back: restarts the stop, or goes to the previous stop from its first beat |
| Esc | End the tour |

- **Gamepad:** A or D-pad right for next, D-pad left for back, B to end.
- **Card buttons:** the same three actions.
- **Other keys:** H (HUD) and N (sound) still work. All other keys are ignored while the guided tour runs, and the player is held still.

## Editing the stops

The tour is data in [js/tour-script.js](../js/tour-script.js). Its header comment lists the actions. A stop's first beat sets the mode, time and sky (a test checks this), so no vehicle is carried into a park or onto a quay, and stepping back looks the same as the run. The Plusbus only appears in the start scene, on Vesterbro: at the harbour front and in the park it has no proper road to stand on.

**Director's shots** (`{ shot }`) hold the camera on a computed view for one beat: an `orbit` circles a point (the Utzon Center and Musikkens Hus are orbited around their footprint centres), and a `glide` eases between two views (the opening). The camera is set through `cameraSystem.debugView`, so the tiles keep streaming around the player and not around the camera.

`tests/tour.test.mjs` checks the following:
- The tour starts and ends at AKKC, and every teleport is a stop.
- Every camera exists.
- Express lasts 100–140 s and Full lasts 300–420 s.
- The runner restores what it changed.

The runner is [js/tour.js](../js/tour.js), and js/main.js wires it in (`tourUi`, the keys and the loop). After each teleport it holds the black for at least 0.8 s, and for up to 2.5 s while the tile streamer is still fetching or building.
