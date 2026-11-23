import { isTypingInField } from './city-config.js';

const DEAD_ZONE = 0.15;
const BUTTON_COUNT = 17;
const LONG_PRESS = 600; // ms of wall-clock time (the frame dt is capped, so it runs slow at low frame rates): View held this long toggles the sound instead of the HUD

// Standard-mapping buttons (Xbox names; PlayStation: A = Cross, B = Circle, X = Square, Y = Triangle, View = Share / Create)
const A = 0, B = 1, X = 2, Y = 3, LB = 4, RB = 5, LT = 6, RT = 7, VIEW = 8, MENU = 9, L3 = 10, R3 = 11;
const UP = 12, DOWN = 13, LEFT = 14, RIGHT = 15;
// Buttons that keep working while the full map is open (everything else is suppressed there)
const MAP_BUTTONS = new Set([A, B, X, MENU]);
const DPAD = [[UP, 'up'], [DOWN, 'down'], [LEFT, 'left'], [RIGHT, 'right']];
// The buttons the start screen answers to (js/start-screen.js handlePad)
const START_BUTTONS = [[A, 'a'], [B, 'b'], [X, 'x'], [Y, 'y'], [LB, 'lb'], [RB, 'rb'], [MENU, 'menu']];
const REPEAT_DELAY = 400, REPEAT_EVERY = 140; // ms: a held D-pad direction repeats after REPEAT_DELAY, every REPEAT_EVERY
const R3_TAP = 350; // ms: the right stick pressed and let go within this, without zooming, recenters the camera

const RUMBLE_GAP = 250; // ms between two rumbles, unless the second hit is clearly harder (scraping along a wall stays a soft buzz)

/**
 * The rumble for an impact at `speed` m/s (the closing speed js/controllers.js and js/traffic.js report): null below
 * 2 m/s, else { duration ms, strong, weak } growing with the speed up to a full 0.3 s jolt at 14 m/s (50 km/h). A drone
 * touching down ('ground') rumbles at 60 %.
 */
function impactRumble(speed, kind = '') {
  if (!(speed >= 2)) return null;
  const s = Math.min(1, (speed - 1) / 13) * (kind === 'ground' ? 0.6 : 1);
  return { duration: Math.round(90 + 210 * s), strong: s, weak: Math.min(1, 0.25 + 0.75 * s) };
}

function axis(value) {
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}

// One axis with the dead zone taken out, rescaled to the full range: steering (from slop-newyork 67ef6be)
function steeringAxis(value) {
  const v = axis(value);
  return Math.sign(v) * Math.max(0, (Math.abs(v) - DEAD_ZONE) / (1 - DEAD_ZONE));
}

function stick(pad, offset) {
  const x = axis(pad.axes?.[offset]), y = axis(pad.axes?.[offset + 1]);
  const distance = Math.hypot(x, y);
  const strength = Math.max(0, (Math.min(distance, 1) - DEAD_ZONE) / (1 - DEAD_ZONE));
  return distance ? { x: x / distance * strength, y: y / distance * strength } : { x: 0, y: 0 };
}

function buttonValue(pad, index) {
  const button = pad.buttons?.[index];
  return Number.isFinite(button?.value) ? Math.max(0, Math.min(1, button.value)) : button?.pressed ? 1 : 0;
}

function buttons(pad) {
  return Array.from({ length: BUTTON_COUNT }, (_, i) => Boolean(pad.buttons?.[i]?.pressed) || buttonValue(pad, i) > 0.5);
}

class GamepadControls {
  constructor(controllerManager, cameraSystem, callbacks = {}) {
    this.controller = controllerManager;
    this.camera = cameraSystem;
    this.callbacks = callbacks;
    this.connected = false;
    this.enabled = true;
    this.padIndex = null;
    this.padId = null;
    this.previousButtons = [];
    this.suppressedButtons = [];
    this.syncButtons = true;
    this.revision = 0;
    this.viewDownAt = null; // performance.now() when View went down; a release before LONG_PRESS is a tap
    this.viewFired = false;
    this.dpad = null; // the held D-pad direction: { dir, next } (performance.now() of its next repeat)
    this.r3DownAt = null; // performance.now() when the right stick went down
    this.r3Zoomed = false; // the right stick zoomed during this press (so letting go does not recenter)
    this.lastRumbleAt = -Infinity;
    this.lastRumbleStrength = 0;
    this.focused = typeof document.hasFocus !== 'function' || document.hasFocus();

    window.addEventListener('blur', () => {
      this.focused = false;
      this.reset();
    });
    window.addEventListener('focus', () => {
      this.focused = true;
      this.reset();
    });
    document.addEventListener('visibilitychange', () => this.reset());
  }

  readPad() {
    // Some browsers expose the API but reject it through Permissions Policy.
    try {
      if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return null;
      const pads = navigator.getGamepads();
      let first = null;
      for (let i = 0; i < (pads?.length || 0); i++) {
        const pad = pads[i];
        if (!pad?.connected || pad.mapping !== 'standard') continue;
        if (pad.index === this.padIndex && pad.id === this.padId) return pad;
        if (!first) first = pad;
      }
      return first;
    } catch {
      return null;
    }
  }

