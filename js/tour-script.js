// js/tour-script.js
// The Refshaleøen tour (js/tour.js runs it): a start scene at Reffen, then the teleport stops round the city and back, each with a
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

const OPERAEN_ID = 'gdk:1064732327'; // Operaen (GeoDanmark footprint under its OSM position)
const AKADEMIET_ID = 'gdk:1064716380'; // Det Kongelige Akademi, Holmen (1861)
const BW_ID = 'gdk:1234037309'; // B&W Hallerne

// Refshalevej northbound across the island: a link of the road graph from (-8.5, -84.6) to (-0.5, -116.1)
const REFSHALEVEJ = { x: -6.5, z: -92.5, heading: 2.89 };
// ...and beside it on the east side: where a cyclist and, outside that, a walker would be
const REFSHALEVEJ_CYCLE = { x: -3.1, z: -91.6, heading: 2.89 };
const REFSHALEVEJ_PAVEMENT = { x: -1.2, z: -91.1, heading: 2.89 };
// the visitor's start: in front of Reffen (TELEPORT_LOCATIONS.reffen)
const REFFEN_SPOT = { x: -174.6, z: -417.8, heading: -0.29 };
const GOLDEN = [{ time: 'golden' }, { sky: 'clear', wet: null }];
// The director's opening: high over the harbour inlet looking across Holmen and Refshaleøen, then down to Reffen
const CITY_ORBIT = { orbit: [-250, 200], radius: 900, height: 420, lookY: 0, from: Math.PI, speed: 0.05 };
const DESCENT = { glide: [[[-700, 380, -900], [-250, 0, 200]], [[-110, 60, -520], [-187, 6, -376]]], duration: 10 };

