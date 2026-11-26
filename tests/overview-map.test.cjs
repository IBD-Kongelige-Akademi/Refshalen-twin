const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

// js/overview-map.js: the radar minimap and the full map ([M]). Ported from upstream's nyc-map tests (click <-> world mapping, pointer
// handling) plus the road-graph parts that replace the Manhattan grid: street chains, labels, routing and the street search.
const source = readFileSync(join(__dirname, '../js/overview-map.js'), 'utf8');
const ROADGRAPH = join(__dirname, '../data/city/roadgraph.json');

class Path2D {
  moveTo() {}
  lineTo() {}
  closePath() {}
  rect() {}
}

const imports = { './city-config.js': { isTypingInField: () => false }, './sun-position.js': { GRID_CONVERGENCE_DEGREES: 0.77 } };
// the module runs in its own vm context: compare its arrays and objects by value
const plain = (v) => JSON.parse(JSON.stringify(v));
const load = (globals = {}) => loadModule(source, { globals: { Path2D, performance: { now: () => 0 }, ...globals }, imports });

// a small graph: a one-way street a -> b -> c (Algade), a two-way side street b - d (Bispensgade) and a footway c - d
function tinyGraph() {
  return {
    nodes: [0, 0, 100, 0, 200, 0, 100, 100],
    names: ['', 'Algade', 'Bispensgade'],
    classes: ['primary', 'secondary', 'residential', 'service', 'cycleway', 'footway'],
    links: [
      [0, 1, 1, 0, 8, 50, 1, 2, 1, 1],
      [1, 2, 1, 0, 8, 50, 1, 2, 1, 1],
      [1, 3, 1, 1, 8, 50, 2, 2, 1, 1],
      [2, 3, 0, 0, 2, 5, 0, 5, 1, 1]
    ]
  };
}

test('streets of one name are chained end to end, and labelled along their straight runs', () => {
  const { streetChains, roadLabels } = load();
  const chains = streetChains(tinyGraph());
  const algade = chains.filter((c) => c.name === 'Algade');
  assert.equal(algade.length, 1, 'the two Algade links make one chain');
  assert.deepEqual(plain(algade[0].pts.map((p) => [p.x, p.z])), [[0, 0], [100, 0], [200, 0]]);
  const labels = roadLabels(chains);
  const l = labels.find((x) => x.text === 'Algade');
  assert.ok(l.anchors.length >= 1 && l.anchors.every((a) => Math.abs(a.ang) < 1e-9), 'a straight east-west run reads left to right');
  assert.deepEqual([l.minX, l.maxX], [0, 200]);
});

test('routing: driving keeps to one-way streets and carriageways, walking may use the footway both ways', () => {
  const { createRouter } = load();
  const r = createRouter(tinyGraph());
  const pts = (route) => plain(route.slice(1, -1).map((p) => [p.x, p.z]));
  // a -> c along the one-way street
  assert.deepEqual(pts(r.route({ x: 0, z: 0 }, { x: 200, z: 0 }, 'car')), [[0, 0], [100, 0], [200, 0]]);
  // c -> a by car: against the one-way street there is no way back (the footway is not for cars)
  assert.equal(r.route({ x: 200, z: 0 }, { x: 0, z: 0 }, 'car'), null);
  // on foot: c -> d (footway) -> b -> a
  assert.deepEqual(pts(r.route({ x: 200, z: 0 }, { x: 0, z: 0 }, 'person')), [[200, 0], [100, 0], [0, 0]]);
  const viaFootway = r.route({ x: 200, z: 1 }, { x: 100, z: 99 }, 'person');
  assert.deepEqual(pts(viaFootway), [[200, 0], [100, 100]], 'the footway is the short way on foot');
  assert.deepEqual(plain([viaFootway[0], viaFootway.at(-1)]), [{ x: 200, z: 1 }, { x: 100, z: 99 }], 'the route starts at the player and ends at the waypoint');
});

