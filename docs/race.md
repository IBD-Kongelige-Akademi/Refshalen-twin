# The Kortdage race

A minigame for the Kortdage conference: race from AKKC to Jomfru Ane Gade in any vehicle, by any route. One highscore list
per kiosk, made fair across vehicles by a handicap.

Code: `js/race.js` (the runner), `js/race-scores.js` (handicap, list, storage), wired in `js/main.js` (`raceUi`), markup in
`index.html` (`#race-popover`, `#race-hud`, `#race-count`, `#race-result`), tests in `tests/race.test.mjs` and
`tests/race-scores.test.mjs`.

## Playing

- **Race** in the toolbar (or `R`) opens the list and the start button; `R` outside the popover starts at once, as does `?race=1`.
- The player is put at the AKKC start (`TELEPORT_LOCATIONS.akkc`), facing along its route, and held for a 3-2-1 countdown.
- The GPS routes to Jomfru Ane Gade. The clock (wall time) stops on entering the street: within 8 m of any road-graph link
  named *Jomfru Ane Gade*. A car can finish at either end of the walking street.
- Esc, **Give up**, a vehicle switch, a teleport (a jump of over 60 m in one frame) or the attract loop (60 s without input,
  where moving counts as input) cancels the race. Mode, teleport and tour controls are greyed out while racing.
- At the finish the visitor enters a name (required, 20 characters) and company (30), which go on the list.

## The handicap

Every mode has a reference speed (`REF_SPEED` in `js/race-scores.js`). At the start the race takes the mode's own route
length (the router in `js/overview-map.js`: car and bus on the carriageways with one-way rules, walkers, skaters and bikes on
every link, the drone straight) and the car's route length:

    par      = route length / REF_SPEED[mode]
    adjusted = time × car par / par

So a run exactly at its par scores the car's par, whatever the vehicle, and the list is sorted by the adjusted time ("car
time"). The raw time and mode are shown under each score. A run faster than half its par is rejected as a glitch.

**Tuning:** `REF_SPEED` is the only knob. If a mode tops the list too easily raise its speed; if it cannot compete lower it.
The starting values are estimates from the controllers' top speeds (`js/controllers.js`), not yet calibrated against test
drives.

## Organisers

- The list lives in the kiosk browser's localStorage (`aalborg-race-scores`); it survives reloads, not a cleared profile.
- **Export CSV** in the race popover downloads the whole list (rank, name, company, mode, adjusted and raw time, finish time).
- `?raceReset=1` clears the list after a confirm dialog.
