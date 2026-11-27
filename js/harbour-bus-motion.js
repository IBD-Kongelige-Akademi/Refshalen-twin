// js/harbour-bus-motion.js
// The harbour buses' motion (js/harbour-bus.js draws them): pure, no three.js, so tests/harbour-bus.test.mjs runs it in node.

export const CRUISE = 4.6;     // m/s, about 9 knots
export const ACCEL = 0.35;     // m/s^2
export const DWELL = 35;       // s alongside at a stop
export const TURN_DWELL = 50;  // s at the end of the line before sailing back

/** Path helpers over a flat [x0, z0, x1, z1, ...] polyline: cumulative lengths, point and heading at s. */
export function makePath(flat) {
  const pts = [];
  for (let i = 0; i + 1 < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1];
  function at(s) {
    s = Math.max(0, Math.min(total, s));
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const a = pts[i - 1], b = pts[i];
    const L = cum[i] - cum[i - 1] || 1;
    const u = (s - cum[i - 1]) / L;
    return { x: a[0] + (b[0] - a[0]) * u, z: a[1] + (b[1] - a[1]) * u, heading: Math.atan2(b[0] - a[0], b[1] - a[1]) };
  }
  return { pts, cum, total, at };
}

/**
 * The motion of one boat over its lines: { line, s, v, wait, stopIndex } advanced by step(dt). `lines` are
 * [{ ref, path: makePath(...), stops: [s, ...] }]; the boat runs lines[k] to its end, then lines[(k + 1) % n].
 */
export function harbourBusMotion(lines, { line = 0, s = 0 } = {}) {
  const st = { line, s, v: 0, wait: 0, next: 0 };
  const cur = () => lines[st.line];
  function nextStop() {
    const L = cur();
    while (st.next < L.stops.length && L.stops[st.next] < st.s - 1) st.next++;
    return st.next < L.stops.length ? L.stops[st.next] : L.path.total;
  }
  nextStop();
  function step(dt) {
    if (st.wait > 0) {
      st.wait = Math.max(0, st.wait - dt);
      return st;
    }
    const L = cur();
    const target = nextStop();
    const ahead = target - st.s;
    // brake to arrive at the stop at rest: v^2 = 2 a d
    const vmax = Math.min(CRUISE, Math.sqrt(Math.max(0, 2 * ACCEL * ahead)) + 0.15);
    st.v = st.v < vmax ? Math.min(vmax, st.v + ACCEL * dt) : vmax;
    st.s = Math.min(target, st.s + st.v * dt);
    if (target - st.s < 0.05) {
      st.v = 0;
      if (st.next < L.stops.length) {
        st.wait = DWELL;
        st.next++;
      } else {
        // end of the line in the district: wait, then sail the next line (the other direction) from its start
        st.wait = TURN_DWELL;
        st.line = (st.line + 1) % lines.length;
        st.s = 0;
        st.next = 0;
      }
    }
    return st;
  }
  return { state: st, step, pose: () => cur().path.at(st.s) };
}