test('names fold Danish letters and accents for the search', () => {
  const { fold } = load();
  assert.equal(fold('Østerågade'), 'oesteraagade');
  assert.equal(fold('Danneskiold-Samsøes Allé'), 'danneskiold-samsoees alle');
});

for (const [width, height, dpr] of [[500, 300, 1], [320, 180, 1.5], [1920, 1080, 2]]) {
  test(`map clicks match rendered world positions at ${width}x${height}, DPR ${dpr}`, () => {
    const window = { innerWidth: width, innerHeight: height, devicePixelRatio: dpr };
    const { OverviewMap } = load({ window });
    const map = Object.create(OverviewMap.prototype);
    // Capture the production render viewport; drawing primitives are irrelevant to coordinate conversion.
    const context = new Proxy({}, { get: () => () => {} });
    let view;
    Object.assign(map, {
      fullCanvas: { clientWidth: width, clientHeight: height },
      fullCtx: context,
      fullStatic: { getContext: () => context },
      isFullMapOpen: true,
      viewCenterX: 200,
      viewCenterZ: -300,
      viewZoom: 0.5,
      version: 0,
      locate: () => 'Aalborg',
      currentRoute: () => null,
      controllerManager: { getActiveEntity: () => ({ position: { x: 200, z: -300 }, heading: 0 }) },
      renderFullMapStatic: (_context, viewport) => { view = viewport; }
    });
    map.resizeFullCanvas();
    map.renderFullMap();
    for (const point of [{ x: 200, z: -300 }, { x: 325, z: -375 }]) {
      const screenX = (view.toX(point.x) + view.w / 2) * view.dpr * width / map.fullCanvas.width;
      const screenY = (view.toY(point.z) + view.h / 2) * view.dpr * height / map.fullCanvas.height;
      const clicked = map.screenToWorld(screenX, screenY, width, height);
      const tolerance = 1 / (view.s * view.dpr);
      assert.ok(Math.abs(clicked.x - point.x) < tolerance, `clicked x ${clicked.x} should match drawn x ${point.x}`);
      assert.ok(Math.abs(clicked.z - point.z) < tolerance, `clicked z ${clicked.z} should match drawn z ${point.z}`);
    }
  });
}

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) || []) listener(event);
    }
  };
}

function classList() {
  const names = new Set();
  return {
    add: (name) => names.add(name),
    remove: (name) => names.delete(name),
    contains: (name) => names.has(name),
    toggle(name, enabled) { if (enabled) names.add(name); else names.delete(name); }
  };
}

function mapHarness(graph = null) {
  const window = { ...eventTarget(), innerWidth: 200, innerHeight: 200 };
  const canvas = {
    ...eventTarget(), style: {}, clientWidth: 200, clientHeight: 200,
    getContext: () => ({}),
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 200 })
  };
  const controls = eventTarget();
  const wrapper = { classList: classList() };
  const zoomIn = eventTarget(), zoomOut = eventTarget();
  const elements = {
    'fullmap-canvas': canvas, 'fullmap-canvas-wrap': wrapper,
    'fullmap-modal': { classList: classList() },
    'map-zoom-in': zoomIn, 'map-zoom-out': zoomOut
  };
  const document = { ...eventTarget(), hidden: false, getElementById: (id) => elements[id] || null, querySelectorAll: () => [] };
  const captured = new Set();
  canvas.setPointerCapture = (id) => captured.add(id);
  canvas.hasPointerCapture = (id) => captured.has(id);
  canvas.releasePointerCapture = (id) => {
    captured.delete(id);
    canvas.dispatch('lostpointercapture', { pointerId: id });
  };
  const { OverviewMap } = load({ window, document });
  const teleports = [], toggles = [];
  const map = new OverviewMap({
    controllerManager: { getActiveEntity: () => ({ position: { x: 1000, z: 2000 } }), activeMode: 'person' },
    roadGraph: graph,
    locate: (x, z) => `Aalborg · ${x}, ${z}`,
    onTeleport: (x, z) => teleports.push([x, z]),
    onToggle: (open) => toggles.push(open)
  });
  // Exercise the real viewport/input state without drawing the map's geographic layers.
  map.renderFullMap = () => {};
  map.viewZoom = 1;
  map.toggleFullMap(true);
  return {
    map, canvas, controls, wrapper, window, document, captured, teleports, toggles, zoomIn, zoomOut,
    pointer(target, type, id, x = 110, y = 120, pointerType = 'touch', button = 0, shiftKey = false) {
      const event = { pointerId: id, clientX: x, clientY: y, pointerType, button, shiftKey, preventDefault() {} };
      (captured.has(id) ? canvas : target).dispatch(type, event);
      window.dispatch(type, event);
    }
  };
}

