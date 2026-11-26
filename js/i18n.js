// js/i18n.js
// English / Danish for the whole UI. English is the source language: every string in index.html and the code is written in
// English, and DA maps it to Danish. The page's static text is translated in place (translateDocument walks the text nodes and
// the title / aria-label / placeholder attributes); text the code writes goes through t(). The choice is kept in localStorage
// (`aalborg-lang`, shared with credits.html) and `?lang=da|en` sets it from the URL (a kiosk's start link).

const STORAGE_KEY = 'aalborg-lang';
const LANGS = ['en', 'da'];
// Danish unless the visitor picked English (or ?lang=en); the source strings stay English
const DEFAULT_LANG = 'da';

// English -> Danish. Keys are the exact English text (trimmed), as written in index.html (entities decoded) or in the code.
const DA = {
  // Refshaleøen: teleports and tour
  'Or drive the Plusbus: the 24.7 m articulated electric bus.': 'Eller kør Plusbussen: den 24,7 m lange leddelte elbus.',
  "Refshaleøen · street food · start": "Refshaleøen · streetfood · start",
  "Holmen · the opera house": "Holmen · operahuset",
  "Holmen · architecture school": "Holmen · arkitektskolen",
  "Nyholm · the mast crane": "Nyholm · mastekranen",
  "Refshaleøen · the shipyard halls": "Refshaleøen · værftshallerne",
  "Refshaleøen · art hall": "Refshaleøen · kunsthal",
  "Refshaleøen · harbour bath": "Refshaleøen · havnebad",
  "Welcome to Refshaleøen: the old B&W shipyard island and Holmen as a digital twin, built from open Danish map data.": "Velkommen til Refshaleøen: den gamle B&W-værftsø og Holmen som digital tvilling, bygget af åbne danske kortdata.",
  "Drive it: cars on the real street network, here up Refshalevej.": "Kør i den: biler på det rigtige vejnet, her op ad Refshalevej.",
  "Reffen, the street food market on the old shipyard quay.": "Reffen, streetfood-markedet på den gamle værftskaj.",
  "Every building comes from GeoDanmark footprints and DHM heights, with BBR use, year and materials.": "Hver bygning kommer fra GeoDanmarks omrids og DHM-højder, med anvendelse, opførelsesår og materialer fra BBR.",
  "The shipyard halls": "Værftshallerne",
  "B&W Hallerne: the shipyard halls of Burmeister & Wain, now venues and studios.": "B&W Hallerne: Burmeister & Wains værftshaller, i dag spillesteder og studier.",
  "Building levels: the plain white massing from the footprints and heights…": "Bygningsniveauer: den hvide volumenmodel fra omrids og højder…",
  "…and the full city with generated windows and doors. Press L to step through them yourself.": "…og hele byen med genererede vinduer og døre. Tryk L for selv at skifte mellem dem.",
  "Art hall": "Kunsthal",
  "Copenhagen Contemporary at twilight in Copenhagen weather: overcast skies and wet roads that mirror the lights.": "Copenhagen Contemporary i tusmørke i københavnsk vejr: overskyet himmel og våde veje, der spejler lysene.",
  "Harbour bath": "Havnebad",
  "La Banchina: a swim and a sauna on the quay of Søndre Refshalebassin.": "La Banchina: en dukkert og en sauna på kajen ved Søndre Refshalebassin.",
  "Mastekranen on Nyholm, the naval mast crane from 1751, seen across the harbour.": "Mastekranen på Nyholm, flådens mastekran fra 1751, set over havnen.",
  "The city is busy: cars, cyclists and pedestrians follow the road network and each other.": "Byen er travl: biler, cyklister og fodgængere følger vejnettet og hinanden.",
  "Det Kongelige Akademi on Holmen: the architecture school in the old naval buildings.": "Det Kongelige Akademi på Holmen: arkitektskolen i flådens gamle bygninger.",
  "The opera house": "Operahuset",
  "Operaen on Holmen, across the harbour from Amalienborg.": "Operaen på Holmen, over for Amalienborg på den anden side af havnen.",
  "The map (M) shows the whole area. Shift-click a place and the GPS routes you there, by road or on foot.": "Kortet (M) viser hele området. Shift-klik på et sted, og GPS'en viser vej dertil, ad vejen eller til fods.",
  "Back at Reffen": "Tilbage ved Reffen",
  "Back at Reffen. Now it is your turn: grab the controller and explore Refshaleøen.": "Tilbage ved Reffen. Nu er det din tur: tag controlleren og udforsk Refshaleøen.",
  // loading screen
  'Initializing WebGPURenderer & TSL Shaders...': 'Starter WebGPURenderer og TSL-shadere...',
  'Initializing Three.js r{rev} WebGPURenderer & TSL Shaders...': 'Starter Three.js r{rev} WebGPURenderer og TSL-shadere...',
  'Constructing Refshaleøen...': 'Bygger Refshaleøen...',
  'Refshaleøen Twin needs WebGPU, which this browser does not have. Try a recent Chrome, Edge or Safari.':
    'Refshaleøen Twin kræver WebGPU, som denne browser ikke har. Prøv en nyere Chrome, Edge eller Safari.',
  'Compiling Shaders & Render Pipelines...': 'Kompilerer shadere og render-pipelines...',
  'Based on Slop New York by mrdoob (MIT), via copenhagen-twin by Martin Collignon (MIT) · Map data © OpenStreetMap contributors (ODbL), GeoDanmark, DAR, BBR, DAGI, DHM and Skråfoto (Klimadatastyrelsen / SDFI, CC BY 4.0, via datagrundlag.dk) · LoD2 roofs: Ramboll, Geoflow (MIT)':
    'Baseret på Slop New York af mrdoob (MIT), via copenhagen-twin af Martin Collignon (MIT) · Kortdata © OpenStreetMap-bidragydere (ODbL), GeoDanmark, DAR, BBR, DAGI, DHM og Skråfoto (Klimadatastyrelsen / SDFI, CC BY 4.0, via datagrundlag.dk) · LoD2-tage: Ramboll, Geoflow (MIT)',
  '3D interactive Refshaleøen Twin viewport': 'Interaktiv 3D-visning af Refshaleøen Twin',

  // title card
  'Credits': 'Kreditering',
  'Credits and data attributions (opens in a new tab)': 'Kreditering og datakilder (åbner i en ny fane)',
  'Based on Slop New York by mrdoob (MIT), via copenhagen-twin by Martin Collignon (MIT). Data: GeoDanmark, DAR, BBR, DAGI, DHM and Skråfoto (Klimadatastyrelsen / SDFI, CC BY 4.0) and © OpenStreetMap contributors (ODbL).':
    'Baseret på Slop New York af mrdoob (MIT), via copenhagen-twin af Martin Collignon (MIT). Data: GeoDanmark, DAR, BBR, DAGI, DHM og Skråfoto (Klimadatastyrelsen / SDFI, CC BY 4.0) og © OpenStreetMap-bidragydere (ODbL).',

  // toolbar
  'Map of Refshaleøen [M]': 'Kort over Refshaleøen [M]',
  'Map': 'Kort',
  'Atmosphere & time of day': 'Stemning og tidspunkt',
  'Time of day': 'Tidspunkt',
  'Golden Hour': 'Gylden time',
  'Sunny Midday': 'Solrig middag',
  'Blue Hour': 'Blå time',
  'Night 23:00': 'Nat 23:00',
  'Teleport the active player': 'Teleportér den aktive spiller',
  'Teleport': 'Teleportér',
  'Tour Refshaleøen from Reffen': 'Rundtur på Refshaleøen fra Reffen',
  'Tour Refshaleøen': 'Rundtur på Refshaleøen',
  'Tour': 'Rundtur',
  'Race from Reffen to Akademiet [R]': 'Kapløb fra Reffen til Akademiet [R]',
  'Race': 'Kapløb',
  'Building model level [L cycles]': 'Bygningsmodelniveau [L skifter]',
  'Buildings': 'Bygninger',
  'Mute sound [N]': 'Slå lyden fra [N]',
  'Mute sound': 'Slå lyden fra',
  'Enable sound [N]': 'Slå lyden til [N]',
  'Enable sound': 'Slå lyden til',
  'Web Audio is unavailable': 'Web Audio er ikke tilgængelig',
  'Clean view: hide the HUD [H]': 'Ren visning: skjul HUD [H]',
  'Show the HUD [H]': 'Vis HUD [H]',
  'Hide HUD': 'Skjul HUD',
  'Show HUD': 'Vis HUD',

  // teleport
  'Teleport to': 'Teleportér til',
  'Europa Plads · start': 'Europa Plads · start',
  'Old town · the cathedral': 'Gamlebyen · domkirken',
  'Old town · nightlife street': 'Gamlebyen · nattelivsgaden',
  'Harbour front · harbour': 'Havnefronten · havnen',
  'Harbour front · the concert hall': 'Havnefronten · koncerthuset',
  'Park · the old amusement park': 'Park · den gamle forlystelsespark',
  'Vesterbro · the hotel tower': 'Vesterbro · hoteltårnet',
  'Citywide': 'Hele byen',

  // tour menu and card
  'Express tour · 2 min': 'Ekspresrundtur · 2 min',
  'An aerial opening, the drive modes, then seven landmarks, hands-off': 'En åbning fra luften, transportformerne og så syv vartegn, helt automatisk',
  'Full tour · 6 min': 'Fuld rundtur · 6 min',
  'Every feature: building levels, night, drone, Plusbus, weather': 'Alle funktioner: bygningsniveauer, nat, drone, Plusbus, vejr',
  'Drive the tour': 'Kør selv rundturen',
  'You drive, the GPS routes you stop to stop (drone starts in the car)': "Du kører, og GPS'en guider dig fra stop til stop (dronen starter i bilen)",
  'Back [←]': 'Tilbage [←]',
  'Back': 'Tilbage',
  'Next [→ / Space]': 'Næste [→ / mellemrum]',
  'Next': 'Næste',
  'Teleport to the next stop': 'Teleportér til næste stop',
  'Skip leg': 'Spring etapen over',
  'End the tour [Esc]': 'Afslut rundturen [Esc]',
  'End tour': 'Afslut rundtur',
  'Press any key or tap to explore Refshaleøen yourself': 'Tryk på en tast eller på skærmen for selv at udforske Refshaleøen',
  'Start': 'Start',
  'Finish': 'Mål',
  'Follow the GPS line on the minimap': 'Følg GPS-linjen på minikortet',

  // tour stops (js/tour-script.js)
  'Welcome to Refshaleøen': 'Velkommen til Refshaleøen',
  'The cathedral': 'Domkirken',
  'Nightlife street': 'Nattelivsgaden',
  'Harbour front · havnen': 'Havnefronten · havnen',
  'The concert hall': 'Koncerthuset',
  'Back at AKKC': 'Tilbage ved AKKC',
  'Your turn': 'Din tur',
  'Welcome to Refshaleøen. This is Refshaleøen as a digital twin, built from open Danish map data.':
    'Velkommen til Refshaleøen. Dette er Refshaleøen som digital tvilling, bygget af åbne danske kortdata.',
  'Refshaleøen from above: 1,325 buildings at their measured heights, the harbour, the streets and the parks.':
    'Refshaleøen fra oven: 1.325 bygninger i deres målte højder, havnen, gaderne og parkerne.',
  'Drive it: cars on the real street network, here down Vesterbro past AKKC.':
    'Kør i den: biler på det rigtige vejnet, her ned ad Vesterbro forbi AKKC.',
  'Cycle it, on a city bike or a cargo bike.': 'Cykl i den, på bycykel eller ladcykel.',
  'Or drive the Plusbus: the 24.7 m articulated electric bus of line 2.':
    'Eller kør Plusbussen: den 24,7 m lange leddelte elbus på linje 2.',
  'Skate, walk or fly the drone too. Keys 1 to 5 switch, or LB / RB on a gamepad.':
    'Du kan også løbe på rulleskøjter, gå eller flyve med dronen. Tasterne 1 til 5 skifter, eller LB / RB på en gamepad.',
  'Welcome to the Kongres & Kultur Center: AKKC itself is a detail model, rebuilt from the Skråfoto oblique aerial photos.':
    'Velkommen til Kongres & Kultur Center: selve AKKC er en detaljemodel, genopbygget ud fra Skråfotos skrå luftfotos.',
  'Click any building for its data: address, year, heights, roof and where each value comes from.':
    'Klik på en bygning for at se dens data: adresse, opførelsesår, højder, tag og hvor hver værdi kommer fra.',
  'Every building comes from GeoDanmark footprints, LoD2 roofs and DHM heights, dressed in its own Skråfoto facade colours.':
    'Hver bygning kommer fra GeoDanmarks bygningsomrids, LoD2-tage og DHM-højder, klædt i sine egne facadefarver fra Skråfoto.',
  'Budolfi Domkirke, modelled from the building drawings: tower, spire and windows.':
    'Budolfi Domkirke, modelleret efter bygningstegningerne: tårn, spir og vinduer.',
  'Building levels: here is the plain white massing from the footprints and heights…':
    'Bygningsniveauer: her er de enkle hvide volumener ud fra omrids og højder…',
  '…the measured LoD2 roofs…': '…de målte LoD2-tage…',
  '…the Skråfoto photo textures on every wall and roof…': '…Skråfoto-teksturerne på hver facade og hvert tag…',
  '…and the full city: generated windows and doors, and the detail models. Press L to step through them yourself.':
    '…og hele byen: genererede vinduer og døre samt detaljemodellerne. Tryk L for selv at skifte mellem dem.',
  'Jomfru Ane Gade after midnight: the bars and clubs light up with neon and their own beats.':
    'Jomfru Ane Gade efter midnat: barer og klubber lyser op med neon og deres egne beats.',
  'Night owls gather at the venue doors. Every bar, pub and nightclub comes from OpenStreetMap.':
    'Natteravnene samles ved dørene. Alle barer, pubber og natklubber kommer fra OpenStreetMap.',
  'Four times of day: golden hour, midday, twilight and midnight. Try the sun buttons at the top.':
    'Fire tidspunkter: gylden time, middag, tusmørke og midnat. Prøv solknapperne øverst.',
  'The Utzon Center from the harbour: the harbour front, rebuilt from Skråfoto.':
    'Utzon Center set fra havnen: havnefronten, genopbygget ud fra Skråfoto.',
  'Up close: its brick walls and lantern windows.': 'Tæt på: murstensvæggene og lanternevinduerne.',
  'Take the drone up yourself (key 4): it climbs to 120 m and lands on any roof.':
    'Tag selv dronen op (tast 4): den stiger til 120 m og lander på ethvert tag.',
  'Musikkens Hus from the harbour: the concert hall and its plaza down to the water.':
    'Musikkens Hus set fra havnen: koncerthuset og pladsen ned til vandet.',
  'The city is busy: cars, cyclists and pedestrians follow the road network, the signals and each other.':
    'Byen er travl: biler, cyklister og fodgængere følger vejnettet, signalerne og hinanden.',
  'AI Plusbuses run line 2 in their real colours, stopping at its stops. The traffic gives way to you, mostly.':
    'AI-styrede Plusbusser kører linje 2 i deres rigtige farver og holder ved stoppestederne. Trafikken viger for dig, for det meste.',
  'Karolinelund at twilight in Refshaleøen weather: overcast skies and wet roads that mirror the lights.':
    'Karolinelund i tusmørke i aalborgensisk vejr: overskyet himmel og våde veje, der spejler lyset.',
  'Trees, lamp posts and park paths are placed from GeoDanmark and the height model, tree by tree.':
    'Træer, lygtepæle og parkstier er placeret ud fra GeoDanmark og højdemodellen, træ for træ.',
  'And when the clouds clear, golden hour returns.': 'Og når skyerne letter, vender den gyldne time tilbage.',
  'Hotel Det Hvide Hus, built from its drawings. Its terrace is walkable, on foot or on a skateboard.':
    'Hotel Det Hvide Hus, bygget efter sine tegninger. Terrassen kan betrædes, til fods eller på skateboard.',
  'Skate, walk or cycle: every mode has its own physics.': 'Rulleskøjter, gang eller cykel: hver transportform har sin egen fysik.',
  'The map (M) shows the whole city. Shift-click a place and the GPS routes you there, by road or on foot.':
    "Kortet (M) viser hele byen. Shift-klik på et sted, og GPS'en guider dig derhen, ad vejen eller til fods.",
  'Back at the Kongres & Kultur Center. Now it is your turn: grab the controller and explore Refshaleøen.':
    'Tilbage ved Kongres & Kultur Center. Nu er det din tur: tag controlleren og udforsk Refshaleøen.',

  // race
  'Race to Akademiet': 'Kapløb til Akademiet',
  'Race: Reffen → Akademiet': 'Kapløb: Reffen → Akademiet',
  'Any route, any vehicle. Times are handicapped by vehicle, so walkers and cyclists can beat the car.':
    'Valgfri rute, valgfrit køretøj. Tiderne får handicap efter køretøj, så gående og cyklister kan slå bilen.',
  'Start the race': 'Start kapløbet',
  'in the car': 'i bilen',
  'Highscores': 'Topliste',
  'Export CSV': 'Eksportér CSV',
  'Give up the race [Esc]': 'Opgiv kapløbet [Esc]',
  'Give up': 'Opgiv',
  'Race result': 'Resultat',
  'Name': 'Navn',
  'Company': 'Firma',
  'Skip': 'Spring over',
  'Save': 'Gem',
  'Race again': 'Kør igen',
  'Close': 'Luk',
  'No times yet. Be the first!': 'Ingen tider endnu. Bliv den første!',
  'handicapped': 'med handicap',
  'to go': 'tilbage',
  'Get ready': 'Gør dig klar',
  'GO!': 'KØR!',
  'You changed vehicle': 'Du skiftede køretøj',
  'You teleported': 'Du teleporterede',
  'No input for a while': 'Ingen aktivitet i et stykke tid',
  'Race cancelled': 'Kapløbet er afbrudt',
  'route': 'rute',
  'That was faster than this vehicle can go: no score this time. Did something glitch?':
    'Det var hurtigere, end dette køretøj kan køre: ingen score denne gang. Gik der noget galt?',
  'You reached Akademiet!': 'Du nåede Akademiet!',
  'Handicapped to car time: {time}.': 'Omregnet til biltid: {time}.',
  'That puts you #{rank} on the list.': 'Det giver dig plads nr. {rank} på listen.',
  'Saved: you are #{rank}!': 'Gemt: du er nr. {rank}!',
  'Saved: you are #{rank}. Top {n}:': 'Gemt: du er nr. {rank}. Top {n}:',
  'Please enter a (polite) name': 'Skriv venligst et (pænt) navn',
  'Racing as': 'Kører som',
  'switch vehicle first to race another way': 'skift køretøj først for at køre på en anden måde',
  'Clear all {n} race highscores on this machine?': 'Slet alle {n} kapløbstider på denne maskine?',
  // race modes (js/race-scores.js MODE_LABEL)
  'Car': 'Bil',
  'Bike': 'Cykel',
  'Cargo bike': 'Ladcykel',
  'On foot': 'Til fods',
  'Roller skates': 'Rulleskøjter',

  // building model levels
  'Building model level': 'Bygningsmodelniveau',
  'Building model': 'Bygningsmodel',
  '0 · White LoD2': '0 · Hvid LoD2',
  'Bare white building shells': 'Bare hvide bygningsskaller',
  'Measured shells, no textures': 'Målte skaller uden teksturer',
  'Oblique aerial photos on the walls': 'Skrå luftfotos på facaderne',
  '3 · LoD2 + Generated detail': '3 · LoD2 + genererede detaljer',
  'Windows, doors, roof details, textures': 'Vinduer, døre, tagdetaljer, teksturer',
  '4 · Full': '4 · Fuld',
  'Hero buildings from drawings': 'Udvalgte bygninger fra tegninger',
  'Rebuilding the buildings…': 'Genopbygger bygningerne…',

  // start screen
  'Sponsored by': 'Sponsoreret af',
  "Refshaleøen and Holmen rebuilt in 3D from open map data and aerial photos. Walk, cycle, drive or fly around the old shipyard island.":
    'Refshaleøen og Holmen genopbygget i 3D ud fra åbne kortdata og luftfotos. Gå, cykl, kør eller flyv rundt på den gamle værftsø.',
  'Choose how to get around': 'Vælg, hvordan du kommer rundt',
  'Choose a mode': 'Vælg en transportform',
  'Walk': 'Gå',
  'On foot, skates or skateboard': 'Til fods, på rulleskøjter eller skateboard',
  'Drive': 'Kør',
  'A car in live traffic': 'En bil i levende trafik',
  'Cycle': 'Cykl',
  'City bike or cargo bike': 'Bycykel eller ladcykel',
  'Fly': 'Flyv',
  'A drone over the rooftops': 'En drone over tagene',
  'The articulated line 2 bus': 'Den leddelte bus på linje 2',
  'What you can do': 'Det kan du',
  'Refshaleøen race': 'Refshaleøen-kapløb',
  'Reffen to Akademiet, any route. Times are handicapped by vehicle, so walkers can beat the car.':
    'Reffen til Akademiet ad valgfri rute. Tiderne får handicap efter køretøj, så gående kan slå bilen.',
  'Guided tour': 'Guidet rundtur',
  'Sit back for 2 or 6 minutes past seven landmarks, or drive it with the GPS.':
    "Læn dig tilbage i 2 eller 6 minutter forbi syv vartegn, eller kør selv med GPS'en.",
  'Map & teleport': 'Kort og teleport',
  'Search a street, click to jump there, right-click to plan a GPS route.':
    'Søg efter en gade, klik for at hoppe derhen, højreklik for at planlægge en GPS-rute.',
  'Real buildings': 'Rigtige bygninger',
  'Click any building for its data. Step from bare LoD2 shells to photo-textured hero buildings.':
    'Klik på en bygning for at se dens data. Gå fra bare LoD2-skaller til fototeksturerede udvalgte bygninger.',
  'Cameras': 'Kameraer',
  'Chase, action, first person and scenic views of the landmarks. Drag to orbit, scroll to zoom.':
    'Følge-, action-, førstepersons- og udsigtskameraer ved vartegnene. Træk for at kredse, scroll for at zoome.',
  'Day & night': 'Dag og nat',
  'Golden hour, midday, blue hour or 23:00 with neon and music from the bars.':
    'Gylden time, middag, blå time eller 23:00 med neon og musik fra barerne.',
  'Controls': 'Styring',
  'Keyboard': 'Tastatur',
  'move': 'bevæg dig',
  'boost': 'boost',
  'jump / climb': 'hop / stig',
  'hide HUD': 'skjul HUD',
  'sound': 'lyd',
  'Left stick move': 'Venstre stik bevæg dig',
  'RT / LT drive': 'RT / LT kør',
  'LB / RB mode': 'LB / RB transportform',
  'D-pad menus': 'D-pad menuer',
  'Menu map': 'Menu kort',
  'Touch': 'Berøring',
  'Joystick to move': 'Joystick for at bevæge dig',
  'Drag to look': 'Træk for at se dig om',
  'Pinch to zoom': 'Knib for at zoome',
  'Explore Refshaleøen': 'Udforsk Refshaleøen',
  'Press': 'Tryk',
  'to start ·': 'for at starte ·',
  'race ·': 'kapløb ·',
  'tour': 'rundtur',
  'Gamepad:': 'Gamepad:',
  'start ·': 'start ·',

  // radar, location
  'Live street radar': 'Live gaderadar',
  'Open the map of Refshaleøen [M]': 'Åbn kortet over Refshaleøen [M]',
  'near': 'nær',

  // walker, bike type, mode bar
  'Walker': 'Figur',
  'Man': 'Mand',
  'Woman': 'Kvinde',
  'Bike type': 'Cykeltype',
  'City bike': 'Bycykel',
  'Third-Person Navigation Mode': 'Transportform',
  'Person [1]': 'Person [1]',
  'Car [2]': 'Bil [2]',
  'Cycle [3]': 'Cykel [3]',
  'Drone [4]': 'Drone [4]',
  'Plusbus [5]': 'Plusbus [5]',
  // the active vehicle (js/controllers.js labels)
  'Pedestrian': 'Fodgænger',
  'Roller skater': 'Rulleskøjteløber',

  // speed cluster and cameras
  'Vehicle telemetry and camera': 'Fartmåler og kamera',
  'Alt': 'Højde',
  'Previous camera': 'Forrige kamera',
  'All cameras [V cycles]': 'Alle kameraer [V skifter]',
  'Next camera [V]': 'Næste kamera [V]',
  'Next camera': 'Næste kamera',
  'Multiple Camera Angles': 'Kameravinkler',
  'Follow': 'Følg',
  'Scenic': 'Udsigt',
  '3rd-Person Chase': 'Følgekamera',
  'Low-Angle Action': 'Lav actionvinkel',
  'First-Person / Cockpit': 'Førsteperson / cockpit',
  'Auto-Director Aerial': 'Automatisk luftkamera',

  // touch controls
  'Touch controls': 'Berøringsstyring',
  'Movement joystick: drag up or down to move, left or right to turn': 'Bevægelsesjoystick: træk op eller ned for at bevæge dig, til venstre eller højre for at dreje',
  'Move & steer': 'Bevæg og styr',
  'Drag to look · Pinch to zoom': 'Træk for at se dig om · Knib for at zoome',
  'Hold to perform an action': 'Hold for at udføre en handling',
  'Jump': 'Hop',
  'Descend': 'Sænk',
  'Ascend': 'Stig',
  'Sprint': 'Spurt',

  // control hints (js/main.js controlHints, js/input-hints.js PAD_HINTS)
  'Turn': 'Drej',
  'Orbit': 'Kreds',
  'Drive / Reverse': 'Kør / bak',
  'Steer': 'Styr',
  'Push / Brake': 'Skub / brems',
  'Lean & Turn': 'Læn og drej',
  'Push hard': 'Skub hårdt',
  'Pedal / Brake': 'Træd / brems',
  'Yaw': 'Drej',
  'Climb / Take off': 'Stig / let',
  'Descend / Land': 'Sænk / land',
  'Drive / Brake': 'Kør / brems',
  'Doors open': 'Dørene åbner',
  'Walk & turn': 'Gå og drej',
  'Push & lean': 'Skub og læn',
  'Look': 'Se dig om',
  'Lean & turn': 'Læn og drej',
  'Fly & yaw': 'Flyv og drej',
  'Climb / Descend': 'Stig / sænk',
  'Drag': 'Træk',
  'Space': 'Mellemrum',

  // full map
  'Map of Refshaleøen': 'Kort over Refshaleøen',
  'Refshaleøen Street Map': 'Refshaleøen gadekort',
  'You are at Gammel Torv': 'Du er ved Gammel Torv',
  'You are at': 'Du er ved',
  'Search streets & places — Refshalevej, Operaen, Reffen…': 'Søg efter gader og steder — Refshalevej, Operaen, Reffen…',
  'Search street or place': 'Søg efter gade eller sted',
  'Close map [M / Esc]': 'Luk kortet [M / Esc]',
  'True north · the map is drawn on the UTM grid, 0.77° off it': 'Geografisk nord · kortet er tegnet på UTM-gitteret, 0,77° derfra',
  'Zoom in': 'Zoom ind',
  'Zoom out': 'Zoom ud',
  'Street view around you': 'Gadevisning omkring dig',
  'Center on player': 'Centrér på spilleren',
  'The whole twin': 'Hele tvillingen',
  'Fit the whole map': 'Vis hele kortet',
  'Click to teleport · Shift-click or right-click to route · Drag to pan · Scroll to zoom':
    'Klik for at teleportere · Shift-klik eller højreklik for at planlægge en rute · Træk for at panorere · Scroll for at zoome',
  'Click to teleport · Shift-click to route': 'Klik for at teleportere · Shift-klik for at planlægge en rute',
  'A to teleport · X to route': 'A for at teleportere · X for at planlægge en rute',
  'Tap to teleport · Drag to pan · Use + / − to zoom': 'Tryk for at teleportere · Træk for at panorere · Brug + / − for at zoome',
  'You': 'Dig',
  'Place': 'Sted',
  'GPS route': 'GPS-rute',
  'streets': 'gader',
  'buildings': 'bygninger',
  'Search': 'Søg i',
  'streets & places…': 'gader og steder…',

  // building info panel (js/buildings-real.js)
  'Building': 'Bygning',
  'Close building info': 'Luk bygningsinfo',
  'Building without an address': 'Bygning uden adresse',
  'Finding the address…': 'Finder adressen…',
  'BBR id': 'BBR-id',
  'Use code': 'Anvendelseskode',
  'Year': 'Opført',
  'Storeys': 'Etager',
  'Height': 'Højde',
  'Roof': 'Tag',
  'Wall colour': 'Facadefarve',
  'Roof colour': 'Tagfarve',
  'Detail': 'Detalje',
  'Roof geometry': 'Taggeometri',
  'Detail model': 'Detaljemodel',
  'Wall': 'Ydervæg',
  'Facade': 'Facade',
  'Entrances': 'Indgange',
  'Record': 'Registrering',
  'unknown': 'ukendt',
  'measured': 'målt',
  'inferred': 'udledt',
  'scaled': 'skaleret',
  'observed': 'observeret',
  'registered': 'registreret',
  'estimated': 'estimeret',
  'to eave': 'til tagfod',
  'to ridge': 'til kip',
  'floor': 'etage',
  'bay': 'fag',
  '+ photo': '+ foto',
  'traced details': 'optegnede detaljer',
  'from DAR adgangspunkt': 'fra DAR-adgangspunkt',
  'street door': 'gadedør',
  'street doors': 'gadedøre',
  'placed by heuristic': 'placeret heuristisk',
  'none': 'ingen',

  // language toggle
  'Switch to English': 'Skift til engelsk',
  'Switch to Danish': 'Skift til dansk'
};

