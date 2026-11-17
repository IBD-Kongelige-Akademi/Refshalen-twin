import { isTypingInField } from './city-config.js';
import { GRID_CONVERGENCE_DEGREES } from './sun-position.js';

// js/overview-map.js
// Live radar minimap (bottom left) + full-screen interactive map ([M]) of the twin, ported from mrdoob's js/nyc-map.js (upstream).
// Both are drawn on a 2D canvas, grid north up (the twin's frame is the UTM 32N grid, 0.77° off true north at Aalborg), 1 unit =
// 1 m, from city-level data so the map is complete before any tile streams in: building footprints, water, parks and green ground
// from data/city/map.json (tools/geodata/city_map.py) and the streets with their names from the citywide road graph
// (data/city/roadgraph.json, which the engine already loads). The GPS route is a shortest path on that road graph (one-way streets
// respected when driving).

const FONT = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const MIN_ZOOM = 0.08; // full map, pixels per metre: the district and its surroundings
const MAX_ZOOM = 6.0; // single doors
const RADAR_SCALE = 0.9; // radar pixels per metre on the ground (zooms out with altitude)
const STREET_ZOOM = 1.6; // "street view around you"
const MAP_PAD_PAN = 600; // gamepad pan, screen pixels a second at full stick
const MAP_PAD_ZOOM = 3; // gamepad zoom, times a second at a full trigger
const ROUTE_EVERY_MS = 400; // the GPS route is recomputed at most this often, and only when the player has moved
const RADAR_EVERY_MS = 66; // the radar's moving parts are redrawn ~15 times a second; its ground layers come from a cache

// Map palette, shared by the radar & the full map (in step with css/style.css): graphite ground with the streets lighter than the
// blocks between them, muted parks & water; a blue GPS route (the HUD accent), white places & player, cyan search hits
const MAP = {
  void: '#0c0f13', // beyond the data
  land: '#171c22',
  water: '#0b1622',
  sea: '#0a1420',
  park: '#19301f',
  parkEdge: '#24432f',
  green: '#172a1d',
  buildings: ['#262c35', '#2e3540', '#3a4250'],
  buildingEdge: '#14181d',
  streets: {
    primary: '#5a6472',
    secondary: '#4c5563',
    residential: '#3d4652',
    service: '#323a45',
    cycleway: '#2f4a3c',
    footway: '#2b323b'
  },
  route: '#009df0', // Ramboll signature blue, the HUD accent
  search: '#5fd0ff',
  halo: 'rgba(8, 11, 15, 0.9)'
};
// street widths on the ground (m) and their minimum on screen (px)
const STREET_W = { primary: [14, 2.4], secondary: [11, 2], residential: [8, 1.4], service: [5, 1], cycleway: [2.6, 0.8], footway: [1.8, 0.6] };
const STREET_ORDER = ['footway', 'cycleway', 'service', 'residential', 'secondary', 'primary'];
const MAJOR = new Set(['primary', 'secondary']);
const DRIVABLE = new Set(['primary', 'secondary', 'residential', 'service']);

// ---------------------------------------------------------------------------------------------------------------------
// World-space vector layers: built once into Path2D objects (world metres) and drawn through a canvas transform
// ---------------------------------------------------------------------------------------------------------------------

function boundsOfFlat(r) {
  const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (let i = 0; i < r.length; i += 2) {
    if (r[i] < b.minX) b.minX = r[i];
    if (r[i] > b.maxX) b.maxX = r[i];
    if (r[i + 1] < b.minZ) b.minZ = r[i + 1];
    if (r[i + 1] > b.maxZ) b.maxZ = r[i + 1];
  }
  return b;
}

// Appends a closed flat ring [x0, z0, ...]; `cw` forces one winding (so overlapping rings union under nonzero) or the opposite (holes)
function addRing(path, r, hole = false) {
  const n = r.length >> 1;
  if (n < 3) return;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
  if ((a >= 0) !== hole) {
    path.moveTo(r[0], r[1]);
    for (let i = 1; i < n; i++) path.lineTo(r[2 * i], r[2 * i + 1]);
  } else {
    path.moveTo(r[2 * n - 2], r[2 * n - 1]);
    for (let i = n - 2; i >= 0; i--) path.lineTo(r[2 * i], r[2 * i + 1]);
  }
  path.closePath();
}

/**
 * A vector layer split into square tiles of Path2D, so a view only rasterizes the tiles it overlaps. Every item goes to the tile
 * holding its centre; a tile's bounds grow to cover its items.
 */
class TiledLayer {
  constructor(size = 250) {
    this.size = size;
    this.tiles = new Map();
  }

  pathFor(b) {
    const key = `${Math.floor((b.minX + b.maxX) * 0.5 / this.size)},${Math.floor((b.minZ + b.maxZ) * 0.5 / this.size)}`;
    let t = this.tiles.get(key);
    if (!t) {
      t = { path: new Path2D(), minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ };
      this.tiles.set(key, t);
    } else {
      t.minX = Math.min(t.minX, b.minX);
      t.maxX = Math.max(t.maxX, b.maxX);
      t.minZ = Math.min(t.minZ, b.minZ);
      t.maxZ = Math.max(t.maxZ, b.maxZ);
    }
    return t.path;
  }

  ring(r, holes) {
    if (!r || r.length < 6) return;
    const p = this.pathFor(boundsOfFlat(r));
    addRing(p, r);
    for (const h of holes || []) addRing(p, h, true);
  }

  segment(ax, az, bx, bz) {
    const p = this.pathFor({ minX: Math.min(ax, bx), maxX: Math.max(ax, bx), minZ: Math.min(az, bz), maxZ: Math.max(az, bz) });
    p.moveTo(ax, az);
    p.lineTo(bx, bz);
  }

