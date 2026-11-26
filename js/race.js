import { TELEPORT_LOCATIONS } from './city-config.js';
import { REF_SPEED, SANITY, parFor, adjustedTime, raceMode, createScores } from './race-scores.js';

// js/race.js
// The Refshaleøen race (docs/race.md): from Reffen to Akademiet in any mode, any route, against the clock.
//   idle -> countdown (3 s, the controls held) -> running (the clock, the GPS route to the finish) -> finished (the result card,
//   name + company for the list) -> idle. The finish is the street itself: within FINISH_RADIUS of any road-graph link named
//   Danneskiold-Samsøes Allé, the Academy's street on Holmen.
// Plain logic over injected functions (js/main.js passes its UI closures), so tests/race.test.mjs runs it without a browser.

export const COUNTDOWN = 3; // s
export const FINISH_RADIUS = 8; // m from the street's centre line
export const FINISH_REACH = 60; // m: the allé's links this close to the Akademiet teleport
export const FINISH_FALLBACK_RADIUS = 25; // m from TELEPORT_LOCATIONS.akademiet when the road graph has no Danneskiold-Samsøes Allé
export const FINISH_NAME = 'Danneskiold-Samsøes Allé'; // the Academy's street on Holmen
const JUMP = 60; // m in one update: a teleport, which ends the race
const HEADING_LOOKAHEAD = 25; // m along the route: the start faces that way

/** The finish line's segments [ax, az, bx, bz] from the road graph's links named `name`. */
export function finishSegments(graph, name = FINISH_NAME, near = TELEPORT_LOCATIONS.akademiet, reach = FINISH_REACH) {
  if (!graph?.names || !graph.links || !graph.nodes) return [];
  const idx = graph.names.indexOf(name);
  if (idx < 0) return [];
  const N = graph.nodes;
  const segs = graph.links.filter((l) => l[6] === idx && l[0] !== l[1]).map((l) => [N[2 * l[0]], N[2 * l[0] + 1], N[2 * l[1]], N[2 * l[1] + 1]]);
  // the long allé runs the length of Holmen: only its links by the Academy are the finish
  return near ? segs.filter((g) => segmentDistance(near.x, near.z, g) <= reach) : segs;
}

function segmentDistance(px, pz, [ax, az, bx, bz]) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const u = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2)) : 0;
  return Math.hypot(px - (ax + dx * u), pz - (az + dz * u));
}

const pathLength = (pts) => {
  let length = 0;
  for (let i = 1; i < (pts?.length || 0); i++) length += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return length;
};

/** The point `distance` metres along the path */
function along(pts, distance) {
  let left = distance;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    if (d >= left && d > 0) {
      const u = left / d;
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * u, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * u };
    }
    left -= d;
  }
  return pts[pts.length - 1];
}