// Text that reads the same in Danish: names, brands and units (kept here so tests can tell "same on purpose" from "missed")
const KEEP = new Set([
  'Reffen', 'Operaen', 'Det Kongelige Akademi', 'Akademiet', 'Mastekranen', 'B&W Hallerne', 'Copenhagen Contemporary', 'La Banchina',
  'Refshaleøen Twin', 'Ramboll', 'Det Kongelige Akademi · Refshaleøen', 'three.js · WebGPU · TSL ·', 'fps', 'km/h',
  'Refshaleøen Kongres & Kultur Center', 'Kongres & Kultur Center', 'Budolfi Domkirke', 'Jomfru Ane Gade', 'Utzon Center',
  'Musikkens Hus', 'Karolinelund', 'Hotel Det Hvide Hus', 'Plusbus', 'Drone', 'Bus', 'Skateboard', 'Skateboarder', 'Gamepad',
  '1 · LoD2', '2 · LoD2 + Skråfoto', 'Boost', 'Sport', 'Horn', 'Stop', 'Shift', 'Refshaleøen'
]);

// Phrases inside the building panel's composed provenance texts (js/appearance.js, js/buildings-real.js describeBuilding),
// replaced whole-word, longest first. Kept apart from DA so a stray text node that reads "model" is never touched.
const DA_PHRASES = {
  'colour differs between 2023 and 2025: probably repainted': 'farven er forskellig i 2023 og 2025: sandsynligvis malet om',
  'colour differs between 2023 and 2025': 'farven er forskellig i 2023 og 2025',
  'not mapped (building tone)': 'ikke kortlagt (bygningens tone)',
  'Architectural style detail': 'Arkitektonisk stildetalje',
  'neighbouring buildings': 'nabobygninger',
  'BBR roof material': 'BBR-tagmateriale',
  'brick hue prior': 'antaget teglfarve',
  'flat extrusion': 'flad ekstrudering',
  'white-balanced': 'hvidbalanceret',
  'same building': 'samme bygning',
  'period preset': 'periodens standard',
  'inferred from': 'udledt fra',
  'the building': 'bygningen',
  'point cloud': 'punktsky',
  'from the': 'fra',
  'observed': 'observeret',
  'sunlit': 'solbelyst',
  'shadow': 'skygge',
  'pitched': 'skrå',
  'fit': 'pasning'
};