  /** Calls fn(path) for every tile overlapping the view */
  each(v, fn) {
    for (const t of this.tiles.values()) {
      if (t.maxX < v.minX || t.minX > v.maxX || t.maxZ < v.minZ || t.minZ > v.maxZ) continue;
      fn(t.path);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The road graph: street chains for the labels and the search, shortest routes for the GPS
// ---------------------------------------------------------------------------------------------------------------------

// search key: lower case, æ ø å as typed on a non-Danish keyboard (ae, oe, aa), other accents dropped
const fold = (s) => String(s || '').toLowerCase().replace(/æ/g, 'ae').replace(/ø/g, 'oe').replace(/å/g, 'aa')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '');

/**
 * The named streets of the road graph as polylines: the links of one name chained end to end (a chain stops at a junction of
 * three or more of that name's links). Returns [{ name, cls, pts: [{x, z}, ...] }].
 */
function streetChains(graph) {
  const N = graph.nodes;
  const byName = new Map();
  for (let i = 0; i < graph.links.length; i++) {
    const l = graph.links[i];
    const name = graph.names[l[6]];
    if (!name || l[0] === l[1]) continue;
    if (!byName.has(l[6])) byName.set(l[6], []);
    byName.get(l[6]).push(i);
  }
  const out = [];
  for (const [nameIdx, ids] of byName) {
    const adj = new Map();
    const add = (n, id) => { if (!adj.has(n)) adj.set(n, []); adj.get(n).push(id); };
    for (const id of ids) {
      add(graph.links[id][0], id);
      add(graph.links[id][1], id);
    }
    const used = new Set();
    const walk = (start, first) => {
      const pts = [{ x: N[2 * start], z: N[2 * start + 1] }];
      let node = start;
      let id = first;
      let cls = graph.classes[graph.links[id][7]];
      while (id !== undefined && !used.has(id)) {
        used.add(id);
        const l = graph.links[id];
        if (MAJOR.has(graph.classes[l[7]])) cls = graph.classes[l[7]];
        node = l[0] === node ? l[1] : l[0];
        pts.push({ x: N[2 * node], z: N[2 * node + 1] });
        const next = adj.get(node);
        id = next.length === 2 ? next.find((k) => !used.has(k)) : undefined;
      }
      out.push({ name: graph.names[nameIdx], cls, pts });
    };
    // chains start at ends and junctions, then whatever is left (loops)
    for (const [n, list] of adj) if (list.length !== 2) for (const id of list) if (!used.has(id)) walk(n, id);
    for (const id of ids) if (!used.has(id)) walk(graph.links[id][0], id);
  }
  return out;
}

/** Street name labels: anchors every ~160 m along each straight run of a chain, in the run's direction (never upside down) */
function roadLabels(chains) {
  const byName = new Map();
  for (const c of chains) {
    const anchors = [];
    const pts = c.pts;
    for (let i = 0; i + 1 < pts.length;) {
      const a = pts[i];
      const dir = Math.atan2(pts[i + 1].z - a.z, pts[i + 1].x - a.x);
      let j = i + 1;
      while (j + 1 < pts.length) {
        let turn = Math.abs(Math.atan2(pts[j + 1].z - pts[j].z, pts[j + 1].x - pts[j].x) - dir);
        if (turn > Math.PI) turn = 2 * Math.PI - turn;
        if (turn > 0.14) break;
        j++;
      }
      const b = pts[j];
      i = j;
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 15) continue;
      let ang = Math.atan2(b.z - a.z, b.x - a.x);
      if (ang >= Math.PI * 0.5 - 0.01) ang -= Math.PI;
      else if (ang < -Math.PI * 0.5 - 0.01) ang += Math.PI;
      const k = Math.max(1, Math.round(len / 160));
      for (let m = 0; m < k; m++) {
        const t = (m + 0.5) / k;
        anchors.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, ang, len: len / k });
      }
    }
    let l = byName.get(c.name);
    if (!l) {
      l = { text: c.name, lower: fold(c.name), major: false, anchors: [], chains: [], minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
      byName.set(c.name, l);
    }
    l.major ||= MAJOR.has(c.cls);
    l.anchors.push(...anchors);
    l.chains.push(c.pts);
    for (const p of c.pts) {
      l.minX = Math.min(l.minX, p.x);
      l.maxX = Math.max(l.maxX, p.x);
      l.minZ = Math.min(l.minZ, p.z);
      l.maxZ = Math.max(l.maxZ, p.z);
    }
  }
  return [...byName.values()];
}

/**
 * Router over the road graph. `route(from, to, mode)` -> [{x, z}, ...] from `from` along the network to `to` (null when the two
 * are not connected): driving keeps to the carriageways and their one-way direction, walking and cycling use every link both ways.
 */
