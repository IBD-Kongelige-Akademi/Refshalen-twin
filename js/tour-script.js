// js/tour-script.js
// The Kortdage tour (js/tour.js runs it): a start scene at AKKC, then the teleport stops round the city and back, each with a
// few beats that show a feature of the twin. Data only, so the captions are easy to edit or translate (docs/tour.md).
//
// A stop is { id, title, sub, beats }: `id` is a TELEPORT_LOCATIONS key. A beat is
// { caption, hold, express?, guidedOnly?, do: [...] }: `hold` is the seconds it stays on screen; the Express tour plays only the
// beats marked `express`, the Full tour plays them all; the drive tour plays the express beats that are not `guidedOnly`.
// The actions in `do` run in order when the beat starts:
//   { camera: id }            a camera preset (js/cameras.js): the stop's scenic view, 'chase', 'action', ...
//   { shot: {...} }           a director's shot for the beat (js/tour.js shotPose): { orbit: [x, z], radius, height, lookY,
//                             from, speed } circles a point; { glide: [[pos, look], [pos, look]], duration } eases between views
//   { mode: m }               person / car / cyclist / drone / bus (the tour puts the visitor's own mode back at the end)
//   { avatar: a }             the walker: man / woman / skater / skateboarder
//   { place: { x, z, heading } }  cuts the player to that spot (after a mode switch: the vehicle starts there)
//   { input: { forward: 0.5 } }   holds controls for the whole beat (driving off, the drone climbing)
//   { time: t }               golden / midday / twilight / midnight
//   { sky: s, wet: w }        clear / overcast and the road wetness (null: the preset's own)
//   { level: l }              building model level: white / lod2 / photo / generated / full
//   { building: id }          opens the building info panel on that building
//   { honk: true }            the active vehicle's horn
//   { map: 'route' }          opens the full map with the GPS route to the next stop ('close' closes it)
// Every stop's first beat sets the mode, time and sky, so no vehicle is carried into a park or onto a quay, and stepping back
// looks the same as the run. The drive tour only runs the actions that leave the visitor in control (time, sky, building, honk).

const AKKC_ID = 'gdk:1210731072'; // tools/overrides/akkc.py
const BUDOLFI_ID = 'gdk:1019258625'; // tools/overrides/budolfi.py

// Vesterbro southbound past AKKC in the right-hand lane: just after the signals at (-654, 370), so the queue at the red light
// is behind; the next signals are 350 m on (-729, 742)
const VESTERBRO = { x: -668.2, z: 399.3, heading: -0.32 };
// ...and beside it on the west side: the cycle track (OSM cycleway (-667.5, 386.7) to (-680.8, 425.0)) and, outside that, the pavement
const VESTERBRO_CYCLE_TRACK = { x: -671.5, z: 398.2, heading: -0.33 };
const VESTERBRO_PAVEMENT = { x: -674.1, z: 399.4, heading: -0.34 };
// the visitor's start: Europa Plads in front of AKKC (TELEPORT_LOCATIONS.akkc)
const EUROPA_PLADS = { x: -663.7, z: 467.9, heading: 0.70 };
const GOLDEN = [{ time: 'golden' }, { sky: 'clear', wet: null }];
// The director's opening: high over the Limfjord looking across the old town, down to AKKC and Vesterbro
const CITY_ORBIT = { orbit: [-250, 0], radius: 700, height: 340, lookY: 0, from: Math.PI, speed: 0.05 };
const DESCENT = { glide: [[[-645, 340, -578], [-250, 0, 0]], [[-560, 60, 330], [-586, 12, 505]]], duration: 10 };

