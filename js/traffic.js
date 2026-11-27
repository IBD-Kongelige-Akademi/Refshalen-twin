import * as THREE from 'three/webgpu';
import { CAR_BODY_TYPES, fleetRandom, fleetVehicle } from './vehicle-fleet.js';
import { buildRoadNetwork } from './road-network.js';
import { createPedestrianSystem } from './pedestrian-system.js';
import { createMover, vehicleShape } from './ragdoll.js';
import { createCityCollisions, createCollisionActor } from './city-collisions.js';
import { signalOffset, vehiclePhase, walkPhase } from './signal-plan.js';
import { cityUniforms, createContactShadowMaterial, createCarFlareMaterial } from './tsl-materials.js';
import { HEADLIGHTS, createVehicleHeadlight, placeVehicleHeadlight } from './vehicle-lights.js';
import {
  BODY_SPECS,
  BUS_SPEC,
  BUS_LONG_SPEC,
  buildCarGeometry,
  buildCarProxyGeometry,
  buildSteerableWheelGeo,
  createLoftedCarMaterial,
  buildLoftedBusBodyGeometry,
  buildBusWheelGeo,
  createBusWheelMaterial,
  createLoftedBusMaterial,
  URBINO_24_SPECS,
  URBINO_24_FRONT_BACK,
  buildBusBellowsGeometry
} from './actor-models.js';
import { URBINO_24, createArticulation } from './articulated-bus.js';

// js/traffic.js
// Copenhagen traffic and pedestrians on the road graph road-network.js derives from the centreline graph:
// - Four AI A-buses on line 2A (the engine's double-articulated model, in Movia's A-bus colours) run its real route both ways and stop at its stops (section 2b).
// - 120 cars (European crossovers, hatchbacks, estates, vans and taxis) and 12 buses keep to their lanes and follow the vehicle
//   ahead (Intelligent Driver Model), change lanes to overtake or to reach a turn lane, turn into other streets,
//   stop for the signals at the junctions the register places (signal-plan.js), give way to oncoming traffic when
//   turning left, to the main road at unsignalized corners and to pedestrians on crosswalks, and never enter an
//   intersection they can't clear.
// - Pedestrians follow connected sidewalks, meet to talk, and cross signalized crosswalks on WALK.
// - Fixed-size local populations replenish distant roads and sidewalks in every direction, protecting the near view.
// - The player's vehicle or character pushes and is pushed by the traffic (SAT contact, impulses, sparks).

const NUM_CARS = 120;
const NUM_BUSES = 12;
const NUM_PLUSBUSES = 4;
const PLUS_DWELL = 14; // s standing at a stop with the doors open
const PLUS_ROUTE_TOLERANCE = 14; // m: an edge within this of a line's path, running its way, is on the route
const JAM_WAIT = 100; // s
// How long (s) a vehicle may stand held inside a solid (a junction curve cutting a building corner, a lane under a parked car)
// before it is placed afresh: its lane cannot take it out, so it would stay wedged until JAM_WAIT
const PINNED_WAIT = 3;
const PINNED_DEPTH = 0.1; // m of overlap with a solid that counts as wedged (a graze along a parked car does not)

// Intelligent Driver Model: max acceleration, comfortable braking, time headway, standstill gap; the sideways
// acceleration drivers accept in bends, which sets how fast they take each turn or lane shift; and how hard they brake
// in an emergency. At the wheel (see steer): the sideways acceleration the tyres grip up to, how far the front wheels
// turn (radians), and how fast the driver turns them at speed (rad/s, ~250°/s at the steering wheel; up to three times
// as fast at walking pace, 3.5 times as fast in a panic). (Ported from mrdoob/slop-newyork 17c0973 and 7fdf054.)
const CAR_DRIVER = { a: 2.0, b: 3.0, T: 1.2, s0: 2.0, aLat: 3.5, bMax: 8, grip: 8, lock: 0.6, steerRate: 0.3 };
const BUS_DRIVER = { a: 1.1, b: 2.5, T: 1.5, s0: 2.5, aLat: 2.0, bMax: 6, grip: 5, lock: 0.9, steerRate: 0.3 };
const PLUS_DRIVER = { a: 1.0, b: 2.2, T: 1.6, s0: 3.0, aLat: 1.6, bMax: 5, grip: 4, lock: 0.9, steerRate: 0.3 };
const LOOKAHEAD = 70; // metres a driver looks ahead for vehicles, stop lines and signals
// Dodging the player (see react): seconds ahead a driver sees a collision coming, the clearance it wants (m), how long
// it keeps up its manoeuvre after the danger has passed (s), the time step it judges the player's course at (s), how
// far across it will swerve at once (m), how much nearer the other way out must be to change its mind (m), and the
// fastest it expects the player to keep turning (rad/s)
const AVOID_NOTICE = 2.2;
const AVOID_MARGIN = 0.5;
const AVOID_HOLD = 1.0;
const AVOID_STEP = 0.1;
const AVOID_REACH = 3.6;
const AVOID_SWITCH = 1.0;
const AVOID_TURN = 1.2;
const AVOID_BRAKE = 1.5; // m/s²: braking while swerving round a player coming at it (more takes the speed it steers with)
// Crashes: the change of velocity (m/s) beyond which a hit driver stops and gathers itself, hazards on, for 4 to 7 s
// (less is a nudge it drives on from); and the tyres' grip stopping a car shoved sideways (m/s²) or spun (rad/s²)
const CRASH_SPEED = 2;
const SLIDE_FRICTION = 7.5;
const SPIN_FRICTION = 6;
const SHOVE_REACH = 6; // m: the furthest a knock carries a vehicle off its path
const LOCK_MAX = 1.3; // radians: the furthest the simulated front wheels turn for a junction curve tighter than full lock
const NOSE_MAX = 0.35; // radians: the furthest a driver heads off its path, but in a swerve or a spin (see steer)

