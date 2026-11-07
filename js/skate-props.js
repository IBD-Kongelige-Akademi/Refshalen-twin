// js/skate-props.js
// What the walking player's skaters ride (controllers.js poses them every frame, see PersonRig.skate in pedestrians.js):
// - a pink quad roller skate, built around a shoe at the ankle joint (+Z towards the toe, metres for a 1.75 m person;
//   the controller scales it with the skater): a boot that covers the shoe, a plate, two trucks of side-by-side wheels
//   and a toe stop. Its wheels lift the sole SKATE_LIFT off the ground.
// - a skateboard (+Z towards the nose): a seven-ply deck with kicked-up nose and tail, grip tape on top, two trucks and
//   four wheels. Its deck top is BOARD_DECK_TOP above the ground.
import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const SOLE_Y = -0.08; // the shoe's sole, from the ankle joint (pedestrians.js ANKLE_H)
const SKATE_WHEEL_R = 0.029;
const SKATE_PLATE = 0.012;
export const SKATE_LIFT = SKATE_PLATE + SKATE_WHEEL_R * 2; // sole above the ground

const BOARD_WHEEL_R = 0.027;
const BOARD_TRUCK_Z = 0.235;
const BOARD_DECK_Y = 0.074; // underside of the deck between the trucks
const BOARD_DECK_T = 0.013;
export const BOARD_DECK_TOP = BOARD_DECK_Y + BOARD_DECK_T;

const mat = (color, roughness = 0.6, metalness = 0) => new THREE.MeshStandardNodeMaterial({ color, roughness, metalness });

// a wheel turning about the X axis, as a child of `parent` at (x, y, z); its pivot is returned for spinning
function addWheel(parent, x, y, z, radius, width, tyre, hub) {
  const pivot = new THREE.Group();
  pivot.position.set(x, y, z);
  const wheel = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width, 18), tyre);
  wheel.rotation.z = Math.PI / 2;
  pivot.add(wheel);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.45, radius * 0.45, width * 1.04, 10), hub);
  cap.rotation.z = Math.PI / 2;
  pivot.add(cap);
  // a dark stripe across the tread shows the wheel turning
  const mark = new THREE.Mesh(new THREE.BoxGeometry(width * 1.02, radius * 0.25, radius * 0.18), hub);
  mark.position.y = radius * 0.93;
  pivot.add(mark);
  parent.add(pivot);
  return pivot;
}

/** One roller skate (left or right are alike). `color` tints the boot. Returns { root, wheels }. */
export function createRollerSkate(color = 0xff5fa8) {
  const root = new THREE.Group();
  root.name = 'RollerSkate';
  const boot = mat(color, 0.38);
  const trim = mat(0xffffff, 0.5);
  const plate = mat(0xd8d8de, 0.35, 0.6);
  const tyre = mat(0xffd1e8, 0.55);
  const hub = mat(0x7a2a55, 0.4);

  // the boot: a shell over the shoe, a padded cuff round the ankle, a white sole edge and laces
  const shell = new THREE.Mesh(new RoundedBoxGeometry(0.118, 0.07, 0.31, 3, 0.03), boot);
  shell.position.set(0, SOLE_Y + 0.035, 0.058);
  root.add(shell);
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.062, 0.12, 16), boot);
  cuff.position.set(0, SOLE_Y + 0.1, -0.03);
  root.add(cuff);
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.057, 0.011, 8, 18), trim);
  collar.rotation.x = Math.PI / 2;
  collar.position.set(0, SOLE_Y + 0.162, -0.03);
  root.add(collar);
  const sole = new THREE.Mesh(new RoundedBoxGeometry(0.122, 0.014, 0.316, 2, 0.006), trim);
  sole.position.set(0, SOLE_Y + 0.005, 0.058);
  root.add(sole);
  for (let i = 0; i < 4; i++) {
    const lace = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.006, 0.01), trim);
    lace.position.set(0, SOLE_Y + 0.072 + i * 0.002, 0.03 + i * 0.03);
    lace.rotation.x = -0.35;
    root.add(lace);
  }

  // plate, trucks and wheels, side by side in pairs
  const plateMesh = new THREE.Mesh(new THREE.BoxGeometry(0.075, SKATE_PLATE, 0.27), plate);
  plateMesh.position.set(0, SOLE_Y - SKATE_PLATE / 2, 0.058);
  root.add(plateMesh);
  const axleY = SOLE_Y - SKATE_PLATE - SKATE_WHEEL_R;
  const wheels = [];
  for (const z of [-0.035, 0.15]) {
    const truck = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.1, 8), plate);
    truck.rotation.z = Math.PI / 2;
    truck.position.set(0, axleY, z);
    root.add(truck);
    const hanger = new THREE.Mesh(new THREE.BoxGeometry(0.03, SKATE_WHEEL_R, 0.024), plate);
    hanger.position.set(0, axleY + SKATE_WHEEL_R / 2, z);
    root.add(hanger);
    for (const x of [-0.047, 0.047]) wheels.push(addWheel(root, x, axleY, z, SKATE_WHEEL_R, 0.03, tyre, hub));
  }
  const stop = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.024, 0.04, 14), trim);
  stop.position.set(0, SOLE_Y - 0.03, 0.215);
  stop.rotation.x = 0.35;
  root.add(stop);
  return { root, wheels, wheelRadius: SKATE_WHEEL_R };
}

