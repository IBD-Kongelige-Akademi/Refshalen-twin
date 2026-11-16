# Start screen

`js/start-screen.js` (logic), `js/main.js` (`startUi`, the wiring), `index.html` (`#start-screen`), `css/style.css`
(`.start-screen`), tests in `tests/start-screen.test.mjs`.

The game runs as a kiosk at the Kortdage conference, so every visitor should see what it can do before playing. The
start screen sits over the running city and shows:

- a mode picker (Walk, Drive, Cycle, Fly, Plusbus), with the current mode marked;
- six features: the race, the tour, the map and teleports, the buildings and their levels, cameras, day and night;
- one row of controls: the keyboard, plus the gamepad once one is connected, or touch on a touch screen;
- three ways in: **Explore Aalborg**, **Race to Jomfru Ane Gade** and **Express tour**.

## When it opens

- After every boot, as the loading screen fades, unless the URL starts a tour (`?tour=`) or the race (`?race=1`).
- When input ends the attract loop (js/tour.js). The loop's `stop()` has put the player back at AKKC by then, so the
  next visitor starts there.
- It closes when the attract loop starts (60 s without input, `?idle=`).
- `?intro=0` turns it off.

## Input

While it is open nothing reaches the game: a capture-phase `keydown` listener on `window` takes every key (except
Ctrl / Alt / Meta combos and the F keys), the gamepad sends its presses to `onStartPad` instead of driving, touch
controls are disabled and the HUD is hidden (`body.start-open`).

| Action | Keyboard | Gamepad |
|---|---|---|
| Pick a mode | 1–5, or the arrows and Enter | LB / RB, or the D-pad and A |
| Explore | Enter, Escape | A on Explore, B |
| Race | R | Y |
| Express tour | T | X |