export function createRace(deps) {
  const {
    controllerManager, mapSystem = null, teleportTo,
    router = mapSystem?.router || null,
    start = TELEPORT_LOCATIONS.reffen,
    target = TELEPORT_LOCATIONS.akademiet,
    finish = [],
    scores = createScores(deps.storage),
    ui = {}
  } = deps;

  const state = { phase: 'idle', t: 0, time: 0, mode: null, activeMode: null, result: null, message: '' };
  let route = null; // { length, carLength, par, carPar, pts }
  let last = null; // the player's position last update

  const player = () => controllerManager.getActiveEntity().position;
  const modeNow = () => raceMode(controllerManager.activeMode, controllerManager.entities?.person?.avatar);
  const blocking = () => state.phase === 'countdown' || state.phase === 'running';

  function routeFor(mode) {
    const direct = [{ x: start.x, z: start.z }, { x: target.x, z: target.z }];
    if (mode === 'drone' || !router) return direct;
    return router.route(start, target, mode === 'car' || mode === 'bus' ? 'car' : 'person') || direct;
  }

  function atFinish(x, z) {
    if (finish.length) return finish.some((s) => segmentDistance(x, z, s) <= FINISH_RADIUS);
    return Math.hypot(x - target.x, z - target.z) <= FINISH_FALLBACK_RADIUS;
  }

  function remaining() {
    const p = player();
    const direct = Math.hypot(target.x - p.x, target.z - p.z);
    const pts = mapSystem?.route?.pts;
    return pts && pts.length > 1 && state.mode !== 'drone' ? Math.max(pathLength(pts), direct * 0.5) : direct;
  }

  function hud() {
    ui.showHud?.({ phase: state.phase, time: state.time, count: Math.ceil(COUNTDOWN - state.t), go: state.phase === 'running' && state.time < 1, distance: remaining(), mode: state.mode });
  }

  // ---- public ------------------------------------------------------------------------------------------------------------

  /** Puts the active player at the start, facing along its route, and counts down. */
  function begin() {
    if (blocking()) return false;
    ui.closePopovers?.();
    ui.hideResult?.();
    const mode = modeNow();
    const pts = routeFor(mode);
    const carPts = routeFor('car');
    const length = pathLength(pts);
    const carLength = pathLength(carPts);
    route = { length, carLength, par: parFor(mode, length), carPar: parFor('car', carLength), pts };
    const ahead = along(pts, Math.min(HEADING_LOOKAHEAD, length));
    const heading = Math.atan2(ahead.x - start.x, ahead.z - start.z);
    teleportTo(start.x, start.z, heading);
    controllerManager.resetInput();
    if (mapSystem?.isFullMapOpen) mapSystem.toggleFullMap(false);
    mapSystem?.setWaypoint(target.x, target.z, target.name || FINISH_NAME);
    Object.assign(state, { phase: 'countdown', t: 0, time: 0, mode, activeMode: controllerManager.activeMode, result: null, message: '' });
    const p = player();
    last = { x: p.x, z: p.z };
    ui.setRacing?.(true);
    hud();
    return true;
  }

  function end() {
    ui.setRacing?.(false);
    ui.hideHud?.();
    mapSystem?.clearWaypoint();
    last = null;
  }

  /** Ends a countdown or a run without a result; `reason` is shown ('user', 'idle', 'mode', 'teleport'). */
  function abort(reason = 'user') {
    if (!blocking()) return false;
    end();
    Object.assign(state, { phase: 'idle', t: 0, message: reason });
    ui.aborted?.(reason);
    return true;
  }

  function finishRun() {
    end();
    const { par, carPar, length } = route;
    const time = state.time;
    const rejected = time < par * SANITY;
    const adjusted = adjustedTime(time, par, carPar);
    state.result = { mode: state.mode, time, par, carPar, length, adjusted, rejected, rank: rejected ? null : scores.rankOf(adjusted) };
    state.phase = 'finished';
    ui.showResult?.(state.result, scores.top(10));
  }

  /** Saves the finished run under the name and company; returns { entry, rank } or null (no name, a rejected run). */
  function submit(name, company) {
    if (state.phase !== 'finished' || !state.result || state.result.rejected) return null;
    const saved = scores.add({ ...state.result, at: Date.now() }, name, company);
    if (!saved) return null;
    state.phase = 'idle';
    ui.showBoard?.(scores.top(10), saved.entry, saved.rank);
    return saved;
  }

  /** Closes the result card without saving. */
  function dismiss() {
    if (state.phase !== 'finished') return false;
    state.phase = 'idle';
    state.result = null;
    ui.hideResult?.();
    return true;
  }

  function update(dt) {
    if (!blocking()) return;
    // wall time, so a slow frame rate does not slow the clock; a longer stall (a hidden tab) counts as 1 s
    const step = Number.isFinite(dt) ? Math.max(0, Math.min(1, dt)) : 0;
    if (controllerManager.activeMode !== state.activeMode) { abort('mode'); return; }
    const p = player();
    if (last && Math.hypot(p.x - last.x, p.z - last.z) > JUMP) { abort('teleport'); return; }
    last = { x: p.x, z: p.z };
    if (state.phase === 'countdown') {
      controllerManager.resetInput(); // the player stays on the line until the go
      state.t += step;
      if (state.t >= COUNTDOWN) {
        state.phase = 'running';
        state.time = 0;
      }
    } else {
      state.time += step;
      if (atFinish(p.x, p.z)) { finishRun(); return; }
    }
    hud();
  }

  return {
    state,
    scores,
    begin,
    abort,
    submit,
    dismiss,
    update,
    atFinish,
    get route() { return route; },
    get blocking() { return blocking(); },
    get active() { return state.phase !== 'idle'; }
  };
}

export { REF_SPEED };
