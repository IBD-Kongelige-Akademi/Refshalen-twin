// Gamepad button names in the HUD's hints, shown instead of the keyboard keys while a pad is connected (js/main.js).
// Keys that have a pad button carry it as data-pad (a name from LABELS, e.g. data-pad="MENU" on the map's [M]); the
// `pad-input` class on <body> lets the CSS hide every other key, since nothing on the pad does what they do.

// The names a pad's own buttons are printed with. Xbox names suit Xbox and XInput pads (8BitDo in XInput mode reports as
// one); PlayStation pads report their maker's id (054c) or their name.
const LABELS = {
  xbox: {
    A: 'A', B: 'B', X: 'X', Y: 'Y', LB: 'LB', RB: 'RB', LT: 'LT', RT: 'RT', VIEW: 'View', MENU: 'Menu',
    LS: 'LS', RS: 'RS', L3: 'LS click', R3: 'RS click', DPAD: 'D-pad'
  },
  playstation: {
    A: '✕', B: '○', X: '□', Y: '△', LB: 'L1', RB: 'R1', LT: 'L2', RT: 'R2', VIEW: 'Create', MENU: 'Options',
    LS: 'L-stick', RS: 'R-stick', L3: 'L3', R3: 'R3', DPAD: 'D-pad'
  }
};

/** Which button names a pad uses, from its id: 'playstation' or 'xbox' (also the default). */
function padFamily(id = '') {
  return /054c|dualsense|dualshock|wireless controller|playstation/i.test(id) ? 'playstation' : 'xbox';
}

function padLabel(family, key) {
  return (LABELS[family] || LABELS.xbox)[key] ?? key;
}

// The hint row under the mode bar on a pad, per mode (the keyboard's is in js/main.js): [buttons, action]
const PAD_HINTS = {
  person: [[['LS'], 'Walk & turn'], [['X'], 'Sprint'], [['A'], 'Jump'], [['Y'], 'Walker'], [['RS'], 'Look']],
  skate: [[['LS'], 'Push & lean'], [['X'], 'Push hard'], [['A'], 'Jump'], [['Y'], 'Walker'], [['RS'], 'Look']],
  car: [[['RT', 'LT'], 'Drive / Reverse'], [['LS'], 'Steer'], [['L3'], 'Horn'], [['RS'], 'Look']],
  cyclist: [[['RT', 'LT'], 'Pedal / Brake'], [['LS'], 'Lean & turn'], [['X'], 'Sprint'], [['Y'], 'Bike'], [['RS'], 'Look']],
  drone: [[['LS'], 'Fly & yaw'], [['RT', 'LT'], 'Climb / Descend'], [['X'], 'Sport'], [['RS'], 'Look']],
  bus: [[['RT', 'LT'], 'Drive / Brake'], [['LS'], 'Steer'], [['L3'], 'Horn'], [['RS'], 'Look']]
};

/** The pad hint row for a hint mode, with the buttons named for `family`. */
function padHints(mode, family) {
  return (PAD_HINTS[mode] || []).map(([keys, action]) => [keys.map((k) => padLabel(family, k)), action]);
}

/**
 * Shows pad buttons (`family`) or, with null, the keyboard keys again: the `pad-input` class on <body>, and every
 * kbd[data-pad] relabelled (its key text is kept in data-key to put back).
 */
function applyPadLabels(doc, family) {
  doc.body.classList.toggle('pad-input', Boolean(family));
  for (const kbd of doc.querySelectorAll('kbd[data-pad]')) {
    if (kbd.dataset.key === undefined) kbd.dataset.key = kbd.textContent;
    kbd.textContent = family ? padLabel(family, kbd.dataset.pad) : kbd.dataset.key;
  }
}

export { padFamily, padLabel, padHints, applyPadLabels, PAD_HINTS };