// Retire distant actors even when looking their way: keeping them indefinitely starves upcoming streets.
// Replacements may enter the far view, but nearby visible roads and sidewalks are protected from pop-in.
const VEHICLE_RADIUS = 380;
const NEAR_RADIUS = 350;
const VEHICLE_SPAWN_DISTANCE = 250;
const GROUNDED_PLAYER_MODES = new Set(['person', 'car', 'cyclist', 'cargobike', 'bus']);
const COLLIDING_PLAYER_MODES = new Set([...GROUNDED_PLAYER_MODES, 'drone']);

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// `options`: { roadGraph, walkable, onSidewalk, blockAt, extraOffset, debug } as road-network.js and the pedestrian
// system take them. Cars and buses drive on the signals' fixed-time plans (signal-plan.js) at the junctions the
// register places.
function createTrafficSystem(scene, signalIntersections, options = {}) {
  const group = new THREE.Group();
  group.name = 'TrafficAndPedestrians';
  let collisionListener = null;
  const collisionEvent = { a: null, b: null, kind: 'vehicle', x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, speed: 0 };

  function setCollisionListener(listener) {
    collisionListener = typeof listener === 'function' ? listener : null;
  }

  // Synchronous notification: listeners must copy any fields they retain. Normal points from b toward a.
  function reportCollision(a, b, x, y, z, nx, nz, speed, kind = 'vehicle') {
    if (!collisionListener || speed <= 0.5) return;
    collisionEvent.kind = kind; // ('pedestrian': a person hit, mostly the body's thump, see audio-system.js crash)
    collisionEvent.a = a; collisionEvent.b = b;
    collisionEvent.x = x; collisionEvent.y = y; collisionEvent.z = z;
    collisionEvent.nx = nx; collisionEvent.nz = nz; collisionEvent.speed = speed;
    collisionListener(collisionEvent);
  }

  const dummy = new THREE.Object3D();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const unitPlane = new THREE.PlaneGeometry(1, 1);
  unitPlane.rotateX(-Math.PI * 0.5);
  const contactShadowMat = createContactShadowMaterial();

  // =========================================================================
  // 0. ROAD NETWORK
  // =========================================================================
  // Vehicles rest on the terrain (js/terrain.js via the scene's ground model); 0 on the flat plane
  const groundAt = (x, z) => (options.groundHeight ? options.groundHeight.terrainAt(x, z) : 0);
  // a vehicle's ground from where it is now: on a bridge deck when it drove onto it, under it when it passes beneath (js/deck-field.js)
  const levelAt = (x, z, y) => (options.groundHeight?.levelAt ? options.groundHeight.levelAt(x, z, y) : groundAt(x, z));
  // what a vehicle is drawn on: `gy` (its level on the ground or a deck) followed at no more than SMOOTH_GRADE per metre driven, so a lump in
  // the terrain or a step between levels is driven over, not popped through
  const vehicleGround = (v) => (Number.isFinite(v.gs) ? v.gs : Number.isFinite(v.gy) ? v.gy : groundAt(v.x, v.z));
  const SMOOTH_GRADE = 0.3;
  const followLevel = (v, moved) => {
    if (!Number.isFinite(v.gs)) { v.gs = v.gy; return; }
    const room = SMOOTH_GRADE * moved;
    v.gs += Math.max(-room, Math.min(room, v.gy - v.gs));
  };
  let network = null;
  let nodes = [];
  let edges = [];
  let connector = null;
  let curvePoint = null;

  // Where lane i of edge e meets a crosswalk, measured along the crosswalk: along its road's lateral axis
  const laneCoord = (e, i) => (e.sx + e.rx * e.lanes[i]) * e.clx + (e.sz + e.rz * e.lanes[i]) * e.clz;

  // The road network can be swapped while the system runs (setNetwork): a streamed city keeps the network of the region around the camera.
  function bindNetwork(net) {
    network = net;
    ({ nodes, edges, connector, curvePoint } = net);
    for (const n of nodes) {
      n.sigOffset = signalOffset(n.x, n.z);
      n.sideGroup = [];
      for (const a of n.arms || []) n.sideGroup[a.side] = a.group;
      n.box = new Array(n.groupCount).fill(0); // vehicles crossing it from each road (group: the widest road is 0)
      n.crossing = new Array(n.sideCount).fill(0); // vehicles crossing (or about to cross) the crosswalk on each side
      n.approach = new Array(n.sideCount).fill(null); // the edge arriving over each side's crosswalk
      n.road = new Array(n.sideCount).fill(null); // an edge arriving or leaving over each side's crosswalk: the road it spans
    }
    for (const e of edges) {
      e.occ = e.lanes.map(() => []); // vehicles in each lane, sorted by position
      // e.inSide / e.outSide: the crosswalks crossed on the way into e.to / out of e.from; e.axisIndex: its group at e.to;
      // e.opposite: the oncoming edge of its road there (road-network.js)
      e.to.approach[e.inSide] = e;
      e.to.road[e.inSide] = e.from.road[e.outSide] = e;
      e.through = 0; // vehicles from e crossing e.to straight on or to the right
      e.lefts = 0; // and to the left
    }
  }
  bindNetwork(options.network || buildRoadNetwork(signalIntersections, options));

  // Is the intersection box held by vehicles of any road but group g's?
  const boxBusy = (n, g) => {
    for (let k = 0; k < n.box.length; k++) if (k !== g && n.box[k] > 0) return true;
    return false;
  };

  // =========================================================================
  // 1. 3D LOFTED SEDANS & SUVS (120 VEHICLES)
  // =========================================================================
  function createVehicle(bus, half, halfWidth, axle, driver, v0) {
    return {
      bus, half, halfWidth, axle, driver, v0,
      edge: null, lane: 0, s: 0, speed: 0, acc: 0, gap: Infinity, leaderSpeed: 0,
      move: null, out: 0, conn: null, cs: 0, trail: null, commit: null, claimed: false, yielding: false, yieldAt: 0,
      wait: 0, laneTimer: Math.random() * 0.5,
      dl: 0, dlv: 0, blink: 0, blinkPhase: Math.random() * 0.8,
      evade: 0, evadeSide: 0, alarm: 0, panic: false, panicAcc: 0, lastDanger: -Infinity, warning: false, shaken: 0,
      reaction: 0.6 + Math.random() * 0.4,
      x: 0, z: 0, prevX: 0, prevZ: 0, tx: 0, tz: 1, nose: 0, yaw: 0, yawRate: 0, steer: 0, delta: 0,
      pitch: 0, roll: 0, pitchVel: 0, rollVel: 0, vx: 0, vz: 0, yawOffset: 0, yawVel: 0,
      pAhead: Infinity, pRight: 0, pSpeed: 0, wheelSpin: Math.random() * Math.PI * 2
    };
  }

  const wheelSpec = BODY_SPECS.crossoverEV;
  const carWheelLeftGeo = buildSteerableWheelGeo(wheelSpec, -1);
  const carWheelRightGeo = buildSteerableWheelGeo(wheelSpec, 1);
  const carWheelMat = createLoftedCarMaterial(wheelSpec, 0x777d81);
  const cars = [];
  const bodyCounts = Object.fromEntries(CAR_BODY_TYPES.map((kind) => [kind, 0]));
  for (let i = 0; i < NUM_CARS; i++) {
    const choice = fleetVehicle(fleetRandom(i, 0), fleetRandom(i, 1), fleetRandom(i, 2));
    const bodyType = choice.body;
    const spec = BODY_SPECS[bodyType];
    const col = new THREE.Color(choice.paint);
    const paint = [Math.fround(col.r), Math.fround(col.g), Math.fround(col.b)];
    const car = createVehicle(false, spec.length / 2, spec.width / 2, spec.wheelZ, CAR_DRIVER, 10 + (i % 5) * 0.9);
    Object.assign(car, { bodyType, paint, taxi: choice.taxi, massRatio: spec.massRatio });
    bodyCounts[bodyType]++;
    cars.push(car);
  }

  const bodies = {};
  for (const kind of CAR_BODY_TYPES) {
    const spec = BODY_SPECS[kind];
    const mat = createLoftedCarMaterial(spec);
    const n = Math.max(1, bodyCounts[kind]);
    const lodMesh = (g, lod) => {
      g.setAttribute('paintColor', new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3));
      g.setAttribute('carState', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
      const mesh = new THREE.InstancedMesh(g, mat, n);
      mesh.name = `traffic-${kind}-${lod}`;
      return mesh;
    };
    bodies[kind] = { near: lodMesh(buildCarGeometry(spec, false), 'near'), far: lodMesh(buildCarProxyGeometry(spec), 'far') };
  }
  const bodyMeshes = Object.values(bodies).flatMap((b) => [b.near, b.far]);
  const carWheelLeftInst = new THREE.InstancedMesh(carWheelLeftGeo, carWheelMat, NUM_CARS * 2);
  const carWheelRightInst = new THREE.InstancedMesh(carWheelRightGeo, carWheelMat, NUM_CARS * 2);

  // 3D Collision Spark & Debris Particle Pool
  const MAX_SPARKS = 120;
  const sparkGeo = new THREE.BoxGeometry(0.038, 0.038, 0.26);
  const sparkMat = new THREE.MeshBasicNodeMaterial({ color: 0xffc438 });
  const sparkInst = new THREE.InstancedMesh(sparkGeo, sparkMat, MAX_SPARKS);
  const sparks = [];
  let sparkCursor = 0;
  for (let s = 0; s < MAX_SPARKS; s++) {
    sparks.push({ x: 0, y: -10, z: 0, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 0.4 });
  }
  function spawnCollisionSparks(x, y, z, nx, nz, impactSpeed) {
    const count = Math.min(24, Math.max(8, Math.floor(impactSpeed * 1.4)));
    const tx = -nz;
    const tz = nx;
    for (let k = 0; k < count; k++) {
      const sp = sparks[sparkCursor];
      sparkCursor = (sparkCursor + 1) % MAX_SPARKS;
      const spread = (Math.random() - 0.5) * 2.2;
      const outBoost = (0.3 + Math.random() * 0.9) * Math.min(14.0, impactSpeed * 0.65);
      const tanBoost = spread * Math.min(12.0, impactSpeed * 0.55);
      sp.x = x + (Math.random() - 0.5) * 0.35;
      sp.y = y + (Math.random() - 0.5) * 0.18;
      sp.z = z + (Math.random() - 0.5) * 0.35;
      sp.floor = groundAt(x, z);
      sp.vx = nx * outBoost + tx * tanBoost;
      sp.vy = 2.4 + Math.random() * 5.4;
      sp.vz = nz * outBoost + tz * tanBoost;
      sp.maxLife = 0.28 + Math.random() * 0.24;
      sp.life = sp.maxLife;
    }
  }

  const carShadowInst = new THREE.InstancedMesh(unitPlane, contactShadowMat, NUM_CARS);
  carShadowInst.renderOrder = 998;

  for (const { near, far } of Object.values(bodies)) {
    near.castShadow = true;
    near.receiveShadow = far.receiveShadow = true;
  }
  carWheelLeftInst.castShadow = carWheelLeftInst.receiveShadow = true;
  carWheelRightInst.castShadow = carWheelRightInst.receiveShadow = true;

  group.add(
    ...bodyMeshes,
    carWheelLeftInst,
    carWheelRightInst,
    sparkInst
  );

  // =========================================================================
  // 2. LOFTED CITY BUSES (12 BUSES)
  // =========================================================================
  const busSets = {};
  for (const spec of [BUS_SPEC, BUS_LONG_SPEC]) {
    const capacity = Math.ceil(NUM_BUSES / 2);
    const geo = buildLoftedBusBodyGeometry(spec);
    const states = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    geo.setAttribute('busState', states);
    const body = new THREE.InstancedMesh(geo, createLoftedBusMaterial(spec), capacity);
    body.name = spec.name;
    body.castShadow = body.receiveShadow = true;
    busSets[spec.name] = { spec, body, states, count: 0 };
    group.add(body);
  }
  const busBodyMeshes = Object.values(busSets).map((b) => b.body);
  const busWheelMat = createBusWheelMaterial();
  const busWheelLeftInst = new THREE.InstancedMesh(buildBusWheelGeo(-1), busWheelMat, NUM_BUSES * 3 + NUM_PLUSBUSES * 4);
  const busWheelRightInst = new THREE.InstancedMesh(buildBusWheelGeo(1), busWheelMat, NUM_BUSES * 3 + NUM_PLUSBUSES * 4);
  const busShadowInst = new THREE.InstancedMesh(unitPlane, contactShadowMat, NUM_BUSES);
  busShadowInst.renderOrder = 998;
  busWheelLeftInst.castShadow = busWheelLeftInst.receiveShadow = true;
  busWheelRightInst.castShadow = busWheelRightInst.receiveShadow = true;

  const buses = [];
  for (let i = 0; i < NUM_BUSES; i++) {
    const spec = i % 2 ? BUS_LONG_SPEC : BUS_SPEC;
    const bus = createVehicle(true, spec.length / 2 + 0.2, spec.width / 2, spec.wheelZ, BUS_DRIVER, 8 + (i % 3));
    Object.assign(bus, { spec, massRatio: spec.massRatio });
    buses.push(bus);
  }

  // =========================================================================
  // 2b. AI PLUSBUSES (LINE 2: SOLARIS URBINO 24)
  // =========================================================================
  // Line 2's paths and stops come from data/city/bus-lines.json (tools/geodata/bus_lines.py, setBusLines). The traffic model drives
  // each Plusbus as a 24.7 m vehicle in the curb lane of the edges on its route (onLine): its front module follows the lane path, the
  // trailing modules follow their hitches (js/articulated-bus.js). It stops at each stop for PLUS_DWELL s with its doors open; one
  // that strays off the route is retired once out of sight and placed on the route again.
  const plusModuleSpecs = [URBINO_24_SPECS[0], URBINO_24_FRONT_BACK, URBINO_24_SPECS[1], URBINO_24_SPECS[2]];
  const plusSets = {};
  for (const spec of plusModuleSpecs) {
    const geo = buildLoftedBusBodyGeometry(spec);
    const states = new THREE.InstancedBufferAttribute(new Float32Array(NUM_PLUSBUSES * 4), 4);
    geo.setAttribute('busState', states);
    const body = new THREE.InstancedMesh(geo, createLoftedBusMaterial(spec), NUM_PLUSBUSES);
    body.name = `traffic-${spec.name}`;
    body.castShadow = body.receiveShadow = true;
    plusSets[spec.name] = { body, states, count: 0 };
    group.add(body);
  }
  const plusBellowsInst = new THREE.InstancedMesh(buildBusBellowsGeometry(),
    new THREE.MeshStandardNodeMaterial({ color: 0x9a9fa3, roughness: 0.62, metalness: 0.25 }), NUM_PLUSBUSES * 2);
  plusBellowsInst.castShadow = true;
  const plusShadowInst = new THREE.InstancedMesh(unitPlane, contactShadowMat, NUM_PLUSBUSES * 3);
  plusShadowInst.renderOrder = 998;
  group.add(plusBellowsInst, plusShadowInst);
  const plusbuses = [];
  for (let i = 0; i < NUM_PLUSBUSES; i++) {
    const v = createVehicle(true, URBINO_24.length / 2 + 0.2, URBINO_24.width / 2, 6, PLUS_DRIVER, 10);
    Object.assign(v, {
      plus: true, massRatio: 0.1,
      // the collision box is the front module's (city-collisions sees it at the module, js/controllers.js does the same for the player);
      // zFront / headlight place the headlamps from the vehicle centre
      spec: { name: 'urbino24', width: URBINO_24.width, length: 10, height: URBINO_24.height, wheelRadius: 0.48, zFront: URBINO_24.length / 2, headlight: [0.79, 0.8] },
      art: createArticulation(), artPlaced: false, line: -1, offRoute: false, frontS: 0, servedS: -Infinity, stopD: Infinity,
      dwell: 0, doors: 0, cox: 0, coz: 0, frontYaw: 0
    });
    plusbuses.push(v);
  }
  const vehicles = [...cars, ...buses, ...plusbuses];
  group.add(busWheelLeftInst, busWheelRightInst);

  // Line paths: { path (flat x, z), cum (metres to each vertex), stops (s), back (towards Væddeløbsbanen: the other sign) }
  let busLines = [];
  const lineEdgeCache = new WeakMap();
  function setBusLines(doc) {
    busLines = [];
    for (const line of doc?.lines || []) {
      for (const d of line.directions || []) {
        const p = d.path;
        const cum = new Float64Array(p.length / 2);
        for (let i = 1; i < cum.length; i++) cum[i] = cum[i - 1] + Math.hypot(p[2 * i] - p[2 * i - 2], p[2 * i + 1] - p[2 * i - 1]);
        busLines.push({ ref: line.ref, path: p, cum, stops: (d.stops || []).map((s) => s.s), back: !/Refshaleøen/.test(d.to || '') }); // the front sign reads REFSHALEØEN towards it, TINGBJERG back
      }
    }
    refreshNearRoute();
  }
  // The nearest point of line L's path to (x, z): s along it, distance, and the path's direction there
  const lineHit = { s: 0, d: 0, tx: 0, tz: 1 };
  function lineProject(L, x, z, out = lineHit) {
    const p = L.path;
    let best = Infinity;
    for (let i = 1; i < L.cum.length; i++) {
      const ax = p[2 * i - 2], az = p[2 * i - 1], dx = p[2 * i] - ax, dz = p[2 * i + 1] - az;
      const l2 = dx * dx + dz * dz || 1e-9;
      const t = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
      const ex = ax + dx * t - x, ez = az + dz * t - z;
      const d2 = ex * ex + ez * ez;
      if (d2 < best) {
        best = d2;
        const l = Math.sqrt(l2);
        out.s = L.cum[i - 1] + l * t;
        out.tx = dx / l;
        out.tz = dz / l;
      }
    }
    out.d = Math.sqrt(best);
    return out;
  }
  // Is edge e on line li's route: near its path all along, and running the same way?
  function onLine(e, li) {
    let c = lineEdgeCache.get(e);
    if (!c) lineEdgeCache.set(e, (c = []));
    if (c[li] === undefined) {
      let ok = true;
      for (const f of [0.1, 0.5, 0.9]) {
        const q = lineProject(busLines[li], e.sx + e.dx * e.len * f, e.sz + e.dz * e.len * f);
        if (q.d > PLUS_ROUTE_TOLERANCE || q.tx * e.dx + q.tz * e.dz < 0.7) { ok = false; break; }
      }
      c[li] = ok;
    }
    return c[li];
  }
  // The curb lane (traffic keeps right: the lane furthest along e's right vector)
  const curbLane = (e) => {
    let best = 0;
    for (let i = 1; i < e.lanes.length; i++) if (e.lanes[i] > e.lanes[best]) best = i;
    return best;
  };

  // =========================================================================
  // 3. PEDESTRIAN SYSTEM
  // =========================================================================
  const player = { active: false, entity: null, x: 0, z: 0, vx: 0, vz: 0, fx: 0, fz: 1, heading: 0, yawRate: 0,
    halfW: 0.86, halfL: 2.18 };
  const nearEdges = [];
  const nearSignals = [];
  // The vehicles around the focus as the people they knock down see them (js/ragdoll.js, slop-newyork 11df5f4): the player's
  // car and traffic (its cars and city buses; the Plusbus is not one, see gatherMovers), with their bodies' shapes (from
  // their meshes, made when first needed)
  const movers = [];
  const moverPool = [];
  const MOVER_RADIUS = 80;
  const shapes = {};
  function shapeOf(kind, bus = false) {
    if (!shapes[kind]) {
      const spec = bus ? busSets[kind].spec : BODY_SPECS[kind];
      const geometry = bus ? busSets[kind].body.geometry : bodies[kind].near.geometry;
      const tyre = bus ? 0.16 : 0.12;
      shapes[kind] = vehicleShape(geometry, {
        wheels: [[spec.wheelX, spec.wheelZ, spec.wheelRadius, tyre], [spec.wheelX, -spec.wheelZ, spec.wheelRadius, tyre]]
      });
    }
    return shapes[kind];
  }
  let playerMover = null;
  function gatherMovers(dt, playerEntity, activeMode) {
    let n = 0;
    const take = () => {
      const m = moverPool[n] || (moverPool[n] = createMover());
      n++;
      m.jx = m.jy = m.jz = 0;
      m.wheelHits = 0;
      m.dt = dt;
      return m;
    };
    playerMover = null;
    if (player.active && activeMode === 'car' && playerEntity?.chassisPivot) {
      const m = playerMover = take();
      const chassis = playerEntity.chassisPivot;
      m.x = player.x; m.z = player.z; m.y = playerEntity.position.y + chassis.position.y;
      m.heading = playerEntity.heading || 0;
      m.vx = player.vx; m.vz = player.vz;
      m.yawRate = playerEntity.angularVel || 0;
      m.pitch = chassis.rotation.x; m.roll = chassis.rotation.z;
      m.shape = shapeOf('hatch'); // (the player's car, js/controllers.js)
      m.mass = 1250;
      m.ref = playerEntity;
      m.knocks = true;
    }
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      // (the Plusbus's three modules follow its path, not one rigid body: its driver stops for people instead)
      if (!v.edge || v.plus || Math.abs(v.x - focusX) > MOVER_RADIUS || Math.abs(v.z - focusZ) > MOVER_RADIUS) continue;
      const m = take();
      const heading = v.yaw + v.yawOffset;
      m.x = v.x; m.z = v.z; m.y = vehicleGround(v);
      m.heading = heading;
      m.vx = Math.sin(heading) * v.speed + v.vx;
      m.vz = Math.cos(heading) * v.speed + v.vz;
      m.yawRate = v.yawRate + v.yawVel;
      m.pitch = v.bus ? 0 : v.pitch; m.roll = v.bus ? 0 : v.roll;
      m.shape = v.bus ? shapeOf(v.spec.name, true) : shapeOf(v.bodyType);
      m.mass = vehicleCollisionActors[i].mass;
      m.ref = v;
      m.knocks = v.speed > 3; // drivers stop for people in their way: only one swerving (or careering) runs into them
    }
    movers.length = n;
    for (let i = 0; i < n; i++) movers[i] = moverPool[i];
  }

  // The people the player's car knocks down (or drives over) push back on it: it slows, and the chassis dips and bumps
  function feelFallen(playerEntity) {
    const m = playerMover;
    if (!m || m.ref !== playerEntity) return;
    const sin = Math.sin(m.heading), cos = Math.cos(m.heading);
    const along = (m.jx * sin + m.jz * cos) / m.mass;
    const across = (m.jx * cos - m.jz * sin) / m.mass;
    if (along || across || m.jy) {
      playerEntity.speed += along;
      playerEntity.vx = (playerEntity.vx || 0) + cos * across;
      playerEntity.vz = (playerEntity.vz || 0) - sin * across;
      playerEntity.pitchVel = (playerEntity.pitchVel || 0) + clamp(along * 0.8, -1.2, 1.2);
      playerEntity.heaveVel = (playerEntity.heaveVel || 0) + clamp((m.jy / m.mass) * 2, -0.6, 0.6);
    }
    if (m.wheelHits) {
      const speed = Math.abs(playerEntity.speed || 0);
      playerEntity.heaveVel = (playerEntity.heaveVel || 0) + Math.min(0.5, 0.06 * speed) * (0.6 + Math.random() * 0.4);
      playerEntity.rollVel = (playerEntity.rollVel || 0) + (Math.random() - 0.5) * Math.min(0.6, 0.08 * speed);
    }
  }

  const pedestrianSystem = createPedestrianSystem(network, {
    player, nearEdges, nearSignals, mayCross, walkOn, visible, nearView, blockAt: options.blockAt, groundHeight: options.groundHeight, movers
  });
  pedestrianSystem.setHitListener((p, m) => {
    const speed = Math.hypot(m.vx, m.vz);
    const dx = p.x - m.x, dz = p.z - m.z, d = Math.hypot(dx, dz) || 1;
    reportCollision(m.ref, p, p.x, groundAt(p.x, p.z) + 0.9, p.z, dx / d, dz / d, speed, 'pedestrian');
  });
  group.add(...pedestrianSystem.meshes);

  const localCollisionStage = createCityCollisions();
  const vehicleCollisionActors = vehicles.map((v, collisionIndex) => {
    const spec = v.bus ? v.spec : BODY_SPECS[v.bodyType];
    const actor = createCollisionActor({
      entity: v,
      kind: v.bus ? 'bus' : 'car',
      collisionIndex,
      mode: 'car',
      spec,
      bodyTop: spec.height || (v.bus ? 3.0 : 1.8),
      radius: v.plus ? spec.length / 2 : Math.max(v.halfWidth, v.half),
      mass: v.plus ? 28000 : v.bus ? 6500 : Math.max(950, 1400 / Math.max(spec.massRatio || 0.5, 0.2)),
      x: 0, y: 0, z: 0, prevX: 0, prevY: 0, prevZ: 0, _wasPlaced: false,
      // (driving along its heading, which may be off its path: see steer)
      getVelocity(out) {
        out.x = Math.sin(v.yaw) * v.speed + v.vx;
        out.z = Math.cos(v.yaw) * v.speed + v.vz;
        return out;
      },
      applyVelocity(dx, dz) {
        const hx = Math.sin(v.yaw), hz = Math.cos(v.yaw);
        const nextX = hx * v.speed + v.vx + dx;
        const nextZ = hz * v.speed + v.vz + dz;
        const speed = Math.max(0, nextX * hx + nextZ * hz);
        v.speed = speed;
        v.vx = nextX - hx * speed;
        v.vz = nextZ - hz * speed;
      },
      move(dx, dz) {
        shove(v, dx, dz);
        if (v.plus) return { x: v.x + v.cox, z: v.z + v.coz }; // the box stays on the front module
        this.heading = Math.atan2(v.tx, v.tz) - v.nose + v.yawOffset;
        return v;
      },
      onStaticContact(collider, nx, nz, incoming, depth) { if (depth > PINNED_DEPTH) v.wedgedAt = updates; },
      onContact(other, nx, nz, speed) {
        applyVehicleImpact(v, actor, other, nx, nz, speed);
        if (speed > 2.2) reportCollision(v, other.entity || other, (v.x + other.x) * 0.5,
          groundAt(v.x, v.z) + 0.56, (v.z + other.z) * 0.5, nx, nz, speed, other.kind === 'pedestrian' ? 'pedestrian' : 'vehicle');
        if (speed > 2.2 && shouldEmitImpactSparks(actor, other)) {
          const x = (actor.x + other.x) * 0.5, z = (actor.z + other.z) * 0.5;
          spawnCollisionSparks(x, groundAt(x, z) + 0.56, z, nx, nz, speed);
        }
      }
    });
    return actor;
  });
  const pedestrianCollisionActors = pedestrianSystem.peds.map((p) => createCollisionActor({
    entity: p,
    kind: 'pedestrian',
    mode: 'person',
    radius: 0.31,
    bodyTop: 1.85,
    mass: 72,
    x: 0, y: 0, z: 0, prevX: 0, prevY: 0, prevZ: 0, _wasPlaced: false,
    heading: 0,
    placed: false,
    getVelocity(out) {
      const speed = p.v * p.dir;
      out.x = p.ux * speed;
      out.z = p.uz * speed;
      return out;
    },
    applyVelocity(dx, dz) {
      const speed = p.v * p.dir + dx * p.ux + dz * p.uz;
      p.v = Math.max(0, speed * p.dir);
    },
    move(dx, dz) {
      p.contactX += dx;
      p.contactZ += dz;
      p.x += dx;
      p.z += dz;
      return p;
    },
    // js/pedestrian-system.js stops stepping aside / drifting back for a moment after a solid pushed this person
    onStaticContact() { p.staticContacts = (p.staticContacts || 0) + 1; }
  }));
  const frameCollisionActors = [];
  let collisionPhase = null;
  function setCollisionPhase(phase) { collisionPhase = typeof phase === 'function' ? phase : null; }
  // (x, z, heading, spec) -> false where a vehicle placed there would stand in a solid (js/city-collisions.js clearOfStatics)
  let spawnClear = null;
  function setSpawnClear(fn) { spawnClear = typeof fn === 'function' ? fn : null; }
  function applyVehicleImpact(v, actor, other, nx, nz, impactSpeed) {
    if (!(impactSpeed > 0.5)) return 0;
    const ownMass = Math.max(1, Number.isFinite(actor.mass) ? actor.mass : 1250);
    const otherMass = Math.max(1, Number.isFinite(other.mass) ? other.mass : 72);
    const receivedDv = impactSpeed * otherMass / (ownMass + otherMass);
    const heading = actor.heading || 0;
    const sin = Math.sin(heading), cos = Math.cos(heading);
    const localNx = nx * cos - nz * sin;
    const localNz = nx * sin + nz * cos;

    if (v) {
      const dx = other.x - actor.x, dz = other.z - actor.z;
      const localX = dx * cos - dz * sin;
      const localZ = dx * sin + dz * cos;
      const torque = localZ * localNx - localX * localNz;
      const scale = v.bus ? 0.35 : 1;
      if (!v.bus) {
        v.yawVel -= torque * Math.min(4.2, receivedDv * 0.26) * scale;
      }
      v.pitchVel -= localNz * Math.min(12, receivedDv) * 0.18 * scale;
      v.rollVel += localNx * Math.min(12, receivedDv) * 0.24 * scale;
      // after a real crash the driver stops, hazards on, for 4 to 7 s (see drive and the lamps); a nudge it drives on from
      if (receivedDv > CRASH_SPEED) v.shaken = Math.max(v.shaken, clock + 4 + Math.min(3, (receivedDv - CRASH_SPEED) * 0.5));
    } else if (actor.mode === 'car' && actor.entity?.type === 'car') {
      const entity = actor.entity;
      const forwardDot = nx * sin + nz * cos;
      const sideDot = nx * cos - nz * sin;
      if (Math.abs(forwardDot) <= 0.72) {
        entity.angularVel = (entity.angularVel || 0)
          + sideDot * (forwardDot >= 0 ? -1 : 1) * Math.min(3.2, receivedDv * 0.22);
      }
      entity.pitchVel = (entity.pitchVel || 0) + forwardDot * Math.min(14, receivedDv) * 0.16;
      entity.rollVel = (entity.rollVel || 0) - sideDot * Math.min(14, receivedDv) * 0.22;
      entity.heaveVel = (entity.heaveVel || 0) + Math.min(1.4, receivedDv * 0.11);
    }
    return receivedDv;
  }

  function shouldEmitImpactSparks(actor, other) {
    if (actor.mode === 'person' || other.mode === 'person' || actor.kind === 'pedestrian' || other.kind === 'pedestrian') return false;
    const actorVehicle = actor.kind === 'car' || actor.kind === 'bus';
    const otherVehicle = other.kind === 'car' || other.kind === 'bus';
    if (actorVehicle && otherVehicle && Number.isFinite(actor.collisionIndex) && Number.isFinite(other.collisionIndex)) {
      return actor.collisionIndex < other.collisionIndex;
    }
    if (actor.kind === 'player' && otherVehicle) return false;
    return actorVehicle || (actor.kind === 'player' && actor.mode === 'car'
      && (other.mode === 'cyclist' || other.mode === 'cargobike'));
  }

  function bindPlayerCollisionActor(actor, entity, mode) {
    const bodyMode = mode === 'bus' ? 'car' : mode; // the Plusbus meets traffic as its front module's box
    if (actor.entity !== entity || actor.mode !== bodyMode) {
      actor._wasPlaced = false;
      actor.prevX = entity.position.x;
      actor.prevY = entity.position.y;
      actor.prevZ = entity.position.z;
      actor.prevHeading = entity.heading || 0;
    }
    actor.entity = entity;
    actor.mode = bodyMode;
  }
  function syncCollisionActors(playerEntity, activeMode) {
    frameCollisionActors.length = 0;
    for (let i = 0; i < vehicleCollisionActors.length; i++) {
      const actor = vehicleCollisionActors[i], v = vehicles[i];
      actor.x = v.x; actor.y = vehicleGround(v); actor.z = v.z;
      actor.heading = Math.atan2(v.tx, v.tz) - v.nose + v.yawOffset;
      actor.prevX = v.prevX; actor.prevZ = v.prevZ;
      if (v.plus) {
        // a Plusbus collides as its front module (the trailers follow its path)
        actor.x += v.cox; actor.z += v.coz;
        actor.prevX += v.cox; actor.prevZ += v.coz;
        actor.heading = v.frontYaw;
      }
      actor.placed = Boolean(v.edge);
      frameCollisionActors.push(actor);
    }
    for (let i = 0; i < pedestrianCollisionActors.length; i++) {
      const actor = pedestrianCollisionActors[i], p = pedestrianSystem.peds[i];
      actor.x = p.x; actor.z = p.z;
      actor.y = options.groundHeight ? options.groundHeight.heightAt(p.x, p.z) : 0.22;
      actor.prevX = p.prevX; actor.prevZ = p.prevZ;
      actor.heading = Math.atan2(p.ux * p.dir, p.uz * p.dir);
      actor.sweep = true;
      actor.placed = p.placed && !p.fall; // (someone knocked down is the ragdoll's, see js/pedestrian-system.js)
      frameCollisionActors.push(actor);
    }
    if (playerEntity && COLLIDING_PLAYER_MODES.has(activeMode)) {
      const actor = activePlayerCollisionActor;
      bindPlayerCollisionActor(actor, playerEntity, activeMode);
      const bus = activeMode === 'bus';
      if (bus) activeMode = 'car';
      actor.spec = playerEntity.bodySpec || null;
      actor.bodyTop = activeMode === 'drone' ? 0.3 : activeMode === 'car' ? playerEntity.bodySpec?.height || 1.8 : 1.9;
      actor.bodyBottom = 0;
      actor.radius = activeMode === 'car' ? (playerEntity.bodySpec?.width || 1.72) / 2
        : activeMode === 'cargobike' ? 0.4 : activeMode === 'drone' ? 0.4 : activeMode === 'cyclist' ? 0.38 : 0.32;
      if (activeMode === 'person') actor.radius = 0.48;
      actor.mass = bus ? 28000 : activeMode === 'drone' ? 0.9 : activeMode === 'car' ? 1250 : activeMode === 'cargobike' ? 125 : activeMode === 'cyclist' ? 95 : 72;
      actor.skipStatic = playerEntity.staticSkip || null;
      actor.x = playerEntity.position.x; actor.y = playerEntity.position.y; actor.z = playerEntity.position.z;
      actor.heading = playerEntity.heading || 0;
      actor.placed = true;
      frameCollisionActors.push(actor);
    } else {
      // A hidden/naval mode may reuse this adapter later; its old trajectory is not current motion.
      activePlayerCollisionActor._wasPlaced = false;
    }
    return frameCollisionActors;
  }
  const activePlayerCollisionActor = createCollisionActor({
    kind: 'player', mode: 'person', radius: 0.32, mass: 72,
    _wasPlaced: false,
    getVelocity(out) {
      const e = this.entity, heading = e.heading || 0, speed = e.speed || 0;
      out.x = Math.sin(heading) * speed + (e.vx || 0);
      out.z = Math.cos(heading) * speed + (e.vz || 0);
      return out;
    },
    applyVelocity(dx, dz) {
      const e = this.entity, heading = e.heading || 0;
      const vx = Math.sin(heading) * (e.speed || 0) + (e.vx || 0) + dx;
      const vz = Math.cos(heading) * (e.speed || 0) + (e.vz || 0) + dz;
      const speed = vx * Math.sin(heading) + vz * Math.cos(heading);
      e.speed = speed;
      if (e.type === 'car') {
        e.vx = vx - Math.sin(heading) * speed;
        e.vz = vz - Math.cos(heading) * speed;
      }
    },
    onContact(other, nx, nz, speed) {
      if (this.mode !== 'car') return;
      applyVehicleImpact(null, this, other, nx, nz, speed);
      if (speed > 2.2 && shouldEmitImpactSparks(this, other)) {
        const x = (this.x + other.x) * 0.5, z = (this.z + other.z) * 0.5;
        spawnCollisionSparks(x, groundAt(x, z) + 0.56, z, nx, nz, speed);
      }
      if (speed > 2.2 && other.kind !== 'car' && other.kind !== 'bus') {
        reportCollision(this.entity, other.entity || other, (this.x + other.x) * 0.5,
          groundAt(this.x, this.z) + 0.56, (this.z + other.z) * 0.5, nx, nz, speed);
      }
    },
    move(dx, dz) {
      const e = this.entity;
      e.position.x += dx; e.position.z += dz;
      e.mesh?.position?.copy(e.position);
      return e.position;
    }
  });

  // Add vehicle contact shadows last + pre-allocated Clustered SpotLight / PointLight pools
  group.add(carShadowInst, busShadowInst);

  const HEADLIGHT_POOL_SIZE = 96;
  const MAX_LIGHT_DIST = 115;
  const MAX_LIGHT_DIST_SQ = MAX_LIGHT_DIST * MAX_LIGHT_DIST;
  const DUAL_BEAM_DIST_SQ = 96 * 96;
  const DUAL_BEAM_MAX_VEHICLES = 44;

  const trafficLightsGroup = new THREE.Group();
  trafficLightsGroup.name = 'TrafficClusteredLights';
  group.add(trafficLightsGroup);

  const headlightPool = [];
  for (let i = 0; i < HEADLIGHT_POOL_SIZE; i++) {
    const spot = createVehicleHeadlight();
    spot.position.set(0, -1000, 0);
    spot.target.position.set(0, -1001, 0);
    trafficLightsGroup.add(spot, spot.target);
    headlightPool.push(spot);
  }

  // Nothing shows until it has been placed
  const carInstances = [...bodyMeshes, carWheelLeftInst, carWheelRightInst, carShadowInst];
  const busInstances = [...busBodyMeshes, busWheelLeftInst, busWheelRightInst, busShadowInst,
    ...Object.values(plusSets).map((set) => set.body), plusBellowsInst, plusShadowInst];
  for (const inst of [...carInstances, ...busInstances, sparkInst]) {
    inst.frustumCulled = false;
    for (let i = 0; i < inst.count; i++) inst.setMatrixAt(i, zero);
  }

  scene.add(group);

  // =========================================================================
  // 4. WHO IS WHERE: LANE OCCUPANCY, INTERSECTIONS, VIEW, PLAYER
  // =========================================================================
  let clock = 0;
  const phaseOf = (e) => vehiclePhase(e.to.sigOffset, e.axisIndex, clock);
  let focusX = 0;
  let focusZ = 140;

  // Lane lists hold pooled { v, s } entries sorted by position s along the lane, rebuilt every frame
  const pool = [];
  let poolUsed = 0;
  const filled = [];
  function occupy(list, v, s) {
    let o = pool[poolUsed++];
    if (!o) pool.push((o = { v: null, s: 0 }));
    o.v = v;
    o.s = s;
    if (!list.length) filled.push(list);
    list.push(o);
    for (let k = list.length - 1; k > 0 && list[k - 1].s > s; k--) {
      list[k] = list[k - 1];
      list[k - 1] = o;
    }
  }

  // Half way through a lane change a vehicle still occupies the lane it is leaving (-1 left, 1 right)
  function straddle(v) {
    if (v.conn) return 0;
    if (v.dl > 0.5 && v.lane + 1 < v.edge.lanes.length) return 1;
    if (v.dl < -0.5 && v.lane > 0) return -1;
    return 0;
  }

  // A vehicle crossing an intersection, or committed to crossing it, holds it against crossing traffic and
  // pedestrians on the crosswalks it passes, and its place in the lane it heads for. The counters it raises are reset
  // next frame for just the nodes and edges touched (a few hundred out of thousands)
  const touchedNodes = [];
  const touchedEdges = [];
  const touchNode = (n) => {
    if (!n.touched) {
      n.touched = true;
      touchedNodes.push(n);
    }
    return n;
  };
  const touchEdge = (e) => {
    if (!e.touched) {
      e.touched = true;
      touchedEdges.push(e);
    }
    return e;
  };
  function claim(v) {
    if (v.claimed) return;
    v.claimed = true;
    const e = v.edge;
    const f = v.move.to;
    touchNode(e.to).box[e.axisIndex]++;
    if (!v.conn || v.cs < v.half + 2.5) e.to.crossing[e.inSide]++; // until its tail is past the crosswalk on its way in
    if (v.move.turn !== 'L') touchEdge(e).through++;
    if (!v.yielding) cross(v);
    occupy(f.occ[v.out], v, v.conn ? v.cs - v.conn.len : v.s - e.len - connector(e, v.lane, f, v.out).len);
  }

  // ...and, unless still waiting inside to turn left, the oncoming lanes and the crosswalk on its way out
  function cross(v) {
    const e = v.edge;
    if (v.move.turn === 'L') touchEdge(e).lefts++;
    touchNode(e.to).crossing[v.move.to.outSide]++;
    v.yielding = false;
  }

  function buildOccupancy() {
    for (const list of filled) list.length = 0;
    filled.length = 0;
    poolUsed = 0;
    for (const n of touchedNodes) {
      n.box.fill(0);
      n.crossing.fill(0);
      n.touched = false;
    }
    touchedNodes.length = 0;
    for (const e of touchedEdges) {
      e.through = e.lefts = 0;
      e.touched = false;
    }
    touchedEdges.length = 0;
    for (const v of vehicles) v.claimed = false;
    for (const v of vehicles) {
      const e = v.edge;
      if (!e) continue;
      if (!v.conn) {
        occupy(e.occ[v.lane], v, v.s);
        const side = straddle(v);
        if (side) occupy(e.occ[v.lane + side], v, v.s);
        if (v.commit === e.to) claim(v);
        if (v.s < v.half) touchNode(e.from).crossing[e.outSide]++; // its tail still over the crosswalk behind it
      } else {
        claim(v);
        occupy(e.occ[v.lane], v, e.len + v.cs); // until it is out of the intersection, still ahead of those behind it
      }
    }
  }

  // The camera's view, for drawing and protecting nearby spawn locations
  const frustum = new THREE.Frustum();
  const viewProjection = new THREE.Matrix4();
  let hasView = false;
  let camX = 0;
  let camY = 10;
  let camZ = 140;
  let camFwdX = 0;
  let camFwdZ = 1;
  function updateView(camera) {
    hasView = !!camera;
    if (!camera) return;
    camera.updateMatrixWorld();
    camX = camera.position.x;
    camY = camera.position.y;
    camZ = camera.position.z;
    const me = camera.matrixWorld.elements;
    camFwdX = -me[8];
    camFwdZ = -me[10];
    viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(viewProjection);
  }
  // Could the camera see a sphere of radius r around ground point (x, z)? Side planes only: the near and far
  // planes depend on depth conventions, and the side planes alone already rule out everything behind the camera.
  function visible(x, z, r) {
    if (!hasView) return false;
    for (let k = 0; k < 4; k++) {
      const { normal, constant } = frustum.planes[k];
      if (normal.x * x + normal.y + normal.z * z + constant < -r) return false;
    }
    return true;
  }

  function nearView(x, z, radius, distance) {
    return hasView && Math.hypot(x - camX, camY, z - camZ) < distance && visible(x, z, radius);
  }

  // Edges and signalized intersections around the focus, to place vehicles and pedestrians on
  let nearX = Infinity;
  let nearZ = Infinity;
  function refreshNear() {
    if (Math.hypot(focusX - nearX, focusZ - nearZ) < 40) return;
    nearX = focusX;
    nearZ = focusZ;
    nearEdges.length = 0;
    nearSignals.length = 0;
    for (const e of edges) {
      const s = clamp((focusX - e.sx) * e.dx + (focusZ - e.sz) * e.dz, 0, e.len);
      const dx = e.sx + e.dx * s - focusX, dz = e.sz + e.dz * s - focusZ;
      if (dx * dx + dz * dz < NEAR_RADIUS * NEAR_RADIUS) nearEdges.push(e);
    }
    if (typeof refreshNearRoute === 'function') refreshNearRoute(); // `typeof`: the unit tests lift this function out of its closure
    for (const n of nodes) {
      const dx = n.x - focusX, dz = n.z - focusZ;
      if (n.signal && dx * dx + dz * dz < NEAR_RADIUS * NEAR_RADIUS) nearSignals.push(n);
    }
  }

  // Where the player is relative to v: metres ahead, metres to the right, and how fast it moves v's way
  function relateToPlayer(v) {
    v.pAhead = Infinity;
    if (!player.active) return;
    const dx = player.x - v.x;
    const dz = player.z - v.z;
    if (Math.abs(dx) > LOOKAHEAD + 10 || Math.abs(dz) > LOOKAHEAD + 10) return;
    const fx = Math.sin(v.yaw);
    const fz = Math.cos(v.yaw);
    v.pAhead = dx * fx + dz * fz;
    v.pRight = dz * fx - dx * fz;
    v.pSpeed = Math.max(0, player.vx * fx + player.vz * fz);
  }

  // Gap to anyone knocked down (lying, getting up or walking back to the pavement) ahead in v's way
  function fallenGap(v) {
    const list = pedestrianSystem.fallen;
    let gap = Infinity;
    if (!list.length) return gap;
    const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw);
    for (let i = 0; i < list.length; i++) {
      const dx = list[i].x - v.x, dz = list[i].z - v.z;
      const ahead = dx * fx + dz * fz;
      if (ahead < 0 || ahead > LOOKAHEAD) continue;
      if (Math.abs(dz * fx - dx * fz) > v.halfWidth + 1.1) continue;
      gap = Math.min(gap, ahead - v.half - 1.1);
    }
    return gap;
  }

  // Gap to the player if it is ahead in the lane whose centre is `off` metres to the right of v
  function playerGap(v, off) {
    if (v.pAhead < 0 || v.pAhead > LOOKAHEAD) return Infinity;
    if (Math.abs(v.pRight - off) > v.halfWidth + player.halfW + 0.4) return Infinity;
    return v.pAhead - v.half - player.halfL;
  }

  // =========================================================================
  // 5. DRIVING
  // =========================================================================
  // The lane nearest to `lane` that move m can be made from (m.out[i] is the lane lane i leads to, or -1)
  function nearestLane(m, lane) {
    let best = -1;
    for (let i = 0; i < m.out.length; i++) {
      if (m.out[i] >= 0 && (best < 0 || Math.abs(i - lane) < Math.abs(best - lane))) best = i;
    }
    return best;
  }

  // First vehicle ahead of position s in a lane list
  function ahead(list, s, v) {
    for (const o of list) if (o.s > s && o.v !== v) return o;
    return null;
  }

  // The front-most vehicle still approaching the end of a lane: not crossing at its end yet, though maybe still coming
  // out of the intersection at its start (at s < 0)
  function leadOf(list) {
    for (let k = list.length - 1; k >= 0; k--) if (!list[k].v.conn || list[k].s < 0) return list[k];
    return null;
  }

  // Intelligent Driver Model: acceleration on a free road, and the braking term for an obstacle `gap` metres
  // (bumper to bumper) ahead moving at `speed`
  const freeAcc = (v) => v.driver.a * (1 - (v.speed / v.v0) ** 4);
  function brake(v, gap, speed, s0 = v.driver.s0, T = v.driver.T) {
    const { a, b } = v.driver;
    const desired = s0 + Math.max(0, v.speed * T + (v.speed * (v.speed - speed)) / (2 * Math.sqrt(a * b)));
    return -a * (desired / Math.max(gap, 0.1)) ** 2;
  }
  // ...and for a line d metres ahead to stop s0 short of: no time gap to keep to a line
  const stopAt = (v, d, s0 = 1) => brake(v, d, 0, s0, 0);

  // Braking for the vehicle ahead of position s in a lane list; remembers the nearest one
  function follow(v, list, s) {
    const o = ahead(list, s, v);
    if (!o) return 0;
    const gap = o.s - o.v.half - s - v.half;
    if (gap > LOOKAHEAD) return 0;
    if (gap < v.gap) {
      v.gap = gap;
      v.leaderSpeed = o.v.speed;
    }
    return brake(v, gap, o.v.speed);
  }

  // Can v, d metres before a line, still stop at it braking no harder than its driver comfortably does?
  const canStopBefore = (v, d) => freeAcc(v) + stopAt(v, d) > -v.driver.b;

  // Braking for a red (or an amber with room to stop) at the end of edge f, `d` metres ahead
  function signalAhead(v, f, d) {
    if (!f.to.signal || d > LOOKAHEAD) return 0;
    const phase = phaseOf(f);
    if (phase === 'green' || (phase === 'amber' && !canStopBefore(v, d))) return 0;
    return stopAt(v, d);
  }

  // Mostly straight on, sometimes a turn (buses keep to wide roads). Routes don't follow the camera;
  // distant vehicles are recycled instead. With `fromLane`, only moves the current lane allows.
  const weights = [];
  function chooseMove(v, fromLane) {
    const e = v.edge;
    // a Plusbus keeps to its line: the move onto the next edge of the route (from its own lane if it can)
    if (v.plus && v.line >= 0) {
      let pick = null;
      for (const m of e.moves) {
        if (!onLine(m.to, v.line)) continue;
        if (!pick || (m.out[v.lane] >= 0 && pick.out[v.lane] < 0)) pick = m;
      }
      if (pick) return pick;
      v.offRoute = true; // the route leaves the network here (or the network's roads miss it): any move, retired out of sight
    }
    let total = 0;
    for (let k = 0; k < e.moves.length; k++) {
      const m = e.moves[k];
      let w = m.turn === 'S' ? (v.bus ? 8 : 3) : 1;
      if (v.bus && m.turn !== 'S' && m.to.lanes.length < 2) w *= 0.05;
      if (m.to.chain?.busOnly) w = 0; // a busway: only the Plusbuses (above) drive on it
      if (fromLane) {
        if (m.out[v.lane] < 0) w = 0;
      } else if (Math.abs(nearestLane(m, v.lane) - v.lane) * 22 > e.len - v.s) {
        w *= 0.02; // too little road left to change lanes for it
      }
      weights[k] = w;
      total += w;
    }
    let r = Math.random() * total;
    let pick = null;
    for (let k = 0; k < e.moves.length; k++) {
      if (weights[k] <= 0) continue;
      pick = e.moves[k];
      r -= weights[k];
      if (r < 0) break;
    }
    // No move from this lane (a lane the road graph couldn't lead anywhere): take any move, changing lanes for it
    if (!pick && fromLane) return chooseMove(v, false);
    return pick || e.moves.find((m) => v.plus || !m.to.chain?.busOnly) || null; // none: it leaves the map here (retired)
  }

  // Could the vehicle of lane entry o, approaching the end of edge a, still stop easily before its line? Vehicles
  // already standing can; drivers who have been waiting a while accept any gap it can still stop for comfortably.
  function canStop(o, a, impatient) {
    const sp = o.v.speed;
    if (sp < 0.5) return true;
    const d = a.len - o.s - o.v.half;
    return impatient ? canStopBefore(o.v, d) : d > (sp * sp) / 5 + sp + 3;
  }

  // A left turn waits for oncoming traffic going straight or right (approach o); vehicles not on o yet haven't picked
  // their way on, and at a red, only those already committed to crossing still come. Waiting at the line, v
  // also takes turns with those waiting at theirs: whoever has waited longer goes first, if it has room to go.
  function yieldOncoming(o, impatient, v = null) {
    if (!o) return false;
    if (o.through > 0) return true;
    const red = o.to.signal && phaseOf(o) === 'red';
    for (const list of o.occ) {
      const lead = leadOf(list);
      if (!lead || (lead.v.edge === o && lead.v.move?.turn === 'L')) continue;
      if (red) continue;
      if (!canStop(lead, o, impatient)) return true;
      const u = lead.v;
      const j = u.edge === o && u.move ? u.move.out[u.lane] : -1;
      if (v && v.wait > 0 && u.wait > v.wait && j >= 0 && o.len - lead.s - u.half < 2 && room(u.move.to, j, u)) return true;
    }
    return false;
  }

  // How far along curve c, out of two-way edge e, v can pull forward before its front corner reaches the
  // oncoming lanes (left of the centre line): where it waits for a gap to turn left
  const corner = { x: 0, z: 0, dx: 0, dz: 1 };
  function yieldPoint(v, c, e) {
    let cs = 0;
    for (; cs < c.len; cs += 0.5) {
      curvePoint(c, cs + v.half, corner);
      const x = corner.x + corner.dz * v.halfWidth;
      const z = corner.z - corner.dx * v.halfWidth;
      if ((x - e.x0) * e.rx + (z - e.z0) * e.rz < 0.3) break;
    }
    return cs - 0.5;
  }

  // At unsignalized corners, give way to the main road.
  function yieldToCrossTraffic(v, n) {
    for (const a of n.in) {
      if (n.signal ? a.axisIndex === v.edge.axisIndex : a.axisIndex !== 0) continue;
      for (const list of a.occ) {
        const lead = leadOf(list);
        if (lead && !canStop(lead, a, !n.signal && v.wait > 8)) return true;
      }
    }
    return false;
  }

  // Seconds v takes to cover dist metres from now, speeding up from rest if it has to
  const timeTo = (v, dist) => dist / Math.max(v.speed, Math.sqrt((v.driver.a * dist) / 2), 0.1);

  // Do people on crosswalk `side` have the WALK? On the parallel green of their road's right-of-way group.
  function walkOn(side, n = null) {
    return !!n && walkPhase(n.sigOffset, n.sideGroup[side] ?? 0, clock);
  }

  // May p step off the curb onto its crosswalk? On the WALK (early in the parallel traffic's green, so red for the
  // traffic arriving over it), once no vehicle is crossing it or committed to, and none is too close to stop
  function mayCross(p) {
    const n = p.node;
    if (!walkOn(p.side, n) || n.crossing[p.side] > 0) return false;
    const e = n.approach[p.side];
    if (!e) return true;
    for (const list of e.occ) {
      const lead = leadOf(list);
      if (lead && !canStop(lead, e, true)) return false;
    }
    return true;
  }

  // Will anyone on crosswalk `side` of n be within reach of the lane meeting it at `coord` between t0 and t1
  // seconds from now? Unless `onIt`, so is anyone waiting at the curb to step off, however far away: on the WALK, they
  // only wait for the vehicles already holding the crosswalk.
  function pedestrianOn(n, side, coord, t0, t1, onIt = false) {
    for (const p of n.walkers) {
      if (p.side !== side || (onIt && p.waiting)) continue;
      const toGo = (coord - p.coord) * p.dir; // metres p still has to walk to get there
      const avoiding = clock < p.avoidUntil;
      // Runners may enter a lane sooner, then slow or stop before clearing it.
      const fast = Math.max(p.speed, p.v, avoiding ? p.avoidSpeed : 0);
      const slow = Math.max(0.1, avoiding ? Math.min(p.speed, p.v, p.avoidSpeed) : p.speed);
      if (p.waiting || ((toGo + 2.6) / slow > t0 && (toGo - 2.6) / fast < t1)) return true;
    }
    return false;
  }

  // ...on the crosswalk v leaves the intersection over, while v, its front bumper d metres before it, passes? Once v
  // holds that crosswalk (it isn't waiting inside to turn), people at the curb wait for it.
  const pedsOut = (v, d) => d > 0 && pedestrianOn(v.edge.to, v.move.to.outSide, laneCoord(v.move.to, v.out), timeTo(v, d), timeTo(v, d + 3 + 2 * v.half), !v.yielding);

  // Must v, pulled into the intersection to turn, wait there: for people crossing its way out (`peds`) or, turning
  // left, for oncoming traffic?
  const holdsOn = (v, peds) => peds || (v.move.turn === 'L' && yieldOncoming(v.edge.opposite, false));

  // Of two vehicles on the same road headed for the same lane, the one whose front is nearer the line goes first (by
  // the front: a bus waiting at the line goes before the cars that pull up beside it)
  const precedence = (u, s) => s + u.half;

  // Would there be room for v in lane j of edge f if everyone headed there queued bumper to bumper behind its far
  // stop line? (An empty lane always has room, however short.) Vehicles take turns for it: whoever has waited longer
  // to go there from another side, or goes first from v's own road, counts as already in.
  function room(f, j, v) {
    let free = f.len - 1;
    for (const o of f.occ[j]) if (o.v !== v && o.s - o.v.half < f.len) free -= 2 * o.v.half + o.v.driver.s0;
    for (const a of f.from.in) {
      if (a.to.signal && phaseOf(a) !== 'green') continue; // waiting at a red: it can't take its turn now
      for (const list of a.occ) {
        const o = leadOf(list);
        if (!o || o.v.claimed || !o.v.move || o.v.move.to !== f || o.v.move.out[o.v.lane] !== j) continue;
        if (a === v.edge ? precedence(o.v, o.s) > precedence(v, v.s) : o.v.wait > v.wait) free -= 2 * o.v.half + o.v.driver.s0;
      }
    }
    return free >= Math.min(2 * v.half + 0.5, f.len - 1);
  }

  // Would v, crossing into lane j of f to arrive at position vs, come alongside another vehicle headed there, cut in
  // ahead of one closing in on it, or close in on one ahead in a lane beside (which it doesn't follow)? Turning buses
  // swing wide, so where a bus turns, the lanes either side count too, and for one turning beside v from v's road, so
  // does how far apart they start turning (the outer one has further to go: side by side on f may be one behind the
  // other at the line, and the other way round).
  function alongside(f, j, v, vs, turn) {
    for (let k = Math.max(0, j - 1); k <= Math.min(f.lanes.length - 1, j + 1); k++) {
      for (const o of f.occ[k]) {
        const swing = turn && (v.bus || o.v.bus);
        if (o.v === v || (k !== j && !swing)) continue;
        let lo = o.s - vs; // how far ahead of v o is
        let hi = lo;
        if (swing && o.v.edge === v.edge) {
          const atLine = (o.v.conn ? v.edge.len + o.v.cs : o.v.s) - v.s;
          lo = Math.min(lo, atLine);
          hi = Math.max(hi, atLine);
        }
        const closing = hi < 0 ? o.v.speed - v.speed : lo > 0 && k !== j ? v.speed - o.v.speed : 0;
        const w = o.v.half + v.half + 1 + 2 * Math.max(0, closing);
        if (lo < w && hi > -w) return true;
      }
    }
    return false;
  }

  // Is a bus at the line in the lane on the outside of v's turn? A bus starting to turn swings its tail out over it.
  function besideTail(v) {
    const e = v.edge;
    const k = v.lane + (v.move.turn === 'R' ? -1 : 1);
    const o = v.move.turn !== 'S' && k >= 0 && k < e.lanes.length ? leadOf(e.occ[k]) : null;
    return !!o && o.v.bus && o.v !== v && e.len - o.s - o.v.half < 2;
  }

  // The lead of another of v's lanes that goes first into lane j of f or, turning where a bus is involved, into a lane
  // beside it (turning buses swing wide): v falls in behind it. As an entry { v, s } of f's lane: where it would be on
  // f now.
  const merger = { v: null, s: 0 };
  function mergingAhead(v, f, j) {
    const e = v.edge;
    merger.v = null;
    for (let i = 0; i < e.lanes.length; i++) {
      const o = i === v.lane ? null : leadOf(e.occ[i]);
      if (!o || o.v === v || o.v.claimed || !o.v.move || o.v.move.to !== f || precedence(o.v, o.s) <= precedence(v, v.s)) continue;
      if (o.v.bus && besideTail(o.v)) continue; // it waits for the bus beside its tail
      const oj = o.v.move.out[o.v.lane];
      if (oj < 0 || (oj !== j && !(Math.abs(oj - j) === 1 && v.move.turn !== 'S' && (v.bus || o.v.bus)))) continue;
      const s = o.s - e.len - connector(e, o.v.lane, f, oj).len;
      if (!merger.v || s < merger.s) {
        merger.v = o.v;
        merger.s = s;
      }
    }
    return merger.v ? merger : null;
  }

  // May v, its front bumper d metres before the stop line, enter the intersection now? Sets the exit lane.
  // Once too close to stop, v is committed: it goes, and holds the intersection from then on.
  // v.why records which test in mayEnter said no (its number), for diagnosis
  function mayEnter(v, d) {
    const e = v.edge;
    const n = e.to;
    const phase = n.signal ? phaseOf(e) : 'green';
    // Could it still stop? For a light that isn't green, also by crawling up to it, closer than it stops for lines
    const stoppable = canStopBefore(v, d) || (phase !== 'green' && v.speed * v.speed < 2 * v.driver.b * d);
    if (stoppable) v.commit = null; // could stop after all: decide afresh
    if (v.commit === n) return true;
    if (v.move.out[v.lane] < 0) {
      // missed the lane for the planned move: go wherever this lane goes instead
      if (d > 12) return (v.why = 1, false);
      v.move = chooseMove(v, true);
    }
    const m = v.move;
    const f = m.to;
    const j = m.out[v.lane];
    if (!(j >= 0 && j < f.lanes.length)) {
      if (!mayEnter.warned) {
        mayEnter.warned = true;
        console.warn('[traffic] lane leads nowhere', { lane: v.lane, lanes: e.lanes.length, out: m.out.slice(), moves: e.moves.length, x: Math.round(v.x), z: Math.round(v.z) });
      }
      return (v.why = 2, false);
    }
    if (phase === 'red' || (phase === 'amber' && stoppable)) return (v.why = 0, false);
    if (boxBusy(n, e.axisIndex)) return (v.why = 3, false); // crossing traffic inside
    const lead = ahead(e.occ[v.lane], v.s, v);
    if (lead && lead.v.yielding) return (v.why = 4, false); // the vehicle ahead waits inside to turn: wait behind the line
    if (v.bus && besideTail(v)) return (v.why = 5, false); // its tail would swing out over that bus as it starts to turn
    // At a signal, the first in line to turn pulls into the intersection to wait there for the people crossing the
    // road it turns into (they walk on the same green): short of their crosswalk or, turning left across oncoming
    // traffic, short of the oncoming lanes until there is a gap. The light changing stops both for it at the latest.
    const c = connector(e, v.lane, f, j);
    const first = n.signal && m.turn !== 'S' && !lead;
    const across = m.turn === 'L' && !!e.opposite;
    const wait = first ? (across ? yieldPoint(v, c, e) : c.len - 3 - v.half) : -1; // < 0: no room inside to wait
    if (m.turn === 'L' ? across && wait < 0 && yieldOncoming(e.opposite, v.wait > 8, v) : e.opposite && e.opposite.lefts > 0) return (v.why = 6, false);
    if (!n.signal && e.axisIndex !== 0 && yieldToCrossTraffic(v, n)) return (v.why = 7, false);
    // nobody on the crosswalks while it passes over them, on the way in and on the way out, and a free place to
    // clear the intersection to, taking turns with lanes merging into it
    if (pedestrianOn(n, e.inSide, laneCoord(e, v.lane), 0, timeTo(v, d + 2.5 + 2 * v.half))) return (v.why = 8, false);
    if (wait < 0 && pedestrianOn(n, f.outSide, laneCoord(f, j), timeTo(v, d + c.len - 3), timeTo(v, d + c.len + 2 * v.half))) return (v.why = 9, false);
    const vs = v.s - e.len - c.len; // where on f it would be now
    if (!room(f, j, v) || alongside(f, j, v, vs, m.turn !== 'S') || mergingAhead(v, f, j)) return (v.why = 10, false);
    v.out = j;
    v.yielding = wait >= 0;
    v.yieldAt = wait;
    if (!stoppable) {
      v.commit = n;
      claim(v); // at once, so vehicles and pedestrians deciding later this frame know
    }
    return true;
  }

  // Overtake into an adjacent lane when it is clearly quicker (MOBIL), or work towards a lane the planned turn
  // can be made from; either only if neither v nor its new follower has to brake hard for it. Not while still
  // pulling out of an intersection or dodging the player, nor in the last 12 m before the next.
  function changeLanes(v) {
    const e = v.edge;
    if (!v.move || v.conn || v.commit || v.panic) return;
    if (Math.abs(v.dl) > 0.5 || v.s < v.half || e.len - v.s - v.half < 12) return;
    let target = -1;
    if (v.move.out[v.lane] < 0) {
      const t = v.lane + Math.sign(nearestLane(v.move, v.lane) - v.lane);
      if (laneSafe(v, t, -4)) target = t;
    } else if (v.speed > 2) {
      let best = laneAcc(v, v.lane) + 0.6;
      for (let t = v.lane - 1; t <= v.lane + 1; t += 2) {
        if (t < 0 || t >= e.lanes.length || v.move.out[t] < 0 || !laneSafe(v, t, -3)) continue;
        const acc = laneAcc(v, t);
        if (acc > best) {
          best = acc;
          target = t;
        }
      }
    }
    if (target < 0) return;
    v.dl += e.lanes[v.lane] - e.lanes[target]; // same spot, now measured from the new lane's centre
    v.lane = target;
    v.trail = null;
  }

  // Can v move into lane t leaving itself and its new follower at least bSafe (negative) acceleration?
  function laneSafe(v, t, bSafe) {
    let lead = null;
    let back = null;
    for (const o of v.edge.occ[t]) {
      if (o.v === v) continue;
      if (o.s > v.s) {
        lead = o;
        break;
      }
      back = o;
    }
    if (lead) {
      const gap = lead.s - lead.v.half - v.s - v.half;
      if (gap < 1.5 || freeAcc(v) + brake(v, gap, lead.v.speed) < bSafe) return false;
    }
    if (back) {
      const f = back.v;
      const gap = v.s - v.half - back.s - f.half;
      if (gap < 1.5 || freeAcc(f) + brake(f, gap, v.speed) < bSafe) return false;
    }
    const off = v.edge.lanes[t] - v.edge.lanes[v.lane] - v.dl;
    const reach = v.half + player.halfL + 6;
    return !(Math.abs(v.pRight - off) < v.halfWidth + player.halfW + 0.4 && v.pAhead > -reach && v.pAhead < reach);
  }

  // Acceleration v would have in lane t behind the vehicle (or player) ahead there
  function laneAcc(v, t) {
    const o = ahead(v.edge.occ[t], v.s, v);
    let worst = o ? brake(v, o.s - o.v.half - v.s - v.half, o.v.speed) : 0;
    const pg = playerGap(v, v.edge.lanes[t] - v.edge.lanes[v.lane] - v.dl);
    if (pg < LOOKAHEAD) worst = Math.min(worst, brake(v, pg, v.pSpeed));
    return freeAcc(v) + worst;
  }

  // Fastest v can take curve c at without exceeding the sideways acceleration its driver accepts
  const bendSpeed = (v, c) => Math.sqrt(v.driver.aLat / Math.max(c.curv, 1e-3));

  // IDM acceleration for vehicles ahead in the lane (and, through the intersection, in the lane it leads to),
  // the stop line while v may not go, a red beyond, the player, and slowing down for turns and give-way lines
  function accelerate(v) {
    const e = v.edge;
    let worst = 0;
    let cap = Infinity;
    v.gap = Infinity;
    if (!v.conn) {
      worst = follow(v, e.occ[v.lane], v.s);
      const side = straddle(v);
      if (side) worst = Math.min(worst, follow(v, e.occ[v.lane + side], v.s));
      const d = e.len - v.s - v.half;
      if (d < LOOKAHEAD && v.move) {
        const go = mayEnter(v, d);
        const f = v.move.to;
        const j = v.move.out[v.lane];
        const c = j < 0 ? null : connector(e, v.lane, f, j);
        const vs = c ? v.s - e.len - c.len : 0; // position on f, measured from its start
        if (!go) {
          worst = Math.min(worst, stopAt(v, d));
        } else {
          worst = Math.min(worst, follow(v, f.occ[j], vs), signalAhead(v, f, f.len - vs - v.half));
          // pulling in to wait inside: slow down for that spot already if it will have to wait there
          if (v.yielding && holdsOn(v, pedsOut(v, d + c.len - 3))) worst = Math.min(worst, stopAt(v, d + v.half + v.yieldAt, 0.5));
        }
        // easing off to fall in behind a vehicle from another lane merging ahead into the same lane (unless committed:
        // then the others wait for v)
        const o = c && !v.claimed && mergingAhead(v, f, j);
        if (o) worst = Math.min(worst, Math.max(-v.driver.b, brake(v, o.s - o.v.half - vs - v.half, o.v.speed)));
        let vt = c ? bendSpeed(v, c) : Infinity;
        const cautious = !e.to.signal && e.axisIndex !== 0;
        if (cautious) vt = Math.min(vt, 5);
        cap = Math.sqrt(vt * vt + 5 * Math.max(0, d));
      }
    } else {
      const f = v.move.to;
      const vs = v.cs - v.conn.len;
      worst = Math.min(follow(v, f.occ[v.out], vs), follow(v, e.occ[v.lane], e.len + v.cs), signalAhead(v, f, f.len - vs - v.half));
      // someone crossing the way out: wait for them inside the intersection, short of the 2.5 m crosswalk
      const d = v.conn.len - 3 - v.cs - v.half;
      const peds = pedsOut(v, d);
      if (v.yielding && v.cs < v.yieldAt && holdsOn(v, peds)) {
        worst = Math.min(worst, stopAt(v, v.yieldAt - v.cs, 0.5)); // waiting inside to turn
      } else {
        if (v.yielding) cross(v);
        if (peds) worst = Math.min(worst, stopAt(v, d, 0.5));
      }
      cap = bendSpeed(v, v.conn);
    }
    // a Plusbus pulls up with its front doors at the next stop
    if (v.plus && v.stopD < LOOKAHEAD) worst = Math.min(worst, stopAt(v, Math.max(0, v.stopD) + 1));
    // (a player alongside, not yet clear ahead, isn't one to follow; nor is one it is swerving round: dodge brakes then)
    const pg = v.panic && v.evadeSide ? Infinity : playerGap(v, 0);
    if (pg > 0 && pg < LOOKAHEAD) {
      worst = Math.min(worst, brake(v, pg, v.pSpeed));
      if (pg < v.gap) {
        v.gap = pg;
        v.leaderSpeed = v.pSpeed;
      }
    }
    const fg = fallenGap(v);
    if (fg < LOOKAHEAD) {
      worst = Math.min(worst, brake(v, Math.max(0, fg), 0));
      if (fg < v.gap) {
        v.gap = Math.max(0, fg);
        v.leaderSpeed = 0;
      }
    }
    const acc = Math.min(freeAcc(v) + worst, (cap - v.speed) * 2);
    v.acc = clamp(acc, -9, v.driver.a);
    // dodging the player (see dodge): braking, or flooring it (unless it must brake for something ahead)
    if (v.panic && v.panicAcc < 0) v.acc = Math.min(v.acc, v.panicAcc);
    else if (v.panic && v.panicAcc > 0 && v.acc > -v.driver.b && v.speed < 1.5 * v.v0) v.acc = Math.max(v.acc, v.panicAcc);
  }

  // Dodging the player. A driver watches the player's course (curving as the player steers) against its own over the
  // next AVOID_NOTICE seconds. If they would meet (closer than AVOID_MARGIN), it has seen the stretch of road the player
  // will sweep across while level with it, and reacts once it has seen that for its reaction time: it steers the least
  // it must, right or left of its lane, to clear that stretch (the side the road and the traffic around it leave room
  // on; on a near tie the right, away from oncoming traffic), braking as it does, or braking hard if there is no way
  // out. From behind, it floors it instead. It sounds its horn as it reacts, and re-judges every frame, so a player
  // who swerves the same way is not driven into; it keeps up its manoeuvre until the danger has passed for AVOID_HOLD.
  function react(v, dt) {
    if (!player.active || clock < v.shaken) {
      calm(v);
      return;
    }
    const d = assess(v);
    if (d.time < AVOID_NOTICE) v.lastDanger = clock;
    if (!v.panic) {
      if (d.time >= AVOID_NOTICE) {
        v.alarm = 0;
        return;
      }
      v.alarm += dt;
      if (v.alarm < v.reaction) return;
      v.panic = true;
      v.warning = true;
    } else if (clock - v.lastDanger > AVOID_HOLD) {
      calm(v);
      return;
    }
    if (d.time < AVOID_NOTICE) dodge(v, d);
  }

  function calm(v) {
    v.panic = v.warning = false;
    v.evade = v.evadeSide = v.panicAcc = v.alarm = 0;
  }

  // The player's position and heading t seconds on, at its speed and turning as it is (no faster than people keep
  // turning: AVOID_TURN)
  const course = { x: 0, z: 0, fx: 0, fz: 1 };
  function predictPlayer(t, out) {
    const w = clamp(player.yawRate, -AVOID_TURN, AVOID_TURN);
    const a = w * t;
    if (Math.abs(a) < 1e-4) {
      out.x = player.x + player.vx * t;
      out.z = player.z + player.vz * t;
    } else {
      // its velocity, turning through a as it goes (heading h -> h + a), integrated
      const sin = Math.sin(a), cos = Math.cos(a);
      out.x = player.x + (player.vx * sin + player.vz * (1 - cos)) / w;
      out.z = player.z + (player.vx * (cos - 1) + player.vz * sin) / w;
    }
    const sin = Math.sin(a), cos = Math.cos(a);
    out.fx = player.fx * cos + player.fz * sin;
    out.fz = player.fz * cos - player.fx * sin;
    return out;
  }

  // How v and the player would meet, both keeping on as they go (v down its path at its speed): seconds until the
  // player would come within AVOID_MARGIN of v (Infinity if not within AVOID_NOTICE), whether at v's front half or
  // its rear, whether crossing v's way, and the stretch of road across v's path the player sweeps while level with it
  // ([lo, hi], metres right of v's path, the player's width included)
  const danger = { time: Infinity, front: true, crossing: false, lo: 0, hi: 0 };
  function assess(v) {
    danger.time = Infinity;
    if (!player.active || Math.abs(player.x - v.x) > 90 || Math.abs(player.z - v.z) > 90) return danger;
    // v's path through where it is (dl is measured from it), along (tx, tz), to the right (-tz, tx)
    const ox = v.x + v.tz * v.dl, oz = v.z - v.tx * v.dl;
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k * AVOID_STEP <= AVOID_NOTICE + 1e-6; k++) {
      const t = k * AVOID_STEP;
      predictPlayer(t, course);
      const rx = course.x - ox, rz = course.z - oz;
      const along = rx * v.tx + rz * v.tz - v.speed * t;
      const across = rz * v.tx - rx * v.tz;
      // the player's half extents along and across v's path, as it is turned
      const c = Math.abs(course.fx * v.tx + course.fz * v.tz), s = Math.abs(course.fz * v.tx - course.fx * v.tz);
      if (Math.abs(along) > v.half + player.halfL * c + player.halfW * s + AVOID_MARGIN) continue;
      const half = player.halfL * s + player.halfW * c;
      lo = Math.min(lo, across - half);
      hi = Math.max(hi, across + half);
      if (danger.time === Infinity && Math.abs(across - v.dl) < half + spread(v) + AVOID_MARGIN) {
        danger.time = t;
        // (coming at v rather than catching up with it from behind)
        danger.front = player.vx * v.tx + player.vz * v.tz < v.speed;
        // the player coming across v's way rather than along it
        danger.crossing = Math.abs(player.vz * v.tx - player.vx * v.tz) > Math.abs(player.vx * v.tx + player.vz * v.tz);
      }
    }
    danger.lo = lo;
    danger.hi = hi;
    return danger;
  }

  // How far v reaches across its path either side, as it is turned (at an angle, its corners reach further)
  function spread(v) {
    return v.halfWidth * Math.cos(v.nose) + v.half * Math.abs(Math.sin(v.nose));
  }

  // Get out of the way the danger leaves (see react), the way that gets it clear soonest: each way out is how far it
  // must move across, how much of that the road and the traffic around it leave room for, and whether it can make it
  // in time; round the player's far side (across its path) only if it can. Sticking to the way it has taken unless the
  // other is clearly better (the right on a near tie), a little further than it must if it can. Braking lightly as it
  // swerves (a car can only move across as fast as it moves along: AVOID_BRAKE), hard for a player crossing its way or
  // with no way clear (edging away from the player as far as there is room then); flooring it for a player coming up
  // from behind
  function dodge(v, d) {
    const need = v.halfWidth + AVOID_MARGIN;
    // the nearest places clear of the player's stretch either side, in metres right of v's path
    const right = d.hi + need, left = d.lo - need;
    const t = Math.max(d.time, 0.5);
    // how far it can move across in that time: at about the tyres' grip, no faster than its speed lets it, after the
    // moment it takes to turn the wheel
    const steering = Math.max(0, t - 0.3);
    const reach = Math.min(0.35 * v.driver.grip * steering * steering, 0.45 * v.speed * steering);
    const middle = (d.lo + d.hi) / 2;
    let side = 0, move = 0, room = 0, best = Infinity;
    for (const s of [1, -1]) {
      const m = s > 0 ? Math.max(0, right - v.dl) : Math.max(0, v.dl - left);
      if ((middle - v.dl) * s > 0.4 && m >= reach) continue; // (the player clearly that side)
      let r = 0;
      for (const f of [1, 0.75, 0.5, 0.25]) {
        if (m * f < AVOID_REACH && clearTo(v, v.dl + s * m * f, t)) {
          r = m * f;
          break;
        }
      }
      if (r === 0 && m > 0) continue;
      const bias = v.evadeSide === s ? AVOID_SWITCH : !v.evadeSide && s > 0 ? 0.5 : 0;
      const cost = 3 * (m - r) + m + Math.max(0, m - reach) - bias;
      if (cost < best) {
        best = cost;
        side = s;
        move = m;
        room = r;
      }
    }
    v.evadeSide = side;
    const clear = side !== 0 && room >= move;
    if (!clear) {
      v.evade = v.dl + side * room;
    } else {
      const goal = side > 0 ? right : left;
      const further = goal + side * AVOID_MARGIN;
      const aim = Math.abs(further - v.dl) < AVOID_REACH && clearTo(v, further, t) ? further : goal;
      v.evade = side > 0 ? Math.max(v.dl, aim) : Math.min(v.dl, aim);
    }
    if (!d.front) v.panicAcc = 1.5 * v.driver.a;
    else v.panicAcc = clear && !d.crossing ? -AVOID_BRAKE : -v.driver.bMax;
  }

  // Could v be `target` metres right of its path for the next t seconds: its outer side on the road (with room to
  // spare for overshooting a little), and clear of the vehicles around it as they go on?
  function clearTo(v, target, t) {
    const ox = v.x + v.tz * v.dl, oz = v.z - v.tx * v.dl;
    const outer = target + Math.sign(target - v.dl || 1) * (v.halfWidth + 0.4);
    for (const a of [0, v.half, v.half + v.speed * t]) {
      if (!network.isRoadClear(ox + v.tx * a - v.tz * outer, oz + v.tz * a + v.tx * outer, 0.2)) return false;
    }
    for (const o of vehicles) {
      if (o === v || !o.edge) continue;
      const rx = o.x - ox, rz = o.z - oz;
      if (Math.abs(rx) > 60 || Math.abs(rz) > 60) continue;
      const heading = o.yaw + o.yawOffset;
      const fx = Math.sin(heading), fz = Math.cos(heading);
      const c = Math.abs(fx * v.tx + fz * v.tz), s = Math.abs(fz * v.tx - fx * v.tz);
      for (const tt of [0, t * 0.5, t]) {
        const x = rx + (fx * o.speed + o.vx) * tt, z = rz + (fz * o.speed + o.vz) * tt;
        const along = x * v.tx + z * v.tz - v.speed * tt;
        const across = z * v.tx - x * v.tz;
        if (Math.abs(along) < v.half + o.half * c + o.halfWidth * s
          && Math.abs(across - target) < v.halfWidth + o.halfWidth * c + o.half * s + 0.3) return false;
      }
    }
    return true;
  }


  // Front bumper at the stop line: cross if allowed, or if going too fast to stop; otherwise wait there
  function enter(v) {
    const e = v.edge;
    if (!mayEnter(v, 0)) {
      const j = v.move.out[v.lane];
      if (v.speed < 4 || j < 0) {
        v.s = e.len - v.half;
        v.speed = 0;
        return;
      }
      v.out = j;
      v.yielding = false;
    }
    v.cs = v.s - e.len;
    v.conn = connector(e, v.lane, v.move.to, v.out);
    claim(v); // at once, so vehicles deciding later this frame know
  }

  let jamRetired = 0;
  function retire(v) {
    v.edge = null;
    v.move = null;
    v.speed = 0;
    v.conn = null;
  }

  // Swaps the road network (a streamed city re-centres it on the camera): everyone is taken off the old one and placed afresh
  // around the focus on the new one by the next updates.
  function setNetwork(net) {
    for (const v of vehicles) {
      retire(v);
      v.claimed = false;
      v.trail = null;
      v.commit = null;
      v.yielding = false;
    }
    bindNetwork(net);
    nearX = Infinity;
    nearZ = Infinity;
    nearEdges.length = 0;
    nearSignals.length = 0;
    pedestrianSystem.setNetwork(net);
  }

  function leave(v) {
    v.s = v.cs - v.conn.len;
    v.edge = v.move.to;
    v.lane = v.out;
    v.trail = v.conn; // the rear axle is still on it
    v.conn = null;
    v.commit = null;
    v.move = chooseMove(v, false);
  }

  function drive(v, dt) {
    if (v.plus) {
      // at a stop: the doors open, stay open for PLUS_DWELL, and shut before it moves off
      if (v.dwell > 0) {
        v.dwell -= dt;
        v.speed = v.acc = 0;
        v.doors = Math.min(1, v.doors + dt);
        if (v.dwell <= 0) v.servedS = v.nextStop;
        return;
      }
      if (v.doors > 0) {
        v.doors = Math.max(0, v.doors - dt);
        v.speed = v.acc = 0;
        return;
      }
      if (v.offRoute && !(hasView && visible(v.x, v.z, 30))) {
        retire(v);
        return;
      }
      trackLine(v);
      if (v.stopD < 2.5 && v.speed < 0.5) {
        v.dwell = PLUS_DWELL;
        v.speed = v.acc = 0;
        return;
      }
    }
    v.laneTimer -= dt;
    if (v.laneTimer <= 0) {
      v.laneTimer = 0.4 + Math.random() * 0.3;
      changeLanes(v);
    }
    accelerate(v);
    // after a crash: to a stop, and staying there for a while (see applyVehicleImpact)
    if (clock < v.shaken) v.acc = Math.min(v.acc, -0.75 * v.driver.bMax);
    const speed = v.speed;
    v.speed = Math.max(0, v.speed + v.acc * dt);
    let ds = v.speed * Math.cos(v.nose) * dt; // (along its path, heading off it as it may be)
    if (ds > v.gap - 0.3) {
      // never into the vehicle ahead
      ds = Math.max(0, v.gap - 0.3);
      v.speed = Math.min(v.speed, v.leaderSpeed);
    }
    v.acc = Math.max(-9, (v.speed - speed) / dt); // as driven, for the body to pitch with: none standing still
    v.wait = v.speed < 0.5 ? v.wait + dt : 0;
    // held in a solid in the last collision pass and not getting anywhere: wedged
    v.wedged = v.wedgedAt >= updates - 1 && v.speed < 0.5 ? (v.wedged || 0) + dt : 0;
    if (v.wedged > PINNED_WAIT) {
      v.wedged = 0;
      jamRetired++;
      retire(v);
      return;
    }
    // Copenhagen's short junction-to-junction links gridlock when full: a vehicle held for JAM_WAIT seconds (out of sight,
    // else twice that) leaves the road and is placed afresh, as a driver turning off the map would
    if (v.wait > (hasView && visible(v.x, v.z, 8) ? 2 * JAM_WAIT : JAM_WAIT)) {
      jamRetired++;
      retire(v);
      return;
    }
    if (!v.conn) {
      v.s += ds;
      if (v.s + v.half >= v.edge.len) {
        if (v.move) enter(v);
        else retire(v); // a road that only leads out of the district: respawned elsewhere
      }
    } else {
      v.cs += ds;
      if (v.cs >= v.conn.len) leave(v);
    }
    if (!v.edge) return; // retired off a road that leads out of the district: placed afresh, nothing to steer along
    steer(v, dt);
  }

  // The driver at the wheel. It steers for the bend in its path a moment ahead (on through the intersection ahead the
  // way it plans to cross it), to head along its path, and back onto it: onto its lane centre after lane changes and
  // knocks, or right of it by however far it swerves out of the player's way (Stanley steering). It turns the front
  // wheels no faster than a person does and no further than it is comfortable with (or, in a panic, than the tyres
  // grip). The car turns only as fast as its front wheels turn it, the tyres sliding at their grip; a knock's spin
  // turns it too, the tyres scrubbing that off. Heading off its path, it drifts across it.
  const bendA = { x: 0, z: 0, dx: 0, dz: 1 };
  const bendB = { x: 0, z: 0, dx: 0, dz: 1 };
  function steer(v, dt) {
    const panic = !!v.evade;
    const wheelbase = 2 * v.axle;
    const c = v.conn ? v.cs : v.s;
    // the bend a moment ahead, as the wheel takes a while to turn: its curvature (to the left) over 2 m
    const ahead = v.axle + 0.5 * v.speed;
    previewPoint(v, c + ahead, bendA);
    previewPoint(v, c + ahead + 2, bendB);
    let bend = Math.atan2(bendB.dx, bendB.dz) - Math.atan2(bendA.dx, bendA.dz);
    bend -= Math.round(bend / (Math.PI * 2)) * Math.PI * 2;
    // ...plus how far right of its path it heads, and how far right of where it should be it is (nose and dl - evade)
    const off = v.dl - (v.evade || 0);
    const want = Math.atan((wheelbase * bend) / 2) + v.nose + Math.atan(((panic ? 3 : 1.2) * off) / (1 + v.speed));
    const lateral = panic ? v.driver.grip : 1.3 * v.driver.aLat; // the sideways acceleration it steers up to
    // Refshaleøen's junction curves are often tighter than a car turns at full lock (a radius under 1 m where the lanes end
    // near the node): there it turns the wheels as far as the curve needs, or it would swing out across the junction
    const need = Math.min(LOCK_MAX, 1.15 * Math.abs(Math.atan((wheelbase * bend) / 2)));
    const most = Math.min(Math.max(v.driver.lock, need), Math.atan((lateral * wheelbase) / Math.max(v.speed * v.speed, 1e-3)));
    const rate = v.driver.steerRate * (panic ? 3.5 : clamp(8 / Math.max(v.speed, 1), 1, 3)) * dt;
    v.delta += clamp(clamp(want, -most, most) - v.delta, -rate, rate);
    const slide = v.driver.grip / Math.max(v.speed, 0.1);
    v.yawRate = clamp((v.speed * Math.tan(v.delta)) / wheelbase, -slide, slide);
    v.yaw += (v.yawRate + v.yawVel) * dt;
    v.yaw -= Math.round(v.yaw / (Math.PI * 2)) * Math.PI * 2;
    v.yawVel -= Math.sign(v.yawVel) * Math.min(Math.abs(v.yawVel), SPIN_FRICTION * dt); // (the tyres scrubbing a spin off)
    // across its path, heading off it (nose: how far right of its path it heads)
    const pathYaw = Math.atan2(v.tx, v.tz);
    let nose = pathYaw - v.yaw;
    nose -= Math.round(nose / (Math.PI * 2)) * Math.PI * 2;
    // ...but no further than NOSE_MAX unless swerving or spun by a knock: where a path turns faster than any car can
    // (a lane-to-lane link of a metre or two turning 90°), the car is turned with it instead of ending up sideways
    if (!panic && v.yawVel === 0 && Math.abs(nose) > NOSE_MAX) {
      nose = Math.sign(nose) * NOSE_MAX;
      v.yaw = pathYaw - nose;
    }
    v.dlv = v.speed * Math.sin(nose);
    v.dl += v.dlv * dt;
  }

  // Point and direction c metres along v's path, as pathPoint, but on through the intersection ahead the way v plans
  // to cross it
  function previewPoint(v, c, out) {
    const e = v.edge;
    const j = v.conn || c <= e.len || !v.move ? -1 : v.move.out[v.lane];
    if (!(j >= 0)) return pathPoint(v, c, out);
    const k = connector(e, v.lane, v.move.to, j);
    if (c - e.len <= k.len) return curvePoint(k, c - e.len, out);
    return lanePoint(v.move.to, j, c - e.len - k.len, out);
  }

  // Point and direction at distance c along v's path: its lane, the curve through the intersection, and the
  // lane after it (or, just out of an intersection, the curve it came along)
  function lanePoint(e, i, s, out) {
    out.x = e.sx + e.dx * s + e.rx * e.lanes[i];
    out.z = e.sz + e.dz * s + e.rz * e.lanes[i];
    out.dx = e.dx;
    out.dz = e.dz;
    return out;
  }
  function pathPoint(v, c, out) {
    const e = v.edge;
    if (v.conn) {
      if (c < 0) return lanePoint(e, v.lane, e.len + c, out);
      if (c > v.conn.len) return lanePoint(v.move.to, v.out, c - v.conn.len, out);
      return curvePoint(v.conn, c, out);
    }
    if (c < 0 && v.trail) return curvePoint(v.trail, v.trail.len + c, out);
    return lanePoint(e, v.lane, c, out);
  }

  // World position from where v is along its path (dl to the right of it), the path's direction there, and how far
  // right of it v heads (nose)
  const front = { x: 0, z: 0, dx: 0, dz: 0 }; // (a Plusbus's front bumper, see trackLine)
  const at = { x: 0, z: 0, dx: 0, dz: 0 };
  function locate(v) {
    pathPoint(v, v.conn ? v.cs : v.s, at);
    v.tx = at.dx;
    v.tz = at.dz;
    v.x = at.x - at.dz * v.dl;
    v.z = at.z + at.dx * v.dl;
    const nose = Math.atan2(at.dx, at.dz) - v.yaw;
    v.nose = nose - Math.round(nose / (Math.PI * 2)) * Math.PI * 2;
  }

  // Move v along and across its path by (dx, dz), as far as the road allows: along within its path, across until its
  // side meets the curb (or SHOVE_REACH from its lane). Returns whether the curb stopped it
  function shove(v, dx, dz) {
    const along = dx * v.tx + dz * v.tz;
    if (v.conn) v.cs = clamp(v.cs + along, -v.half, v.conn.len - 0.01);
    else v.s = clamp(v.s + along, 0, v.edge.len - v.half);
    const to = clamp(v.dl + dz * v.tx - dx * v.tz, -SHOVE_REACH, SHOVE_REACH);
    let blocked = false;
    // (a side already off the carriageway, cutting a junction corner or where the index has no road, isn't held back)
    if (to !== v.dl && sideOnRoad(v, v.dl, Math.sign(to - v.dl)) && !sideOnRoad(v, to, Math.sign(to - v.dl))) {
      // as far as it fits
      let lo = 0, hi = 1;
      for (let k = 0; k < 6; k++) {
        const mid = (lo + hi) / 2;
        if (sideOnRoad(v, v.dl + (to - v.dl) * mid, Math.sign(to - v.dl))) lo = mid;
        else hi = mid;
      }
      v.dl += (to - v.dl) * lo;
      blocked = true;
    } else {
      v.dl = to;
    }
    locate(v);
    return blocked;
  }

  // Would v's side (right for side 1, left for -1) still be on the road, front and back, `dl` metres right of its path?
  const sidePoint = { x: 0, z: 0, dx: 0, dz: 0 };
  function sideOnRoad(v, dl, side) {
    pathPoint(v, v.conn ? v.cs : v.s, sidePoint);
    const outer = dl + side * v.halfWidth;
    for (const a of [-0.8 * v.half, 0.8 * v.half]) {
      const x = sidePoint.x + sidePoint.dx * a - sidePoint.dz * outer;
      const z = sidePoint.z + sidePoint.dz * a + sidePoint.dx * outer;
      if (!network.isRoadClear(x, z, 0.05)) return false;
    }
    return true;
  }

  // Steering shown on the front wheels, turn signals, and body pitch & roll from acceleration & turning (the heading
  // itself is the driver's doing, see steer)
  function pose(v, dt) {
    v.steer = clamp(v.delta, -v.driver.lock, v.driver.lock); // (drawn no further than a real wheel turns, see steer)

    const turn = v.move ? v.move.turn : 'S';
    if (v.evade) v.blink = 0; // no time to signal a swerve
    else if (Math.abs(v.dl) > 0.3 && Math.abs(v.dlv) > 0.05) v.blink = v.dl > 0 ? -1 : 1;
    else if (turn !== 'S' && (v.conn || v.edge.len - v.s < 35)) v.blink = turn === 'R' ? 1 : -1;
    else v.blink = 0;

    v.pitchVel += ((-0.008 * v.acc - v.pitch) * 68.0 - v.pitchVel * 10.8) * dt;
    v.pitch = clamp(v.pitch + v.pitchVel * dt, -0.22, 0.22);
    v.rollVel += ((0.01 * v.speed * v.yawRate - v.roll) * 68.0 - v.rollVel * 10.8) * dt;
    v.roll = clamp(v.roll + v.rollVel * dt, -0.26, 0.26);
  }

  // Knock velocity from collisions (a sideways slide, a roll backwards) carries v along and across its path until the
  // tyres' grip stops it (SLIDE_FRICTION), or sideways, the curb does
  function knock(v, dt) {
    if (v.vx === 0 && v.vz === 0) return;
    if (shove(v, v.vx * dt, v.vz * dt)) {
      const across = v.vz * v.tx - v.vx * v.tz;
      v.vx += v.tz * across;
      v.vz -= v.tx * across;
    }
    const k = Math.hypot(v.vx, v.vz);
    const keep = Math.max(0, k - SLIDE_FRICTION * dt) / (k || 1);
    v.vx *= keep;
    v.vz *= keep;
  }

  // =========================================================================
  // 6. PLACING VEHICLES
  // =========================================================================
  // Room at s in a lane list: margin metres to the vehicles either side, and two seconds more for the one behind
  function laneClear(list, s, margin) {
    for (const o of list) if (Math.abs(o.s - s) < o.v.half + margin + (o.s < s ? 2 * o.v.speed : 0)) return false;
    return true;
  }

  function place(v, e, lane, s) {
    v.edge = e;
    v.lane = lane;
    v.s = s;
    v.conn = null;
    v.trail = null;
    v.commit = null;
    v.yielding = false;
    v.wait = 0;
    v.speed = v.v0 * 0.5;
    v.acc = 0;
    v.dl = v.dlv = 0;
    calm(v);
    v.lastDanger = -Infinity;
    v.shaken = 0;
    v.vx = v.vz = v.yawOffset = v.yawVel = v.pitch = v.pitchVel = v.roll = v.rollVel = 0;
    locate(v);
    // on a road under a bridge it stands under it, on the bridge on it: walked out from the edge's end that is off the decks
    const seed = options.groundHeight?.levelAlong ? options.groundHeight.levelAlong(e.sx, e.sz, e.dx, e.dz, e.len, s) : NaN;
    v.gy = levelAt(v.x, v.z, seed);
    v.gs = v.gy;
    v.prevX = v.x;
    v.prevZ = v.z;
    v.yaw = Math.atan2(v.tx, v.tz); // (placed heading down its lane)
    v.nose = v.yawRate = v.steer = v.delta = 0;
    v.move = chooseMove(v, false);
    occupy(e.occ[lane], v, s);
  }

  // A Plusbus goes in the curb lane of an edge on one of the lines' routes, its stops ahead of it still to serve
  // The near edges a Plusbus could be placed on, with their line: rebuilt with the near edges (refreshNear) and when the lines arrive
  const nearRoute = [];
  function refreshNearRoute() {
    nearRoute.length = 0;
    for (const e of nearEdges) {
      // the old town's links are short: the nose has to fit on the edge, the tail may reach back over the one before
      if (e.len < URBINO_24.length / 2 + 6.2) continue;
      for (let li = 0; li < busLines.length; li++) if (onLine(e, li)) nearRoute.push(e, li);
    }
  }

  const PLUS_SPAWN_RETRY = 0.5; // s between a waiting Plusbus's placement attempts
  function spawnPlus(v, rMin, rMax, protectView) {
    if (!nearRoute.length || clock < (v.nextSpawnTry || 0)) return false;
    v.nextSpawnTry = clock + PLUS_SPAWN_RETRY;
    for (let attempt = 0; attempt < 6; attempt++) {
      const k = 2 * Math.floor(Math.random() * (nearRoute.length / 2));
      const e = nearRoute[k], li = nearRoute[k + 1];
      const lane = curbLane(e);
      const along = (focusX - e.sx) * e.dx + (focusZ - e.sz) * e.dz;
      const minS = Math.max(Math.min(v.half + 2, e.len - v.half - 3), along - rMax);
      const maxS = Math.min(e.len - v.half - 3, along + rMax);
      if (minS > maxS) continue;
      const s = minS + Math.random() * (maxS - minS);
      const x = e.sx + e.dx * s + e.rx * e.lanes[lane];
      const z = e.sz + e.dz * s + e.rz * e.lanes[lane];
      const d = Math.hypot(x - focusX, z - focusZ);
      if (d < rMin || d > rMax || (protectView && nearView(x, z, v.half + 4, VEHICLE_SPAWN_DISTANCE))) continue;
      if (player.active && Math.hypot(x - player.x, z - player.z) < 35) continue;
      // the previous edge must not be another vehicle's: the tail would sit on it
      if (s < v.half && e.from && edges.some((f) => f.to === e.from && f.occ.some((l) => l.length) && onLine(f, li))) continue;
      if (!laneClear(e.occ[lane], s, v.half + 8)) continue;
      if (plusbuses.some((o) => o !== v && o.edge && Math.hypot(o.x - x, o.z - z) < 120)) continue; // spread along the line
      if (typeof spawnClear === 'function' && !spawnClear(x, z, Math.atan2(e.dx, e.dz), v.spec)) continue;
      v.line = li;
      v.offRoute = false;
      v.dwell = v.doors = 0;
      v.artPlaced = false;
      // the stops behind its front are served already
      v.servedS = lineProject(busLines[li], x + e.dx * v.half, z + e.dz * v.half).s;
      place(v, e, lane, s);
      return true;
    }
    return false;
  }

  // Where a Plusbus is on its line: the front bumper's distance along the path, the next stop's distance ahead of it (stopD), and
  // off the route when the bumper is far from the path
  function trackLine(v) {
    const L = busLines[v.line];
    if (!L) { v.stopD = Infinity; return; }
    pathPoint(v, (v.conn ? v.cs : v.s) + v.half - 0.2, front);
    const q = lineProject(L, front.x, front.z);
    v.frontS = q.s;
    if (q.d > PLUS_ROUTE_TOLERANCE * 1.5) v.offRoute = true;
    v.stopD = Infinity;
    for (const s of L.stops) {
      if (s <= v.servedS) continue;
      if (s < v.frontS - 3) { v.servedS = s; continue; } // passed without stopping (placed beyond it, or pushed past)
      v.stopD = s - v.frontS;
      v.nextStop = s;
      break;
    }
  }

  // The three modules from the lane path: the front module's two axles on the path (offset dl to the side), the trailers following
  const plusFrontAxle = { x: 0, z: 0, dx: 0, dz: 0 };
  const plusRearAxle = { x: 0, z: 0, dx: 0, dz: 0 };
  function posePlus(v) {
    const nose = (v.conn ? v.cs : v.s) + URBINO_24.length / 2;
    pathPoint(v, nose - URBINO_24.axles[0], plusFrontAxle);
    pathPoint(v, nose - URBINO_24.axles[1], plusRearAxle);
    const h = Math.atan2(plusFrontAxle.x - plusRearAxle.x, plusFrontAxle.z - plusRearAxle.z);
    const rx = plusRearAxle.x - v.tz * v.dl, rz = plusRearAxle.z + v.tx * v.dl;
    const art = v.art;
    if (!v.artPlaced || Math.hypot(art.state.x - rx, art.state.z - rz) > 6) {
      const ahead = URBINO_24.axles[1] - (URBINO_24.modules[0].from + URBINO_24.modules[0].to) / 2;
      art.place(rx + Math.sin(h) * ahead, rz + Math.cos(h) * ahead, h);
      v.artPlaced = true;
    } else {
      art.follow(rx, rz, h);
    }
    const m = art.module(0);
    v.cox = m.x - v.x;
    v.coz = m.z - v.z;
    v.frontYaw = m.yaw;
  }

  // Put v in a free lane around the focus. Normal replenishment protects the near view; teleports can fill it.
  function spawnVehicle(v, rMin, rMax, protectView) {
    if (v.plus) return spawnPlus(v, rMin, rMax, protectView);
    for (let attempt = 0; attempt < 12; attempt++) {
      const e = nearEdges[Math.floor(Math.random() * nearEdges.length)];
      if (!e || e.chain?.busOnly || (v.bus && e.axis !== 'ave') || e.len < 2 * v.half + 10) continue;
      const lane = Math.floor(Math.random() * e.lanes.length);
      const along = (focusX - e.sx) * e.dx + (focusZ - e.sz) * e.dz;
      const minS = Math.max(v.half + 5, along - rMax);
      const maxS = Math.min(e.len - v.half - 5, along + rMax);
      if (minS > maxS) continue;
      const s = minS + Math.random() * (maxS - minS);
      const x = e.sx + e.dx * s + e.rx * e.lanes[lane];
      const z = e.sz + e.dz * s + e.rz * e.lanes[lane];
      const d = Math.hypot(x - focusX, z - focusZ);
      if (d < rMin || d > rMax || (protectView && nearView(x, z, v.half + 4, VEHICLE_SPAWN_DISTANCE))) continue;
      if (player.active && Math.hypot(x - player.x, z - player.z) < 25) continue;
      if (!laneClear(e.occ[lane], s, v.half + 8)) continue;
      // never in a parked car, a pole or a wall (the streamed tiles' solids may sit on a lane the road graph runs along); `typeof`:
      // the unit tests lift this function out of its closure
      if (typeof spawnClear === 'function' && !spawnClear(x, z, Math.atan2(e.dx, e.dz), v.bus ? v.spec : BODY_SPECS[v.bodyType])) continue;
      place(v, e, lane, s);
      return true;
    }
    return false;
  }

  // =========================================================================
  // 7. RENDERING
  // =========================================================================
  // Beyond CAR_PROXY_DISTANCE, cars use the ~500-triangle stand-in with built-in wheels instead of the full lofted
  // body + 4 separate wheel instances; vehicles outside the view frustum (with a margin for cast shadows and headlight
  // cones) are skipped altogether.
  const CAR_PROXY_DISTANCE = 90;
  const dirtyPaint = new Set();
  const dirtyState = new Set();
  const litVehicles = [];
  let litVehicleCount = 0;
  let wheelCars = 0;
  let visibleCars = 0;
  let visibleBuses = 0;
  let busAxles = 0;
  let updates = 0;

  function flagRange(attr, n) {
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, n * attr.itemSize);
    attr.needsUpdate = true;
  }

  // 3D spinning alloy wheels & tires (left & right, front & rear), exact 1:1 ground rolling, steering front wheels.
  // Shared wheels are modelled at baseRadius, then scaled to each body’s rolling radius.
  function placeWheels(v, i, rotY, roll, radius, halfTrack, halfBase, leftInst, rightInst, baseRadius = 0.37, axles = null) {
    const sinY = Math.sin(rotY);
    const cosY = Math.cos(rotY);
    const scale = radius / baseRadius;
    dummy.scale.set(scale, scale, scale);
    const count = axles ? axles.length : 2;
    for (let w = 0; w < count; w++) {
      const wz = axles ? axles[w] : w === 0 ? halfBase : -halfBase;
      dummy.rotation.set(v.wheelSpin + w * 0.55, rotY + (w === 0 ? v.steer : 0), roll, 'YXZ');
      dummy.position.set(v.x - halfTrack * cosY + wz * sinY, radius + vehicleGround(v), v.z + halfTrack * sinY + wz * cosY);
      dummy.updateMatrix();
      leftInst.setMatrixAt(i + w, dummy.matrix);

      dummy.position.set(v.x + halfTrack * cosY + wz * sinY, radius + vehicleGround(v), v.z - halfTrack * sinY + wz * cosY);
      dummy.updateMatrix();
      rightInst.setMatrixAt(i + w, dummy.matrix);
    }
  }

  // Lamp state for the car & bus materials: brake lights while slowing down or standing, the turn signal on the side
  // v is heading for (left = +x)
  function writeLampState(v, array, o) {
    const hazard = clock < v.shaken; // (after a crash, see applyVehicleImpact)
    const blinkOn = (v.blink !== 0 || hazard) && (clock + v.blinkPhase) % 0.8 <= 0.4;
    array[o] = v.acc < -0.8 || v.speed < 0.3 ? 1 : 0;
    array[o + 1] = blinkOn && (v.blink < 0 || hazard) ? 1 : 0;
    array[o + 2] = blinkOn && (v.blink > 0 || hazard) ? 1 : 0;
  }

  function renderCar(c) {
    const rotY = c.yaw + c.yawOffset;
    const sinY = Math.sin(rotY);
    const cosY = Math.cos(rotY);
    const spec = BODY_SPECS[c.bodyType];
    const forwardDist = (c.x - c.prevX) * sinY + (c.z - c.prevZ) * cosY;
    const rawStep = forwardDist / spec.wheelRadius;
    c.wheelSpin = (c.wheelSpin + Math.sign(rawStep) * Math.min(Math.abs(rawStep), 0.48)) % (Math.PI * 2);
    if (hasView && !visible(c.x, c.z, 18)) return;

    const near = Math.hypot(c.x - focusX, c.z - focusZ) < CAR_PROXY_DISTANCE;
    const bodyInst = near ? bodies[c.bodyType].near : bodies[c.bodyType].far;
    const slot = bodyInst.count++;

    dummy.position.set(c.x, vehicleGround(c), c.z);
    dummy.rotation.set(c.pitch, rotY, c.roll, 'YXZ');
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    bodyInst.setMatrixAt(slot, dummy.matrix);

    const attrs = bodyInst.geometry.attributes;
    const paint = attrs.paintColor.array;
    const o3 = slot * 3;
    if (paint[o3] !== c.paint[0] || paint[o3 + 1] !== c.paint[1] || paint[o3 + 2] !== c.paint[2]) {
      paint[o3] = c.paint[0];
      paint[o3 + 1] = c.paint[1];
      paint[o3 + 2] = c.paint[2];
      dirtyPaint.add(bodyInst);
    }
    const state = attrs.carState.array;
    const o4 = slot * 4;
    const hazard = clock < c.shaken; // (after a crash, see applyVehicleImpact)
    const blinkOn = (c.blink !== 0 || hazard) && (clock + c.blinkPhase) % 0.8 <= 0.4;
    const b0 = c.acc < -0.8 || c.speed < 0.3 ? 1 : 0;
    const b1 = blinkOn && (c.blink < 0 || hazard) ? 1 : 0;
    const b2 = blinkOn && (c.blink > 0 || hazard) ? 1 : 0;
    const b3 = c.taxi ? 1 : 0;
    if (state[o4] !== b0 || state[o4 + 1] !== b1 || state[o4 + 2] !== b2 || state[o4 + 3] !== b3) {
      state[o4] = b0;
      state[o4 + 1] = b1;
      state[o4 + 2] = b2;
      state[o4 + 3] = b3;
      dirtyState.add(bodyInst);
    }

    // Soft Under-Car Contact Shadow (AO) stays flat on the asphalt
    const visIdx = visibleCars++;
    dummy.rotation.set(0, rotY, 0, 'YXZ');
    dummy.position.set(c.x, 0.018 + vehicleGround(c), c.z);
    dummy.scale.set(spec.width + 0.3, 1.0, spec.length + 0.5);
    dummy.updateMatrix();
    carShadowInst.setMatrixAt(visIdx, dummy.matrix);

    const dxCam = c.x - camX;
    const dzCam = c.z - camZ;
    const distSq = dxCam * dxCam + dzCam * dzCam + camY * camY;
    if (distSq < MAX_LIGHT_DIST_SQ) {
      const d = Math.sqrt(distSq);
      const forwardDot = dxCam * camFwdX + dzCam * camFwdZ;
      const effDist = d + Math.max(0, 5.0 - forwardDot) * 3.2;
      if (effDist < MAX_LIGHT_DIST) {
        c._camDistSq = distSq;
        c._effDist = effDist;
        c._sinY = sinY;
        c._cosY = cosY;
        c._braking = b0;
        litVehicles[litVehicleCount++] = c;
      }
    }

    if (near) {
      placeWheels(c, wheelCars++ * 2, rotY, c.roll, spec.wheelRadius, spec.wheelX, spec.wheelZ, carWheelLeftInst, carWheelRightInst);
    }
  }

  function renderBus(b) {
    const spec = b.spec;
    const set = busSets[spec.name];
    const rotY = b.yaw + b.yawOffset;
    const sinY = Math.sin(rotY);
    const cosY = Math.cos(rotY);
    const forwardDist = (b.x - b.prevX) * sinY + (b.z - b.prevZ) * cosY;
    const rawStep = forwardDist / spec.wheelRadius;
    b.wheelSpin = (b.wheelSpin + Math.sign(rawStep) * Math.min(Math.abs(rawStep), 0.48)) % (Math.PI * 2);
    if (hasView && !visible(b.x, b.z, 22)) return;

    const i = visibleBuses++;
    dummy.position.set(b.x, 0.018 + vehicleGround(b), b.z);
    dummy.rotation.set(0, rotY, 0, 'YXZ');
    dummy.scale.set(spec.width + 0.32, 1.0, spec.length + 0.55);
    dummy.updateMatrix();
    busShadowInst.setMatrixAt(i, dummy.matrix);

    // Lofted Bus Body is defined in ground-relative Y (0.36m skirt to 3.0m roof crown)
    dummy.position.set(b.x, vehicleGround(b), b.z);
    dummy.rotation.set(b.pitch, rotY, b.roll, 'YXZ');
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    const slot = set.count++;
    set.body.setMatrixAt(slot, dummy.matrix);
    writeLampState(b, set.states.array, slot * 4);

    const dxCam = b.x - camX;
    const dzCam = b.z - camZ;
    const distSq = dxCam * dxCam + dzCam * dzCam + camY * camY;
    if (distSq < MAX_LIGHT_DIST_SQ) {
      const d = Math.sqrt(distSq);
      const forwardDot = dxCam * camFwdX + dzCam * camFwdZ;
      const effDist = d + Math.max(0, 5.0 - forwardDot) * 3.2;
      if (effDist < MAX_LIGHT_DIST) {
        b._camDistSq = distSq;
        b._effDist = effDist;
        b._sinY = sinY;
        b._cosY = cosY;
        b._braking = b.acc < -0.8 || b.speed < 0.3 ? 1 : 0;
        litVehicles[litVehicleCount++] = b;
      }
    }

    placeWheels(b, busAxles, rotY, 0, spec.wheelRadius, spec.wheelX, spec.wheelZ, busWheelLeftInst, busWheelRightInst, spec.wheelRadius, spec.axles);
    busAxles += spec.axles ? spec.axles.length : 2;
  }

  // A Plusbus: three module bodies (the front one under its direction's sign), two bellows between their faces, four axles of
  // wheels, a contact shadow per module; the doors open in the body state's w
  let plusBellowsCount = 0;
  let plusShadowCount = 0;
  const plusModuleSets = [null, plusSets[URBINO_24_SPECS[1].name], plusSets[URBINO_24_SPECS[2].name]];
  function renderPlus(v) {
    const rotY = v.frontYaw;
    const forwardDist = (v.x - v.prevX) * Math.sin(rotY) + (v.z - v.prevZ) * Math.cos(rotY);
    v.wheelSpin = (v.wheelSpin + clamp(forwardDist / 0.48, -0.48, 0.48)) % (Math.PI * 2);
    if (hasView && !visible(v.x, v.z, URBINO_24.length / 2 + 6)) return;
    const art = v.art;
    plusModuleSets[0] = plusSets[(busLines[v.line]?.back ? URBINO_24_FRONT_BACK : URBINO_24_SPECS[0]).name];
    for (let i = 0; i < 3; i++) {
      const m = art.module(i);
      const spec = URBINO_24_SPECS[i];
      const set = plusModuleSets[i];
      const y = levelAt(m.x, m.z, vehicleGround(v));
      const sinY = Math.sin(m.yaw), cosY = Math.cos(m.yaw);
      dummy.position.set(m.x, y, m.z);
      dummy.rotation.set(0, m.yaw, 0, 'YXZ');
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      const slot = set.count++;
      set.body.setMatrixAt(slot, dummy.matrix);
      writeLampState(v, set.states.array, slot * 4);
      set.states.array[slot * 4 + 3] = v.doors;

      dummy.position.set(m.x, 0.018 + y, m.z);
      dummy.scale.set(spec.width + 0.4, 1, spec.length + 0.3);
      dummy.updateMatrix();
      plusShadowInst.setMatrixAt(plusShadowCount++, dummy.matrix);

      dummy.scale.set(1, 1, 1);
      spec.axles.forEach((wz, k) => {
        const steer = i === 0 && k === 0 ? v.steer : 0;
        dummy.rotation.set(v.wheelSpin + k * 0.55, m.yaw + steer, 0, 'YXZ');
        dummy.position.set(m.x - spec.wheelX * cosY + wz * sinY, spec.wheelRadius + y, m.z + spec.wheelX * sinY + wz * cosY);
        dummy.updateMatrix();
        busWheelLeftInst.setMatrixAt(busAxles, dummy.matrix);
        dummy.position.set(m.x + spec.wheelX * cosY + wz * sinY, spec.wheelRadius + y, m.z - spec.wheelX * sinY + wz * cosY);
        dummy.updateMatrix();
        busWheelRightInst.setMatrixAt(busAxles, dummy.matrix);
        busAxles++;
      });
    }
    // the bellows: straight sleeves between the faces, turned halfway and stretched to the gap (the outside of a bend opens up)
    for (let j = 0; j < 2; j++) {
      const { a, b } = art.bellows(j);
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      const len = Math.hypot(a.x - b.x, a.z - b.z);
      dummy.position.set(mx, levelAt(mx, mz, vehicleGround(v)), mz);
      dummy.rotation.set(0, len > 0.05 ? Math.atan2(a.x - b.x, a.z - b.z) : a.yaw, 0, 'YXZ');
      dummy.scale.set(1, 1, Math.max(0.6, len / 0.7));
      dummy.updateMatrix();
      plusBellowsInst.setMatrixAt(plusBellowsCount++, dummy.matrix);
    }

    const dxCam = v.x - camX;
    const dzCam = v.z - camZ;
    const distSq = dxCam * dxCam + dzCam * dzCam + camY * camY;
    if (distSq < MAX_LIGHT_DIST_SQ) {
      const d = Math.sqrt(distSq);
      const effDist = d + Math.max(0, 5.0 - (dxCam * camFwdX + dzCam * camFwdZ)) * 3.2;
      if (effDist < MAX_LIGHT_DIST) {
        v._camDistSq = distSq;
        v._effDist = effDist;
        v._sinY = Math.sin(v.yaw);
        v._cosY = Math.cos(v.yaw);
        v._braking = v.acc < -0.8 || v.speed < 0.3 ? 1 : 0;
        litVehicles[litVehicleCount++] = v;
      }
    }
  }

  function smoothDistFade(d, start, end) {
    const t = clamp((end - d) / (end - start), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function updateTrafficLights() {
    litVehicles.length = litVehicleCount;
    if (litVehicleCount > 1) {
      litVehicles.sort((a, b) => a._effDist - b._effDist);
    }

    const glow = cityUniforms && cityUniforms.uInteriorGlow ? cityUniforms.uInteriorGlow.value : 0.48;
    // Front headlights are off during Midday (0.24) & Golden Hour (0.48); fade in smoothly for Dusk (1.25) & Night (1.55)
    const beamScale = clamp((glow - 0.60) * 1.45, 0.0, 1.28);
    const tailScale = clamp(0.18 + glow * 0.66, 0.24, 1.22);

    const maxDualVehicles = HEADLIGHT_POOL_SIZE >> 1;
    const vehCutoff = litVehicleCount > maxDualVehicles
      ? Math.min(MAX_LIGHT_DIST, litVehicles[maxDualVehicles]._effDist)
      : MAX_LIGHT_DIST;
    let spotUsed = 0;
    if (beamScale > 0.001) {
      for (let i = 0; i < litVehicleCount && spotUsed + 2 <= HEADLIGHT_POOL_SIZE; i++) {
        const v = litVehicles[i];
        const fade = smoothDistFade(v._effDist, vehCutoff * 0.62, vehCutoff);
        if (fade <= 0.001) continue;
        const spec = v.bus ? v.spec : BODY_SPECS[v.bodyType];
        const fullReach = HEADLIGHTS.distance;
        let maxReach = fullReach;
        if (player.active && v.pAhead > 0 && v.pAhead < 30) {
          const latWeight = smoothDistFade(Math.abs(v.pRight), 2.2, 5.5);
          const clampedReach = Math.max(4.5, v.pAhead - player.halfL - 1.5);
          maxReach = fullReach + (clampedReach - fullReach) * latWeight;
        }

        const baseInt = (v.bus ? HEADLIGHTS.busIntensity : HEADLIGHTS.intensity) * beamScale * fade;
        // Match the body instance, including suspension and impact rotation.
        dummy.position.set(v.x, vehicleGround(v), v.z);
        dummy.rotation.set(v.pitch, v.yaw + v.yawOffset, v.roll, 'YXZ');
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        for (let side = -1; side <= 1; side += 2) {
          const spot = headlightPool[spotUsed++];
          placeVehicleHeadlight(spot, spec, side, dummy.matrix);
          spot.distance = maxReach;
          spot.intensity = baseInt;
        }
      }
    }
    for (let i = spotUsed; i < HEADLIGHT_POOL_SIZE; i++) {
      const spot = headlightPool[i];
      spot.intensity = 0;
      spot.position.set(0, -1000, 0);
    }

  }

  function updateSparks(dt) {
    let count = 0;
    for (let s = 0; s < MAX_SPARKS; s++) {
      const sp = sparks[s];
      if (sp.life > 0) {
        sp.life -= dt;
        sp.vy -= 22.0 * dt;
        sp.x += sp.vx * dt;
        sp.y += sp.vy * dt;
        sp.z += sp.vz * dt;
        const spGround = (sp.floor || 0) + 0.03; // terrain height at the impact
        if (sp.y < spGround) {
          sp.y = spGround;
          sp.vy = Math.abs(sp.vy) * 0.45;
          sp.vx *= 0.78;
          sp.vz *= 0.78;
        }
        const tLife = Math.max(0, sp.life / sp.maxLife);
        const spdXZ = Math.hypot(sp.vx, sp.vz) || 0.001;
        const yawSp = Math.atan2(sp.vx, sp.vz);
        const pitchSp = -Math.atan2(sp.vy, spdXZ);
        dummy.position.set(sp.x, sp.y, sp.z);
        dummy.rotation.set(pitchSp, yawSp, 0, 'YXZ');
        dummy.scale.set(tLife, tLife, Math.max(0.4, Math.min(2.2, spdXZ * 0.16)) * tLife);
        dummy.updateMatrix();
        sparkInst.setMatrixAt(count++, dummy.matrix);
      }
    }
    // Keep one degenerate instance for shader warm-up, then hide the empty pool and stop uploading it.
    sparkInst.visible = count > 0 || updates <= 2;
    if (count === 0 && updates <= 2) sparkInst.setMatrixAt(count++, zero);
    sparkInst.count = count;
    if (count > 0) flagRange(sparkInst.instanceMatrix, count);
  }

  // =========================================================================
  // 8. UPDATE
  // =========================================================================
  let lastFocusX = Infinity;
  let lastFocusZ = Infinity;
  let vehicleCursor = 0;

  function update(dt, elapsed, focusPos = null, playerEntity = null, activeMode = 'car', camera = null) {
    clock = elapsed;
    focusX = focusPos ? focusPos.x : 0;
    focusZ = focusPos ? focusPos.z : 140;
    // a jump of the camera (teleport, first frame): everything far away can be placed anywhere around it
    const jump = Math.hypot(focusX - lastFocusX, focusZ - lastFocusZ) > 140;
    lastFocusX = focusX;
    lastFocusZ = focusZ;
    // Opt-in phase timings for profiling (set globalThis.__trafficProfile = {}): ms per phase summed over frames, the Plusbuses apart
    const prof = globalThis.__trafficProfile || null;
    let lapT = prof ? performance.now() : 0;
    const lap = (name) => { if (!prof) return; const now = performance.now(); prof[name] = (prof[name] || 0) + now - lapT; lapT = now; };
    if (prof) prof.frames = (prof.frames || 0) + 1;
    refreshNear();
    updateView(camera);
    lap('near');

    const playerGround = playerEntity && options.groundHeight
      ? (options.groundHeight.heightAt?.(playerEntity.position.x, playerEntity.position.z)
        ?? options.groundHeight.terrainAt?.(playerEntity.position.x, playerEntity.position.z) ?? 0)
      : 0;
    player.active = Boolean(playerEntity && GROUNDED_PLAYER_MODES.has(activeMode)
      && Math.abs(playerEntity.position.y - playerGround) < 2.6);
    if (playerEntity) {
      const heading = playerEntity.heading || 0;
      const speed = playerEntity.speed || 0;
      player.entity = playerEntity;
      player.x = playerEntity.position.x;
      player.z = playerEntity.position.z;
      player.fx = Math.sin(heading);
      player.fz = Math.cos(heading);
      // how fast it turns: the car's own yaw rate, or (walking, cycling) its heading's change since last frame
      let turned = heading - player.heading;
      turned -= Math.round(turned / (Math.PI * 2)) * Math.PI * 2;
      player.yawRate = playerEntity.angularVel ?? (dt > 0 ? turned / dt : 0);
      player.heading = heading;
      player.vx = player.fx * speed + (playerEntity.vx || 0);
      player.vz = player.fz * speed + (playerEntity.vz || 0);
    }
    player.halfW = activeMode === 'cargobike' ? 0.4 : activeMode === 'cyclist' ? 0.35 : activeMode === 'person' ? 0.48 : (playerEntity?.bodySpec?.width || 1.72) / 2;
    player.halfL = activeMode === 'cargobike' ? 1.34 : activeMode === 'cyclist' ? 0.85 : activeMode === 'person' ? 0.48 : (playerEntity?.bodySpec?.length || 4.36) / 2;

    // 1. Cars & buses
    // Limit attempted placements, not just successes, and rotate through the pool so an awkward location
    // cannot monopolize a frame. Previous-frame lane lists protect spawn spacing; rebuild before driving.
    let budget = jump ? vehicles.length : 4;
    for (let scanned = 0; scanned < vehicles.length && budget > 0; scanned++) {
      const v = vehicles[vehicleCursor];
      vehicleCursor = (vehicleCursor + 1) % vehicles.length;
      const d = v.edge ? Math.hypot(v.x - focusX, v.z - focusZ) : Infinity;
      if (d <= (jump ? NEAR_RADIUS : VEHICLE_RADIUS)) continue;
      budget--;
      spawnVehicle(v, jump ? 0 : 100, NEAR_RADIUS, !jump);
      lap(v.plus ? 'spawnPlus' : 'spawn');
    }
    lap('spawn');
    buildOccupancy();
    lap('occupancy');
    for (const m of bodyMeshes) m.count = 0;
    litVehicleCount = 0;
    wheelCars = 0;
    visibleCars = 0;
    visibleBuses = 0;
    busAxles = 0;
    for (const set of Object.values(busSets)) set.count = 0;
    for (const set of Object.values(plusSets)) set.count = 0;
    plusBellowsCount = plusShadowCount = 0;
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      if (!v.edge) continue;

      v.prevX = v.x;
      v.prevZ = v.z;
      relateToPlayer(v);
      if (dt > 0) react(v, dt);
      if (dt > 0) drive(v, dt);
      else v.acc = 0;
      if (!v.edge) continue;
      locate(v);
      knock(v, dt);
      pose(v, dt);
      if (v.plus) posePlus(v);
      v.gy = levelAt(v.x, v.z, v.gy);
      followLevel(v, Math.hypot(v.x - (v.groundX ?? v.x), v.z - (v.groundZ ?? v.z)));
      v.groundX = v.x;
      v.groundZ = v.z;
      lap(v.plus ? 'drivePlus' : 'drive');
    }
    lap('drive');

    // Pedestrians and road vehicles complete their movement before any actor batches are populated.
    gatherMovers(dt, playerEntity, activeMode);
    pedestrianSystem.simulate(dt, elapsed, focusX, focusZ, jump, hasView, activeMode);
    feelFallen(playerEntity);
    lap('pedestrians');
    const collisionActors = syncCollisionActors(playerEntity, activeMode);
    if (collisionPhase) collisionPhase(collisionActors, { dt, elapsed, focusPos, playerEntity, activeMode });
    else localCollisionStage.resolve(collisionActors, { dt });
    lap('collide');

    // Corrections from the contact pass now feed the body, wheel, light, pedestrian and shadow batches.
    for (const v of vehicles) {
      if (!v.edge) continue;
      if (v.plus) renderPlus(v);
      else if (v.bus) renderBus(v);
      else renderCar(v);
      lap(v.plus ? 'renderPlus' : 'render');
    }
    const hideEmpty = ++updates > 2;
    for (const m of bodyMeshes) {
      const n = m.count;
      m.visible = n > 0 || !hideEmpty;
      if (n === 0) {
        if (!hideEmpty) {
          m.setMatrixAt(0, zero);
          m.count = 1;
          flagRange(m.instanceMatrix, 1);
        }
        continue;
      }
      flagRange(m.instanceMatrix, n);
      if (dirtyPaint.has(m)) flagRange(m.geometry.attributes.paintColor, n);
      if (dirtyState.has(m)) flagRange(m.geometry.attributes.carState, n);
    }
    dirtyPaint.clear();
    dirtyState.clear();
    const syncInst = (inst, n) => {
      inst.visible = n > 0 || !hideEmpty;
      if (n === 0) {
        if (!hideEmpty) {
          inst.setMatrixAt(0, zero);
          inst.count = 1;
          flagRange(inst.instanceMatrix, 1);
        } else {
          inst.count = 0;
        }
        return;
      }
      inst.count = n;
      flagRange(inst.instanceMatrix, n);
    };
    syncInst(carWheelLeftInst, wheelCars * 2);
    syncInst(carWheelRightInst, wheelCars * 2);
    syncInst(carShadowInst, visibleCars);
    for (const set of Object.values(busSets)) {
      syncInst(set.body, set.count);
      if (set.count > 0) flagRange(set.states, set.count);
    }
    syncInst(busWheelLeftInst, busAxles);
    syncInst(busWheelRightInst, busAxles);
    syncInst(busShadowInst, visibleBuses);
    for (const set of Object.values(plusSets)) {
      syncInst(set.body, set.count);
      if (set.count > 0) flagRange(set.states, set.count);
    }
    syncInst(plusBellowsInst, plusBellowsCount);
    syncInst(plusShadowInst, plusShadowCount);
    lap('render');
    updateTrafficLights();
    lap('lights');

    // 2. Pedestrians
    pedestrianSystem.render(dt);
    lap('pedestrianRender');

    // 3. Collision sparks, including the player's own impacts against buildings
    if (playerEntity && playerEntity.lastCollisionSpark) {
      const bs = playerEntity.lastCollisionSpark;
      spawnCollisionSparks(bs.x, bs.y, bs.z, bs.nx, bs.nz, bs.speed);
      playerEntity.lastCollisionSpark = null;
    }
    updateSparks(dt);
    lap('sparks');
  }

  if (options.debug) Object.assign(options.debug, { room, alongside, mergingAhead, yieldOncoming, yieldToCrossTraffic, boxBusy, vehicles });
  return {
    group,
    update,
    setCollisionListener,
    setCollisionPhase,
    setSpawnClear,
    cars,
    buses: [...buses, ...plusbuses],
    plusbuses,
    get lineStats() { return { lines: busLines.length, nearRoute: nearRoute.length / 2, near: nearEdges.length }; },
    peds: pedestrianSystem.peds,
    fallen: pedestrianSystem.fallen,
    // the world knocked-down people land in: the ground's height, and the buildings & street furniture to bounce off
    setWorld: pedestrianSystem.setWorld,
    get network() { return network; },
    setNetwork,
    setBusLines,
    collisionActors: frameCollisionActors,
    syncCollisionActors,
    collisionStats: localCollisionStage.stats,
    get jamRetired() { return jamRetired; }
  };
}


export { createTrafficSystem };
