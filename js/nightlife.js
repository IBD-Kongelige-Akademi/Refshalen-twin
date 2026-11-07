// js/nightlife.js
// Pure nightlife logic (no three.js, no Web Audio, headless-testable). The venues are bars, pubs and nightclubs at their street
// fronts (data/city/nightlife.json, tools/geodata/nightlife.py); this module
//   * clusters them into strips (Jomfru Ane Gade: ~20 venues along 160 m), the places that come alive after dark;
//   * says how lively the city is for a time-of-day preset (js/lighting.js ids: golden = Dawn, midday, twilight = Blue Hour,
//     midnight = Night);
//   * gives every venue a look and a sound: neon colours, beat tempo, loudness (nightclubs loudest, pubs quietest);
//   * renders the beat loops the venues play (kick, clap, hats and bass, as heard through a club's door: muffled), as plain
//     Float32Array samples so js/nightlife-audio.js only wraps them in AudioBuffers;
//   * picks the few venues the listener can hear (no allocation: the caller owns the output array).
// js/nightlife-scene.js draws the lights, js/nightlife-audio.js plays the beats; js/pedestrian-system.js sends more people to a
// strip in the evening through `nightlife` (the shared state below).

/** How lively the night is per lighting preset (0 = closed, 1 = full): little at Dawn (the last guests), none at Midday. */
export const PRESET_LEVEL = Object.freeze({ golden: 0.12, midday: 0, twilight: 0.45, midnight: 1 });

/** Activity 0-1 for a lighting preset id; unknown presets follow the night factor (js/lighting.js nightFactor: 0 day, 0.86 night). */
export function nightlifeLevel(presetId, nightFactor = 0) {
  if (presetId in PRESET_LEVEL) return PRESET_LEVEL[presetId];
  return Math.max(0, Math.min(1, (nightFactor - 0.2) / 0.66));
}

/** Per kind: tempo range (bpm), loudness (0-1), audible range (m), beat style and neon palette (linear rgb pairs). */
export const KIND_STYLE = Object.freeze({
  nightclub: { bpm: [124, 130], loud: 1, range: 95, style: 'club' },
  bar: { bpm: [116, 124], loud: 0.6, range: 65, style: 'house' },
  pub: { bpm: [96, 108], loud: 0.45, range: 50, style: 'rock' },
  biergarten: { bpm: [96, 104], loud: 0.4, range: 50, style: 'rock' }
});

/** Neon pairs (sign colour, second colour of the moving spots), saturated so the bloom keeps them coloured. */
export const PALETTE = Object.freeze([
  [[1.0, 0.05, 0.55], [0.1, 0.35, 1.0]], // magenta / blue
  [[0.0, 0.85, 1.0], [0.85, 0.05, 1.0]], // cyan / violet
  [[1.0, 0.25, 0.02], [1.0, 0.0, 0.25]], // amber / red
  [[0.3, 1.0, 0.1], [0.0, 0.6, 1.0]], // green / azure
  [[0.65, 0.1, 1.0], [1.0, 0.1, 0.45]], // purple / pink
  [[1.0, 0.75, 0.2], [1.0, 0.3, 0.05]] // warm gold / orange (pubs)
]);

/** A stable 0-1 hash of a string (FNV-1a), so a venue keeps its colours and tempo from session to session. */
export function hash01(s) {
  let h = 0x811c9dc5;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 4294967296;
}

/**
 * The look and sound of a venue: { style, bpm, loud, range, sign: rgb, spot: rgb, phase (0-1 beat offset), seed }.
 * Pubs get the warm palette; clubs and bars a neon pair by hash. Venues in one cluster share a tempo grid but not a phase.
 */
export function venueLook(v) {
  const k = KIND_STYLE[v.kind] || KIND_STYLE.bar;
  const seed = hash01(`${v.name}|${v.src || ''}|${v.x},${v.z}`);
  const warm = k.style === 'rock';
  const pal = warm ? PALETTE[5] : PALETTE[Math.floor(seed * 5) % 5];
  // tempos on whole bpm, so a loop of 2 bars holds a whole number of beats at any sample rate
  const bpm = Math.round(k.bpm[0] + (k.bpm[1] - k.bpm[0]) * hash01(`${seed}bpm`));
  return { style: k.style, bpm, loud: k.loud, range: k.range, sign: pal[0], spot: pal[1], phase: hash01(`${seed}ph`), seed };
}

/**
 * Single-linkage clusters of venues no further than `link` m apart, with at least `min` venues:
 * [{ x, z, r (m, from the centre to the furthest front plus `pad`), venues: [indices], name (the commonest street), level weight }].
 * Generic: any strip of bars (Jomfru Ane Gade, Ved Stranden, ...) becomes a cluster; a lone pub does not.
 */