  reset() {
    this.revision++;
    this.viewDownAt = null;
    this.dpad = null;
    this.r3DownAt = null;
    this.controller.clearGamepadInput();
    const pad = this.readPad();
    if (pad && pad.index === this.padIndex && pad.id === this.padId) {
      this.previousButtons = buttons(pad);
      this.suppressedButtons = this.previousButtons.slice();
      this.syncButtons = false;
    } else {
      this.syncButtons = true;
    }
  }

  setEnabled(enabled) {
    enabled = Boolean(enabled);
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.reset();
  }

  update(dt) {
    const pad = this.readPad();
    const connected = Boolean(pad);
    const changedPad = pad ? pad.index !== this.padIndex || pad.id !== this.padId : this.connected;
    if (changedPad) {
      this.controller.clearGamepadInput();
      this.padIndex = pad ? pad.index : null;
      this.padId = pad ? pad.id : null;
      this.syncButtons = true;
    }
    this.connected = connected;
    if (!pad) return;

    const pressed = buttons(pad);
    if (this.syncButtons) {
      // Connecting, switching pads, or resetting must not turn a held button into a fresh action.
      this.previousButtons = pressed.slice();
      this.suppressedButtons = pressed.slice();
      this.syncButtons = false;
    }
    for (let i = 0; i < BUTTON_COUNT; i++) if (!pressed[i]) this.suppressedButtons[i] = false;
    const edge = (i) => pressed[i] && !this.previousButtons[i] && !this.suppressedButtons[i];
    const held = (i) => pressed[i] && !this.suppressedButtons[i];
    // Capture edges before callbacks: changing mode or opening the map may synchronously call reset().
    const toggleMap = edge(MENU), closeMap = edge(B), confirm = edge(A), route = edge(X);
    const cycleMode = Number(Boolean(edge(RB))) - Number(Boolean(edge(LB)));
    const dpadX = Number(Boolean(edge(RIGHT))) - Number(Boolean(edge(LEFT)));
    const anyPress = pressed.some((_, i) => edge(i));
    // cameras have no button: they are picked from the HUD's camera switch (the D-pad)
    const cycleSubtype = edge(Y), recenter = edge(R3), horn = edge(L3), inspect = closeMap;
    const interact = confirm && this.controller.getGoBoatInteraction?.();
    const startPress = START_BUTTONS.find(([i]) => edge(i))?.[1] || null;
    this.previousButtons = pressed;
    const step = Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 0;

    const target = document.activeElement;
    const typing = isTypingInField({ target }) || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
    if (!this.focused || document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus()) || typing) {
      this.suppressedButtons = pressed.slice();
      this.viewDownAt = null;
      this.controller.clearGamepadInput();
      return;
    }

    // Any fresh press or a stick off centre is activity (the tour's idle timer and attract loop, js/tour.js)
    const sticksMoved = stick(pad, 0).x || stick(pad, 0).y || stick(pad, 2).x || stick(pad, 2).y;
    if (sticksMoved || anyPress) this.callbacks.onActivity?.();
    if (this.callbacks.startActive?.()) {
      // The start screen (js/start-screen.js): the D-pad moves its highlight, the buttons pick; nothing drives the player
      this.controller.clearGamepadInput();
      this.viewDownAt = null;
      const dir = this.dpadDirection(held);
      if (dir) this.callbacks.onStartPad?.(dir);
      else if (startPress) this.callbacks.onStartPad?.(startPress);
      return;
    }
    if (this.tourMode) {
      // A guided tour plays: A / D-pad right next, D-pad left back, B ends it; nothing drives the player
      this.controller.clearGamepadInput();
      this.viewDownAt = null;
      if (closeMap) this.callbacks.onTour?.('end');
      else if (confirm || dpadX > 0) this.callbacks.onTour?.('next');
      else if (dpadX < 0) this.callbacks.onTour?.('prev');
      return;
    }

    const revision = this.revision;
    if (toggleMap) {
      this.controller.clearGamepadInput();
      this.callbacks.onToggleMap?.();
      return;
    }
    if (!this.enabled) {
      // The full map: the left stick pans, the triggers (or the D-pad) zoom, A teleports to the crosshair, X routes there, B closes
      this.controller.clearGamepadInput();
      this.viewDownAt = null;
      for (let i = 0; i < BUTTON_COUNT; i++) if (!MAP_BUTTONS.has(i)) this.suppressedButtons[i] = pressed[i];
      if (closeMap) { this.callbacks.onCloseMap?.(); return; }
      if (confirm) { this.callbacks.onMapTeleport?.(); return; }
      if (route) this.callbacks.onMapWaypoint?.();
      const pan = stick(pad, 0);
      const zoom = buttonValue(pad, RT) - buttonValue(pad, LT) + Number(Boolean(pressed[UP])) - Number(Boolean(pressed[DOWN]));
      this.callbacks.onMapInput?.(pan.x, pan.y, Math.max(-1, Math.min(1, zoom)), step);
      return;
    }

