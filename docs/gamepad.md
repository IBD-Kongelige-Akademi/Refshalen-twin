# Gamepad

`js/gamepad-controls.js` reads the first connected pad that the browser reports with the **standard** mapping (`pad.mapping === 'standard'`). This covers Xbox One / Series pads and Xbox-licensed (XInput) pads in Chrome, Edge and Firefox, plus DualSense / DualShock 4 and Switch Pro pads in Chrome and Edge. Pads without that mapping, such as many DirectInput pads, are ignored. The browser only exposes a pad after one of its buttons is pressed with the page in focus.

To check a pad, open the console and run `navigator.getGamepads().filter(Boolean).map((p) => [p.id, p.mapping])`.

Button names below are Xbox names. On a PlayStation pad: A = Cross, B = Circle, X = Square, Y = Triangle, View = Share / Create, Menu = Options.

## Driving, walking and flying

| Input | Action | Keyboard |
|---|---|---|
| Left stick | Move / steer | W A S D |
| Right stick | Look / orbit the camera | Drag |
| Right stick click | Recenter the camera | |
| RT / LT | Throttle / brake and reverse (car, bus, bikes); climb / descend (drone) | W / S, Space / Q |
| A | Jump on foot; board or leave the GoBoat when you can | Space, E |
| X (hold) | Boost / sprint | Shift |
| B | Open or close the info panel for the building in the middle of the screen | Click |
| Left stick click | Horn | B |
| Y | Next camera | V |
| LB / RB | Previous / next mode | 1–5 |
| D-pad up / down | Zoom in / out | Wheel |
| D-pad left / right | Previous / next building model level | Shift+L / L |
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