// one layer of the deck: the flat middle and the nose & tail kicked up 0.3 rad past the trucks, with rounded ends
function deckLayer(thickness, y, material) {
  const group = new THREE.Group();
  const half = 0.1; // half the deck's width
  const flat = 0.27; // the kick starts this far from the middle
  const mid = new THREE.Mesh(new THREE.BoxGeometry(half * 2, thickness, flat * 2), material);
  mid.position.y = y + thickness / 2;
  group.add(mid);
  const end = new THREE.Shape();
  end.moveTo(-half, 0);
  end.lineTo(-half, 0.06);
  end.absarc(0, 0.06, half, Math.PI, 0, true);
  end.lineTo(half, 0);
  end.lineTo(-half, 0);
  const endGeo = new THREE.ExtrudeGeometry(end, { depth: thickness, bevelEnabled: false, curveSegments: 10 });
  // the shape lies in XY; turn it so its length runs along +Z and its thickness along +Y
  endGeo.rotateX(Math.PI / 2);
  endGeo.translate(0, thickness, 0);
  for (const dir of [1, -1]) {
    const pivot = new THREE.Group();
    pivot.position.set(0, y, dir * flat);
    // (Euler XYZ: the tail's half-turn about Y comes first, so both ends kick upwards with -dir * 0.3)
    pivot.rotation.set(-dir * 0.3, dir > 0 ? 0 : Math.PI, 0);
    pivot.add(new THREE.Mesh(endGeo, material));
    group.add(pivot);
  }
  return group;
}

/** A skateboard. Returns { root, tilt, wheels }: `tilt` rolls the deck & trucks for carving, `wheels` spin. */
export function createSkateboard() {
  const root = new THREE.Group();
  root.name = 'Skateboard';
  const tilt = new THREE.Group();
  root.add(tilt);
  const grip = mat(0x1c1c1e, 0.95);
  const graphic = mat(0x2f7fd8, 0.55);
  const wood = mat(0xd9b27c, 0.7);
  const metal = mat(0xb9bcc2, 0.32, 0.75);
  const tyre = mat(0xf1e6c8, 0.6);
  const hub = mat(0x55575c, 0.4, 0.4);

  tilt.add(deckLayer(0.004, BOARD_DECK_Y, graphic));
  tilt.add(deckLayer(0.005, BOARD_DECK_Y + 0.004, wood));
  tilt.add(deckLayer(0.004, BOARD_DECK_Y + 0.009, grip));

  const axleY = BOARD_WHEEL_R;
  const wheels = [];
  for (const z of [BOARD_TRUCK_Z, -BOARD_TRUCK_Z]) {
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.012, 0.075), metal);
    base.position.set(0, BOARD_DECK_Y - 0.006, z);
    tilt.add(base);
    const king = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.016, BOARD_DECK_Y - axleY - 0.01, 10), metal);
    king.position.set(0, (BOARD_DECK_Y + axleY) / 2, z);
    tilt.add(king);
    const hanger = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.19, 10), metal);
    hanger.rotation.z = Math.PI / 2;
    hanger.position.set(0, axleY, z);
    root.add(hanger);
    for (const x of [-0.092, 0.092]) wheels.push(addWheel(root, x, axleY, z, BOARD_WHEEL_R, 0.034, tyre, hub));
  }
  return { root, tilt, wheels, wheelRadius: BOARD_WHEEL_R };
}