    // View: a tap toggles the HUD, a long press toggles the sound (once per press)
    let viewTap = false, viewLong = false;
    if (held(VIEW)) {
      const now = performance.now();
      this.viewDownAt ??= now;
      if (!this.viewFired && now - this.viewDownAt >= LONG_PRESS) viewLong = this.viewFired = true;
    } else {
      viewTap = this.viewDownAt !== null && !this.viewFired;
      this.viewDownAt = null;
      this.viewFired = false;
    }
    if (viewTap) this.callbacks.onToggleHud?.();
    if (viewLong) this.callbacks.onToggleSound?.();
    if (horn) this.callbacks.onHorn?.();
    if (revision !== this.revision) return;

    // The D-pad moves the HUD highlight (js/hud-nav.js); while it shows, A presses the highlighted button and B backs out
    const dir = this.dpadDirection(held);
    if (dir) this.callbacks.onNav?.(dir);
    if (revision !== this.revision) return;
    if (confirm && this.callbacks.navActive?.()) {
      this.suppressedButtons[A] = true; // no jump while this press is held
      this.callbacks.onNavPress?.();
      return;
    }
    if (inspect && this.callbacks.onNavBack?.()) this.suppressedButtons[B] = true;
    else if (inspect) this.callbacks.onInspect?.();
    if (revision !== this.revision) return;
    if (interact) { this.callbacks.onInteract?.(); return; }
    if (cycleMode) this.callbacks.onCycleMode?.(cycleMode);
    if (revision !== this.revision) return;
    if (cycleSubtype) this.callbacks.onCycleSubtype?.();
    if (revision !== this.revision) return;

    const mode = this.controller.activeMode;
    // Driving, the left stick only steers and the triggers alone drive and brake, so a stick pushed off-centre while
    // steering does not also accelerate (slop-newyork 67ef6be)
    const driving = mode === 'car' || mode === 'bus' || mode === 'cyclist' || mode === 'cargobike';
    const movement = driving ? { x: steeringAxis(pad.axes?.[0]), y: 0 } : stick(pad, 0);
    const look = stick(pad, 2);
    // Right stick pressed in: up / down zoom (the camera keeps its pitch); a quick press without zooming recenters
    let zoom = 0;
    if (held(R3)) {
      this.r3DownAt ??= performance.now();
      if (recenter) this.r3Zoomed = false;
      zoom = look.y;
      if (zoom) this.r3Zoomed = true;
    } else if (this.r3DownAt !== null) {
      if (!this.r3Zoomed && performance.now() - this.r3DownAt <= R3_TAP) this.camera.resetOrbit();
      this.r3DownAt = null;
      this.r3Zoomed = false;
    }
    let drive = -movement.y;
    let vertical = 0;
    if (driving) {
      drive = buttonValue(pad, RT) - buttonValue(pad, LT);
    } else if (mode === 'drone') {
      vertical = buttonValue(pad, RT) - buttonValue(pad, LT);
    }
    this.controller.setGamepadInput('forward', Math.max(0, drive));
    this.controller.setGamepadInput('backward', Math.max(0, -drive));
    this.controller.setGamepadInput('left', Math.max(0, -movement.x));
    this.controller.setGamepadInput('right', Math.max(0, movement.x));
    this.controller.setGamepadInput('up', mode === 'person' ? Number(Boolean(held(A))) : Math.max(0, vertical));
    this.controller.setGamepadInput('down', Math.max(0, -vertical));
    this.controller.setGamepadInput('boost', Number(Boolean(held(X))));
    this.camera.applyGamepadInput(look.x, zoom ? 0 : look.y, zoom, step);
  }

  /**
   * Shakes the pad for a collision of the player at `speed` m/s (see impactRumble) through its vibration actuator
   * (Chrome / Edge: Xbox and XInput pads, DualShock 4). Returns whether a rumble started; pads without one stay still.
   */
  rumbleImpact(speed, kind) {
    const effect = impactRumble(speed, kind);
    if (!effect || !this.connected || !this.focused || document.hidden) return false;
    const now = performance.now();
    if (now - this.lastRumbleAt < RUMBLE_GAP && effect.strong <= this.lastRumbleStrength * 1.5) return false;
    const actuator = this.readPad()?.vibrationActuator;
    if (typeof actuator?.playEffect !== 'function') return false;
    this.lastRumbleAt = now;
    this.lastRumbleStrength = effect.strong;
    try {
      actuator.playEffect('dual-rumble', { startDelay: 0, duration: effect.duration, strongMagnitude: effect.strong, weakMagnitude: effect.weak })
        ?.catch?.(() => {});
    } catch {
      return false;
    }
    return true;
  }

  /** The D-pad direction to act on this frame: a fresh press, or a held one once it repeats (null otherwise). */
  dpadDirection(held) {
    const now = performance.now();
    const down = DPAD.find(([i]) => held(i));
    if (!down) { this.dpad = null; return null; }
    const dir = down[1];
    if (this.dpad?.dir !== dir) {
      this.dpad = { dir, next: now + REPEAT_DELAY };
      return dir;
    }
    if (now < this.dpad.next) return null;
    this.dpad.next = now + REPEAT_EVERY;
    return dir;
  }
}

export { GamepadControls, impactRumble };
