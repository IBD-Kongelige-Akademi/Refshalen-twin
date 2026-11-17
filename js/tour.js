import { TELEPORT_LOCATIONS } from './city-config.js';
import { TOUR_STOPS } from './tour-script.js';
import { t } from './i18n.js';

// js/tour.js
// The Kortdage tour (docs/tour.md): from AKKC round the teleport stops and back, one feature of the twin per stop.
//   express / full: hands-off. Fade to black, teleport, the stop's beats (js/tour-script.js) on its scenic camera, next stop.
//   drive:          the visitor drives; the map's GPS routes to the next stop, arriving plays its express beats.
//   attract loop:   after `idleSeconds` without input the express tour starts by itself and loops; any input ends it and
//                   gives the controls back at AKKC.
// Plain logic over injected functions (js/main.js passes its UI closures), so tests/tour.test.mjs runs it without a browser.

const FADE = 0.45; // s for the fade to black (css/style.css #tour-fade uses the same)
const HOLD_MIN = 0.8; // s of black after the teleport, so the near tiles start streaming in
const HOLD_MAX = 2.5; // s of black at most while tiles are still loading
const ARRIVE_RADIUS = 25; // m from the stop that counts as arrived on the drive tour
const ROUTE_END_RADIUS = 12; // m from the GPS route's end (a car route stops at the last drivable node before a walking street)
const ROUTE_END_REACH = 90; // m: ... when that end is this close to the stop
const DRIVE_SAFE = new Set(['time', 'sky', 'wet', 'building', 'honk']); // actions that leave the visitor in control

// The drive tour plays the express beats too, but not the guided-only ones (the start scene's director's cut and showcase)
function beatsFor(stop, kind) {
  if (kind === 'full') return stop.beats;
  return stop.beats.filter((b) => b.express && !(kind === 'drive' && b.guidedOnly));
}

const smooth = (u) => { const s = Math.max(0, Math.min(1, u)); return s * s * (3 - 2 * s); };
const lerp = (a, b, u) => a + (b - a) * u;

/**
 * A director's camera shot at `t` seconds into it, as { pos: [x, y, z], look: [x, y, z] }; an orbit's heights are over the ground at
 * the point it circles (out over the fjord the ground under the camera is the seabed), a glide's over the ground under each view:
 *   { orbit: [x, z], radius, height, lookY, from, speed }   circles the point, starting at angle `from` (0: south of it,
 *                                                           PI: north of it), turning `speed` rad/s
 *   { glide: [[pos, look], [pos, look]], duration }         eases from the first view to the second
 */
function shotPose(shot, t, groundAt = () => 0) {
  let pos, look;
  if (shot.orbit) {
    const [cx, cz] = shot.orbit;
    const a = (shot.from || 0) + (shot.speed || 0) * t;
    pos = [cx + Math.sin(a) * shot.radius, shot.height, cz + Math.cos(a) * shot.radius];
    look = [cx, shot.lookY || 0, cz];
    const base = groundAt(cx, cz);
    pos[1] += base;
    look[1] += base;
    return { pos, look };
  } else if (shot.glide) {
    const [[p0, l0], [p1, l1]] = shot.glide;
    const u = smooth(t / (shot.duration || 1));
    pos = p0.map((v, i) => lerp(v, p1[i], u));
    look = l0.map((v, i) => lerp(v, l1[i], u));
  } else return null;
  pos[1] += groundAt(pos[0], pos[2]);
  look[1] += groundAt(look[0], look[2]);
  return { pos, look };
}

/** Seconds the guided tour of `kind` takes: the beats plus each stop's fade out, black hold and fade in. */
function tourDuration(kind, stops = TOUR_STOPS) {
  return stops.reduce((sum, stop) => sum + FADE * 2 + HOLD_MIN + beatsFor(stop, kind).reduce((s, b) => s + b.hold, 0), 0);
}

