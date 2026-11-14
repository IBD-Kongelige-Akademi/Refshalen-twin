// js/race-scores.js
// The Kortdage race's highscores (docs/race.md): one list per kiosk in localStorage, every mode on it, made comparable by a
// handicap. Each mode's par = its route length to Jomfru Ane Gade / its reference speed; a run's score ("adjusted time") is its
// time scaled to the car's par, i.e. what the run would have taken in the car at the same pace relative to par.
// Pure: storage is injected, so tests/race-scores.test.mjs runs without a browser.

// Reference speeds in m/s: about what a good run averages through the old town in each mode (top speeds in js/controllers.js:
// car 23.5 / boost 36, bus 19.4, bikes 6.9 / 8.3, walk 4.4 / sprint 8.2, skates 7.8, board 8.6, drone 16.7 / sport 20.8).
// The one place to tune the fairness: raise a mode's speed if it wins too easily, lower it if it cannot compete.
export const REF_SPEED = {
  car: 17,
  bus: 11,
  cyclist: 7.6,
  cargobike: 7.2,
  walk: 7.2,
  skates: 6.8,
  board: 7.4,
  drone: 19
};

export const MODE_LABEL = {
  car: 'Car', bus: 'Plusbus', cyclist: 'Bike', cargobike: 'Cargo bike', walk: 'On foot', skates: 'Roller skates', board: 'Skateboard', drone: 'Drone'
};
// index.html icon per mode (a <use href="#i-…">)
export const MODE_ICON = { car: 'car', bus: 'bus', cyclist: 'bike', cargobike: 'bike', walk: 'walk', skates: 'walk', board: 'walk', drone: 'drone' };

export const STORAGE_KEY = 'aalborg-race-scores';
const VERSION = 1;
const MAX_ENTRIES = 500; // the whole conference fits; the list shows the top
export const SANITY = 0.5; // a run faster than this share of its par is a glitch (a teleport, a fall through the map)

/** The race mode of the active controller: the walker's avatar picks walk / skates / board. */
export function raceMode(activeMode, avatar) {
  if (activeMode === 'person') return avatar === 'skater' ? 'skates' : avatar === 'skateboarder' ? 'board' : 'walk';
  return Object.hasOwn(REF_SPEED, activeMode) ? activeMode : 'car';
}

/** Seconds a good run of `mode` takes over `length` metres. */
export function parFor(mode, length) {
  return length / (REF_SPEED[mode] || REF_SPEED.car);
}

/** The run's time scaled to the car's par: `time` seconds in `mode` against `par`, given the car's par `carPar`. */
export function adjustedTime(time, par, carPar) {
  return par > 0 && carPar > 0 ? time * (carPar / par) : time;
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '--:--.-';
  const tenths = Math.floor(seconds * 10 + 1e-6);
  const m = Math.floor(tenths / 600);
  const s = Math.floor((tenths % 600) / 10);
  return `${m}:${String(s).padStart(2, '0')}.${tenths % 10}`;
}

// A short list of words a public kiosk should not show (the input is otherwise free text)
const BLOCKED = ['fuck', 'shit', 'cunt', 'nigger', 'nigga', 'faggot', 'whore', 'pik', 'fisse', 'kusse', 'luder', 'neger', 'bøsserøv', 'hitler', 'nazi'];
const fold = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[0@]/g, 'o').replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/[4]/g, 'a').replace(/[5$]/g, 's');

/** Trimmed, single-spaced, without control characters, at most `max` characters; '' when blocked. */
export function cleanText(text, max) {
  const s = String(text ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  const words = fold(s).split(/[^a-zæøå]+/);
  const joined = fold(s).replace(/[^a-zæøå]/g, '');
  if (BLOCKED.some((w) => words.includes(w) || (w.length >= 5 && joined.includes(w)))) return '';
  return s;
}

export const NAME_MAX = 20;
export const COMPANY_MAX = 30;

/** The highscore list over a Storage-like object ({ getItem, setItem, removeItem }); every access survives a missing storage. */
export function createScores(storage = globalThis.localStorage) {
  let entries = null;

  function load() {
    if (entries) return entries;
    entries = [];
    try {
      const doc = JSON.parse(storage?.getItem(STORAGE_KEY) || 'null');
      if (doc?.version === VERSION && Array.isArray(doc.entries)) {
        entries = doc.entries.filter((e) => e && Number.isFinite(e.adjusted) && Number.isFinite(e.time));
      }
    } catch { /* missing or broken storage: an empty list */ }
    sort();
    return entries;
  }
  function sort() {
    entries.sort((a, b) => a.adjusted - b.adjusted || a.at - b.at);
  }
  function save() {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, entries }));
      return true;
    } catch { return false; }
  }

  /** The rank (1-based) a run with this adjusted time would get, before it is added. */
  function rankOf(adjusted) {
    return load().filter((e) => e.adjusted <= adjusted).length + 1;
  }

  /** Adds a finished run ({ mode, time, par, carPar, length }) under the name and company; returns { entry, rank } or null. */
  function add(run, name, company) {
    const cleanName = cleanText(name, NAME_MAX);
    if (!cleanName || !Number.isFinite(run?.time) || run.time <= 0) return null;
    load();
    const entry = {
      name: cleanName,
      company: cleanText(company, COMPANY_MAX),
      mode: run.mode,
      // tenths, cut like formatTime cuts them, so the list shows what the result card showed
      time: Math.floor(run.time * 10 + 1e-6) / 10,
      adjusted: Math.floor(adjustedTime(run.time, run.par, run.carPar) * 10 + 1e-6) / 10,
      par: Math.round(run.par * 10) / 10,
      at: run.at ?? Date.now()
    };
    entries.push(entry);
    sort();
    if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
    save();
    const rank = entries.indexOf(entry) + 1;
    return { entry, rank: rank || null };
  }

  function top(n = 10) {
    return load().slice(0, n);
  }

  function clear() {
    entries = [];
    try { storage?.removeItem(STORAGE_KEY); } catch { /* nothing to clear */ }
  }

  function toCsv() {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = load().map((e, i) => [i + 1, q(e.name), q(e.company), MODE_LABEL[e.mode] || e.mode, e.adjusted.toFixed(1), e.time.toFixed(1), new Date(e.at).toISOString()].join(','));
    return ['rank,name,company,mode,adjusted_s,time_s,finished', ...rows].join('\n');
  }

  return { load, top, add, rankOf, clear, toCsv, get size() { return load().length; } };
}
