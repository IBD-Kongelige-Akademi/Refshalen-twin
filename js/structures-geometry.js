// js/structures-geometry.js
// Pure (no three.js) geometry of the `structures` layer (tools/geodata/city_structures.py): bridge decks and railway tracks as plain
// arrays (position, normal, index, and per vertex `kind` and `along` for the shader in js/structures.js).
//
// A deck: its top (the outline triangulated, every vertex at the deck height + DECK_LIFT), the fascia round its edge and the soffit under
// it where it stands clear of the ground, parapets (road and rail decks: a concrete wall) or railings (foot bridges) along the edges that
// stand over PARAPET_MIN_CLEAR, and piers along the axes where the deck is over PIER_MIN_CLEAR. A track: a ballast bed (the sleepers are
// painted on it) and the two rails, on the terrain, or on the deck where the track is tagged a bridge.
import earcut from './earcut.js';
import { deckHeight } from './deck-field.js';

export const KIND = Object.freeze({ road: 0, foot: 1, ballastDeck: 2, concrete: 3, metal: 4, ballast: 5, steel: 6 });
export const DECK = Object.freeze({
  lift: 0.03, // the deck top over its measured height (over the draped road at the bridge ends)
  thick: { road: 1.0, rail: 1.2, foot: 0.45 },
  parapet: { road: 1.0, rail: 1.0, foot: 1.1 },
  parapetW: 0.25,
  parapetMinClear: 0.8,
  pierMinClear: 3.0,
  pierStep: 24,
  edgeStep: 3
});
export const TRACK = Object.freeze({ step: 4, gauge: 1.435, railW: 0.07, railH: 0.15, bedTop: 1.6, bedFoot: 2.4, bedH: 0.35, sleeperH: 0.12 });

export class Arrays {
  constructor() { this.position = []; this.normal = []; this.kind = []; this.along = []; this.index = []; }
  vert(x, y, z, nx, ny, nz, kind, along = 0) {
    this.position.push(x, y, z);
    this.normal.push(nx, ny, nz);
    this.kind.push(kind);
    this.along.push(along);
    return this.position.length / 3 - 1;
  }
  /** A quad a-b-c-d (counter-clockwise seen from its front) with one normal */
  quad(a, b, c, d, n, kind, along = [0, 0, 0, 0]) {
    const i = this.vert(...a, ...n, kind, along[0]);
    this.vert(...b, ...n, kind, along[1]);
    this.vert(...c, ...n, kind, along[2]);
    this.vert(...d, ...n, kind, along[3]);
    this.index.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }
  get triangles() { return this.index.length / 3; }
}

const area2 = (r) => {
  let a = 0;
  for (let i = 0, k = r.length - 2; i < r.length; k = i, i += 2) a += r[k] * r[i + 1] - r[i] * r[k + 1];
  return a;
};

/**
 * One deck: its outline (`ring`, `holes`, densified by the build) with the ground under every vertex (`ringG`, `holesG`), and its axes
 * (`pts` flat [x, z, deck y, ground y, ...]). Needs no terrain. Returns { arrays, stats }.
 */