export function clusterVenues(venues, { link = 35, min = 5, pad = 15 } = {}) {
  const n = venues.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.hypot(venues[i].x - venues[j].x, venues[i].z - venues[j].z) <= link) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  const out = [];
  for (const idx of groups.values()) {
    if (idx.length < min) continue;
    let x = 0, z = 0;
    for (const i of idx) { x += venues[i].x; z += venues[i].z; }
    x /= idx.length; z /= idx.length;
    let r = 0;
    const streets = new Map();
    for (const i of idx) {
      r = Math.max(r, Math.hypot(venues[i].x - x, venues[i].z - z));
      const s = venues[i].street;
      if (s) streets.set(s, (streets.get(s) || 0) + 1);
    }
    let name = null, best = 0;
    for (const [s, c] of streets) if (c > best) { best = c; name = s; }
    out.push({ x, z, r: r + pad, venues: idx, name });
  }
  return out.sort((a, b) => b.venues.length - a.venues.length);
}

/**
 * The light pulse of a beat at time t (s): 1 on the beat, decaying with `decay` (s); `phase` offsets the grid in beats.
 * The shader in js/nightlife-scene.js uses the same formula (pulse = exp(-frac(t * bpm / 60 + phase) * 60 / bpm / decay)).
 */
export function beatPulse(t, bpm, phase = 0, decay = 0.11) {
  const beats = t * bpm / 60 + phase;
  const frac = beats - Math.floor(beats);
  return Math.exp(-(frac * 60 / bpm) / decay);
}

/**
 * Indices of the `n` venues the listener at (x, z) hears loudest (gain over distance), within each venue's range, written into
 * `out` (cleared first); returns out. Venue records carry `look` (venueLook). No allocation beyond `out` growing to n once.
 */
export function selectAudible(venues, x, z, n, out, scratch = []) {
  out.length = 0;
  scratch.length = 0;
  for (let i = 0; i < venues.length; i++) {
    const v = venues[i];
    const d = Math.hypot(v.x - x, v.z - z);
    if (d > v.look.range) continue;
    scratch.push(i);
  }
  // partial selection sort on loudness at the listener (n is 2-3)
  const score = (i) => venues[i].look.loud / Math.max(4, Math.hypot(venues[i].x - x, venues[i].z - z));
  for (let k = 0; k < n && k < scratch.length; k++) {
    let best = k;
    for (let j = k + 1; j < scratch.length; j++) if (score(scratch[j]) > score(scratch[best])) best = j;
    const t = scratch[k]; scratch[k] = scratch[best]; scratch[best] = t;
    out.push(scratch[k]);
  }
  return out;
}

/** Gain of a venue's voice before the spatial roll-off: its loudness times the night's activity, with a soft start. */
export const venueGain = (look, level) => look.loud * level * level * (3 - 2 * level) * 0.55;

// ---------------------------------------------------------------- beat loops