test('unrelated touches cannot move or release the map pan', () => {
  const h = mapHarness();
  assert.equal(h.canvas.style.touchAction, 'none');
  h.pointer(h.canvas, 'pointerdown', 1);
  h.pointer(h.controls, 'pointerdown', 2);
  h.pointer(h.canvas, 'pointerdown', 3);
  h.pointer(h.controls, 'pointermove', 2, 190);
  h.pointer(h.canvas, 'pointermove', 3, 190);
  h.pointer(h.controls, 'pointerup', 2);
  h.pointer(h.canvas, 'pointercancel', 3);
  assert.equal(h.map.viewCenterX, 1000);
  assert.equal(h.map.isPanning, true);
  assert.equal(h.teleports.length, 0);
  h.pointer(h.controls, 'pointermove', 1, 130);
  assert.equal(h.map.viewCenterX, 980);
  h.pointer(h.controls, 'pointerup', 1, 130);
  assert.equal(h.map.isPanning, false);
  assert.equal(h.wrapper.classList.contains('is-panning'), false);
  assert.equal(h.teleports.length, 0);
});

test('a normal map tap teleports once and releases capture; a shift-tap sets the GPS waypoint instead', () => {
  const h = mapHarness();
  h.pointer(h.canvas, 'pointerdown', 1);
  h.pointer(h.canvas, 'pointerup', 1);
  assert.deepEqual(h.teleports, [[1000, 2000]]);
  assert.equal(h.captured.size, 0);
  assert.equal(h.map.isPanning, false);
  assert.equal(h.map.waypoint, null);
  h.pointer(h.canvas, 'pointerdown', 2, 110, 120, 'mouse', 0, true);
  h.pointer(h.canvas, 'pointerup', 2, 110, 120, 'mouse', 0, true);
  assert.equal(h.teleports.length, 1, 'no teleport');
  assert.deepEqual([h.map.waypoint.x, h.map.waypoint.z, h.map.waypoint.name], [1000, 2000, '1000, 2000']);
});

for (const interruption of ['pointercancel', 'lostpointercapture', 'blur', 'hidden', 'close']) {
  test(`${interruption} cancels a map tap without teleporting or leaving a drag active`, () => {
    const h = mapHarness();
    h.pointer(h.canvas, 'pointerdown', 1);
    if (interruption === 'blur') h.window.dispatch('blur');
    else if (interruption === 'hidden') {
      h.document.hidden = true;
      h.document.dispatch('visibilitychange');
    } else if (interruption === 'close') h.map.toggleFullMap(false);
    else if (interruption === 'lostpointercapture') h.canvas.releasePointerCapture(1);
    else h.pointer(h.canvas, interruption, 1);
    h.pointer(h.canvas, 'pointerup', 1);
    assert.equal(h.teleports.length, 0);
    assert.equal(h.map.isPanning, false);
    assert.equal(h.captured.size, 0);
    assert.equal(h.wrapper.classList.contains('is-panning'), false);
    if (interruption === 'close') {
      assert.deepEqual(h.toggles, [true, false]);
      h.map.toggleFullMap(true);
    }
    h.pointer(h.canvas, 'pointerdown', 2);
    h.pointer(h.canvas, 'pointerup', 2);
    assert.equal(h.teleports.length, 1);
  });
}