export function buildDeckArrays(deck) {
  const A = new Arrays();
  const kind = deck.kind === 'rail' ? 'rail' : deck.kind === 'foot' ? 'foot' : 'road';
  const thick = DECK.thick[kind];
  const topKind = kind === 'rail' ? KIND.ballastDeck : kind === 'foot' ? KIND.foot : KIND.road;
  const rings = [deck.ring, ...(deck.holes || [])];
  const groundOf = [deck.ringG || [], ...(deck.holesG || [])];
  // ---- the top and the soffit: the outline (and its holes) triangulated
  const flat = [];
  const gs0 = [];
  const holeIdx = [];
  for (let r = 0; r < rings.length; r++) {
    if (r) holeIdx.push(flat.length / 2);
    for (const v of rings[r]) flat.push(v);
    for (let i = 0; i < rings[r].length / 2; i++) gs0.push(groundOf[r][i] ?? 0);
  }
  const tri = earcut(flat, holeIdx, 2);
  const n = flat.length / 2;
  const ys = new Float64Array(n);
  const gs = Float64Array.from(gs0);
  for (let i = 0; i < n; i++) {
    const y = deckHeight(deck, flat[2 * i], flat[2 * i + 1]);
    ys[i] = (y === null ? gs[i] : Math.max(y, gs[i])) + DECK.lift;
  }
  // the edge follows the nearest carried way, which can switch from one to the next along it: a median and a mean along each ring keep
  // the fascia and the parapet straight
  for (let r = 0, o = 0; r < rings.length; o += rings[r].length / 2, r++) {
    const m = rings[r].length / 2;
    if (m < 7) continue;
    const src = ys.slice(o, o + m);
    const med = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      const w = [];
      for (let k = -2; k <= 2; k++) w.push(src[(i + k + m) % m]);
      w.sort((a, b) => a - b);
      med[i] = w[2];
    }
    for (let i = 0; i < m; i++) ys[o + i] = Math.max((med[(i - 1 + m) % m] + med[i] + med[(i + 1) % m]) / 3, gs[o + i] + DECK.lift);
  }
  // the top faces up: with z south, a ring counter-clockwise from above has a negative area2 in (x, z)
  const flip = area2(rings[0]) > 0;
  const base = A.position.length / 3;
  for (let i = 0; i < n; i++) A.vert(flat[2 * i], ys[i], flat[2 * i + 1], 0, 1, 0, topKind, 0);
  for (let t = 0; t < tri.length; t += 3) {
    const [a, b, c] = flip ? [tri[t], tri[t + 2], tri[t + 1]] : [tri[t], tri[t + 1], tri[t + 2]];
    A.index.push(base + a, base + b, base + c);
  }
  const sb = A.position.length / 3;
  for (let i = 0; i < n; i++) A.vert(flat[2 * i], ys[i] - thick, flat[2 * i + 1], 0, -1, 0, KIND.concrete, 0);
  for (let t = 0; t < tri.length; t += 3) {
    const [a, b, c] = flip ? [tri[t], tri[t + 2], tri[t + 1]] : [tri[t], tri[t + 1], tri[t + 2]];
    if (ys[a] - thick - gs[a] < 0.05 && ys[b] - thick - gs[b] < 0.05 && ys[c] - thick - gs[c] < 0.05) continue; // in the ground
    A.index.push(sb + a, sb + c, sb + b);
  }
  // ---- the fascia and the parapets round every ring
  let offset = 0;
  let parapetM = 0;
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    const m = ring.length / 2;
    const ccw = area2(ring) > 0;
    const outSign = (r === 0) === ccw ? 1 : -1;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      const ax = ring[2 * i], az = ring[2 * i + 1], bx = ring[2 * j], bz = ring[2 * j + 1];
      const ya = ys[offset + i], yb = ys[offset + j];
      const ca = ya - gs[offset + i], cb = yb - gs[offset + j];
      const dx = bx - ax, dz = bz - az;
      const l = Math.hypot(dx, dz) || 1;
      const nx = (dz / l) * outSign, nz = (-dx / l) * outSign; // outward normal
      if (ca > 0.15 || cb > 0.15) {
        const ba = Math.max(ya - thick, gs[offset + i]), bb = Math.max(yb - thick, gs[offset + j]);
        A.quad([ax, ba, az], [bx, bb, bz], [bx, yb, bz], [ax, ya, az], [nx, 0, nz], KIND.concrete);
      }
      if (ca > DECK.parapetMinClear && cb > DECK.parapetMinClear) {
        const h = DECK.parapet[kind];
        const w = kind === 'foot' ? 0.06 : DECK.parapetW;
        const ix = -nx * w, iz = -nz * w;
        const pk = kind === 'foot' ? KIND.metal : KIND.concrete;
        A.quad([ax, ya, az], [bx, yb, bz], [bx, yb + h, bz], [ax, ya + h, az], [nx, 0, nz], pk); // outer face
        A.quad([bx + ix, yb, bz + iz], [ax + ix, ya, az + iz], [ax + ix, ya + h, az + iz], [bx + ix, yb + h, bz + iz], [-nx, 0, -nz], pk);
        A.quad([ax, ya + h, az], [bx, yb + h, bz], [bx + ix, yb + h, bz + iz], [ax + ix, ya + h, az + iz], [0, 1, 0], pk); // cap
        parapetM += l;
      }
    }
    offset += m;
  }
  // ---- piers under the axes, from the ground (or the bed under the water) to the soffit
  let piers = 0;
  for (const a of deck.axes || []) {
    const p = a.pts;
    let run = 0;
    for (let i = 4; i < p.length; i += 4) {
      const ax = p[i - 4], az = p[i - 3], bx = p[i], bz = p[i + 1];
      const seg = Math.hypot(bx - ax, bz - az);
      run += seg;
      if (run < DECK.pierStep || i + 4 >= p.length) continue;
      run = 0;
      const y = Math.max(p[i + 2], p[i + 3]) + DECK.lift - thick;
      const g = p[i + 3];
      if (y - g < DECK.pierMinClear - thick) continue;
      const tx = (bx - ax) / (seg || 1), tz = (bz - az) / (seg || 1);
      const across = kind === 'foot' ? 0.5 : a.kind === 'rail' ? 2.0 : 2.5;
      pierBox(A, bx, bz, tx, tz, 0.6, across, g - 1.5, y);
      piers++;
    }
  }
  return { arrays: A, stats: { triangles: A.triangles, parapetM: Math.round(parapetM), piers } };
}

