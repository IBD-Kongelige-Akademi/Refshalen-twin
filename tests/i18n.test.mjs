import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { t, translatePhrases, getLang, setLang, onLangChange, DA, KEEP } from '../js/i18n.js';
import { TOUR_STOPS } from '../js/tour-script.js';
import { MODE_LABEL } from '../js/race-scores.js';
import { TELEPORT_LOCATIONS } from '../js/city-config.js';

// js/i18n.js: the Danish translation. Every string the page shows has a Danish entry, or is listed in KEEP as reading the same.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const places = new Set(Object.values(TELEPORT_LOCATIONS).flatMap((p) => [p.name]));
// the loading screen is written in Danish (it shows before js/i18n.js loads): a Danish text with an English key counts too
const danish = new Set(Object.values(DA));
const covered = (s) => Object.hasOwn(DA, s) || danish.has(s) || KEEP.has(s) || places.has(s);
const missing = (list) => [...new Set(list)].filter((s) => !covered(s));

test('every text and label in index.html has a Danish entry', () => {
  const html = read('index.html');
  const body = html.slice(html.indexOf('<body>'))
    // key caps and icons are not translated: a tag in their place keeps the text either side apart, as in the DOM
    .replace(/<svg[\s\S]*?<\/svg>/g, '<i/>')
    .replace(/<kbd[^>]*>[\s\S]*?<\/kbd>/g, '<i/>')
    .replace(/<!--[\s\S]*?-->/g, '<i/>');
  // skip the language toggles themselves, which js/i18n.js labels on its own
  const withoutToggles = body.replace(/<button[^>]*data-lang-toggle[^>]*>[\s\S]*?<\/button>/g, ' ');
  const texts = withoutToggles.split(/<[^>]+>/).map((s) => decode(s.trim())).filter((s) => /\p{L}{2}/u.test(s));
  const attrs = [...withoutToggles.matchAll(/\s(?:title|aria-label|placeholder)="([^"]*)"/g)].map((m) => decode(m[1].trim())).filter(Boolean);
  assert.deepEqual(missing(texts), [], 'text without a Danish entry');
  assert.deepEqual(missing(attrs), [], 'title / aria-label / placeholder without a Danish entry');
});

test('the tour, cameras, modes, hints and vehicle labels have Danish entries', () => {
  const tour = TOUR_STOPS.flatMap((stop) => [stop.title, stop.sub, ...stop.beats.map((b) => b.caption)]);
  assert.deepEqual(missing(tour), [], 'tour script');
  const cameras = [...read('js/cameras.js').matchAll(/name: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(cameras.length >= 10);
  assert.deepEqual(missing(cameras), [], 'camera names');
  assert.deepEqual(missing(Object.values(MODE_LABEL)), [], 'race mode labels');
  const main = read('js/main.js');
  const hints = /const controlHints = \{([\s\S]*?)\n {2}\};/.exec(main)[1];
  assert.deepEqual(missing([...hints.matchAll(/\], '([^']+)'\]/g)].map((m) => m[1])), [], 'keyboard hints');
  const pad = /const PAD_HINTS = \{([\s\S]*?)\n\};/.exec(read('js/input-hints.js'))[1];
  assert.deepEqual(missing([...pad.matchAll(/\], '([^']+)'\]/g)].map((m) => m[1])), [], 'gamepad hints');
  const labels = [...read('js/controllers.js').matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(labels.length >= 8);
  assert.deepEqual(missing(labels), [], 'vehicle labels');
  // every t('...') literal in the code
  for (const file of ['js/main.js', 'js/tour.js', 'js/buildings-real.js', 'js/overview-map.js']) {
    const keys = [...read(file).matchAll(/\bt\('((?:[^'\\]|\\.)+)'/g)].map((m) => m[1].replace(/\\'/g, "'"));
    assert.deepEqual(missing(keys), [], `${file} t() keys`);
  }
});

test('Danish is the default language', () => {
  assert.equal(getLang(), 'da');
  assert.equal(t('Explore Refshaleøen'), 'Udforsk Refshaleøen');
});

test('t() switches with the language, fills placeholders and passes unknown text through', () => {
  const seen = [];
  const off = onLangChange((lang) => seen.push(lang));
  setLang('en');
  assert.equal(getLang(), 'en');
  assert.equal(t('Explore Refshaleøen'), 'Explore Refshaleøen');
  assert.equal(t('Saved: you are #{rank}!', { rank: 3 }), 'Saved: you are #3!');
  assert.equal(setLang('da'), true);
  assert.equal(setLang('da'), false, 'no change');
  assert.equal(setLang('sv'), false, 'unknown language');
  assert.equal(t('Explore Refshaleøen'), 'Udforsk Refshaleøen');
  assert.equal(t('Saved: you are #{rank}!', { rank: 3 }), 'Gemt: du er nr. 3!');
  assert.equal(t('Algade'), 'Algade');
  assert.equal(translatePhrases('observed 2025, shadow, white-balanced'), 'observeret 2025, skygge, hvidbalanceret');
  assert.equal(translatePhrases('LoD2.2 from the 2024 point cloud (saddeltag), fit 0.12 m'), 'LoD2.2 fra 2024 punktsky (saddeltag), pasning 0.12 m');
  assert.equal(translatePhrases('outfit'), 'outfit', 'whole words only');
  setLang('en');
  assert.equal(translatePhrases('observed 2025, sunlit'), 'observed 2025, sunlit');
  assert.deepEqual(seen, ['en', 'da', 'en']);
  off();
});

test('no two English texts on the page share a Danish text that would switch back wrongly', () => {
  // translateDocument maps Danish back to English through the first key with that Danish text; static page text must be that key
  const firstKey = new Map();
  for (const [en, da] of Object.entries(DA)) if (!firstKey.has(da)) firstKey.set(da, en);
  const html = decode(read('index.html'));
  const clashes = Object.entries(DA).filter(([en, da]) => firstKey.get(da) !== en && html.includes(`>${en}<`));
  assert.deepEqual(clashes, []);
});
