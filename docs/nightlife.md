# Nightlife: Jomfru Ane Gade after dark

Jomfru Ane Gade is Aalborg's (and Denmark's best-known) street of bars and nightclubs: about twenty venues along 160 m of
pedestrian street between Bispensgade and Strandvejen. After dark the twin lights their fronts, plays their music in the street
and sends an evening crowd there. The same machinery works for any strip of bars the data has (Ved Stranden, Vesterbro, Maren
Turis Gade); nothing is hard-coded for Jomfru Ane Gade except the tuning.

## Data

`tools/geodata/nightlife.py` → `data/city/nightlife.json` (`aalborg-nightlife/1`), named in the tile index as `city.nightlife`
(`build_city.py --stage index` keeps it, and the packs carry it).

- Source: the cached OSM ground-floor layer (`data/raw/city/osm_groundfloor.json`, written by `groundfloor.py`), amenity = `bar`,
  `pub`, `nightclub`, `biergarten`. The tile `groundfloor.json` lumps these under `kind: food`, so the tool reads the raw tags.
- Each venue is moved to its **front**: the line from the OSM point (usually inside the building) to the nearest named street leaves
  the building at the street-facing wall; that crossing and the wall's outward normal (`nx`, `nz`) are written. Venues more than
  25 m from a street are dropped (2 of 71).
- Today: 69 venues, 19 on Jomfru Ane Gade (6 nightclubs: Pigen og Trompeten, Zwei Grosse, Under Buret, Escape, Storm P, …).

## Engine

| Module | What it does |
| --- | --- |
| `js/nightlife.js` | Pure: activity per time-of-day preset, venue look (neon pair, tempo, loudness, range) from a name hash, single-linkage clusters (35 m link, ≥ 5 venues), the beat pulse, the audible-venue pick, the beat loops as samples, and the shared state (`nightlife`). |
| `js/nightlife-scene.js` | Two instanced draws for all venues: neon signs over the doors, and an additive "L" per venue (a wash up the facade, a pool with rotating disco spots on the pavement), animated in TSL from one clock uniform. Borrows 3 of the street lamps' 8 real point lights (`furniture.reserveLights`) for the venues nearest the camera and cycles their colour on the beat. |
| `js/nightlife-audio.js` | 3 voices (2 on small devices): the venues the listener hears loudest play a looping AudioBuffer of their style and tempo through the city's `SpatialEmitter` (HRTF at the door, inverse roll-off, fade at the range edge, muffled by the buildings in between). |
| `js/walk-limits.js`, `js/pedestrian-routes.js`, `js/pedestrian-system.js` | The footways through a cluster are walked like park paths (by day too: it is a pedestrian street). A quarter of the pedestrians are night owls: as lively as the night is, they come out of a venue's door onto the strip, head for points along it, stop outside the bars, and night owls walking elsewhere out of sight are now and then sent there. |

### Time of day

| Preset (top bar) | Level | What you see and hear |
| --- | --- | --- |
| Midday | 0 | Nothing: the group is hidden, no voices, the real lights go back to the street lamps. |
| Golden Hour (dawn) | 0.12 | Faint signs; a quiet thud from the clubs as the last guests leave. |
| Blue Hour | 0.45 | Signs on, spill at half strength, beats audible near the doors, some night owls on the strip. |
| Night | 1 | Full neon, flashing spots, the club lights in the street, beats from 50–95 m, the crowd. |

The level eases over 1.6 s when the preset changes.

### Kinds

| Kind | Style | Tempo | Loudness | Audible range |
| --- | --- | --- | --- | --- |
| nightclub | club (four on the floor, off-beat hat, bass) | 124–130 bpm | 1 | 95 m |
| bar | house | 116–124 bpm | 0.6 | 65 m |
| pub, biergarten | rock (kick 1 & 3, snare 2 & 4) | 96–108 bpm | 0.45 | 50 m |

Pubs get a warm amber sign; clubs and bars one of five neon pairs, picked by a hash of name and position (stable between sessions).

### Beat and light in step

A voice starts on the audio clock's beat grid (offset = clock mod loop, shifted by the venue's phase), and while sound plays
`main.js` drives the scene's clock with `audioSystem.beatClock`: the spots and real lights flash on the kicks you hear. Without
sound (muted, no gesture yet) the scene runs on its own clock.

### Budget

- **Draw calls:** +2 at night (signs, spill), 0 by day (the group is hidden).
- **Lights:** none added; 3 of the existing pool are lent while the scene shows (adding lights would recompile every lit shader).
- **CPU per frame:** two uniforms, ≤ 3 light updates; the nearest venues are re-picked after 4 m of travel; the instances are
  re-seated on the terrain every 4 s while visible (the terrain streams in after the data).
- **Audio:** ≤ 3 looping buffer sources, built only when a venue comes into range; one buffer per style and tempo
  (~0.7 MB each, rendered once, ~10–20 ms).
- **No per-frame allocation** in the scene or audio update paths (`selectAudible` writes into caller-owned arrays).

### Spawning on the strip

The pedestrian spawner normally places people out of the camera's view (150 m) and at least 60 m from the player. Standing in
Jomfru Ane Gade, the whole street fails both rules, so the strip stayed empty. A night owl therefore spawns at a venue's door
instead: the point of the strip's footway beside a random venue of the cluster, at least 25 m from the player and out of view
within 30 m. In the dark, with the doors lit, someone stepping out of a club 30 m away does not read as a pop.

## Checks

- `tests/nightlife.test.mjs`: levels per preset, looks, clusters, beat pulse, audible pick, gains, loops, state, hot paths.
- Viewer (headless Edge, `?hooks`): `__twin.nightlife` (state), `__twin.nightlifeScene.stats`, `__twin.audioSystem.nightlife.playing`.
  Shots: `.context/nightlife/jag-midday-street.png`, `jag-midnight-street.png`, `jag-twilight-street.png`, `jag-night-crowd-b.png`.
- Measured at the player standing in the street (2026-11-07, headless Edge): Midday group hidden, 0 voices, 803 draw calls;
  Night +2 draws, 3 voices, 3 lights lent; night owls on the strip's footways 0 → 72 within a minute of switching to Night
  (pedestrians within the cluster: 11 at Midday, 75 at Night). The cluster that forms is Jomfru Ane Gade with Ved Stranden and
  the bars round Bispensgade: 27 venues, radius 119 m. No console errors.

## Not done / ideas

- Opening hours are in the data (`hours`) but not used: every venue is open at Night.
- No queue at the doors, no bouncers, no inside: people walk and stand on the strip.
- The street's own festoon lights and the Jomfru Ane Gade arch sign are not modelled.