function rng(seed) {
  let s = (Math.floor(seed * 4294967296) >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Bass line per style in semitones over the root (one entry per eighth note; null = rest). */
const BASS = {
  club: [0, null, 0, null, 0, null, 0, 3, 0, null, 0, null, 5, null, 3, null],
  house: [null, 0, null, 0, null, 0, null, 7, null, 0, null, 0, null, 5, null, 3],
  rock: [0, 0, 0, 0, 5, 5, 7, 7, 0, 0, 0, 0, 3, 3, 5, 7]
};

/**
 * One loop of `bars` 4/4 bars at `bpm` for a style ('club' | 'house' | 'rock'), as heard from the street: kick and bass carry,
 * claps and hats are low-passed (the door, the walls). Returns { samples: Float32Array, beats, duration (s) }.
 * Deterministic for a seed. The loop length is a whole number of samples per beat * beats, so it repeats seamlessly.
 */
export function renderBeatLoop(style, bpm, rate, { bars = 2, seed = 0.5, root = 41.2 } = {}) {
  const beats = bars * 4;
  const spb = Math.round(rate * 60 / bpm); // samples per beat
  const len = spb * beats;
  const out = new Float32Array(len);
  const rand = rng(seed + 0.123);
  const add = (start, n, f) => {
    for (let i = 0; i < n && start + i < len; i++) out[start + i] += f(i / rate, i);
  };
  // kick: a sine falling from 120 Hz to 45 Hz
  const kick = (start, amp) => {
    let ph = 0;
    add(start, Math.round(rate * 0.32), (t) => {
      const f = 45 + 75 * Math.exp(-t / 0.035);
      ph += (2 * Math.PI * f) / rate;
      return amp * Math.sin(ph) * Math.exp(-t / 0.13);
    });
  };
  // snare / clap: band of noise with a short body, then a low-pass (one pole)
  const clap = (start, amp, cutoff) => {
    let lp = 0;
    const a = 1 - Math.exp((-2 * Math.PI * cutoff) / rate);
    add(start, Math.round(rate * 0.18), (t) => {
      const noise = rand() * 2 - 1;
      lp += a * (noise - lp);
      return amp * (lp * Math.exp(-t / 0.05) + 0.25 * Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t / 0.03));
    });
  };
  const hat = (start, amp) => {
    let prev = 0, lp = 0;
    const a = 1 - Math.exp((-2 * Math.PI * 2500) / rate); // the muffled top of a hat through a door
    add(start, Math.round(rate * 0.05), (t) => {
      const noise = rand() * 2 - 1;
      const hp = noise - prev;
      prev = noise;
      lp += a * (hp - lp);
      return amp * lp * Math.exp(-t / 0.015);
    });
  };
  const bass = (start, n, semis, amp) => {
    const f = root * Math.pow(2, semis / 12);
    let ph = 0;
    add(start, n, (t, i) => {
      ph += (2 * Math.PI * f) / rate;
      // a rounded saw (three harmonics), gated so the notes are separate
      const s = Math.sin(ph) + 0.4 * Math.sin(2 * ph) + 0.18 * Math.sin(3 * ph);
      const env = Math.min(1, t / 0.006) * Math.min(1, (n - i) / (rate * 0.012));
      return amp * s * env;
    });
  };
  const eighth = Math.round(spb / 2);
  const line = BASS[style] || BASS.club;
  for (let b = 0; b < beats; b++) {
    const at = b * spb;
    const back = b % 2 === 1;
    if (style === 'rock') {
      if (!back) kick(at, 0.95);
      else clap(at, 0.55, 1800);
      if (b % 4 === 2) kick(at + eighth, 0.7);
      hat(at, 0.22); hat(at + eighth, 0.16);
    } else {
      kick(at, 1);
      if (back) clap(at, style === 'club' ? 0.35 : 0.45, 1400);
      hat(at + eighth, style === 'club' ? 0.3 : 0.25); // the off-beat open hat
    }
    for (let e = 0; e < 2; e++) {
      const step = (b * 2 + e) % line.length;
      if (line[step] !== null) bass(at + e * eighth, Math.round(eighth * (style === 'rock' ? 0.85 : 0.6)), line[step], style === 'club' ? 0.32 : 0.26);
    }
  }
  // soft clip and normalise to 0.9 peak
  let peak = 0;
  for (let i = 0; i < len; i++) {
    out[i] = Math.tanh(out[i] * 1.2);
    peak = Math.max(peak, Math.abs(out[i]));
  }
  if (peak > 0) for (let i = 0; i < len; i++) out[i] *= 0.9 / peak;
  return { samples: out, beats, duration: len / rate, samplesPerBeat: spb };
}

// ---------------------------------------------------------------- shared state

/**
 * The nightlife state the scene, the audio and the pedestrians share: the venues (with their looks), their clusters and the
 * current activity level. `setVenues` takes the nightlife.json venues; `setLevel` the preset's level.
 */
export function createNightlifeState() {
  const state = {
    venues: [],
    clusters: [],
    level: 0,
    setVenues(list) {
      state.venues = (list || []).filter((v) => Number.isFinite(v.x) && Number.isFinite(v.z)).map((v) => ({
        ...v, nx: Number.isFinite(v.nx) ? v.nx : 0, nz: Number.isFinite(v.nz) ? v.nz : 1, look: venueLook(v)
      }));
      state.clusters = clusterVenues(state.venues);
      return state;
    },
    setLevel(level) {
      state.level = Math.max(0, Math.min(1, level || 0));
    },
    /** The liveliest cluster within `reach` m of (x, z) while the night is on, else null (js/pedestrian-system.js). */
    hotspotNear(x, z, reach) {
      if (state.level <= 0) return null;
      let best = null, bestD = Infinity;
      for (const c of state.clusters) {
        const d = Math.hypot(c.x - x, c.z - z) - c.r;
        if (d < reach && d < bestD) { best = c; bestD = d; }
      }
      return best;
    }
  };
  return state;
}

/** The one shared state of the viewer (js/main.js fills it; the scene, audio and pedestrians read it). */
export const nightlife = createNightlifeState();
