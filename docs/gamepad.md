# Gamepad

`js/gamepad-controls.js` reads the first connected pad that the browser reports with the **standard** mapping (`pad.mapping === 'standard'`). This covers Xbox One / Series pads and Xbox-licensed (XInput) pads in Chrome, Edge and Firefox, plus DualSense / DualShock 4 and Switch Pro pads in Chrome and Edge. Pads without that mapping, such as many DirectInput pads, are ignored. The browser only exposes a pad after one of its buttons is pressed with the page in focus.

To check a pad, open `tools/pad-test.html` (below): it shows the pad's name, whether it has the standard mapping, and the number of every button you press.

Button names below are Xbox names. On a PlayStation pad: A = Cross, B = Circle, X = Square, Y = Triangle, View = Share / Create, Menu = Options. On an 8BitDo pad, View is − and Menu is +.

Cameras have no pad button: pick them from the HUD's camera switch with the D-pad. Back paddles (8BitDo's L4 / R4) are not part of the browser's standard mapping, and in Chrome the Ultimate 2C reports nothing for them. To see what a pad's buttons report, open `tools/pad-test.html` on the dev server (http://127.0.0.1:8010/tools/pad-test.html) in Chrome or Edge, click the page and press them: it lights up each button with its number and shows the pad's name and mapping.

The browser pane in the Claude desktop app does not see gamepads; play and test with a pad in Chrome or Edge.

## The HUD with the D-pad

The D-pad moves a yellow highlight between the HUD's buttons, by where they sit on screen (`js/hud-nav.js`). Every HUD control can be reached this way:
- the toolbar: Map, Time of day, Teleport, Tour, Race, Buildings, Sound and Clean view;
- the mode bar, and the walker or bike type above it (Man, Woman, Roller skates, Skateboard; City bike, Cargo bike);
- the camera switch.

| Input | Action |
|---|---|
| D-pad | Show the highlight (it starts on Map), then move it. Holding a direction repeats it. |
| A | Press the highlighted button. A dropdown opens with the highlight on its current item, and the D-pad then moves inside the dropdown. |
| B | Close the open dropdown, or hide the highlight |

While the highlight shows, A and B go to the HUD and not to the game. The sticks and triggers keep driving. The highlight hides itself after 8 s without D-pad input.

## Driving, walking and flying

| Input | Action | Keyboard |
|---|---|---|
| Left stick | Move / steer | W A S D |
| Right stick | Look / orbit the camera | Drag |
| Right stick pressed in + up / down | Zoom in / out | Wheel |
| Right stick click (quick) | Recenter the camera | |
| RT / LT | Throttle / brake and reverse (car, bus, bikes); climb / descend (drone) | W / S, Space / Q |
| A (no HUD highlight) | Jump on foot; board or leave the GoBoat when you can | Space, E |
| X (hold) | Boost / sprint | Shift |
| B (no HUD highlight) | Open or close the info panel for the building in the middle of the screen | Click |
| Left stick click | Horn | B |
| Y | Next walker (Walk: Man, Woman, Roller skates, Skateboard) or bike type (Cycle: City bike, Cargo bike) | Click |
| LB / RB | Previous / next mode (keeps the last walker and bike type) | 1–5 |
| D-pad | The HUD (see above) | |
| View (tap) | Show or hide the HUD | H |
| View (hold 0.6 s) | Sound on or off | N |
| Menu | Open the full map | M |

## Full map

While the map is open, the pad drives the map. A crosshair marks the centre of the map from the first pad input. A mouse press hides it again.

| Input | Action |
|---|---|
| Left stick | Pan |
| RT / LT, or D-pad up / down | Zoom in / out (about the centre) |
| A | Teleport to the crosshair |
| X | Set the GPS route to the crosshair |
| B or Menu | Close the map |

Searching the map still needs a keyboard.

## Behaviour

- Buttons held while the pad connects, while the map opens or closes, while a mode changes, or after a teleport do not fire again until they are released.
- The pad does nothing while the window is unfocused or hidden, or while a text field has focus.
- B inspects the building that a ray through the middle of the screen hits first. In the chase camera this is the building ahead of the player. Pressing B on the same building again, or on no building, closes the panel, as a click would.