function createRouter(graph) {
  const N = graph.nodes;
  const n = N.length >> 1;
  const nets = {};
  const net = (drive) => {
    const key = drive ? 'drive' : 'walk';
    if (nets[key]) return nets[key];
    const head = new Int32Array(n).fill(-1);
    const next = [];
    const to = [];
    const cost = [];
    const used = new Uint8Array(n);
    const arc = (a, b, w) => {
      to.push(b);
      cost.push(w);
      next.push(head[a]);
      head[a] = to.length - 1;
      used[a] = used[b] = 1;
    };
    for (const l of graph.links) {
      if (l[0] === l[1]) continue;
      const cls = graph.classes[l[7]];
      if (drive && !DRIVABLE.has(cls)) continue;
      const w = Math.hypot(N[2 * l[1]] - N[2 * l[0]], N[2 * l[1] + 1] - N[2 * l[0] + 1]);
      const fwd = !drive || l[2] > 0 || l[3] === 0;
      const back = !drive || l[3] > 0 || l[2] === 0;
      if (fwd) arc(l[0], l[1], w);
      if (back) arc(l[1], l[0], w);
    }
    // nearest-node grid over the nodes this network uses
    const CELL = 50;
    const grid = new Map();
    for (let i = 0; i < n; i++) {
      if (!used[i]) continue;
      const k = `${Math.floor(N[2 * i] / CELL)},${Math.floor(N[2 * i + 1] / CELL)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    }
    const nearest = (x, z) => {
      const cx = Math.floor(x / CELL);
      const cz = Math.floor(z / CELL);
      let best = -1;
      let bd = Infinity;
      for (let r = 0; r <= 8 && (best < 0 || r <= 1 + bd / CELL); r++) {
        for (let ix = cx - r; ix <= cx + r; ix++) {
          for (let iz = cz - r; iz <= cz + r; iz++) {
            if (Math.max(Math.abs(ix - cx), Math.abs(iz - cz)) !== r) continue;
            for (const i of grid.get(`${ix},${iz}`) || []) {
              const d = Math.hypot(N[2 * i] - x, N[2 * i + 1] - z);
              if (d < bd) {
                bd = d;
                best = i;
              }
            }
          }
        }
      }
      return best;
    };
    nets[key] = { head, next, to, cost, nearest };
    return nets[key];
  };

  function route(from, to, mode = 'person') {
    const g = net(mode === 'car');
    const s = g.nearest(from.x, from.z);
    const t = g.nearest(to.x, to.z);
    if (s < 0 || t < 0) return null;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    // binary heap of [dist, node]
    const heap = [];
    const push = (d, v) => {
      heap.push([d, v]);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    dist[s] = 0;
    push(0, s);
    while (heap.length) {
      const [d, u] = pop();
      if (d > dist[u]) continue;
      if (u === t) break;
      for (let e = g.head[u]; e >= 0; e = g.next[e]) {
        const v = g.to[e];
        const nd = d + g.cost[e];
        if (nd < dist[v]) {
          dist[v] = nd;
          prev[v] = u;
          push(nd, v);
        }
      }
    }
    if (dist[t] === Infinity) return null;
    const path = [];
    for (let v = t; v >= 0; v = prev[v]) path.push({ x: N[2 * v], z: N[2 * v + 1] });
    path.reverse();
    return [{ x: from.x, z: from.z }, ...path, { x: to.x, z: to.z }];
  }

  return { route };
}

// ---------------------------------------------------------------------------------------------------------------------

/** A map viewport: centre (cx, cz) in world metres, s pixels per metre, w x h CSS pixels on a canvas of pixel ratio dpr */
class MapView {
  constructor(cx, cz, s, w, h, dpr = 1) {
    this.cx = cx;
    this.cz = cz;
    this.s = s;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.minX = cx - w / (2 * s);
    this.maxX = cx + w / (2 * s);
    this.minZ = cz - h / (2 * s);
    this.maxZ = cz + h / (2 * s);
  }

  /** Canvas transform for world metres */
  world(ctx) {
    const { s, dpr } = this;
    ctx.setTransform(s * dpr, 0, 0, s * dpr, dpr * (this.w * 0.5 - this.cx * s), dpr * (this.h * 0.5 - this.cz * s));
  }

  /** Canvas transform for CSS pixels from the canvas centre (what toX / toY return) */
  screen(ctx) {
    ctx.setTransform(this.dpr, 0, 0, this.dpr, this.dpr * this.w * 0.5, this.dpr * this.h * 0.5);
  }

  toX(x) {
    return (x - this.cx) * this.s;
  }

  toY(z) {
    return (z - this.cz) * this.s;
  }
}

// Player heading arrow at the (already rotated) origin: white, on a dark halo
function drawPlayerArrow(ctx, tipY, halfWidth, tailY) {
  ctx.beginPath();
  ctx.moveTo(0, tipY);
  ctx.lineTo(halfWidth, tailY);
  ctx.lineTo(0, tailY * 0.45);
  ctx.lineTo(-halfWidth, tailY);
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = MAP.halo;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

// GPS route along the road graph (screen points): yellow on a dark casing
function drawRoute(ctx, pts, width) {
  if (!pts || pts.length < 2) return;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.strokeStyle = MAP.halo;
  ctx.lineWidth = width + 3;
  ctx.stroke();
  ctx.strokeStyle = MAP.route;
  ctx.lineWidth = width;
  ctx.stroke();
}

// Waypoint: a yellow target
function drawWaypoint(ctx, x, y, r) {
  ctx.fillStyle = MAP.halo;
  ctx.beginPath();
  ctx.arc(x, y, r + 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = MAP.route;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = MAP.halo;
  ctx.beginPath();
  ctx.arc(x, y, r * 0.38, 0, Math.PI * 2);
  ctx.fill();
}

const overlaps = (boxes, b) => boxes.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);

class OverviewMap {
  /**
   * @param roadGraph  the citywide road graph ({ nodes, links, names, classes }) or null
   * @param places     { key: { name, sub, x, z, pin? } } (the teleports): white pins at `pin` (the building's centre) or else x, z, searchable
   * @param locate     (x, z) -> 'Aalborg · <street>' (world.locationLabel)
   * @param translate  English UI text -> the current language (js/i18n.js t)
   */
  constructor({ controllerManager, cameraSystem, trafficSystem = null, roadGraph = null, places = {}, locate = () => '', translate = (text) => text, onTeleport, onToggle }) {
    this.t = translate;
    this.controllerManager = controllerManager;
    this.cameraSystem = cameraSystem;
    this.trafficSystem = trafficSystem;
    this.onTeleport = onTeleport;
    this.onToggle = onToggle;
    this.locate = locate;
    this.places = Object.values(places).map((p) => ({ ...p, x: p.pin?.x ?? p.x, z: p.pin?.z ?? p.z, lower: fold(p.name) }));
    this.layers = null;
    this.mapLabels = [];
    this.bounds = null;
    this.version = 0;
    this.setRoadGraph(roadGraph);

    this.miniCanvas = document.getElementById('minimap-canvas');
    this.miniCtx = this.miniCanvas ? this.miniCanvas.getContext('2d') : null;
    this.miniScale = RADAR_SCALE;
    this.miniCache = null; // { canvas, cx, cz, s, version }: the radar's ground layers, twice the radar's size
    this.miniNext = 0;

    // The map is drawn grid north up; the compass needle points to true north, GRID_CONVERGENCE_DEGREES to its left
    const needle = document.getElementById('map-compass-needle');
    if (needle) needle.setAttribute('transform', `rotate(${-GRID_CONVERGENCE_DEGREES} 22 22)`);

    this.modal = document.getElementById('fullmap-modal');
    this.fullCanvas = document.getElementById('fullmap-canvas');
    this.fullCanvasWrap = document.getElementById('fullmap-canvas-wrap');
    this.fullCtx = this.fullCanvas ? this.fullCanvas.getContext('2d') : null;
    this.fullDpr = 1;
    this.fullStatic = null; // the full map's ground layers & labels for the current view
    this.fullStaticKey = '';
    this.elHoverInfo = document.getElementById('fullmap-hover-info');
    this.elPlayerInfo = document.getElementById('fullmap-player-info');
    this.elSearchInput = document.getElementById('fullmap-search');
    this.elCounts = document.getElementById('fullmap-counts');
    this.updateCounts();

    this.isFullMapOpen = false;
    // Full map viewport state (world metres; zoom in CSS pixels per metre)
    this.viewCenterX = 0;
    this.viewCenterZ = 0;
    this.viewZoom = 0.9;
    this.isPanning = false;
    this.panPointerId = null;
    this.panStart = { x: 0, y: 0, cx: 0, cz: 0, shift: false };
    this.dragMoved = false;

    this.hoverWorld = null;
    this.searchHighlight = '';
    this.searchPath = null;
    this.textWidths = new Map();
    this.waypoint = null; // { x, z, name }: the GPS target (shift-click, right-click or a search)
    this.route = null; // { pts, from: {x, z}, mode, at }
    this.lastRouteAt = -Infinity;

    // Street names measured before the web font arrived would be spaced for the fallback font: measure & draw again
    if (document.fonts) {
      document.fonts.ready.then(() => {
        this.textWidths.clear();
        this.miniCache = null;
        this.fullStaticKey = '';
      });
    }

    this.initEvents();
  }

  setRoadGraph(graph) {
    this.roadGraph = graph;
    this.roadLabels = graph ? roadLabels(streetChains(graph)) : [];
    this.router = graph ? createRouter(graph) : null;
    this.streets = null; // built with the first draw
    this.version++;
    this.updateCounts?.();
  }

  /** data/city/map.json (tools/geodata/city_map.py): footprints, water, parks, green ground and place labels */
  setData(doc) {
    if (!doc) return;
    const L = { water: new TiledLayer(), sea: new TiledLayer(), parks: new TiledLayer(), green: new TiledLayer(), buildings: [new TiledLayer(), new TiledLayer(), new TiledLayer()] };
    for (const w of doc.water || []) (w.sea ? L.sea : L.water).ring(w.r, w.holes);
    for (const p of doc.parks || []) L.parks.ring(p.r);
    for (const g of doc.green || []) L.green.ring(g.r);
    for (const b of doc.buildings || []) L.buildings[b.h > 20 ? 2 : b.h > 10 ? 1 : 0].ring(b.r);
    this.layers = L;
    this.buildingCount = (doc.buildings || []).length;
    this.mapLabels = (doc.labels || []).map((l) => ({ ...l, lower: fold(l.text) }));
    if (doc.bbox) this.bounds = { minX: doc.bbox[0], minZ: doc.bbox[1], maxX: doc.bbox[2], maxZ: doc.bbox[3] };
    this.version++;
    this.miniCache = null;
    this.fullStaticKey = '';
    this.updateCounts();
  }

  updateCounts() {
    if (!this.elCounts) return;
    const parts = [`${this.roadLabels.length} ${this.t('streets')}`];
    if (this.buildingCount) parts.push(`${this.buildingCount.toLocaleString('en-US')} ${this.t('buildings')}`);
    this.elCounts.textContent = parts.join(' · ');
    if (this.elSearchInput) this.elSearchInput.placeholder = `${this.t('Search')} ${this.roadLabels.length} ${this.t('streets & places…')}`;
  }

  /** The language changed (js/main.js): the counts and search hint now, the "You are at" line on the next draw */
  refreshLanguage() {
    this.updateCounts();
    this.playerInfoText = '';
    if (this.isFullMapOpen) this.renderFullMap();
  }

  streetLayers() {
    if (this.streets || !this.roadGraph) return this.streets;
    const g = this.roadGraph;
    const N = g.nodes;
    const layers = Object.fromEntries(STREET_ORDER.map((c) => [c, new TiledLayer()]));
    for (const l of g.links) {
      const layer = layers[g.classes[l[7]]];
      if (layer && l[0] !== l[1]) layer.segment(N[2 * l[0]], N[2 * l[0] + 1], N[2 * l[1]], N[2 * l[1] + 1]);
    }
    this.streets = layers;
    return layers;
  }

  initEvents() {
    const on = (id, type, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener(type, fn);
    };
    on('minimap-card', 'click', () => this.toggleFullMap(true));
    on('close-fullmap-btn', 'click', () => this.toggleFullMap(false));
    on('map-zoom-in', 'click', () => {
      this.viewZoom = Math.min(MAX_ZOOM, this.viewZoom * 1.45);
      this.renderFullMap();
    });
    on('map-zoom-out', 'click', () => {
      this.viewZoom = Math.max(MIN_ZOOM, this.viewZoom / 1.45);
      this.renderFullMap();
    });
    on('map-center-player', 'click', () => {
      const ent = this.controllerManager.getActiveEntity();
      this.viewCenterX = ent.position.x;
      this.viewCenterZ = ent.position.z;
      this.viewZoom = STREET_ZOOM;
      this.renderFullMap();
    });
    on('map-view-all', 'click', () => this.fitAll());

    if (this.elSearchInput) {
      this.elSearchInput.addEventListener('input', () => this.search(this.elSearchInput.value));
      this.elSearchInput.addEventListener('keydown', (e) => {
        if (e.code === 'Enter' && this.searchHit) this.setWaypoint(this.searchHit.x, this.searchHit.z, this.searchHit.name);
      });
    }

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.isFullMapOpen) {
        this.toggleFullMap(false);
      } else if (e.code === 'KeyM' && !isTypingInField(e)) {
        this.toggleFullMap(!this.isFullMapOpen);
      }
    });

    if (!this.fullCanvas) return;
    this.fullCanvas.style.touchAction = 'none';
    this.fullCanvas.addEventListener('pointerdown', (e) => {
      this.setPadCursor(false);
      if (e.button !== 0 || !this.isFullMapOpen || this.panPointerId !== null) return;
      e.preventDefault();
      this.panPointerId = e.pointerId;
      this.fullCanvas.setPointerCapture(e.pointerId);
      this.isPanning = true;
      this.dragMoved = false;
      this.panStart.x = e.clientX;
      this.panStart.y = e.clientY;
      this.panStart.cx = this.viewCenterX;
      this.panStart.cz = this.viewCenterZ;
      this.panStart.shift = !!e.shiftKey;
      if (this.fullCanvasWrap) this.fullCanvasWrap.classList.add('is-panning');
    });

    this.fullCanvas.addEventListener('pointermove', (e) => {
      if (!this.isFullMapOpen || !this.fullCanvas) return;
      if (this.isPanning ? e.pointerId !== this.panPointerId : e.pointerType !== 'mouse') return;
      const rect = this.fullCanvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      if (this.isPanning) {
        e.preventDefault();
        const dx = e.clientX - this.panStart.x;
        const dy = e.clientY - this.panStart.y;
        if (Math.hypot(dx, dy) > 5) this.dragMoved = true;
        this.viewCenterX = this.panStart.cx - dx / this.viewZoom;
        this.viewCenterZ = this.panStart.cz - dy / this.viewZoom;
        this.renderFullMap();
        return;
      }
      if (mx >= 0 && mx <= rect.width && my >= 0 && my <= rect.height) {
        const wPos = this.screenToWorld(mx, my, rect.width, rect.height);
        this.hoverWorld = wPos;
        if (this.elHoverInfo) this.elHoverInfo.textContent = `${this.placeName(wPos.x, wPos.z)} · ${this.t('Click to teleport · Shift-click to route')}`;
      }
    });

    this.fullCanvas.addEventListener('pointerup', (e) => {
      if (e.pointerId !== this.panPointerId) return;
      const clicked = !this.dragMoved && Math.hypot(e.clientX - this.panStart.x, e.clientY - this.panStart.y) <= 5;
      const shift = this.panStart.shift || !!e.shiftKey;
      this.cancelPan();
      if (!clicked || !this.isFullMapOpen || !this.fullCanvas) return;
      const rect = this.fullCanvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      if (mx < 0 || mx > rect.width || my < 0 || my > rect.height) return;
      const wPos = this.clampToData(this.screenToWorld(mx, my, rect.width, rect.height));
      if (shift) {
        this.setWaypoint(wPos.x, wPos.z);
        return;
      }
      if (this.onTeleport) this.onTeleport(wPos.x, wPos.z);
      this.renderFullMap();
    });
    // right-click: route there without teleporting
    this.fullCanvas.addEventListener('contextmenu', (e) => {
      if (!this.isFullMapOpen) return;
      e.preventDefault?.();
      const rect = this.fullCanvas.getBoundingClientRect();
      const wPos = this.clampToData(this.screenToWorld(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height));
      this.setWaypoint(wPos.x, wPos.z);
    });
    for (const type of ['pointercancel', 'lostpointercapture']) {
      this.fullCanvas.addEventListener(type, (e) => {
        if (e.pointerId === this.panPointerId) this.cancelPan();
      });
    }
    window.addEventListener('blur', () => this.cancelPan());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.cancelPan();
    });

    // Wheel zoom about the cursor (the place under it stays put)
    this.fullCanvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = this.fullCanvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const before = this.screenToWorld(mx, my, rect.width, rect.height);
      const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
      this.viewZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.viewZoom * factor));
      this.viewCenterX = before.x - (mx - rect.width * 0.5) / this.viewZoom;
      this.viewCenterZ = before.z - (my - rect.height * 0.5) / this.viewZoom;
      this.renderFullMap();
    }, { passive: false });
  }

  placeName(x, z) {
    const label = this.locate(x, z) || '';
    const i = label.indexOf(' · ');
    return i >= 0 ? label.slice(i + 3) : label || 'Aalborg';
  }

  /** The gamepad's crosshair at the centre of the full map (a mouse press hides it again) */
  setPadCursor(on) {
    if (this.padCursor === Boolean(on)) return;
    this.padCursor = Boolean(on);
    this.fullCanvasWrap?.classList.toggle('pad-cursor', this.padCursor);
  }

  /** The place under the crosshair, inside the map's extent */
  centerWorld() {
    return this.clampToData({ x: this.viewCenterX, z: this.viewCenterZ });
  }

  /**
   * Gamepad on the full map: the stick pans (`panX`, `panY` in -1..1, MAP_PAD_PAN screen pixels a second at full tilt, so the same
   * on-screen speed at any zoom) and `zoom` (-1..1) zooms about the centre, MAP_PAD_ZOOM times a second at full press. The crosshair
   * shows from the first pad input; the hover line names the place under it.
   */
  gamepadInput(panX, panY, zoom, dt) {
    if (!this.isFullMapOpen || !(dt > 0)) return;
    if (!panX && !panY && !zoom) return;
    this.setPadCursor(true);
    this.viewCenterX += (panX * MAP_PAD_PAN * dt) / this.viewZoom;
    this.viewCenterZ += (panY * MAP_PAD_PAN * dt) / this.viewZoom;
    if (zoom) this.viewZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.viewZoom * MAP_PAD_ZOOM ** (zoom * dt)));
    const b = this.bounds;
    if (b) {
      this.viewCenterX = Math.max(b.minX, Math.min(b.maxX, this.viewCenterX));
      this.viewCenterZ = Math.max(b.minZ, Math.min(b.maxZ, this.viewCenterZ));
    }
    const p = this.centerWorld();
    if (this.elHoverInfo) this.elHoverInfo.textContent = `${this.placeName(p.x, p.z)} · ${this.t('A to teleport · X to route')}`;
    this.renderFullMap();
  }

  teleportToCenter() {
    if (!this.isFullMapOpen) return;
    const p = this.centerWorld();
    this.onTeleport?.(p.x, p.z);
    this.renderFullMap();
  }

  waypointAtCenter() {
    if (!this.isFullMapOpen) return;
    const p = this.centerWorld();
    this.setWaypoint(p.x, p.z);
  }

  setWaypoint(x, z, name = this.placeName(x, z)) {
    this.waypoint = { x, z, name };
    this.route = null;
    this.lastRouteAt = -Infinity;
    this.renderFullMap();
  }

  clearWaypoint() {
    this.waypoint = null;
    this.route = null;
  }

  /** The GPS route from the player to the waypoint along the road graph; recomputed when the player has moved or the mode changed */
  currentRoute(px, pz, now = performance.now()) {
    if (!this.waypoint) return null;
    const active = this.controllerManager.activeMode;
    const mode = active === 'car' || active === 'bus' ? 'car' : 'person';
    const r = this.route;
    const stale = !r || r.mode !== mode || Math.hypot(px - r.from.x, pz - r.from.z) > 15;
    if (stale && now - this.lastRouteAt >= ROUTE_EVERY_MS) {
      this.lastRouteAt = now;
      const pts = this.router ? this.router.route({ x: px, z: pz }, this.waypoint, mode) : null;
      this.route = { pts: pts || [{ x: px, z: pz }, { x: this.waypoint.x, z: this.waypoint.z }], from: { x: px, z: pz }, mode };
    }
    return this.route ? this.route.pts : null;
  }

  /**
   * Street / place search: highlights every stretch of the matching streets and frames them (or flies to the matching place).
   * The best hit is remembered (`searchHit`); Enter routes there.
   */
  search(text) {
    const q = fold(String(text || '').trim());
    this.searchHighlight = q;
    this.searchPath = null;
    this.searchHit = null;
    if (q.length > 0) {
      const place = this.places.find((p) => p.lower.includes(q)) || this.mapLabels.find((l) => l.lower.includes(q));
      const exact = this.roadLabels.filter((l) => l.lower === q);
      const roads = exact.length ? exact : this.roadLabels.filter((l) => l.lower.includes(q));
      if (roads.length) {
        this.searchPath = new Path2D();
        const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
        for (const l of roads) {
          for (const pts of l.chains) {
            this.searchPath.moveTo(pts[0].x, pts[0].z);
            for (let i = 1; i < pts.length; i++) this.searchPath.lineTo(pts[i].x, pts[i].z);
          }
          b.minX = Math.min(b.minX, l.minX);
          b.maxX = Math.max(b.maxX, l.maxX);
          b.minZ = Math.min(b.minZ, l.minZ);
          b.maxZ = Math.max(b.maxZ, l.maxZ);
        }
        this.searchBounds = b;
      }
      if (place) {
        this.viewCenterX = place.x;
        this.viewCenterZ = place.z;
        this.viewZoom = Math.max(this.viewZoom, STREET_ZOOM * 0.75);
        this.searchHit = { x: place.x, z: place.z, name: place.name || place.text };
      } else if (roads.length) {
        const b = this.searchBounds;
        const { w, h } = this.fullSize();
        this.viewCenterX = (b.minX + b.maxX) * 0.5;
        this.viewCenterZ = (b.minZ + b.maxZ) * 0.5;
        const fit = Math.min(w / ((b.maxX - b.minX) * 1.3 + 1), h / ((b.maxZ - b.minZ) * 1.3 + 1));
        this.viewZoom = Math.max(MIN_ZOOM, Math.min(STREET_ZOOM * 1.5, fit));
        // the waypoint for Enter: the street's anchor nearest the middle of its extent
        const mid = roads[0].anchors.reduce((best, a) => {
          const d = Math.hypot(a.x - this.viewCenterX, a.z - this.viewCenterZ);
          return !best || d < best.d ? { d, a } : best;
        }, null);
        if (mid) this.searchHit = { x: mid.a.x, z: mid.a.z, name: roads[0].text };
      }
    }
    this.renderFullMap();
  }

  fitAll() {
    const b = this.bounds || { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000 };
    const { w, h } = this.fullSize();
    this.viewCenterX = (b.minX + b.maxX) * 0.5;
    this.viewCenterZ = (b.minZ + b.maxZ) * 0.5;
    this.viewZoom = Math.max(MIN_ZOOM, Math.min(w / ((b.maxX - b.minX) * 1.08), h / ((b.maxZ - b.minZ) * 1.08)));
    this.renderFullMap();
  }

  cancelPan() {
    const id = this.panPointerId;
    this.panPointerId = null;
    this.isPanning = false;
    if (this.fullCanvasWrap) this.fullCanvasWrap.classList.remove('is-panning');
    if (id !== null && this.fullCanvas && this.fullCanvas.hasPointerCapture(id)) this.fullCanvas.releasePointerCapture(id);
  }

  toggleFullMap(open) {
    this.isFullMapOpen = Boolean(open);
    if (!this.isFullMapOpen) {
      this.cancelPan();
      this.setPadCursor(false);
    }
    if (this.onToggle) this.onToggle(this.isFullMapOpen);
    if (!this.modal) return;
    this.modal.classList.toggle('hidden', !this.isFullMapOpen);
    if (this.isFullMapOpen) {
      // the HUD's popovers live in the top layer, above the map
      for (const pop of document.querySelectorAll('.popover[popover]')) {
        if (typeof pop.hidePopover === 'function' && pop.matches(':popover-open')) pop.hidePopover();
      }
      const ent = this.controllerManager.getActiveEntity();
      this.viewCenterX = ent.position.x;
      this.viewCenterZ = ent.position.z;
      this.resizeFullCanvas();
      this.renderFullMap();
    }
  }

  resizeFullCanvas() {
    if (!this.fullCanvas) return;
    // Layout size (the opening animation's transforms don't change it), at most ~6 megapixels however large the screen
    const w = this.fullCanvas.clientWidth || window.innerWidth;
    const h = this.fullCanvas.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(6e6 / Math.max(1, w * h)));
    this.fullDpr = dpr;
    this.fullCanvas.width = Math.max(1, Math.floor(w * dpr));
    this.fullCanvas.height = Math.max(1, Math.floor(h * dpr));
  }

  // Full map size in CSS pixels
  fullSize() {
    const dpr = this.fullDpr || 1;
    if (!this.fullCanvas || !this.fullCanvas.width) return { w: 1200, h: 800 };
    return { w: this.fullCanvas.width / dpr, h: this.fullCanvas.height / dpr };
  }

  screenToWorld(sx, sy, width, height) {
    return {
      x: this.viewCenterX + (sx - width * 0.5) / this.viewZoom,
      z: this.viewCenterZ + (sy - height * 0.5) / this.viewZoom
    };
  }

  // Teleports land where the twin has data: inside the map's extent
  clampToData(p) {
    const b = this.bounds;
    if (!b) return p;
    return { x: Math.max(b.minX + 15, Math.min(b.maxX - 15, p.x)), z: Math.max(b.minZ + 15, Math.min(b.maxZ - 15, p.z)) };
  }

  textWidth(ctx, text) {
    const key = `${ctx.font}|${ctx.letterSpacing || ''}|${text}`;
    let w = this.textWidths.get(key);
    if (w === undefined) {
      w = ctx.measureText(text).width;
      this.textWidths.set(key, w);
    }
    return w;
  }

  /** The ground: land, green ground, parks, water, buildings, streets and the search highlight (world transform of view v) */
  drawWorld(ctx, v, isMinimap) {
    const s = v.s;
    const px = (n) => n / s; // screen pixels -> metres (line widths)
    v.world(ctx);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const b = this.bounds;
    if (b) {
      ctx.fillStyle = MAP.land;
      ctx.fillRect(b.minX, b.minZ, b.maxX - b.minX, b.maxZ - b.minZ);
    }
    const L = this.layers;
    if (L) {
      ctx.fillStyle = MAP.green;
      L.green.each(v, (p) => ctx.fill(p));
      ctx.fillStyle = MAP.park;
      L.parks.each(v, (p) => ctx.fill(p));
      if (!isMinimap && s >= 0.3) {
        ctx.strokeStyle = MAP.parkEdge;
        ctx.lineWidth = px(1);
        L.parks.each(v, (p) => ctx.stroke(p));
      }
      // (no outline: the water pieces are cut at the 500 m tile edges, which an outline would draw across the fjord)
      ctx.fillStyle = MAP.sea;
      L.sea.each(v, (p) => ctx.fill(p));
      ctx.fillStyle = MAP.water;
      L.water.each(v, (p) => ctx.fill(p));
    }

    // streets, minor first; at low zoom only the main roads
    const streets = this.streetLayers();
    if (streets) {
      for (const cls of STREET_ORDER) {
        if (s < 0.25 && !MAJOR.has(cls)) continue;
        if (s < 0.6 && (cls === 'footway' || cls === 'cycleway')) continue;
        const [m, minPx] = STREET_W[cls];
        ctx.strokeStyle = MAP.streets[cls];
        ctx.lineWidth = Math.max(px(minPx), m);
        streets[cls].each(v, (p) => ctx.stroke(p));
      }
    }

    // building footprints over the streets' casing, lowest first
    if (L && s >= 0.3) {
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = MAP.buildings[i];
        L.buildings[i].each(v, (p) => ctx.fill(p));
      }
      if (s >= 1.2) {
        ctx.strokeStyle = MAP.buildingEdge;
        ctx.lineWidth = px(0.8);
        for (let i = 0; i < 3; i++) L.buildings[i].each(v, (p) => ctx.stroke(p));
      }
    }

    // search highlight: every stretch of the matching streets
    if (this.searchPath && !isMinimap) {
      ctx.strokeStyle = MAP.search;
      ctx.lineWidth = Math.max(px(3), 9);
      ctx.stroke(this.searchPath);
    }
  }

  /**
   * Street names along the streets (screen transform of view v): the best anchor of each street that fits its name, one label per
   * street per `sameNameGap` pixels, none overlapping another (or the boxes already in `placed`)
   */
  drawRoadLabels(ctx, v, { fontPx = 10, maxLabels = 400, sameNameGap = 260, placed = [], majorOnly = false } = {}) {
    const s = v.s;
    const q = this.searchHighlight;
    ctx.font = `600 ${fontPx}px ${FONT}`;
    const inset = (fontPx * 2.5) / s;
    const minX = v.minX + inset;
    const maxX = v.maxX - inset;
    const minZ = v.minZ + inset;
    const maxZ = v.maxZ - inset;
    const cands = [];
    for (const l of this.roadLabels) {
      if (l.maxX < minX || l.minX > maxX || l.maxZ < minZ || l.minZ > maxZ) continue;
      const hit = q.length > 0 && l.lower.includes(q);
      if (majorOnly && !l.major && !hit) continue;
      const width = this.textWidth(ctx, l.text);
      const need = (width + 14) / s;
      for (const a of l.anchors) {
        if (a.len < need || a.x < minX || a.x > maxX || a.z < minZ || a.z > maxZ) continue;
        const d = Math.hypot(a.x - v.cx, a.z - v.cz) * s;
        cands.push({ l, a, width, hit, score: (hit ? 1e6 : 0) + (l.major ? 2000 : 0) + Math.min(a.len * s, 400) - d * 0.5 });
      }
    }
    cands.sort((a, b) => b.score - a.score);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = MAP.halo;
    const byName = new Map();
    let n = 0;
    for (const c of cands) {
      if (n >= maxLabels) break;
      const X = v.toX(c.a.x);
      const Y = v.toY(c.a.z);
      const same = byName.get(c.l.text);
      if (same && same.some(([x, y]) => Math.hypot(x - X, y - Y) < sameNameGap)) continue;
      const hw = c.width * 0.5 + 3;
      const hh = fontPx * 0.5 + 2;
      const ca = Math.abs(Math.cos(c.a.ang));
      const sa = Math.abs(Math.sin(c.a.ang));
      const bx = hw * ca + hh * sa;
      const by = hw * sa + hh * ca;
      const box = [X - bx, Y - by, X + bx, Y + by];
      if (overlaps(placed, box)) continue;
      placed.push(box);
      if (same) same.push([X, Y]);
      else byName.set(c.l.text, [[X, Y]]);
      ctx.save();
      ctx.translate(X, Y);
      ctx.rotate(c.a.ang);
      ctx.fillStyle = c.hit ? MAP.search : c.l.major ? '#e8ebf0' : '#9ba5b3';
      ctx.strokeText(c.l.text, 0, 0);
      ctx.fillText(c.l.text, 0, 0);
      ctx.restore();
      n++;
    }
    ctx.textBaseline = 'alphabetic';
  }

  update(now = performance.now()) {
    // The full map covers the whole screen, radar included
    if (this.isFullMapOpen) this.renderFullMap(now);
    else if (now >= this.miniNext) {
      this.miniNext = now + RADAR_EVERY_MS;
      this.renderMinimap(now);
    }
  }

  // =========================================================================
  // 1. LIVE RADAR MINIMAP (BOTTOM-LEFT HUD)
  // =========================================================================
  renderMinimap(now = performance.now()) {
    if (!this.miniCtx || !this.miniCanvas) return;
    // Nothing to draw while the radar is hidden (narrow screens, clean view)
    if (!this.miniCanvas.offsetParent || document.body.classList.contains('hud-minimized')) return;
    const ctx = this.miniCtx;
    const w = this.miniCanvas.clientWidth;
    const h = this.miniCanvas.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (this.miniCanvas.width !== bw || this.miniCanvas.height !== bh) {
      this.miniCanvas.width = bw;
      this.miniCanvas.height = bh;
      this.miniCache = null;
    }

    const ent = this.controllerManager.getActiveEntity();
    const px = ent.position.x;
    const pz = ent.position.z;
    // Ground-level radar shows ~300 m of the city; it zooms out as the player climbs (drone)
    const target = Math.max(0.12, RADAR_SCALE / (1 + Math.max(0, ent.position.y - 20) / 60));
    this.miniScale += (target - this.miniScale) * 0.25;
    const scale = this.miniScale;

    // Ground layers & street names come from a cached render twice the radar's size, redrawn when the player nears its edge,
    // the zoom drifts or the data arrives
    let c = this.miniCache;
    if (!c || c.version !== this.version || Math.abs(scale / c.s - 1) > 0.12 ||
      Math.abs(px - c.cx) > w / c.s - w / (2 * scale) - 8 / scale ||
      Math.abs(pz - c.cz) > h / c.s - h / (2 * scale) - 8 / scale) {
      if (!c) {
        c = this.miniCache = { canvas: document.createElement('canvas') };
        c.canvas.width = bw * 2;
        c.canvas.height = bh * 2;
        c.ctx = c.canvas.getContext('2d');
      }
      c.cx = px;
      c.cz = pz;
      c.s = scale;
      c.version = this.version;
      c.ctx.setTransform(1, 0, 0, 1, 0, 0);
      c.ctx.fillStyle = MAP.void;
      c.ctx.fillRect(0, 0, bw * 2, bh * 2);
      const cv = new MapView(px, pz, scale, w * 2, h * 2, dpr);
      this.drawWorld(c.ctx, cv, true);
      cv.screen(c.ctx);
      this.drawRoadLabels(c.ctx, cv, { fontPx: 9.5, maxLabels: 28, sameNameGap: 180 });
    }

    const v = new MapView(px, pz, scale, w, h, dpr);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = MAP.void;
    ctx.fillRect(0, 0, bw, bh);
    const k = scale / c.s;
    ctx.drawImage(c.canvas, dpr * ((c.cx - w / c.s - px) * scale + w * 0.5), dpr * ((c.cz - h / c.s - pz) * scale + h * 0.5),
      dpr * w * 2 * k, dpr * h * 2 * k);

    v.screen(ctx);
    const toX = (wx) => v.toX(wx);
    const toY = (wz) => v.toY(wz);

    // Live traffic blips
    const cars = this.trafficSystem?.cars;
    if (cars && cars.length) {
      ctx.fillStyle = 'rgba(226, 232, 240, 0.34)';
      for (let i = 0; i < cars.length; i += 2) {
        const car = cars[i];
        const p = car.position || car;
        const cx = toX(p.x);
        const cy = toY(p.z);
        if (Math.abs(cx) < w * 0.5 && Math.abs(cy) < h * 0.5) ctx.fillRect(cx - 1, cy - 1, 2, 2);
      }
    }

    // GPS route to the waypoint
    const route = this.currentRoute(px, pz, now);
    if (route) {
      drawRoute(ctx, route.map((p) => [toX(p.x), toY(p.z)]), 3);
      drawWaypoint(ctx, toX(this.waypoint.x), toY(this.waypoint.z), 4.5);
    }

    // Place blips
    for (const lm of this.places) {
      const lx = toX(lm.x);
      const ly = toY(lm.z);
      if (Math.abs(lx) < w * 0.48 && Math.abs(ly) < h * 0.48) {
        ctx.fillStyle = MAP.halo;
        ctx.beginPath();
        ctx.arc(lx, ly, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(lx, ly, 2.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Camera view cone & player arrow at the centre
    const cam = this.cameraSystem;
    if (cam?.currentLookAt && cam.currentPos) {
      const camAngle = Math.atan2(cam.currentLookAt.x - cam.currentPos.x, cam.currentLookAt.z - cam.currentPos.z);
      ctx.save();
      ctx.rotate(-camAngle + Math.PI);
      const grad = ctx.createRadialGradient(0, 0, 2, 0, 0, 58);
      grad.addColorStop(0, 'rgba(255, 255, 255, 0.3)');
      grad.addColorStop(1, 'rgba(255, 255, 255, 0.0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, 58, -Math.PI * 0.72, -Math.PI * 0.28);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.save();
    ctx.rotate(-(ent.heading || 0) + Math.PI);
    drawPlayerArrow(ctx, -9, 6.5, 7);
    ctx.restore();
    ctx.restore();
  }

  // =========================================================================
  // 2. FULL-SCREEN INTERACTIVE MAP ([M])
  // =========================================================================
  renderFullMap(now = performance.now()) {
    if (!this.fullCtx || !this.fullCanvas || !this.isFullMapOpen) return;
    const ctx = this.fullCtx;
    const dpr = this.fullDpr || 1;
    const { w, h } = this.fullSize();
    const v = new MapView(this.viewCenterX, this.viewCenterZ, this.viewZoom, w, h, dpr);

    const ent = this.controllerManager.getActiveEntity();
    if (this.elPlayerInfo) {
      const text = `${this.t('You are at')} ${this.placeName(ent.position.x, ent.position.z)}`;
      if (text !== this.playerInfoText) {
        this.playerInfoText = text;
        this.elPlayerInfo.textContent = text;
      }
    }

    // Ground layers, names & place pins: re-rendered only when the view, the search or the data change
    const key = `${v.cx}|${v.cz}|${v.s}|${this.fullCanvas.width}|${this.fullCanvas.height}|${this.searchHighlight}|${this.version}`;
    if (!this.fullStatic) this.fullStatic = document.createElement('canvas');
    if (key !== this.fullStaticKey) {
      this.fullStaticKey = key;
      const sc = this.fullStatic;
      if (sc.width !== this.fullCanvas.width || sc.height !== this.fullCanvas.height) {
        sc.width = this.fullCanvas.width;
        sc.height = this.fullCanvas.height;
      }
      this.renderFullMapStatic(sc.getContext('2d'), v);
    }

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.fullStatic, 0, 0);
    v.screen(ctx);
    const toX = (wx) => v.toX(wx);
    const toY = (wz) => v.toY(wz);

    const route = this.currentRoute(ent.position.x, ent.position.z, now);
    if (route) {
      drawRoute(ctx, route.map((p) => [toX(p.x), toY(p.z)]), 4);
      drawWaypoint(ctx, toX(this.waypoint.x), toY(this.waypoint.z), 7);
    }

    // Player blip & heading arrow, with a slow pulse to find it at a glance
    ctx.save();
    ctx.translate(toX(ent.position.x), toY(ent.position.z));
    const pulse = (now % 1800) / 1800;
    ctx.fillStyle = `rgba(255, 255, 255, ${0.24 * (1 - pulse)})`;
    ctx.beginPath();
    ctx.arc(0, 0, 10 + pulse * 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.beginPath();
    ctx.arc(0, 0, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(-(ent.heading || 0) + Math.PI);
    drawPlayerArrow(ctx, -11, 7.5, 8);
    ctx.restore();
    ctx.restore();
  }

  renderFullMapStatic(ctx, v) {
    const { w, h, s } = v;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = MAP.void;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    this.drawWorld(ctx, v, false);

    v.screen(ctx);
    const toX = (wx) => v.toX(wx);
    const toY = (wz) => v.toY(wz);

    // Place pins & labels (placed first: their boxes keep the other names clear)
    ctx.font = `700 11px ${FONT}`;
    const placed = [];
    const pins = [];
    for (const lm of this.places) {
      const lx = toX(lm.x);
      const ly = toY(lm.z);
      if (Math.abs(lx) > w * 0.48 || Math.abs(ly) > h * 0.48) continue;
      const labelW = this.textWidth(ctx, lm.name) + 6;
      const box = [lx + 6, ly - 8, lx + 8 + labelW, ly + 7];
      const showLabel = !overlaps(placed, box);
      placed.push([lx - 6, ly - 6, lx + 6, ly + 6]);
      if (showLabel) placed.push(box);
      pins.push({ lm, lx, ly, showLabel });
    }

    // Water and park names, letter-spaced like a printed atlas (wherever they fit)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tracking = 'letterSpacing' in ctx;
    for (const l of this.mapLabels) {
      const water = l.kind === 'water';
      if (!water && (s < 0.25 || l.area_m2 * s * s < 2500)) continue;
      const dx = toX(l.x);
      const dy = toY(l.z);
      if (Math.abs(dx) > w * 0.47 || Math.abs(dy) > h * 0.47) continue;
      ctx.font = water ? `italic 500 ${s < 0.4 ? 13 : 12}px ${FONT}` : `700 10px ${FONT}`;
      ctx.fillStyle = water ? 'rgba(112, 168, 214, 0.62)' : 'rgba(150, 196, 160, 0.62)';
      if (tracking) ctx.letterSpacing = water ? '2px' : '1.4px';
      const text = water ? l.text.toUpperCase() : l.text;
      const half = this.textWidth(ctx, text) * 0.5 + 4;
      const box = [dx - half, dy - 8, dx + half, dy + 8];
      if (overlaps(placed, box)) continue;
      placed.push(box);
      ctx.fillText(text, dx, dy);
    }
    if (tracking) ctx.letterSpacing = '0px';
    ctx.textBaseline = 'alphabetic';

    // Street names along their course (collision-free at all zoom levels)
    const fontPx = Math.max(9, Math.min(12, Math.round(9.5 * Math.sqrt(Math.max(s, 0.4)))));
    this.drawRoadLabels(ctx, v, { fontPx, maxLabels: 420, sameNameGap: 300, placed, majorOnly: s < 0.5 });

    ctx.font = `700 11px ${FONT}`;
    ctx.textAlign = 'left';
    for (const { lm, lx, ly, showLabel } of pins) {
      ctx.fillStyle = MAP.halo;
      ctx.beginPath();
      ctx.arc(lx, ly, 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(lx, ly, 4.2, 0, Math.PI * 2);
      ctx.fill();
      if (showLabel) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = MAP.halo;
        ctx.strokeText(lm.name, lx + 9, ly + 4);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(lm.name, lx + 9, ly + 4);
      }
    }

    this.drawScaleBar(ctx, v);
    ctx.restore();
  }

  drawScaleBar(ctx, v) {
    const target = 120 / v.s; // metres in ~120 px
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    const step = [1, 2, 5, 10].map((m) => m * pow).filter((m) => m <= target).pop() || pow;
    const len = step * v.s;
    const x0 = -v.w * 0.5 + 24;
    const y0 = v.h * 0.5 - 26;
    const label = step >= 1000 ? `${step / 1000} km` : `${step} m`;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, y0 - 6);
    ctx.lineTo(x0, y0);
    ctx.lineTo(x0 + len, y0);
    ctx.lineTo(x0 + len, y0 - 6);
    ctx.strokeStyle = MAP.halo;
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(236, 239, 244, 0.92)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = `650 11px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.lineWidth = 3;
    ctx.strokeStyle = MAP.halo;
    ctx.strokeText(label, x0 + len + 8, y0 + 3);
    ctx.fillStyle = 'rgba(236, 239, 244, 0.95)';
    ctx.fillText(label, x0 + len + 8, y0 + 3);
  }
}

export { OverviewMap, MapView, streetChains, roadLabels, createRouter, fold };