test('a pointer released outside the map or far from its start does not teleport', () => {
  const h = mapHarness();
  h.pointer(h.canvas, 'pointerdown', 1, 205);
  h.pointer(h.controls, 'pointerup', 1, 215);
  h.pointer(h.canvas, 'pointerdown', 2, 110);
  h.pointer(h.canvas, 'pointerup', 2, 130);
  assert.equal(h.teleports.length, 0);
});

test('mouse hover and zoom buttons remain available without a pan', () => {
  const h = mapHarness();
  h.pointer(h.canvas, 'pointermove', 1, 120, 130, 'mouse');
  assert.equal(h.map.hoverWorld.x, 1010);
  assert.equal(h.map.hoverWorld.z, 2010);
  h.pointer(h.canvas, 'pointermove', 2, 180, 130);
  assert.equal(h.map.hoverWorld.x, 1010, 'untracked touch does not update hover');
  h.zoomIn.dispatch('click');
  assert.equal(h.map.viewZoom, 1.45);
  h.zoomOut.dispatch('click');
  assert.equal(h.map.viewZoom, 1);
});

test('the GPS route follows the road graph and is only recomputed once the player has moved', () => {
  const h = mapHarness(tinyGraph());
  h.map.setWaypoint(200, 0);
  const first = h.map.currentRoute(0, 0, 1000);
  assert.deepEqual(plain(first.slice(1, -1).map((p) => [p.x, p.z])), [[0, 0], [100, 0], [200, 0]]);
  assert.equal(h.map.currentRoute(5, 0, 2000), first, 'a few metres on: the same route');
  assert.notEqual(h.map.currentRoute(60, 0, 3000), first, 'farther on: a new route');
});

test('searching Refshalevej frames the street on the built road graph', { skip: !existsSync(ROADGRAPH) && 'no data/city/roadgraph.json' }, () => {
  const h = mapHarness(JSON.parse(readFileSync(ROADGRAPH, 'utf8')));
  h.map.search('refshalevej');
  const label = h.map.roadLabels.find((l) => l.text === 'Refshalevej');
  assert.ok(label, 'the street is in the road graph');
  assert.ok(h.map.searchPath, 'the street is highlighted');
  const { viewCenterX: x, viewCenterZ: z } = h.map;
  assert.ok(x >= label.minX && x <= label.maxX && z >= label.minZ && z <= label.maxZ, 'the view is centred on the street');
  assert.ok(h.map.searchHit && h.map.searchHit.name === 'Refshalevej', 'Enter would route there');
});

test('gamepad on the full map: the stick pans at a steady screen speed, the triggers zoom, A and X act at the crosshair', () => {
  const h = mapHarness();
  h.map.gamepadInput(0, 0, 0, 0.1);
  assert.equal(h.wrapper.classList.contains('pad-cursor'), false, 'no crosshair before any pad input');
  h.map.gamepadInput(1, -0.5, 0, 0.5);
  assert.equal(h.wrapper.classList.contains('pad-cursor'), true);
  assert.deepEqual([h.map.viewCenterX, h.map.viewCenterZ], [1300, 1850], '600 px/s at 1 px/m');
  h.map.gamepadInput(0, 0, 1, 1);
  assert.equal(h.map.viewZoom, 3);
  h.map.gamepadInput(1, 0, 0, 0.5);
  assert.equal(h.map.viewCenterX, 1400, 'the same screen speed when zoomed in');
  h.map.teleportToCenter();
  assert.deepEqual(h.teleports, [[1400, 1850]]);
  h.map.waypointAtCenter();
  assert.deepEqual([h.map.waypoint.x, h.map.waypoint.z], [1400, 1850]);
  h.pointer(h.canvas, 'pointerdown', 1, 110, 120, 'mouse');
  assert.equal(h.wrapper.classList.contains('pad-cursor'), false, 'a mouse press hides the crosshair');
  h.map.gamepadInput(0, 1, 0, 0.1);
  h.map.toggleFullMap(false);
  assert.equal(h.wrapper.classList.contains('pad-cursor'), false);
});
