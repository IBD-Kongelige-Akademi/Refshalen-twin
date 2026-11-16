// js/start-screen.js
// The start screen (docs/start-screen.md): what the twin can do, a mode picker and three ways in (explore, race, tour).
// It opens after every boot and again whenever the attract loop ends, so each kiosk visitor sees it; `?intro=0` turns it off.
// Plain logic over an injected `ui` (js/main.js startUi), like js/tour.js and js/race.js, so tests/start-screen.test.mjs
// runs without a DOM.

const MODES = ['person', 'car', 'cyclist', 'drone', 'bus'];
const ACTIONS = ['explore', 'race', 'tour'];
// The focus ring walks two rows: the mode tiles, then the action buttons
const ITEMS = [...MODES.map((id) => ({ row: 0, kind: 'mode', id })), ...ACTIONS.map((id) => ({ row: 1, kind: 'action', id }))];
const EXPLORE = ITEMS.findIndex((it) => it.id === 'explore');
const DIGITS = { Digit1: 'person', Digit2: 'car', Digit3: 'cyclist', Digit4: 'drone', Digit5: 'bus',
  Numpad1: 'person', Numpad2: 'car', Numpad3: 'cyclist', Numpad4: 'drone', Numpad5: 'bus' };

/** The mode bar's mode for a controller mode (the cargo bike is a Cycle). */
function primaryMode(mode) {
  return mode === 'cargobike' ? 'cyclist' : MODES.includes(mode) ? mode : 'car';
}

function createStartScreen(deps = {}) {
  const {
    ui = {},
    enabled = true,
    getMode = () => 'car',
    onSelectMode = () => {},
    onExplore = () => {},
    onRace = () => {},
    onTour = () => {},
    onOpenChange = () => {}
  } = deps;
  let open = false;
  let focus = EXPLORE;

  function show(index) {
    focus = index;
    ui.focus?.(ITEMS[focus]);
  }

  function openScreen() {
    if (!enabled || open) return false;
    open = true;
    ui.show?.();
    ui.markMode?.(primaryMode(getMode()));
    show(EXPLORE);
    onOpenChange(true);
    return true;
  }

  function close() {
    if (!open) return false;
    open = false;
    ui.hide?.();
    onOpenChange(false);
    return true;
  }

  function selectMode(mode) {
    if (!open || !MODES.includes(mode)) return false;
    onSelectMode(mode);
    ui.markMode?.(primaryMode(getMode()));
    return true;
  }

  function cycleMode(step) {
    const i = MODES.indexOf(primaryMode(getMode()));
    return selectMode(MODES[(i + step + MODES.length) % MODES.length]);
  }

  /** explore / race / tour: closes the screen first, so the callback finds the game running */
  function activate(action) {
    if (!open || !ACTIONS.includes(action)) return false;
    close();
    if (action === 'explore') onExplore();
    else if (action === 'race') onRace();
    else onTour();
    return true;
  }

  /** Enter / A on the focused item: a mode tile picks the mode and moves on to Explore, a button does its action */
  function press() {
    const item = ITEMS[focus];
    if (item.kind === 'action') return activate(item.id);
    selectMode(item.id);
    show(EXPLORE);
    return true;
  }

  /** left / right step along the row; up / down switch rows (up lands on the selected mode, down on Explore) */
  function move(dir) {
    const item = ITEMS[focus];
    if (dir === 'left' || dir === 'right') {
      const row = ITEMS.map((it, i) => [it, i]).filter(([it]) => it.row === item.row).map(([, i]) => i);
      const at = row.indexOf(focus);
      show(row[(at + (dir === 'right' ? 1 : -1) + row.length) % row.length]);
    } else if (dir === 'up' && item.row === 1) {
      show(MODES.indexOf(primaryMode(getMode())));
    } else if (dir === 'down' && item.row === 0) {
      show(EXPLORE);
    }
    return true;
  }

  /** A key while the screen is open; returns true when the screen used it (the caller then stops it going further). */
  function handleKey(code, { shift = false } = {}) {
    if (!open) return false;
    if (DIGITS[code]) return selectMode(DIGITS[code]) || true;
    switch (code) {
      case 'ArrowLeft': return move('left');
      case 'ArrowRight': return move('right');
      case 'ArrowUp': return move('up');
      case 'ArrowDown': return move('down');
      case 'Tab': return show((focus + (shift ? -1 : 1) + ITEMS.length) % ITEMS.length) || true;
      case 'Enter': case 'NumpadEnter': case 'Space': return press();
      case 'KeyR': return activate('race');
      case 'KeyT': return activate('tour');
      case 'Escape': return activate('explore');
      default: return true; // nothing else reaches the game behind the screen
    }
  }

  /** A gamepad press (js/gamepad-controls.js onStartPad): D-pad moves, A presses, B explores, Y races, X tours, LB / RB modes */
  function handlePad(button) {
    if (!open) return false;
    switch (button) {
      case 'up': case 'down': case 'left': case 'right': return move(button);
      case 'a': case 'menu': return press();
      case 'b': return activate('explore');
      case 'y': return activate('race');
      case 'x': return activate('tour');
      case 'lb': return cycleMode(-1);
      case 'rb': return cycleMode(1);
      default: return true;
    }
  }

  /** A click or tap on a tile or button: focus follows it */
  function click(item) {
    const index = ITEMS.findIndex((it) => it.kind === item?.kind && it.id === item?.id);
    if (!open || index < 0) return false;
    show(index);
    return item.kind === 'action' ? activate(item.id) : selectMode(item.id);
  }

  return {
    open: openScreen,
    close,
    selectMode,
    activate,
    handleKey,
    handlePad,
    click,
    get isOpen() { return open; },
    get focused() { return ITEMS[focus]; }
  };
}

export { createStartScreen, primaryMode, MODES, ACTIONS };
