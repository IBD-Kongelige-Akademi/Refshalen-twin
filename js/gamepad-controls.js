import { isTypingInField } from './city-config.js';

const DEAD_ZONE = 0.15;
const BUTTON_COUNT = 17;
const LONG_PRESS = 600; // ms of wall-clock time (the frame dt is capped, so it runs slow at low frame rates): View held this long toggles the sound instead of the HUD

// Standard-mapping buttons (Xbox names; PlayStation: A = Cross, B = Circle, X = Square, Y = Triangle, View = Share / Create)
const A = 0, B = 1, X = 2, Y = 3, LB = 4, RB = 5, LT = 6, RT = 7, VIEW = 8, MENU = 9, L3 = 10, R3 = 11;
const UP = 12, DOWN = 13, LEFT = 14, RIGHT = 15;
// Buttons that keep working while the full map is open (everything else is suppressed there)
const MAP_BUTTONS = new Set([A, B, X, MENU]);

function axis(value) {
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
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
    const cycleLevel = Number(Boolean(edge(RIGHT))) - Number(Boolean(edge(LEFT)));
    const cycleCamera = edge(Y), recenter = edge(R3), horn = edge(L3), inspect = closeMap;
    const interact = confirm && this.controller.getGoBoatInteraction?.();
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
    if (cycleLevel) this.callbacks.onCycleLevel?.(cycleLevel);
    if (inspect) this.callbacks.onInspect?.();
    if (revision !== this.revision) return;
    if (interact) { this.callbacks.onInteract?.(); return; }
    if (cycleMode) this.callbacks.onCycleMode?.(cycleMode);
    if (revision !== this.revision) return;
    if (cycleCamera) this.callbacks.onCycleCamera?.(1);
    if (revision !== this.revision) return;
    if (recenter) this.camera.resetOrbit();

    const movement = stick(pad, 0), look = stick(pad, 2);
    const mode = this.controller.activeMode;
    let drive = -movement.y;
    let vertical = 0;
    if (mode === 'car' || mode === 'bus' || mode === 'cyclist' || mode === 'cargobike') {
      drive = Math.max(0, drive, buttonValue(pad, RT)) - Math.max(0, -drive, buttonValue(pad, LT));
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
    const zoom = Number(Boolean(held(DOWN))) - Number(Boolean(held(UP)));
    this.camera.applyGamepadInput(look.x, look.y, zoom, step);
  }
}

export { GamepadControls };