function pierBox(A, x, z, tx, tz, hl, hw, y0, y1) {
  const rx = -tz, rz = tx;
  const c = (sa, sw) => [x + tx * hl * sa + rx * hw * sw, z + tz * hl * sa + rz * hw * sw];
  const P = [c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)];
  const N = [[-rx, -rz], [tx, tz], [rx, rz], [-tx, -tz]];
  for (let k = 0; k < 4; k++) {
    const [ax, az] = P[k];
    const [bx, bz] = P[(k + 1) % 4];
    A.quad([ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az], [N[k][0], 0, N[k][1]], KIND.concrete);
  }
}

/**
 * One track: `pts` flat [x, z, y, ...] at the height it lies at (the terrain, or its deck; tools/geodata/city_structures.py). Needs no
 * terrain. Returns { arrays, stats }.
 */
export function buildTrackArrays(track) {
  const A = new Arrays();
  const p = track.pts;
  const pts = [];
  const np = p.length / 3;
  for (let i = 0; i + 1 < np; i++) {
    const ax = p[3 * i], az = p[3 * i + 1], ay = p[3 * i + 2], bx = p[3 * i + 3], bz = p[3 * i + 4], by = p[3 * i + 5];
    const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / TRACK.step));
    for (let j = 0; j < k; j++) pts.push([ax + ((bx - ax) * j) / k, az + ((bz - az) * j) / k, ay + ((by - ay) * j) / k]);
  }
  if (np) pts.push([p[3 * np - 3], p[3 * np - 2], p[3 * np - 1]]);
  if (pts.length < 2) return { arrays: A, stats: { triangles: 0, metres: 0 } };
  // per station: position, right vector, height, distance along
  const st = [];
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x, z, y] = pts[i];
    const [ax, az] = pts[Math.max(0, i - 1)];
    const [bx, bz] = pts[Math.min(pts.length - 1, i + 1)];
    const l = Math.hypot(bx - ax, bz - az) || 1;
    if (i) s += Math.hypot(x - pts[i - 1][0], z - pts[i - 1][1]);
    st.push({ x, z, rx: -(bz - az) / l, rz: (bx - ax) / l, y: y + (track.bridge ? DECK.lift : 0), s });
  }
  const bedY = TRACK.bedH;
  const disused = track.kind === 'disused';
  // ballast bed: foot - top - top - foot across, a strip of three faces along
  const prof = [[-TRACK.bedFoot, 0, KIND.ballast], [-TRACK.bedTop, bedY, KIND.ballast], [TRACK.bedTop, bedY, KIND.ballast], [TRACK.bedFoot, 0, KIND.ballast]];
  for (let f = 0; f < 3; f++) {
    const [u0, h0] = prof[f];
    const [u1, h1] = prof[f + 1];
    const du = u1 - u0, dh = h1 - h0;
    const ln = Math.hypot(du, dh) || 1;
    for (let i = 1; i < st.length; i++) {
      const a = st[i - 1], b = st[i];
      const pa0 = [a.x + a.rx * u0, a.y + h0 - 0.02, a.z + a.rz * u0], pa1 = [a.x + a.rx * u1, a.y + h1 - 0.02, a.z + a.rz * u1];
      const pb0 = [b.x + b.rx * u0, b.y + h0 - 0.02, b.z + b.rz * u0], pb1 = [b.x + b.rx * u1, b.y + h1 - 0.02, b.z + b.rz * u1];
      // the face normal: across-up in the section, turned into the world by the station's right vector
      const nu = -dh / ln, nh = du / ln;
      const n = [a.rx * nu, nh, a.rz * nu];
      // the top face carries the sleepers (along = metres, the shader paints them); the slopes are plain ballast (along < 0)
      const al = f === 1 ? [a.s, a.s, b.s, b.s] : [-1, -1, -1, -1];
      A.quad(pa1, pa0, pb0, pb1, n, KIND.ballast, al);
    }
  }
  // the rails: a head (top + two sides) each side of the gauge, on the sleepers
  const railY = bedY + TRACK.sleeperH;
  const half = TRACK.gauge / 2 + TRACK.railW / 2;
  for (const side of [-1, 1]) {
    for (const [o0, o1, nrm] of [[-TRACK.railW / 2, TRACK.railW / 2, 'top'], [-TRACK.railW / 2, -TRACK.railW / 2, 'in'], [TRACK.railW / 2, TRACK.railW / 2, 'out']]) {
      for (let i = 1; i < st.length; i++) {
        const a = st[i - 1], b = st[i];
        const c = side * half;
        const k = disused ? KIND.metal : KIND.steel;
        if (nrm === 'top') {
          const pa0 = [a.x + a.rx * (c + o0), a.y + railY + TRACK.railH, a.z + a.rz * (c + o0)];
          const pa1 = [a.x + a.rx * (c + o1), a.y + railY + TRACK.railH, a.z + a.rz * (c + o1)];
          const pb0 = [b.x + b.rx * (c + o0), b.y + railY + TRACK.railH, b.z + b.rz * (c + o0)];
          const pb1 = [b.x + b.rx * (c + o1), b.y + railY + TRACK.railH, b.z + b.rz * (c + o1)];
          A.quad(pa1, pa0, pb0, pb1, [0, 1, 0], k);
        } else {
          const sgn = nrm === 'in' ? -1 : 1;
          const pa0 = [a.x + a.rx * (c + o0), a.y + railY, a.z + a.rz * (c + o0)];
          const pa1 = [a.x + a.rx * (c + o0), a.y + railY + TRACK.railH, a.z + a.rz * (c + o0)];
          const pb0 = [b.x + b.rx * (c + o0), b.y + railY, b.z + b.rz * (c + o0)];
          const pb1 = [b.x + b.rx * (c + o0), b.y + railY + TRACK.railH, b.z + b.rz * (c + o0)];
          if (sgn > 0) A.quad(pa0, pb0, pb1, pa1, [a.rx, 0, a.rz], k);
          else A.quad(pb0, pa0, pa1, pb1, [-a.rx, 0, -a.rz], k);
        }
      }
    }
  }
  return { arrays: A, stats: { triangles: A.triangles, metres: Math.round(st[st.length - 1].s) } };
}