const TOUR_STOPS = [
  {
    id: 'reffen',
    title: 'Reffen',
    sub: 'Welcome to Refshaleøen',
    beats: [
      { hold: 12, caption: 'Welcome to Refshaleøen: the old B&W shipyard island and Holmen as a digital twin, built from open Danish map data.', do: [...GOLDEN, { mode: 'person' }, { avatar: 'man' }, { shot: CITY_ORBIT }] },
      { express: true, guidedOnly: true, hold: 10, caption: 'Refshaleøen from above: 1,325 buildings at their measured heights, the harbour, the streets and the parks.', do: [...GOLDEN, { mode: 'person' }, { avatar: 'man' }, { shot: DESCENT }] },
      { express: true, guidedOnly: true, hold: 6, caption: 'Drive it: cars on the real street network, here up Refshalevej.', do: [{ mode: 'car' }, { place: REFSHALEVEJ }, { camera: 'chase' }, { input: { forward: 0.55 } }] },
      { express: true, guidedOnly: true, hold: 5, caption: 'Cycle it, on a city bike or a cargo bike.', do: [{ mode: 'cyclist' }, { place: REFSHALEVEJ_CYCLE }, { camera: 'action' }, { input: { forward: 1 } }] },
      { express: true, guidedOnly: true, hold: 6, caption: 'Or drive the Plusbus: the 24.7 m articulated electric bus.', do: [{ mode: 'bus' }, { place: REFSHALEVEJ }, { camera: 'chase' }, { input: { forward: 0.85 } }, { honk: true }] },
      { guidedOnly: true, hold: 7, caption: 'Skate, walk or fly the drone too. Keys 1 to 5 switch, or LB / RB on a gamepad.', do: [{ mode: 'person' }, { avatar: 'skater' }, { place: REFSHALEVEJ_PAVEMENT }, { camera: 'action' }, { input: { forward: 1 } }] },
      { express: true, hold: 7, caption: 'Reffen, the street food market on the old shipyard quay.', do: [...GOLDEN, { mode: 'person' }, { avatar: 'man' }, { place: REFFEN_SPOT }, { camera: 'reffen' }] },
      { hold: 12, caption: 'Every building comes from GeoDanmark footprints and DHM heights, with BBR use, year and materials.', do: [{ camera: 'reffen' }] }
    ]
  },
  {
    id: 'bw',
    title: 'B&W Hallerne',
    sub: 'The shipyard halls',
    beats: [
      { express: true, hold: 8, caption: 'B&W Hallerne: the shipyard halls of Burmeister & Wain, now venues and studios.', do: [...GOLDEN, { mode: 'person' }, { camera: 'bw' }, { building: BW_ID }] },
      { hold: 11, caption: 'Click any building for its data: address, year, heights, roof and where each value comes from.', do: [{ building: BW_ID }] },
      { hold: 11, caption: 'Building levels: the plain white massing from the footprints and heights…', do: [{ level: 'white' }] },
      { hold: 12, caption: '…and the full city with generated windows and doors. Press L to step through them yourself.', do: [{ level: 'full' }] }
    ]
  },
  {
    id: 'cc',
    title: 'Copenhagen Contemporary',
    sub: 'Art hall',
    beats: [
      { express: true, hold: 8, caption: 'Copenhagen Contemporary at twilight in Copenhagen weather: overcast skies and wet roads that mirror the lights.', do: [{ time: 'twilight' }, { sky: 'overcast', wet: 0.85 }, { mode: 'person' }, { avatar: 'man' }, { camera: 'cc' }] },
      { hold: 14, caption: 'And when the clouds clear, golden hour returns.', do: [...GOLDEN, { camera: 'cc' }] }
    ]
  },
  {
    id: 'banchina',
    title: 'La Banchina',
    sub: 'Harbour bath',
    beats: [
      { express: true, hold: 8, caption: 'La Banchina: a swim and a sauna on the quay of Søndre Refshalebassin.', do: [...GOLDEN, { mode: 'person' }, { avatar: 'skater' }, { camera: 'banchina' }] },
      { hold: 18, caption: 'Take the drone up yourself (key 4): it climbs to 120 m and lands on any roof.', do: [{ mode: 'drone' }, { camera: 'chase' }, { input: { up: 0.7 } }] }
    ]
  },
  {
    id: 'bygning147',
    title: 'Bygning 147',
    sub: 'B&W office building',
    beats: [
      { express: true, hold: 8, caption: 'Bygning 147 on Refshalevej, the 1955 B&W office building, here as Anders Hermund\'s Rhino model.', do: [...GOLDEN, { mode: 'person' }, { avatar: 'man' }, { camera: 'bygning147' }] }
    ]
  },
  {
    id: 'mastekranen',
    title: 'Mastekranen',
    sub: 'Nyholm · the mast crane',
    beats: [
      { express: true, hold: 10, caption: 'Mastekranen on Nyholm, the naval mast crane from 1751, seen across the harbour.', do: [...GOLDEN, { mode: 'person' }, { shot: { orbit: [-351.6, 237.3], radius: 160, height: 40, lookY: 15, from: 2.2, speed: 0.08 } }] },
      { hold: 16, caption: 'The city is busy: cars, cyclists and pedestrians follow the road network and each other.', do: [{ camera: 'action' }] }
    ]
  },
  {
    id: 'akademiet',
    title: 'Det Kongelige Akademi',
    sub: 'Holmen · architecture school',
    beats: [
      { express: true, hold: 10, caption: 'Det Kongelige Akademi on Holmen: the architecture school in the old naval buildings.', do: [...GOLDEN, { mode: 'person' }, { camera: 'akademiet' }, { building: AKADEMIET_ID }] },
      { hold: 14, caption: 'Four times of day: golden hour, midday, twilight and midnight. Try the sun buttons at the top.', do: [{ time: 'midnight' }, { camera: 'akademiet' }] }
    ]
  },
  {
    id: 'operaen',
    title: 'Operaen',
    sub: 'The opera house',
    beats: [
      { express: true, hold: 10, caption: 'Operaen on Holmen, across the harbour from Amalienborg.', do: [...GOLDEN, { mode: 'person' }, { shot: { orbit: [-641.3, 953.7], radius: 220, height: 45, lookY: 15, from: 2.75, speed: 0.06 } }, { building: OPERAEN_ID }] },
      { hold: 16, caption: 'The map (M) shows the whole area. Shift-click a place and the GPS routes you there, by road or on foot.', do: [{ map: 'route' }] }
    ]
  },
  {
    id: 'operaparken',
    title: 'Operaparken',
    sub: 'The park by the opera',
    beats: [
      { express: true, hold: 8, caption: 'Operaparken: the new park behind the opera house, with its glasshouse café.', do: [...GOLDEN, { mode: 'person' }, { camera: 'operaparken' }] }
    ]
  },
  {
    id: 'kai',
    title: 'KAI',
    sub: 'The new swimming hall',
    beats: [
      { express: true, hold: 8, caption: 'KAI on Papirøen, the new swimming hall by Kengo Kuma: brick peaks floating on a glass ground floor, built from the drawings.', do: [...GOLDEN, { mode: 'person' }, { camera: 'kai' }] }
    ]
  },
  {
    id: 'marmorkirken',
    title: 'Marmorkirken',
    sub: 'The marble church',
    beats: [
      { express: true, hold: 8, caption: 'Marmorkirken at the end of Frederiksgade, seen along the axis from Amalienborg.', do: [...GOLDEN, { mode: 'person' }, { camera: 'marmorkirken' }] }
    ]
  },
  {
    id: 'reffen',
    title: 'Back at Reffen',
    sub: 'Your turn',
    beats: [
      { express: true, hold: 8, caption: 'Back at Reffen. Now it is your turn: grab the controller and explore Refshaleøen.', do: [{ map: 'close' }, ...GOLDEN, { mode: 'person' }, { avatar: 'man' }, { camera: 'reffen' }] }
    ]
  }
];

export { TOUR_STOPS, OPERAEN_ID, AKADEMIET_ID, BW_ID, REFSHALEVEJ, REFSHALEVEJ_CYCLE, REFSHALEVEJ_PAVEMENT };