function createTour(deps) {
  const {
    stops = TOUR_STOPS,
    locations = TELEPORT_LOCATIONS,
    teleportTo, selectMode, selectCamera, selectTime, selectBuildingLevel,
    controllerManager, cameraSystem, mapSystem = null, lightingSystem, audioSystem = null, buildings = null,
    ui = {}, isLoading = () => false,
    setView = () => {}, groundAt = () => 0 // the director's shots: a fixed camera view (null: the camera preset again)
  } = deps;
  const lastStop = stops.length - 1;
  let idleSeconds = deps.idleSeconds ?? 60;

  // `ready`: the boot is over (the idle timer and ?tour wait for it)
  const state = { kind: null, loop: false, stopIndex: 0, beatIndex: 0, phase: null, t: 0, idle: 0, ready: false };
  let snapshot = null;
  let held = null; // { up: 0.7 } held for the beat
  let pendingBuilding = null; // a building panel waiting for its tile
  let mapOpenedByTour = false;
  let shot = null; // { shot, t }: the director's shot of this beat and how long it has run

  const guided = () => state.kind === 'express' || state.kind === 'full';
  const stopAt = (i) => stops[i];
  const locOf = (stop) => locations[stop.id];
  const beatsOf = (stop) => beatsFor(stop, state.kind);

  function applyShot() {
    if (shot) setView(shotPose(shot.shot, shot.t, groundAt));
  }
  function clearShot() {
    if (!shot) return;
    shot = null;
    setView(null);
  }

  function takeSnapshot() {
    return {
      mode: controllerManager.activeMode,
      avatar: controllerManager.entities?.person?.avatar ?? null,
      time: lightingSystem.activePresetId,
      sky: lightingSystem.skyMode,
      wet: lightingSystem.wetnessOverride ?? null,
      level: buildings?.level ?? null,
      sound: audioSystem?.enabled ?? null
    };
  }

  function applySky(sky, wet) {
    const wetness = wet ?? null;
    const changedWet = (lightingSystem.wetnessOverride ?? null) !== wetness;
    lightingSystem.wetnessOverride = wetness;
    if (lightingSystem.skyMode !== sky) lightingSystem.setSkyMode(sky); // re-applies the preset
    else if (changedWet) lightingSystem.applyPreset(lightingSystem.activePresetId, true);
  }

  function setAvatar(avatar) {
    if (!avatar || controllerManager.entities?.person?.avatar === avatar) return;
    controllerManager.setPersonAvatar(avatar);
    if (controllerManager.activeMode === 'person') selectMode('person'); // refreshes the walk-type buttons and hints
  }

  function tryShowBuilding() {
    if (pendingBuilding && buildings?.showBuilding(pendingBuilding, false)) pendingBuilding = null;
  }

  function run(actions, { snap = false, drive = false } = {}) {
    for (const action of actions || []) {
      const [key] = Object.keys(action);
      if (drive && !DRIVE_SAFE.has(key)) continue;
      if (key === 'camera') selectCamera(action.camera, snap);
      else if (key === 'mode') {
        if (controllerManager.activeMode !== action.mode) selectMode(action.mode);
      } else if (key === 'avatar') setAvatar(action.avatar);
      else if (key === 'time') selectTime(action.time);
      else if (key === 'sky') applySky(action.sky, action.wet);
      else if (key === 'level') selectBuildingLevel?.(action.level);
      else if (key === 'building') {
        pendingBuilding = action.building;
        tryShowBuilding();
      } else if (key === 'honk') audioSystem?.honk(controllerManager.getActiveEntity());
      else if (key === 'input') held = { ...action.input };
      else if (key === 'place') teleportTo(action.place.x, action.place.z, action.place.heading); // a cut to another spot
      else if (key === 'shot') {
        shot = { shot: action.shot, t: 0 };
        applyShot();
      }
      else if (key === 'map') {
        if (action.map === 'route') {
          const next = stopAt(Math.min(state.stopIndex + 1, lastStop));
          const loc = locOf(next);
          if (mapSystem && loc) {
            mapSystem.setWaypoint(loc.x, loc.z, next.title);
            if (!mapSystem.isFullMapOpen) mapSystem.toggleFullMap(true);
            mapOpenedByTour = true;
          }
        } else closeTourMap();
      }
    }
  }

  function closeTourMap() {
    if (!mapOpenedByTour || !mapSystem) return;
    mapOpenedByTour = false;
    if (mapSystem.isFullMapOpen) mapSystem.toggleFullMap(false);
    mapSystem.clearWaypoint();
  }

  // ---- guided tour -------------------------------------------------------------------------------------------------------

  function enterStop(i) {
    state.stopIndex = i;
    state.beatIndex = 0;
    state.phase = 'fadeOut';
    state.t = 0;
    held = null;
    clearShot();
    pendingBuilding = null;
    ui.fade?.(true);
  }

  function arriveGuided() {
    const stop = stopAt(state.stopIndex);
    const loc = locOf(stop);
    closeTourMap();
    ui.hideBuilding?.();
    if (loc) teleportTo(loc.x, loc.z, loc.heading);
    // the first beat's camera is placed under the black
    run(beatsOf(stop)[0]?.do, { snap: true });
    state.phase = 'load';
    state.t = 0;
  }

  function startBeat(i) {
    state.beatIndex = i;
    state.t = 0;
    held = null;
    clearShot();
    if (i > 0) run(beatsOf(stopAt(state.stopIndex))[i].do);
  }

  function nextGuided() {
    if (state.stopIndex < lastStop) return enterStop(state.stopIndex + 1);
    if (state.loop) return enterStop(0);
    return stop({ restore: true });
  }

  function updateGuided(dt) {
    controllerManager.resetInput();
    if (held) for (const [action, value] of Object.entries(held)) controllerManager.setGamepadInput(action, value);
    state.t += dt;
    if (state.phase === 'fadeOut') {
      if (state.t >= FADE) arriveGuided();
    } else if (state.phase === 'load') {
      if (state.t >= HOLD_MIN && (state.t >= HOLD_MAX || !isLoading())) {
        ui.fade?.(false);
        state.phase = 'beat';
        state.t = 0;
      }
    } else if (state.phase === 'beat') {
      tryShowBuilding();
      if (shot) { shot.t += dt; applyShot(); }
      const beats = beatsOf(stopAt(state.stopIndex));
      if (state.t >= beats[state.beatIndex].hold) {
        if (state.beatIndex + 1 < beats.length) startBeat(state.beatIndex + 1);
        else nextGuided();
      }
    }
  }

  // ---- drive tour --------------------------------------------------------------------------------------------------------

  function arriveDrive(i) {
    state.stopIndex = i;
    state.phase = 'arrive';
    state.t = 0;
    state.beatIndex = 0;
    mapSystem?.clearWaypoint();
    run(beatsOf(stopAt(i))[0]?.do, { drive: true });
  }

  function startLeg(i) {
    state.stopIndex = i;
    state.phase = 'leg';
    state.t = 0;
    const stop = stopAt(i);
    const loc = locOf(stop);
    if (mapSystem && loc) mapSystem.setWaypoint(loc.x, loc.z, stop.title);
  }

  function routeInfo(px, pz) {
    const pts = mapSystem?.route?.pts;
    if (!pts || pts.length < 2) return null;
    let length = 0;
    for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    const end = pts[pts.length - 1];
    return { length, end, endDistance: Math.hypot(end.x - px, end.z - pz) };
  }

  function legDistance() {
    const loc = locOf(stopAt(state.stopIndex));
    const p = controllerManager.getActiveEntity().position;
    const direct = Math.hypot(loc.x - p.x, loc.z - p.z);
    const route = routeInfo(p.x, p.z);
    return { direct, route };
  }

  function updateDrive(dt) {
    state.t += dt;
    if (state.phase === 'arrive') {
      tryShowBuilding();
      const beats = beatsOf(stopAt(state.stopIndex));
      if (state.t >= beats[state.beatIndex].hold) {
        if (state.beatIndex + 1 < beats.length) {
          state.beatIndex++;
          state.t = 0;
          run(beats[state.beatIndex].do, { drive: true });
        } else if (state.stopIndex < lastStop) startLeg(state.stopIndex + 1);
        else stop({ restore: false });
      }
    } else if (state.phase === 'leg') {
      const { direct, route } = legDistance();
      const loc = locOf(stopAt(state.stopIndex));
      const endNearStop = route && Math.hypot(route.end.x - loc.x, route.end.z - loc.z) < ROUTE_END_REACH;
      if (direct < ARRIVE_RADIUS || (endNearStop && direct < ROUTE_END_REACH && route.endDistance < ROUTE_END_RADIUS)) arriveDrive(state.stopIndex);
    }
  }

  function skipLeg() {
    if (state.kind !== 'drive') return false;
    if (state.phase === 'leg') {
      const loc = locOf(stopAt(state.stopIndex));
      teleportTo(loc.x, loc.z, loc.heading);
      arriveDrive(state.stopIndex);
    } else if (state.phase === 'arrive') {
      state.t = Infinity; // the beat ends at the next update
    }
    return true;
  }

  // ---- the card ----------------------------------------------------------------------------------------------------------

  function card() {
    const stop = stopAt(state.stopIndex);
    const counter = state.stopIndex === 0 ? t('Start') : state.stopIndex === lastStop ? t('Finish') : `${state.stopIndex} / ${lastStop - 1}`;
    // the script is English; the card shows it in the chosen language (js/i18n.js)
    const info = { kind: state.kind, loop: state.loop, counter, title: t(stop.title), sub: t(stop.sub), caption: '', progress: 0, phase: state.phase };
    if (state.phase === 'leg') {
      const { direct, route } = legDistance();
      const metres = Math.round(route ? Math.max(route.length, direct * 0.5) : direct);
      info.title = `${t('Next')}: ${t(stop.title)}`;
      info.caption = `${t('Follow the GPS line on the minimap')} · ${metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${metres} m`}`;
      info.distance = metres;
      return info;
    }
    const beats = beatsOf(stop);
    const beat = beats[state.beatIndex] || beats[0];
    info.caption = t(beat?.caption || '');
    if (state.phase === 'beat' || state.phase === 'arrive') info.progress = Math.min(1, state.t / (beat?.hold || 1));
    else if (state.phase === 'load' || state.phase === 'fadeOut') info.progress = 0;
    return info;
  }

  // ---- public ------------------------------------------------------------------------------------------------------------

  function start(kind, { loop = false } = {}) {
    if (!['express', 'full', 'drive'].includes(kind)) return false;
    if (state.kind) stop({ restore: true });
    snapshot = takeSnapshot();
    ui.closePopovers?.();
    if (mapSystem?.isFullMapOpen) mapSystem.toggleFullMap(false);
    Object.assign(state, { kind, loop: loop && kind !== 'drive', idle: 0 });
    mapOpenedByTour = false;
    held = null;
    pendingBuilding = null;
    if (kind === 'drive') {
      if (controllerManager.activeMode === 'drone') selectMode('car');
      ui.setTouring?.(false, state);
      arriveDrive(0);
    } else {
      ui.setTouring?.(true, state);
      enterStop(0);
    }
    ui.showCard?.(card());
    return true;
  }

  function stop({ restore = true } = {}) {
    if (!state.kind) return false;
    const wasGuided = guided();
    ui.fade?.(false);
    ui.hideCard?.();
    ui.setTouring?.(false, state);
    closeTourMap();
    if (state.kind === 'drive') mapSystem?.clearWaypoint();
    controllerManager.resetInput();
    held = null;
    pendingBuilding = null;
    clearShot();
    const snap = snapshot;
    Object.assign(state, { kind: null, loop: false, phase: null, t: 0, idle: 0 });
    snapshot = null;
    if (snap && restore) {
      if (snap.level && buildings && buildings.level !== snap.level) selectBuildingLevel?.(snap.level);
      selectTime(snap.time);
      applySky(snap.sky, snap.wet);
      if (wasGuided) {
        if (snap.avatar) setAvatar(snap.avatar);
        if (controllerManager.activeMode !== snap.mode) selectMode(snap.mode);
        const home = locations[stops[0].id];
        teleportTo(home.x, home.z, home.heading);
        ui.hideBuilding?.();
      }
    }
    return true;
  }

  /** next / prev / end from the keys, the card's buttons and the gamepad; returns true when the tour used it. */
  function command(cmd) {
    if (!state.kind) return false;
    if (state.loop) { stop({ restore: true }); return true; }
    if (cmd === 'end') { stop({ restore: true }); return true; }
    if (state.kind === 'drive') return cmd === 'next' ? skipLeg() : false;
    if (cmd === 'next') {
      if (state.phase === 'beat') state.t = Infinity;
      return true;
    }
    if (cmd === 'prev') {
      enterStop(state.beatIndex > 0 || state.phase !== 'beat' ? state.stopIndex : Math.max(0, state.stopIndex - 1));
      return true;
    }
    return false;
  }

  /** Any input (key, click, touch, gamepad): resets the idle timer and ends the attract loop. Returns true if it ended it. */
  function noteInput({ end = true } = {}) {
    state.idle = 0;
    if (end && state.kind && state.loop) {
      stop({ restore: true });
      return true;
    }
    return false;
  }

  function update(dt) {
    const step = Number.isFinite(dt) ? Math.max(0, Math.min(0.25, dt)) : 0;
    if (state.ready && idleSeconds > 0 && (!state.kind || state.kind === 'drive')) {
      state.idle += step;
      if (state.idle >= idleSeconds) start('express', { loop: true });
    }
    if (!state.kind) return;
    if (guided()) updateGuided(step);
    else updateDrive(step);
    if (state.kind) ui.showCard?.(card()); // the adapter only touches the DOM where something changed
  }

  return {
    state,
    start,
    stop,
    command,
    next: () => command('next'),
    prev: () => command('prev'),
    skipLeg,
    noteInput,
    update,
    get active() { return Boolean(state.kind); },
    get guided() { return guided(); },
    get idleSeconds() { return idleSeconds; },
    set idleSeconds(s) { idleSeconds = Number.isFinite(s) ? Math.max(0, s) : 0; },
    setReady() { state.ready = true; state.idle = 0; }
  };
}

export { createTour, tourDuration, beatsFor, shotPose, FADE, HOLD_MIN, HOLD_MAX, ARRIVE_RADIUS };