const TOUR_STOPS = [
  {
    id: 'akkc',
    title: 'Aalborg Kongres & Kultur Center',
    sub: 'Welcome to Kortdage',
    beats: [
      { hold: 12, caption: 'Welcome to Kortdage. This is Aalborg as a digital twin, built from open Danish map data.', do: [...GOLDEN, { mode: 'person' }, { avatar: 'man' }, { shot: CITY_ORBIT }] },
      { express: true, guidedOnly: true, hold: 10, caption: 'Aalborg from above: 3,340 buildings at their measured heights, the Limfjord, the streets and the parks.', do: [...GOLDEN, { mode: 'person' }, { avatar: 'man' }, { shot: DESCENT }] },
      { express: true, guidedOnly: true, hold: 6, caption: 'Drive it: cars on the real street network, here down Vesterbro past AKKC.', do: [{ mode: 'car' }, { place: VESTERBRO }, { camera: 'chase' }, { input: { forward: 0.55 } }] },
      { express: true, guidedOnly: true, hold: 5, caption: 'Cycle it, on a city bike or a cargo bike.', do: [{ mode: 'cyclist' }, { place: VESTERBRO_CYCLE_TRACK }, { camera: 'action' }, { input: { forward: 1 } }] },
      { express: true, guidedOnly: true, hold: 6, caption: 'Or drive the Plusbus: the 24.7 m articulated electric bus of line 2.', do: [{ mode: 'bus' }, { place: VESTERBRO }, { camera: 'chase' }, { input: { forward: 0.85 } }, { honk: true }] },
      { guidedOnly: true, hold: 7, caption: 'Skate, walk or fly the drone too. Keys 1 to 5 switch, or LB / RB on a gamepad.', do: [{ mode: 'person' }, { avatar: 'skater' }, { place: VESTERBRO_PAVEMENT }, { camera: 'action' }, { input: { forward: 1 } }] },
      { express: true, hold: 7, caption: 'Welcome to the Kongres & Kultur Center: AKKC itself is a detail model, rebuilt from the Skråfoto oblique aerial photos.', do: [...GOLDEN, { mode: 'person' }, { avatar: 'man' }, { place: EUROPA_PLADS }, { camera: 'akkc' }] },
      { express: true, hold: 6, caption: 'Click any building for its data: address, year, heights, roof and where each value comes from.', do: [{ building: AKKC_ID }] },
      { hold: 12, caption: 'Every building comes from GeoDanmark footprints, LoD2 roofs and DHM heights, dressed in its own Skråfoto facade colours.', do: [{ camera: 'akkc' }] }
    ]
  },
  {
    id: 'budolfi',
    title: 'Budolfi Domkirke',
    sub: 'The cathedral',
    beats: [
      { express: true, hold: 10, caption: 'Budolfi Domkirke, modelled from the building drawings: tower, spire and windows.', do: [...GOLDEN, { mode: 'person' }, { camera: 'budolfi' }, { building: BUDOLFI_ID }] },
      { hold: 11, caption: 'Building levels: here is the plain white massing from the footprints and heights…', do: [{ level: 'white' }] },
      { hold: 11, caption: '…the measured LoD2 roofs…', do: [{ level: 'lod2' }] },
      { hold: 11, caption: '…the Skråfoto photo textures on every wall and roof…', do: [{ level: 'photo' }] },
      { hold: 12, caption: '…and the full city: generated windows and doors, and the detail models. Press L to step through them yourself.', do: [{ level: 'full' }] }
    ]
  },
  {
    id: 'jomfru',
    title: 'Jomfru Ane Gade',
    sub: 'Nightlife street',
    beats: [
      { express: true, hold: 10, caption: 'Jomfru Ane Gade after midnight: the bars and clubs light up with neon and their own beats.', do: [{ time: 'midnight' }, { sky: 'clear', wet: null }, { mode: 'person' }, { camera: 'jomfru' }] },
      { hold: 18, caption: 'Night owls gather at the venue doors. Every bar, pub and nightclub comes from OpenStreetMap.', do: [{ avatar: 'woman' }, { camera: 'chase' }] },
      { hold: 14, caption: 'Four times of day: golden hour, midday, twilight and midnight. Try the sun buttons at the top.', do: [{ camera: 'jomfru' }] }
    ]
  },
  {
    id: 'utzon',
    title: 'Utzon Center',
    sub: 'Harbour front · Limfjorden',
    beats: [
      { express: true, hold: 10, caption: 'The Utzon Center from the Limfjord: the harbour front, rebuilt from Skråfoto.', do: [...GOLDEN, { mode: 'person' }, { shot: { orbit: [202.4, -172.2], radius: 170, height: 38, lookY: 9, from: 2.2, speed: 0.08 } }] },
      { hold: 13, caption: 'Up close: its brick walls and lantern windows.', do: [{ shot: { orbit: [202.4, -172.2], radius: 115, height: 18, lookY: 10, from: 2.95, speed: -0.04 } }] },
      { hold: 18, caption: 'Take the drone up yourself (key 4): it climbs to 120 m and lands on any roof.', do: [{ mode: 'drone' }, { camera: 'chase' }, { input: { up: 0.7 } }] }
    ]
  },
  {
    id: 'musikkens',
    title: 'Musikkens Hus',
    sub: 'The concert hall',
    beats: [
      { express: true, hold: 10, caption: 'Musikkens Hus from the Limfjord: the concert hall and its plaza down to the water.', do: [...GOLDEN, { mode: 'person' }, { avatar: 'man' }, { shot: { orbit: [600, 27.4], radius: 190, height: 35, lookY: 14, from: 2.75, speed: 0.06 } }] },
      { hold: 16, caption: 'The city is busy: cars, cyclists and pedestrians follow the road network, the signals and each other.', do: [{ camera: 'action' }] },
      { hold: 14, caption: 'AI Plusbuses run line 2 in their real colours, stopping at its stops. The traffic gives way to you, mostly.', do: [{ camera: 'chase' }] }
    ]
  },
  {
    id: 'karolinelund',
    title: 'Karolinelund',
    sub: 'Park · the old amusement park',
    beats: [
      { express: true, hold: 10, caption: 'Karolinelund at twilight in Aalborg weather: overcast skies and wet roads that mirror the lights.', do: [{ time: 'twilight' }, { sky: 'overcast', wet: 0.85 }, { mode: 'person' }, { avatar: 'man' }, { camera: 'karolinelund' }] },
      { hold: 16, caption: 'Trees, lamp posts and park paths are placed from GeoDanmark and the height model, tree by tree.', do: [{ camera: 'chase' }] },
      { hold: 14, caption: 'And when the clouds clear, golden hour returns.', do: [...GOLDEN, { camera: 'karolinelund' }] }
    ]
  },
  {
    id: 'hvidehus',
    title: 'Hotel Det Hvide Hus',
    sub: 'Vesterbro · the hotel tower',
    beats: [
      { express: true, hold: 10, caption: 'Hotel Det Hvide Hus, built from its drawings. Its terrace is walkable, on foot or on a skateboard.', do: [...GOLDEN, { mode: 'person' }, { avatar: 'skater' }, { camera: 'hvidehus' }] },
      { hold: 14, caption: 'Skate, walk or cycle: every mode has its own physics.', do: [{ camera: 'chase' }] },
      { hold: 16, caption: 'The map (M) shows the whole city. Shift-click a place and the GPS routes you there, by road or on foot.', do: [{ map: 'route' }] }
    ]
  },
  {
    id: 'akkc',
    title: 'Back at AKKC',
    sub: 'Your turn',
    beats: [
      { express: true, hold: 8, caption: 'Back at the Kongres & Kultur Center. Now it is your turn: grab the controller and explore Aalborg.', do: [{ map: 'close' }, ...GOLDEN, { mode: 'person' }, { avatar: 'man' }, { camera: 'akkc' }] }
    ]
  }
];

export { TOUR_STOPS, AKKC_ID, BUDOLFI_ID, VESTERBRO, VESTERBRO_CYCLE_TRACK, VESTERBRO_PAVEMENT };