const REVERSE = new Map();
for (const [en, da] of Object.entries(DA)) if (!REVERSE.has(da)) REVERSE.set(da, en);
const PHRASE_LIST = Object.entries(DA_PHRASES).sort((a, b) => b[0].length - a[0].length);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PHRASE_RE = new RegExp(`(?<![\\w-])(${PHRASE_LIST.map(([en]) => escapeRe(en)).join('|')})(?![\\w-])`, 'g');

function initialLang() {
  try {
    const param = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('lang') : null;
    if (LANGS.includes(param)) {
      localStorage.setItem(STORAGE_KEY, param);
      return param;
    }
  } catch { /* no URL or storage: the default */ }
  try {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (LANGS.includes(saved)) return saved;
  } catch { /* storage blocked */ }
  return DEFAULT_LANG;
}

let lang = initialLang();
const listeners = new Set();

const fill = (text, vars) => (vars ? text.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m)) : text);

/** `text` (English) in the current language, with {name} placeholders filled from `vars`. Unknown text passes through. */
function t(text, vars) {
  if (text === null || text === undefined) return text;
  const en = String(text);
  return fill(lang === 'da' && Object.hasOwn(DA, en) ? DA[en] : en, vars);
}

/** A composed English provenance text with its known phrases in the current language. */
function translatePhrases(text) {
  if (lang !== 'da' || typeof text !== 'string') return text;
  return text.replace(PHRASE_RE, (m) => DA_PHRASES[m]);
}

function getLang() {
  return lang;
}

/** Switches the language ('en' / 'da'), remembers it and tells the listeners; returns whether it changed. */
function setLang(next) {
  if (!LANGS.includes(next) || next === lang) return false;
  lang = next;
  try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* not remembered, still switched */ }
  for (const fn of listeners) fn(lang);
  return true;
}

function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// One string of the page in the current language: English text is looked up, Danish text is first mapped back to its English
// key, so the page can be switched either way any number of times. Surrounding whitespace is kept.
function swap(value) {
  const trimmed = value.trim();
  if (!trimmed) return value;
  const en = REVERSE.get(trimmed) ?? trimmed;
  const out = lang === 'da' && Object.hasOwn(DA, en) ? DA[en] : en;
  return out === trimmed ? value : value.replace(trimmed, out);
}

// Not translated: key caps (js/input-hints.js relabels them), street names, the race names people typed, the building panel
// (js/buildings-real.js writes it with t()) and anything marked data-i18n-skip
const SKIP = 'kbd, script, style, svg, .street-sign, .location-signs, .race-board, #building-info, [data-i18n-skip]';
const ATTRS = ['title', 'aria-label', 'placeholder'];

/** Puts the page's static text, its tooltips / labels and the language toggles (`[data-lang-toggle]`) in the current language. */
function translateDocument(doc = globalThis.document) {
  if (!doc?.body) return;
  doc.documentElement.lang = lang;
  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.parentElement?.closest(SKIP)) nodes.push(n);
  }
  for (const n of nodes) {
    const next = swap(n.nodeValue);
    if (next !== n.nodeValue) n.nodeValue = next;
  }
  for (const el of doc.body.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(','))) {
    if (el.closest('[data-i18n-skip]')) continue;
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v === null) continue;
      const next = swap(v);
      if (next !== v) el.setAttribute(a, next);
    }
  }
  // the toggles name the language they switch to, in that language
  const target = lang === 'da' ? 'en' : 'da';
  for (const el of doc.querySelectorAll('[data-lang-toggle]')) {
    el.textContent = el.dataset.langToggle === 'short' ? target.toUpperCase() : target === 'da' ? 'Dansk' : 'English';
    el.lang = target;
    const label = target === 'da' ? 'Skift til dansk' : 'Switch to English';
    el.title = label;
    el.setAttribute('aria-label', label);
  }
}

export { t, translatePhrases, getLang, setLang, onLangChange, translateDocument, DA, DA_PHRASES, KEEP, LANGS, STORAGE_KEY };
