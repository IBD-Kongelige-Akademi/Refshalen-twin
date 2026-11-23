import * as THREE from 'three/webgpu';
import { cityUniforms } from './tsl-materials.js';
import { CAR_PLATE, plateRegistration } from './vehicle-fleet.js';
import {
  Fn,
  float,
  vec2,
  vec3,
  color,
  attribute,
  sin,
  abs,
  fract,
  floor,
  min,
  max,
  clamp,
  mix,
  step,
  smoothstep,
  length,
  fwidth,
  uniform,
  texture,
  time,
  instanceIndex
} from 'three/tsl';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// js/actor-models.js
// Realistic 3D Lofted Vehicle Geometry + TSL Materials (the skinned, animated people are in pedestrians.js)
// Ported and adapted from Three.js webgpu_generator_city:
// - LoftGeometry.js (skinning 3D cross-section rings with arc-length UVs, smooth seam normals & Newell caps)
// - CarGenerator.js (lofted sedan/SUV bodies with circular wheel arches, curved cabin windscreens,
//   crowned roofs, LatheGeometry tyres & recessed 5-spoke alloy wheels, side mirrors, roof signs & TSL fascia/seams)

const _vector = new THREE.Vector3();

// ============================================================================
// 1. LOFT GEOMETRY (Ported from three/addons/geometries/LoftGeometry.js)
// ============================================================================
class LoftGeometry extends THREE.BufferGeometry {
  constructor(sections = [], options = {}) {
    super();
    this.type = 'LoftGeometry';

    const { closed = true, capStart = false, capEnd = false } = options;
    const rows = sections.length;
    if (rows < 2) return;
    const columns = sections[0].length;
    for (let i = 1; i < rows; i++) {
      if (sections[i].length !== columns) return;
    }

    const pointsPerRow = closed ? columns + 1 : columns;
    const indices = [];
    const vertices = [];
    const uvs = [];

    const rowU = [0];
    for (let i = 1; i < rows; i++) {
      let distance = 0;
      for (let j = 0; j < columns; j++) {
        distance += sections[i][j].distanceTo(sections[i - 1][j]);
      }
      rowU.push(rowU[i - 1] + distance / columns);
    }
    const totalU = rowU[rows - 1];

    for (let i = 0; i < rows; i++) {
      const section = sections[i];
      const colV = [0];
      for (let j = 1; j < pointsPerRow; j++) {
        colV.push(colV[j - 1] + section[j % columns].distanceTo(section[(j - 1) % columns]));
      }
      const totalV = colV[pointsPerRow - 1];

      for (let j = 0; j < pointsPerRow; j++) {
        const point = section[j % columns];
        vertices.push(point.x, point.y, point.z);
        uvs.push(
          totalU > 0 ? rowU[i] / totalU : i / (rows - 1),
          totalV > 0 ? colV[j] / totalV : j / (pointsPerRow - 1)
        );
      }
    }

    for (let i = 0; i < rows - 1; i++) {
      for (let j = 0; j < pointsPerRow - 1; j++) {
        const a = i * pointsPerRow + j;
        const b = i * pointsPerRow + j + 1;
        const c = (i + 1) * pointsPerRow + j + 1;
        const d = (i + 1) * pointsPerRow + j;
        indices.push(a, b, d);
        indices.push(b, c, d);
      }
    }

    function generateCap(sectionIndex) {
      const section = sections[sectionIndex];
      const centroid = new THREE.Vector3();
      const normal = new THREE.Vector3();

      for (let i = 0; i < columns; i++) {
        const p = section[i];
        const q = section[(i + 1) % columns];
        centroid.add(p);
        normal.x += (p.y - q.y) * (p.z + q.z);
        normal.y += (p.z - q.z) * (p.x + q.x);
        normal.z += (p.x - q.x) * (p.y + q.y);
      }
      centroid.divideScalar(columns);
      normal.normalize();

      const neighbor = sections[sectionIndex === 0 ? 1 : rows - 2];
      _vector.set(0, 0, 0);
      for (let i = 0; i < columns; i++) _vector.add(neighbor[i]);
      _vector.divideScalar(columns).sub(centroid);
      if (normal.dot(_vector) > 0) normal.negate();

      const tangent = new THREE.Vector3(1, 0, 0);
      if (Math.abs(normal.x) > 0.9) tangent.set(0, 1, 0);
      const bitangent = new THREE.Vector3().crossVectors(normal, tangent).normalize();
      tangent.crossVectors(bitangent, normal);

      const contour = [];
      const points = section.slice();
      for (let i = 0; i < columns; i++) {
        _vector.subVectors(points[i], centroid);
        contour.push(new THREE.Vector2(_vector.dot(tangent), _vector.dot(bitangent)));
      }

      if (THREE.ShapeUtils.isClockWise(contour) === true) {
        contour.reverse();
        points.reverse();
      }

      const faces = THREE.ShapeUtils.triangulateShape(contour, []);
      const minV = new THREE.Vector2(Infinity, Infinity);
      const maxV = new THREE.Vector2(-Infinity, -Infinity);
      for (let i = 0; i < columns; i++) {
        minV.min(contour[i]);
        maxV.max(contour[i]);
      }
      const width = Math.max(maxV.x - minV.x, Number.EPSILON);
      const height = Math.max(maxV.y - minV.y, Number.EPSILON);

      const indexOffset = vertices.length / 3;
      for (let i = 0; i < columns; i++) {
        const point = points[i];
        vertices.push(point.x, point.y, point.z);
        uvs.push((contour[i].x - minV.x) / width, (contour[i].y - minV.y) / height);
      }
      for (let i = 0; i < faces.length; i++) {
        const face = faces[i];
        indices.push(indexOffset + face[0], indexOffset + face[1], indexOffset + face[2]);
      }
    }

    if (capStart === true) generateCap(0);
    if (capEnd === true) generateCap(rows - 1);

    this.setIndex(indices);
    this.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    this.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    this.computeVertexNormals();

    if (closed === true) {
      const normals = this.getAttribute('normal');
      for (let i = 0; i < rows; i++) {
        const a = i * pointsPerRow;
        const b = i * pointsPerRow + (pointsPerRow - 1);
        _vector.set(
          normals.getX(a) + normals.getX(b),
          normals.getY(a) + normals.getY(b),
          normals.getZ(a) + normals.getZ(b)
        ).normalize();
        normals.setXYZ(a, _vector.x, _vector.y, _vector.z);
        normals.setXYZ(b, _vector.x, _vector.y, _vector.z);
      }
    }
  }
}

function part(geometry, id) {
  const g = geometry.index ? geometry : mergeVertices(geometry);
  if (!g.attributes.uv) {
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  }
  g.setAttribute('partId', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(id), 1));
  return g;
}

// ============================================================================
// 2. LOFTED VEHICLE GEOMETRY & TSL MATERIAL
// ============================================================================
// Car bodies are lofted from ~45 cross-sections generated along the car out of a few smooth side- & plan-view curves
// (monotone cubic splines) plus elliptical roundings into the nose and tail: rounded plan-view corners, a hood that
// rolls down into the fascia, a tucked-in sill, crowned hood & deck, fender flares and circular wheel arches. A second,
// open loft sits on the belt line as the glasshouse (raked windshield & backlight, tumblehome side glass, crowned roof
// with rounded rails). All the detail (glass, seals, pillars, lamps, grilles, plates, door seams,
// brake lights & turn signals) is painted by one TSL material from object-space position & normal, so each body type
// stays a single instanced draw call.
const CAR_PARTS = {
  BODY: 0,
  WINDOW: 1,
  TYRE: 2,
  ALLOY: 3,
  TRIM: 4,
  MIRROR: 5,
  SIGN: 6,
  FRONT: 7,
  REAR: 8
};

// Design tables. Curves are [z, value] control points (z = +front); nose / tail entries are [length, tip value,
// superellipse exponent] roundings of the same quantities into the tips.
const BODY_SPECS = {
  sedan: {
    name: 'sedan',
    zFront: 2.25,
    zRear: -2.25,
    wheelRadius: 0.35,
    wheelZ: 1.38,
    wheelX: 0.83,
    archGap: 0.065, // wheel arch radius = wheelRadius + archGap
    archFlare: 0.02, // extra half-width over the wheels
    tuck: 0.075, // sill tucked in from the widest point
    halfWidth: [[2.25, 0.91], [1.38, 0.922], [0, 0.928], [-1.38, 0.926], [-2.25, 0.915]],
    sill: [[2.25, 0.29], [1.2, 0.265], [-1.2, 0.265], [-2.25, 0.3]],
    shoulder: [[2.25, 0.66], [0, 0.7], [-2.25, 0.76]],
    edge: [[2.1, 0.79], [1.5, 0.85], [0.85, 0.935], [0.55, 0.955], [-1.0, 0.985], [-1.62, 0.975], [-2.1, 0.91]],
    crown: [[2.1, 0.035], [0.95, 0.03], [0.66, 0.004], [-1.56, 0.004], [-1.78, 0.016], [-2.25, 0.012]],
    tumble: [[2.25, 0.11], [0.9, 0.09], [-1.6, 0.085], [-2.25, 0.105]],
    nose: { halfWidth: [0.3, 0.7, 3], edge: [0.12, 0.77, 3], crown: [0.12, 0.01, 2], sill: [0.13, 0.33, 2], shoulder: [0.2, 0.59, 2.4] },
    tail: { halfWidth: [0.3, 0.72, 2.6], edge: [0.11, 0.905, 3], crown: [0.11, 0.008, 2], sill: [0.14, 0.35, 2], shoulder: [0.2, 0.69, 2.4] },
    cabin: {
      cowl: 0.86,
      roofFront: 0.0,
      roofRear: -1.0,
      deck: -1.68,
      roofY: [[0.0, 1.435], [-0.5, 1.455], [-1.0, 1.42]],
      rail: [0.645, 0.625], // roof rail half-width at the front & rear of the roof
      inset: 0.035, // side glass base inset from the body's top edge
      bulge: 0.012, // side glass outward curvature
      roofEdge: 0.05, // roof rail rounding height
      roofCrown: 0.035,
      roofRound: 4,
      pillars: [-0.3] // B (and C) pillar centres
    },
    doors: [0.84, -0.3, -1.02], // door shut lines
    handles: [-0.13, -0.86],
    headlight: [0.59, 0.69, 0.23, 0.055], // centre |x|, y, half-width, half-height
    taillight: [0.575, 0.795, 0.255, 0.064],
    grille: [0.68, 0.31, 0.06], // upper grille between the headlights: y, half-width, half-height
    intake: [0.37, 0.46, 0.045], // lower grille
    plates: [0.555, 0.68], // front / rear plate centre heights
    bumperLine: [0.775, 0.565], // hood / bumper and trunk / bumper shut lines on the nose & tail
    bumpers: [[0.46, 0.03], [0.49, 0.035]], // front / rear trim: centre height, half-height
    chrome: false, // retained legacy silhouette, without chrome
    cladding: 0, // height of the unpainted lower body cladding (SUVs)
    rails: false,
    rearWiper: false
  },
  suv: {
    name: 'suv',
    zFront: 2.3,
    zRear: -2.3,
    wheelRadius: 0.39,
    wheelZ: 1.4,
    wheelX: 0.87,
    archGap: 0.075,
    archFlare: 0.03,
    tuck: 0.07,
    halfWidth: [[2.3, 0.948], [1.4, 0.96], [0, 0.966], [-1.4, 0.964], [-2.3, 0.956]],
    sill: [[2.3, 0.39], [1.2, 0.35], [-1.2, 0.35], [-2.3, 0.41]],
    shoulder: [[2.3, 0.8], [0, 0.84], [-2.3, 0.88]],
    edge: [[2.1, 0.99], [1.5, 1.045], [0.85, 1.1], [0.6, 1.12], [-1.0, 1.145], [-2.0, 1.175], [-2.3, 1.18]],
    crown: [[2.1, 0.035], [0.9, 0.03], [0.6, 0.004], [-2.3, 0.004]],
    tumble: [[2.3, 0.1], [0.9, 0.08], [-2.3, 0.08]],
    nose: { halfWidth: [0.27, 0.76, 3], edge: [0.13, 0.96, 3], crown: [0.13, 0.01, 2], sill: [0.12, 0.42, 2], shoulder: [0.2, 0.74, 2.4] },
    tail: { halfWidth: [0.24, 0.8, 2.6], edge: [0.08, 1.13, 3], crown: [0.08, 0, 2], sill: [0.14, 0.44, 2], shoulder: [0.18, 0.84, 2.4] },
    cabin: {
      cowl: 0.8,
      roofFront: 0.08,
      roofRear: -1.96,
      deck: -2.2,
      roofY: [[0.08, 1.735], [-0.9, 1.76], [-1.96, 1.745]],
      rail: [0.71, 0.7],
      inset: 0.035,
      bulge: 0.012,
      roofEdge: 0.055,
      roofCrown: 0.03,
      roofRound: 4,
      pillars: [-0.3, -1.18]
    },
    doors: [0.78, -0.3, -1.18],
    handles: [-0.13, -1.0],
    headlight: [0.64, 0.86, 0.235, 0.065],
    taillight: [0.745, 0.985, 0.105, 0.13],
    grille: [0.83, 0.36, 0.095],
    intake: [0.465, 0.44, 0.04],
    plates: [0.66, 0.82],
    bumperLine: [0.965, 0.655],
    bumpers: [[0.56, 0.04], [0.56, 0.04]],
    chrome: false,
    cladding: 0.5,
    rails: true,
    rearWiper: true
  }
};
Object.assign(BODY_SPECS, {
  crossoverEV: {
    ...BODY_SPECS.suv, name: 'crossoverEV', length: 4.6, width: 1.88, height: 1.63, massRatio: 0.42,
    wheelRadius: 0.37, wheelZ: 1.4, wheelX: 0.82, archGap: 0.045, archFlare: 0.012,
    halfWidth: [[2.3, 0.9], [1.4, 0.928], [0, 0.924], [-1.4, 0.928], [-2.3, 0.9]],
    sill: [[2.3, 0.3], [1.2, 0.28], [-1.2, 0.28], [-2.3, 0.33]],
    shoulder: [[2.3, 0.83], [0, 0.94], [-2.3, 1.02]],
    edge: [[2.3, 0.98], [1.6, 1.05], [1.05, 1.1], [-1.0, 1.14], [-2.3, 1.12]],
    crown: [[2.3, 0.022], [1.1, 0.012], [-2.3, 0.004]],
    nose: { halfWidth: [0.3, 0.76, 3], edge: [0.1, 0.95, 3], crown: [0.1, 0.01, 2], sill: [0.12, 0.34, 2], shoulder: [0.2, 0.82, 2.4] },
    tail: { halfWidth: [0.22, 0.79, 3], edge: [0.08, 1.1, 3], crown: [0.08, 0, 2], sill: [0.12, 0.35, 2], shoulder: [0.18, 0.97, 2.4] },
    cabin: {
      ...BODY_SPECS.suv.cabin, cowl: 1.16, roofFront: 0.22, roofRear: -1.55, deck: -2.23,
      roofY: [[0.22, 1.6], [-0.65, 1.63], [-1.55, 1.57]], rail: [0.68, 0.66], pillars: [-0.3, -1.38]
    },
    doors: [1.1, -0.3, -1.42], handles: [-0.12, -1.24],
    headlight: [0.65, 0.91, 0.2, 0.035], taillight: [0.66, 1.03, 0.22, 0.034],
    grille: [0.8, 0, 0], intake: [0.41, 0.48, 0.035], plates: [0.62, 0.76],
    bumperLine: [0.99, 0.63], bumpers: [[0.37, 0.025], [0.39, 0.025]],
    chrome: false, cladding: 0.43, rails: false, lightBar: true, aero: true, taxiSign: true
  },
  hatch: {
    ...BODY_SPECS.sedan, name: 'hatch', length: 4.2, width: 1.79, height: 1.5, massRatio: 0.54,
    zFront: 2.1, zRear: -2.1, wheelRadius: 0.325, wheelZ: 1.31, wheelX: 0.785, archGap: 0.045, archFlare: 0.01,
    halfWidth: [[2.1, 0.86], [1.31, 0.885], [0, 0.88], [-1.31, 0.885], [-2.1, 0.86]],
    sill: [[2.1, 0.24], [1, 0.22], [-1, 0.22], [-2.1, 0.27]],
    shoulder: [[2.1, 0.68], [0, 0.77], [-2.1, 0.83]],
    edge: [[2.1, 0.83], [1.4, 0.88], [0.85, 0.94], [-1, 0.99], [-2.1, 1.0]],
    crown: [[2.1, 0.025], [0.85, 0.012], [-2.1, 0.004]],
    nose: { halfWidth: [0.24, 0.69, 3], edge: [0.09, 0.8, 3], crown: [0.1, 0.01, 2], sill: [0.1, 0.28, 2], shoulder: [0.18, 0.65, 2.4] },
    tail: { halfWidth: [0.18, 0.72, 3], edge: [0.07, 0.98, 3], crown: [0.08, 0, 2], sill: [0.1, 0.28, 2], shoulder: [0.14, 0.8, 2.4] },
    cabin: {
      ...BODY_SPECS.sedan.cabin, cowl: 0.95, roofFront: 0.15, roofRear: -1.7, deck: -2.04,
      roofY: [[0.15, 1.47], [-0.75, 1.5], [-1.7, 1.45]], rail: [0.64, 0.66], pillars: [-0.25, -1.35]
    },
    doors: [0.92, -0.25, -1.38], handles: [-0.08, -1.2],
    headlight: [0.59, 0.75, 0.2, 0.045], taillight: [0.61, 0.91, 0.19, 0.05],
    grille: [0.71, 0.29, 0.025], intake: [0.35, 0.43, 0.04], plates: [0.52, 0.64],
    bumperLine: [0.81, 0.52], bumpers: [[0.32, 0.022], [0.32, 0.022]],
    chrome: false, cladding: 0.29, rails: false, rearWiper: true
  },
  estate: {
    ...BODY_SPECS.sedan, name: 'estate', length: 4.7, width: 1.83, height: 1.48, massRatio: 0.49,
    zFront: 2.35, zRear: -2.35, wheelRadius: 0.34, wheelZ: 1.36, wheelX: 0.8, archGap: 0.045, archFlare: 0.01,
    halfWidth: [[2.35, 0.88], [1.36, 0.905], [0, 0.9], [-1.36, 0.905], [-2.35, 0.88]],
    edge: [[2.35, 0.82], [1.45, 0.88], [0.8, 0.96], [-1.0, 1.01], [-2.35, 1.02]],
    crown: [[2.35, 0.025], [0.8, 0.008], [-2.35, 0.004]],
    tail: { halfWidth: [0.2, 0.75, 3], edge: [0.07, 1.0, 3], crown: [0.08, 0, 2], sill: [0.12, 0.31, 2], shoulder: [0.16, 0.76, 2.4] },
    cabin: {
      ...BODY_SPECS.sedan.cabin, cowl: 0.87, roofFront: 0.02, roofRear: -1.98, deck: -2.29,
      roofY: [[0.02, 1.42], [-0.9, 1.445], [-1.98, 1.42]], rail: [0.66, 0.67], pillars: [-0.32, -1.35]
    },
    doors: [0.84, -0.32, -1.38], handles: [-0.14, -1.2],
    headlight: [0.61, 0.74, 0.21, 0.04], taillight: [0.62, 0.92, 0.2, 0.04],
    grille: [0.69, 0.28, 0.035], plates: [0.53, 0.68],
    chrome: false, cladding: 0.32, rails: true, rearWiper: true, taxiSign: true
  },
  van: {
    ...BODY_SPECS.suv, name: 'van', length: 5.9, width: 2.0, height: 2.65, massRatio: 0.3,
    zFront: 2.95, zRear: -2.95, wheelRadius: 0.37, wheelZ: 1.83, wheelX: 0.88, archGap: 0.05, archFlare: 0,
    halfWidth: [[2.95, 0.97], [1.83, 1], [-1.83, 1], [-2.95, 0.98]],
    sill: [[2.95, 0.32], [1.83, 0.3], [-1.83, 0.3], [-2.95, 0.34]],
    shoulder: [[2.95, 0.86], [1.8, 1.06], [-2.95, 1.12]],
    edge: [[2.95, 1.18], [2.45, 1.28], [1.8, 1.36], [-2.95, 1.36]],
    crown: [[2.95, 0.03], [2.0, 0.008], [-2.95, 0]],
    tumble: [[2.95, 0.07], [-2.95, 0.045]],
    nose: { halfWidth: [0.22, 0.82, 3], edge: [0.09, 1.13, 3], crown: [0.1, 0.01, 2], sill: [0.1, 0.36, 2], shoulder: [0.16, 0.8, 2.4] },
    tail: { halfWidth: [0.12, 0.86, 4], edge: [0.05, 1.33, 4], crown: [0.05, 0, 2], sill: [0.1, 0.36, 2], shoulder: [0.12, 1.06, 3] },
    cabin: {
      ...BODY_SPECS.suv.cabin, cowl: 2.45, roofFront: 1.7, roofRear: -2.82, deck: -2.93,
      roofY: [[1.7, 2.62], [0, 2.65], [-2.82, 2.62]], rail: [0.86, 0.88], pillars: [1.0],
      roofEdge: 0.07, roofCrown: 0.03, roofRound: 6
    },
    doors: [2.4, 0.95, -1.7], handles: [1.1, 0.72],
    headlight: [0.69, 0.99, 0.19, 0.07], taillight: [0.84, 1.04, 0.065, 0.22],
    grille: [0.94, 0.34, 0.08], intake: [0.43, 0.48, 0.045], plates: [0.67, 0.74],
    bumperLine: [1.13, 0.55], bumpers: [[0.48, 0.055], [0.48, 0.055]],
    chrome: false, cladding: 0.55, rails: false, rearWiper: false, panelVan: true
  }
});
for (const spec of Object.values(BODY_SPECS)) {
  spec.length ??= spec.zFront - spec.zRear;
  spec.width ??= Math.max(...spec.halfWidth.map((p) => p[1])) * 2;
  spec.massRatio ??= 0.5;
  // Kept for code that places lamp flares: lamp heights (front, rear) and centres across the car
  spec.lamps = [spec.headlight[1], spec.taillight[1]];
  spec.lampX = [spec.headlight[0], spec.taillight[0]];
}

const lerp = (a, b, t) => a + (b - a) * t;

// Monotone cubic (Fritsch-Carlson) interpolation through [x, y] control points: smooth, never overshoots
function smoothCurve(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  if (n === 1) return () => pts[0][1];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const h = [];
  const d = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1] - xs[i]);
    d.push((ys[i + 1] - ys[i]) / h[i]);
  }
  const m = [d[0]];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) {
      m.push(0);
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m.push((w1 + w2) / (w1 / d[i - 1] + w2 / d[i]));
    }
  }
  m.push(d[n - 2]);
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i];
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
}

// 1 along the body, falling to 0 at the tip along a superelliptic quarter (vertical tangent at the tip)
function endFactor(z, zTip, length, exponent = 2) {
  const u = zTip > 0 ? (z - (zTip - length)) / length : (zTip + length - z) / length;
  if (u <= 0) return 1;
  if (u >= 1) return 0;
  return Math.pow(1 - Math.pow(u, exponent), 1 / exponent);
}

/**
 * Evaluates a body spec's curves into the cross-section parameters along the vehicle (memoized on the spec):
 *   body(z) -> { W: half-width, yB: sill, yS: shoulder (widest), yE / xE: top edge, yT: crown, xB: sill half-width }
 */
function bodyProfile(spec) {
  if (spec._body) return spec._body;
  const W0 = smoothCurve(spec.halfWidth);
  const B0 = smoothCurve(spec.sill);
  const S0 = smoothCurve(spec.shoulder);
  const E0 = smoothCurve(spec.edge);
  const C0 = smoothCurve(spec.crown);
  const T0 = smoothCurve(spec.tumble);
  const archR = spec.wheelRadius + spec.archGap;
  const axles = spec.axles || [spec.wheelZ, -spec.wheelZ];

  const rounded = (z, value, key) => {
    const nose = spec.nose[key];
    const tail = spec.tail[key];
    if (nose && z > 0) value = nose[1] + (value - nose[1]) * endFactor(z, spec.zFront, nose[0], nose[2]);
    if (tail && z < 0) value = tail[1] + (value - tail[1]) * endFactor(z, spec.zRear, tail[0], tail[2]);
    return value;
  };

  const body = (z) => {
    let flare = 0;
    for (const axle of axles) {
      const d = (z - axle) / (archR + 0.4);
      if (Math.abs(d) < 1) flare = Math.max(flare, (1 - d * d) ** 2);
    }
    const W = rounded(z, W0(z) + spec.archFlare * flare, 'halfWidth');
    let yB = rounded(z, B0(z), 'sill');
    for (const axle of axles) {
      const d = Math.abs(z - axle);
      if (d < archR) yB = Math.max(yB, spec.wheelRadius + Math.sqrt(archR * archR - d * d));
    }
    const yE = rounded(z, E0(z), 'edge');
    const yT = yE + Math.max(0, rounded(z, C0(z), 'crown'));
    const yS = Math.min(Math.max(rounded(z, S0(z), 'shoulder'), yB + 0.035), yE - 0.035);
    const xE = Math.max(W - T0(z), W * 0.55);
    return { z, W, yB, yS, yE, yT, xE, xB: W - spec.tuck };
  };
  spec._body = body;
  return body;
}

/**
 * A car's body profile plus its glasshouse (memoized on the spec):
 *   cabin(z) -> { beltX, beltY: side glass base, railX, railY: top of the side glass, h: roof / glass crown height }
 */
function carLayout(spec) {
  if (spec._layout) return spec._layout;
  const body = bodyProfile(spec);
  const archR = spec.wheelRadius + spec.archGap;
  const cab = spec.cabin;
  const roofY = smoothCurve(cab.roofY);
  const H = cab.roofEdge + cab.roofCrown;
  const belt = (z) => {
    const s = body(z);
    return { x: s.xE - cab.inset, y: s.yE - 0.004 };
  };
  const bc = belt(cab.cowl);
  const bd = belt(cab.deck);
  const railF = { x: cab.rail[0], y: roofY(cab.roofFront) - H };
  const railR = { x: cab.rail[1], y: roofY(cab.roofRear) - H };
  const roofMid = (cab.roofFront + cab.roofRear) / 2;
  const railM = { x: (cab.rail[0] + cab.rail[1]) / 2, y: roofY(roofMid) - H };
  // At the cowl & deck the glass arch stays under the hood / trunk crown, so the glass grows out of the panel
  const hCowl = Math.max(0.006, body(cab.cowl).yT - bc.y - 0.008);
  const hDeck = Math.max(0.006, body(cab.deck).yT - bd.y - 0.008);

  const cabin = (z) => {
    const b = belt(z);
    let railX;
    let railY;
    let h;
    if (z >= cab.roofFront) {
      const t = (cab.cowl - z) / (cab.cowl - cab.roofFront);
      railX = lerp(bc.x, railF.x, t);
      railY = lerp(bc.y, railF.y, t);
      h = lerp(hCowl, H, Math.min(1, t * 1.6));
    } else if (z <= cab.roofRear) {
      const t = (z - cab.deck) / (cab.roofRear - cab.deck);
      railX = lerp(bd.x, railR.x, t);
      railY = lerp(bd.y, railR.y, t);
      h = lerp(hDeck, H, Math.min(1, t * 1.6));
    } else {
      const t = (cab.roofFront - z) / (cab.roofFront - cab.roofRear);
      railX = lerp(railF.x, railR.x, t);
      railY = roofY(z) - H;
      h = H;
    }
    return { z, beltX: Math.max(b.x, railX), beltY: Math.min(b.y, railY), railX, railY, h, bulge: cab.bulge };
  };

  // Height of the glasshouse's top surface (roof / windshield crown) at |x| for a cabin section
  const cabinTop = (c, x) => {
    const n = cab.roofRound;
    const ratio = Math.min(1, Math.abs(x) / Math.max(c.railX, 1e-4));
    const th = Math.acos(Math.pow(ratio, n / 2));
    return c.railY + c.h * Math.pow(Math.sin(th), 2 / n);
  };

  spec._layout = { spec, body, cabin, cabinTop, archR, belt: { cowl: bc, deck: bd }, rail: { front: railF, mid: railM, rear: railR, roofMid } };
  return spec._layout;
}

// Section winding used by every car loft in this file: left (-x) bottom, up & over the top, right (+x) bottom
function mirrorSection(right, center, z) {
  const pts = [];
  for (const [x, y] of right) pts.push(new THREE.Vector3(-x, y, z));
  if (center) pts.push(new THREE.Vector3(center[0], center[1], z));
  for (let i = right.length - 1; i >= 0; i--) pts.push(new THREE.Vector3(right[i][0], right[i][1], z));
  return pts;
}

const BODY_LOWER_ROUND = 2.8;
const BODY_UPPER_ROUND = 3.2;

// Right half of a body cross-section: superelliptic lower corner (sill -> widest point), superelliptic upper corner
// (widest point -> top edge) and a parabolic crown. Specs may sharpen the corners (lowerRound / upperRound) and sample
// the upper corner more densely (upperSamples).
function bodyHalfProfile(s, detail, spec = {}) {
  const n1 = spec.lowerRound || BODY_LOWER_ROUND;
  const n2 = spec.upperRound || BODY_UPPER_ROUND;
  const right = [];
  const low = detail ? [0, 0.32, 0.64, 1] : [0, 1];
  const up = detail ? spec.upperSamples || [0.38, 0.72, 1] : [1];
  const top = detail ? [0.66, 0.33] : [0.5];
  for (const a of low) {
    const th = (a * Math.PI) / 2;
    right.push([s.xB + (s.W - s.xB) * Math.pow(Math.sin(th), 2 / n1), s.yS - (s.yS - s.yB) * Math.pow(Math.cos(th), 2 / n1)]);
  }
  for (const a of up) {
    const th = (a * Math.PI) / 2;
    right.push([s.xE + (s.W - s.xE) * Math.pow(Math.cos(th), 2 / n2), s.yS + (s.yE - s.yS) * Math.pow(Math.sin(th), 2 / n2)]);
  }
  for (const f of top) right.push([s.xE * f, s.yE + (s.yT - s.yE) * (1 - f * f)]);
  return right;
}

function bodyStations(spec, detail) {
  const zs = [];
  const add = (z) => zs.push(Math.min(spec.zFront, Math.max(spec.zRear, z)));
  const step = detail ? spec.stationStep || 0.28 : 0.75;
  for (let z = spec.zRear; z < spec.zFront; z += step) add(z);
  add(spec.zFront);
  const noseLen = Math.max(...Object.values(spec.nose).map((v) => v[0]));
  const tailLen = Math.max(...Object.values(spec.tail).map((v) => v[0]));
  for (const u of detail ? [0, 0.3, 0.52, 0.7, 0.83, 0.92, 0.97, 0.993] : [0, 0.6, 0.92]) {
    add(spec.zFront - noseLen * (1 - u));
    add(spec.zRear + tailLen * (1 - u));
  }
  const archR = spec.wheelRadius + spec.archGap;
  const k = detail ? 8 : 4;
  for (const axle of spec.axles || [spec.wheelZ, -spec.wheelZ]) {
    for (let i = 0; i <= k; i++) add(axle + archR * Math.cos((i / k) * Math.PI));
    add(axle + archR + 0.006);
    add(axle - archR - 0.006);
  }
  if (detail && spec.cabin) {
    add(spec.cabin.cowl);
    add(spec.cabin.deck);
  }
  zs.sort((a, b) => b - a);
  const eps = detail ? 0.004 : 0.04;
  const out = [];
  for (const z of zs) {
    if (!out.length || out[out.length - 1] - z > eps) out.push(z);
  }
  out[0] = spec.zFront;
  out[out.length - 1] = spec.zRear;
  return out;
}

function buildBodyLoft(spec, detail = 1) {
  const body = bodyProfile(spec);
  const sections = bodyStations(spec, detail).map((z) => {
    const s = body(z);
    return mirrorSection(bodyHalfProfile(s, detail, spec), [0, s.yT], z);
  });
  return new LoftGeometry(sections, { capStart: true, capEnd: true });
}

function buildCarBody(spec, detail = 1) {
  return part(buildBodyLoft(spec, detail), CAR_PARTS.BODY);
}

function cabinSection(c, detail, roundness) {
  const right = [[c.beltX, c.beltY]];
  if (detail) {
    for (const s of [1 / 3, 2 / 3]) {
      right.push([lerp(c.beltX, c.railX, s) + c.bulge * 4 * s * (1 - s), lerp(c.beltY, c.railY, s)]);
    }
  }
  right.push([c.railX, c.railY]);
  for (const f of detail ? [0.2, 0.42, 0.68] : [0.5]) {
    const th = (f * Math.PI) / 2;
    right.push([c.railX * Math.pow(Math.cos(th), 2 / roundness), c.railY + c.h * Math.pow(Math.sin(th), 2 / roundness)]);
  }
  return mirrorSection(right, [0, c.railY + c.h], c.z);
}

function cabinStations(spec, detail) {
  const cab = spec.cabin;
  const zs = [];
  for (const t of detail ? [0, 0.1, 0.24, 0.42, 0.62, 0.82] : [0, 0.5]) zs.push(lerp(cab.cowl, cab.roofFront, t));
  for (const t of detail ? [0, 0.25, 0.5, 0.75] : [0, 0.5]) zs.push(lerp(cab.roofFront, cab.roofRear, t));
  for (const t of detail ? [1, 0.8, 0.6, 0.4, 0.22, 0.1, 0] : [1, 0.5, 0]) zs.push(lerp(cab.deck, cab.roofRear, t));
  return zs;
}

function buildCarCabin(spec, detail = 1) {
  const L = carLayout(spec);
  const sections = cabinStations(spec, detail).map((z) => cabinSection(L.cabin(z), detail, spec.cabin.roofRound));
  return part(new LoftGeometry(sections, { closed: false }), CAR_PARTS.WINDOW);
}

/**
 * Half-width of a body's outer skin at height y of the cross-section at z (for decals & signs that hug the sides)
 */
function carBodyHalfWidthAt(spec, z, y) {
  const s = bodyProfile(spec)(z);
  const n1 = spec.lowerRound || BODY_LOWER_ROUND;
  const n2 = spec.upperRound || BODY_UPPER_ROUND;
  const pts = [];
  for (let i = 0; i <= 16; i++) {
    const th = ((i / 16) * Math.PI) / 2;
    pts.push([s.xB + (s.W - s.xB) * Math.pow(Math.sin(th), 2 / n1), s.yS - (s.yS - s.yB) * Math.pow(Math.cos(th), 2 / n1)]);
  }
  for (let i = 1; i <= 16; i++) {
    const th = ((i / 16) * Math.PI) / 2;
    pts.push([s.xE + (s.W - s.xE) * Math.pow(Math.cos(th), 2 / n2), s.yS + (s.yE - s.yS) * Math.pow(Math.sin(th), 2 / n2)]);
  }
  if (y <= pts[0][1]) return pts[0][0];
  for (let i = 1; i < pts.length; i++) {
    if (y <= pts[i][1]) {
      const t = (y - pts[i - 1][1]) / Math.max(pts[i][1] - pts[i - 1][1], 1e-6);
      return lerp(pts[i - 1][0], pts[i][0], t);
    }
  }
  return s.xE;
}

/**
 * A thin grid patch lying `offset` m off the body side (side = +1: +x) over z0..z1, y0..y1. UVs read from the
 * front of the car to the back on both sides (u = 0 at the front on the +x side, at the back on the -x side).
 */
function buildCarSidePatch(spec, side, z0, z1, y0, y1, offset = 0.003, nz = 10, ny = 6) {
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let j = 0; j <= ny; j++) {
    const v = j / ny;
    const y = lerp(y0, y1, v);
    for (let i = 0; i <= nz; i++) {
      const u = i / nz;
      const z = side > 0 ? lerp(z1, z0, u) : lerp(z0, z1, u);
      positions.push(side * (carBodyHalfWidthAt(spec, z, y) + offset), y, z);
      uvs.push(u, v);
      if (i < nz && j < ny) {
        const a = j * (nz + 1) + i;
        const b = a + 1;
        const c = a + nz + 1;
        const d = c + 1;
        if (side > 0) indices.push(a, b, c, b, d, c);
        else indices.push(a, c, b, b, c, d);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

function roundedRectShape(hw, hh, r) {
  const s = new THREE.Shape();
  s.moveTo(-hw + r, -hh);
  s.lineTo(hw - r, -hh);
  s.quadraticCurveTo(hw, -hh, hw, -hh + r);
  s.lineTo(hw, hh - r);
  s.quadraticCurveTo(hw, hh, hw - r, hh);
  s.lineTo(-hw + r, hh);
  s.quadraticCurveTo(-hw, hh, -hw, hh - r);
  s.lineTo(-hw, -hh + r);
  s.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
  return s;
}

// Rounded box extruded along z, centred on the origin
function roundedBox(hw, hh, depth, r, bevel = 0.012) {
  const g = new THREE.ExtrudeGeometry(roundedRectShape(hw - bevel, hh - bevel, Math.max(0.002, r - bevel)), {
    depth: Math.max(0.001, depth - 2 * bevel),
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: 2
  });
  return g.translate(0, 0, -(depth - 2 * bevel) / 2);
}

/**
 * Builds a single wheel assembly (LatheGeometry tyre + recessed alloy lip + dished hub)
 * centered at the origin (for steerable/spinning player wheels) or translated to (x, r, z).
 */
function buildWheelParts(spec, side, translateToAxle = false, z = 0) {
  const r = spec.wheelRadius;
  const rim = r * (spec.aero ? 0.68 : 0.64);
  const width = r * 0.68;
  const wheelProfile = [
    new THREE.Vector2(rim + 0.014, -width * 0.44),
    new THREE.Vector2(r * 0.96, -width * 0.33),
    new THREE.Vector2(r, -width * 0.05),
    new THREE.Vector2(r, width * 0.05),
    new THREE.Vector2(r * 0.96, width * 0.33),
    new THREE.Vector2(rim + 0.014, width * 0.44)
  ];

  const x = translateToAxle ? side * spec.wheelX : 0;
  const y = translateToAxle ? r : 0;
  const zOff = translateToAxle ? z : 0;

  const tyre = new THREE.LatheGeometry(wheelProfile, 20)
    .rotateZ(-side * Math.PI * 0.5)
    .translate(x, y, zOff);
  const lip = new THREE.LatheGeometry(
    [new THREE.Vector2(rim + 0.014, width * 0.44), new THREE.Vector2(rim, width * 0.29)],
    20
  )
    .rotateZ(-side * Math.PI * 0.5)
    .translate(x, y, zOff);
  const backLip = new THREE.LatheGeometry(
    [new THREE.Vector2(rim, -width * 0.29), new THREE.Vector2(rim + 0.014, -width * 0.44)],
    20
  )
    .rotateZ(-side * Math.PI * 0.5)
    .translate(x, y, zOff);
  const hub = new THREE.CircleGeometry(rim, 20);
  hub.attributes.position.setZ(0, -0.015);
  hub.computeVertexNormals();
  hub.rotateY(side * Math.PI * 0.5).translate(x + side * width * 0.29, y, zOff);

  const backHub = new THREE.CircleGeometry(rim, 20);
  backHub.attributes.position.setZ(0, -0.015);
  backHub.computeVertexNormals();
  backHub.rotateY(-side * Math.PI * 0.5).translate(x - side * width * 0.29, y, zOff);

  const list = [
    part(tyre, CAR_PARTS.TYRE),
    part(lip, CAR_PARTS.ALLOY),
    part(backLip, CAR_PARTS.ALLOY),
    part(hub, CAR_PARTS.ALLOY),
    part(backHub, CAR_PARTS.ALLOY)
  ];

  if (translateToAxle) list.push(buildWheelWell(spec, side, z));
  return list;
}

// Dark arch liner behind a wheel, so the arch never shows through to the other side of the car
function buildWheelWell(spec, side, z) {
  const r = spec.wheelRadius;
  const width = r * 0.68;
  const wellOuter = new THREE.CircleGeometry(spec.wheelRadius + spec.archGap + 0.01, 10, 0, Math.PI)
    .rotateY(side * Math.PI * 0.5)
    .translate(side * (spec.wheelX - (width * 0.5 + 0.02)), r, z);
  const wellInner = new THREE.CircleGeometry(spec.wheelRadius + spec.archGap + 0.01, 10, 0, Math.PI)
    .rotateY(-side * Math.PI * 0.5)
    .translate(side * (spec.wheelX - (width * 0.5 + 0.02)), r, z);
  return part(mergeGeometries([wellOuter, wellInner]), CAR_PARTS.TRIM);
}

function buildSteerableWheelGeo(spec, side) {
  return mergeGeometries(buildWheelParts(spec, side, false));
}

function buildMirrors(spec) {
  const L = carLayout(spec);
  const z = spec.cabin.cowl - 0.17;
  const c = L.cabin(z);
  const list = [];
  for (const side of [-1, 1]) {
    const housing = roundedBox(0.1, 0.06, 0.085, 0.035, 0.014)
      .rotateY(side * 0.12)
      .translate(side * (c.beltX + 0.15), c.beltY + 0.085, z - 0.02);
    const arm = new THREE.BoxGeometry(0.12, 0.035, 0.06)
      .rotateZ(side * 0.35)
      .translate(side * (c.beltX + 0.04), c.beltY + 0.045, z);
    list.push(part(housing, CAR_PARTS.MIRROR), part(arm, CAR_PARTS.TRIM));
  }
  return list;
}

function buildRoofRails(spec) {
  const L = carLayout(spec);
  const cab = spec.cabin;
  const list = [];
  for (const side of [-1, 1]) {
    const sections = [0.04, 0.1, 0.9, 0.96].map((t, i) => {
      const z = lerp(cab.roofFront, cab.roofRear, t);
      const c = L.cabin(z);
      const x = side * c.railX * 0.8;
      const y = L.cabinTop(c, x) + (i === 0 || i === 3 ? 0.004 : 0.05);
      return [
        new THREE.Vector3(x - 0.02, y - 0.016, z),
        new THREE.Vector3(x + 0.02, y - 0.016, z),
        new THREE.Vector3(x + 0.02, y + 0.016, z),
        new THREE.Vector3(x - 0.02, y + 0.016, z)
      ].reverse();
    });
    list.push(part(new LoftGeometry(sections, { capStart: true, capEnd: true }), CAR_PARTS.TRIM));
  }
  return list;
}

// Wrap the bumper strips around the nose and tail. Six rectangular sections cost just 44 triangles each;
// the inner faces sit in the body, while the outer faces stand 2.5 cm proud of the tips.
function buildBumpers(spec) {
  return spec.bumpers.map(([y, h], end) => {
    const direction = end === 0 ? 1 : -1;
    const tip = end === 0 ? spec.zFront : spec.zRear;
    const sections = [];
    for (const side of [-1, 1]) {
      for (const setback of side < 0 ? [0.3, 0.07, 0] : [0, 0.07, 0.3]) {
        const z = tip - direction * setback;
        const x = side * (carBodyHalfWidthAt(spec, z, y) + 0.012);
        const innerX = x - side * 0.05;
        const outerZ = z + direction * 0.025;
        const innerZ = z - direction * 0.105;
        const section = [
          new THREE.Vector3(x, y - h, outerZ),
          new THREE.Vector3(innerX, y - h, innerZ),
          new THREE.Vector3(innerX, y + h, innerZ),
          new THREE.Vector3(x, y + h, outerZ)
        ];
        sections.push(direction > 0 ? section : section.reverse());
      }
    }
    return part(new LoftGeometry(sections, { capStart: true, capEnd: true }), CAR_PARTS.TRIM);
  });
}

function taxiSignLayout(spec) {
  const L = carLayout(spec), z = L.rail.roofMid;
  return { width: 0.45, height: 0.15, depth: 0.12, z, y: L.cabinTop(L.cabin(z), 0) + 0.08 };
}

function buildTaxiSign(spec) {
  const s = taxiSignLayout(spec);
  return part(new THREE.BoxGeometry(s.width, s.height, s.depth).translate(0, s.y, s.z), CAR_PARTS.SIGN);
}

function buildCarGeometry(spec, includeWheels = true) {
  const parts = [buildCarBody(spec, 1), buildCarCabin(spec, 1), ...buildMirrors(spec), ...buildBumpers(spec)];
  for (const side of [-1, 1]) {
    for (const z of [-spec.wheelZ, spec.wheelZ]) {
      if (includeWheels) parts.push(...buildWheelParts(spec, side, true, z));
      else parts.push(buildWheelWell(spec, side, z));
    }
  }
  if (spec.rails) parts.push(...buildRoofRails(spec));
  if (spec.taxiSign) parts.push(buildTaxiSign(spec));
  return mergeGeometries(parts);
}

// A ~500-triangle stand-in for distant cars (a few pixels tall): the same body & glasshouse lofted from a handful of
// coarse sections and dark wheel blocks. Same attributes (partId, uv, normal) as the full
// model, so it renders with the same material and per-instance paint.
function buildCarProxyGeometry(spec) {
  const parts = [buildCarBody(spec, 0), buildCarCabin(spec, 0)];
  if (spec.taxiSign) parts.push(buildTaxiSign(spec));
  const r = spec.wheelRadius;
  for (const side of [-1, 1]) {
    for (const z of [-spec.wheelZ, spec.wheelZ]) {
      parts.push(part(new THREE.BoxGeometry(r * 0.6, r * 1.7, r * 1.7).translate(side * spec.wheelX, r * 0.88, z), CAR_PARTS.TYRE));
    }
  }
  return mergeGeometries(parts);
}

// Filter-width anti-aliased 2D rounded rectangle SDF (ported from CarGenerator.js)
const roundedRect = Fn(([point, halfSize, radiusNode]) => {
  const pt = vec2(point).toVar();
  const hs = vec2(halfSize).toVar();
  const rad = float(radiusNode).toVar();
  const q = abs(pt).sub(hs).add(rad).toVar();
  const dist = length(max(q, vec2(0.0))).add(min(max(q.x, q.y), 0.0)).sub(rad).toVar();
  const edge = max(fwidth(dist), 0.001).toVar();
  return smoothstep(edge, edge.negate(), dist);
});

// IQ polynomial smooth maximum: rounds the corners of max()-combined half-plane distances
const smax = (a, b, k) => {
  const h = max(float(k).sub(abs(a.sub(b))), 0.0).div(k);
  return max(a, b).add(h.mul(h).mul(k * 0.25));
};

// Signed distance (approximate outside, exact inside) to a convex polygon given as outward half-planes [nx, ny, c]
const polygonDistance = (px, py, planes, k) => {
  let d = null;
  for (const [nx, ny, c] of planes) {
    const e = px.mul(nx).add(py.mul(ny)).sub(c);
    d = d === null ? e : smax(d, e, k);
  }
  return d;
};

// Outward half-planes of a counter-clockwise polygon, each edge moved in by its margin
function polygonPlanes(points, margins) {
  const planes = [];
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    const len = Math.hypot(bx - ax, by - ay);
    const nx = (by - ay) / len;
    const ny = -(bx - ax) / len;
    planes.push([nx, ny, ax * nx + ay * ny - margins[i]]);
  }
  return planes;
}

const coverage = (d) => {
  const w = max(fwidth(d), 0.0008);
  return smoothstep(w, w.negate(), d);
};

const _carMaterialCache = new Map();
const _carPlateTextures = new Map();
let _taxiSignTexture;

function carPlateTexture(commercial = false) {
  if (_carPlateTextures.has(commercial)) return _carPlateTextures.get(commercial);
  const canvas = document.createElement('canvas');
  const { textureWidth: w, rowHeight: h, variants } = CAR_PLATE;
  canvas.width = w;
  canvas.height = h * variants;
  const ctx = canvas.getContext('2d');
  for (let row = 0; row < variants; row++) {
    const y = row * h;
    ctx.fillStyle = commercial ? '#f3cf25' : '#f4f4ef';
    ctx.fillRect(0, y, w, h);
    ctx.strokeStyle = '#bf2831';
    ctx.lineWidth = 2;
    ctx.strokeRect(3, y + 3, w - 6, h - 6);
    ctx.fillStyle = '#1563a1';
    ctx.fillRect(7, y + 7, 45, h - 14);
    ctx.fillStyle = '#f5d844';
    for (let k = 0; k < 12; k++) {
      const a = k * Math.PI / 6;
      ctx.fillRect(28 + Math.sin(a) * 13, y + 32 + Math.cos(a) * 13, 3, 3);
    }
    ctx.fillStyle = '#f4f4ef';
    ctx.font = 'bold 24px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('DK', 29, y + 79);
    ctx.fillStyle = '#17191b';
    ctx.font = 'bold 82px "Arial Narrow", "Liberation Sans Narrow", Arial, sans-serif';
    ctx.fillText(plateRegistration(row), 284, y + 60, 438);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  _carPlateTextures.set(commercial, tex);
  return tex;
}

function taxiSignTexture() {
  if (_taxiSignTexture) return _taxiSignTexture;
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 80;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#16834d'; ctx.fillRect(0, 0, 256, 80);
  ctx.fillStyle = '#f4f4e9'; ctx.font = 'bold 62px Arial, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('TAXI', 128, 43);
  _taxiSignTexture = new THREE.CanvasTexture(canvas);
  _taxiSignTexture.colorSpace = THREE.SRGBColorSpace;
  return _taxiSignTexture;
}

/**
 * Creates the TSL material for lofted vehicles.
 * Instanced traffic reads the per-instance `paintColor` (vec3) and `carState` (vec4: brake, left (+x) & right (-x)
 * turn signal, taxi sign) attributes; with a fixed `fixedColorHex` (the player's car, wheels) the state is the
 * `material.userData.carState` uniform instead.
 * Every mask is built once and shared by the colour, roughness, metalness & emissive graphs (TSL turns nodes used
 * more than once into temporaries), so the fragment shader evaluates each SDF a single time.
 */
function createLoftedCarMaterial(spec, fixedColorHex = null) {
  const cacheKey = `${spec.name}_${fixedColorHex ?? 'instanced'}_${spec.taxiSign ? 'taxi' : 'private'}`;
  if (_carMaterialCache.has(cacheKey)) {
    return _carMaterialCache.get(cacheKey);
  }

  const L = carLayout(spec);
  const cab = spec.cabin;
  const fixed = fixedColorHex !== null;
  const stateUniform = fixed ? uniform(new THREE.Vector4(0, 0, 0, 0)) : null;
  const state = fixed ? stateUniform : attribute('carState', 'vec4');
  const paint = fixed ? color(fixedColorHex) : attribute('paintColor', 'vec3');

  const axleZ = float(spec.wheelZ);
  const wheelR = float(spec.wheelRadius);
  const archR = L.archR;

  // Glass outlines from the glasshouse layout: side windows in side view (z, y), windshield & backlight from above
  // (|x|, z). Each edge is pulled in by its pillar / frame width; the seal outline sits a little further out.
  const bc = L.belt.cowl;
  const bd = L.belt.deck;
  const rf = L.rail.front;
  const rm = L.rail.mid;
  const rr = L.rail.rear;
  const sidePoly = [[cab.cowl, bc.y], [cab.roofFront, rf.y], [L.rail.roofMid, rm.y], [cab.roofRear, rr.y], [cab.deck, bd.y]];
  const sideGlassPlanes = polygonPlanes(sidePoly, [0.05, 0.03, 0.03, 0.065, 0.02]);
  const sideSealPlanes = polygonPlanes(sidePoly, [0.034, 0.016, 0.016, 0.05, 0.004]);
  const frontPoly = [[-1, cab.cowl], [-1, cab.roofFront], [rf.x, cab.roofFront], [bc.x, cab.cowl]];
  const frontGlassPlanes = polygonPlanes(frontPoly, [0, 0.045, 0.06, 0.05]);
  const frontSealPlanes = polygonPlanes(frontPoly, [0, 0.03, 0.045, 0.035]);
  const rearPoly = [[-1, cab.roofRear], [-1, cab.deck], [bd.x, cab.deck], [rr.x, cab.roofRear]];
  const rearGlassPlanes = polygonPlanes(rearPoly, [0, 0.045, 0.065, 0.05]);
  const rearSealPlanes = polygonPlanes(rearPoly, [0, 0.03, 0.05, 0.035]);
  const [hlX, hlY, hlW, hlH] = spec.headlight;
  const [tlX, tlY, tlW, tlH] = spec.taillight;
  const [grY, grW, grH] = spec.grille;
  const [inY, inW, inH] = spec.intake;
  const [plateF, plateR] = spec.plates;
  const frontZone = spec.zFront - 0.55;
  const rearZone = spec.zRear + 0.55;
  const sillY = spec.sill[1][1];
  const rearSill = spec.tail.sill[1];
  const one = float(1.0);

  const p = attribute('position', 'vec3');
  const n = attribute('normal', 'vec3');
  const partId = attribute('partId', 'float');
  const isPart = (id) => step(abs(partId.sub(id)), 0.25);
  const isBody = isPart(CAR_PARTS.BODY);
  const isWindow = isPart(CAR_PARTS.WINDOW);
  const isTyre = isPart(CAR_PARTS.TYRE);
  const isAlloy = isPart(CAR_PARTS.ALLOY);
  const isTrim = isPart(CAR_PARTS.TRIM);
  const isMirror = isPart(CAR_PARTS.MIRROR);
  const isSign = isPart(CAR_PARTS.SIGN);
  const ax = abs(p.x);
  const isSide = smoothstep(0.45, 0.7, abs(n.x));
  const front = smoothstep(0.12, 0.38, n.z).mul(step(frontZone, p.z)).mul(isBody);
  const rear = smoothstep(0.12, 0.38, n.z.negate()).mul(step(p.z, rearZone)).mul(isBody);
  const under = smoothstep(-0.25, -0.55, n.y).mul(isBody);
  const belt = mix(float(bd.y), float(bc.y), clamp(p.z.sub(cab.deck).div(cab.cowl - cab.deck), 0.0, 1.0));

  // Glasshouse: side windows (minus the B / C pillars), windshield & backlight, their black seals, chrome sill strip
  let sideG = polygonDistance(p.z, p.y, sideGlassPlanes, 0.07);
  for (const zp of cab.pillars) sideG = max(sideG, float(0.036).sub(abs(p.z.sub(zp))));
  const cabOnly = spec.panelVan ? step(1.04, p.z) : float(1.0);
  const backlight = spec.panelVan ? float(0.0) : coverage(polygonDistance(ax, p.z, rearGlassPlanes, 0.09)).mul(isWindow);
  const glass = max(max(coverage(sideG).mul(cabOnly), coverage(polygonDistance(ax, p.z, frontGlassPlanes, 0.09))), backlight.div(max(isWindow, 1e-4)))
    .mul(isWindow);
  const seal = max(
    coverage(polygonDistance(p.z, p.y, sideSealPlanes, 0.07)).mul(cabOnly),
    max(coverage(polygonDistance(ax, p.z, frontSealPlanes, 0.09)), spec.panelVan ? float(0.0) : coverage(polygonDistance(ax, p.z, rearSealPlanes, 0.09)))
  ).mul(isWindow);
  const chromeBelt = spec.chrome
    ? smoothstep(0.003, 0.006, p.y.sub(belt))
      .mul(smoothstep(0.016, 0.012, p.y.sub(belt)))
      .mul(smoothstep(0.5, 0.7, abs(n.x)))
      .mul(step(cab.deck + 0.05, p.z))
      .mul(step(p.z, cab.cowl - 0.08))
      .mul(isWindow)
    : float(0.0);
  const chmsl = roundedRect(vec2(p.x, p.z.sub(cab.roofRear - 0.075)), vec2(0.14, 0.012), 0.005).mul(backlight).mul(step(n.z, -0.1));
  const rearWiper = spec.rearWiper
    ? roundedRect(vec2(p.x.add(0.15), p.z.sub(cab.deck + 0.075)), vec2(0.22, 0.006), 0.003).mul(backlight)
    : float(0.0);

  // Wheel arches: distance from the nearest axle in side view (or from the hub of a centred, spinning wheel)
  const isCenteredWheel = step(abs(p.z), wheelR.add(0.05)).mul(max(isTyre, isAlloy));
  const wheelVec = mix(vec2(abs(p.z).sub(axleZ), p.y.sub(wheelR)), vec2(p.z, p.y), isCenteredWheel);
  const wheelDist = length(wheelVec);

  // Lamps, grilles & plates on the nose and tail (projected along z, so the lamps wrap around the corners)
  const hlUV = vec2(ax.sub(hlX), p.y.sub(hlY));
  const headlight = roundedRect(hlUV, vec2(hlW, hlH), 0.01).mul(smoothstep(0.02, 0.25, n.z)).mul(step(frontZone, p.z)).mul(isBody);
  const turnFront = smoothstep(hlX + hlW * 0.65, hlX + hlW * 0.72, ax).mul(headlight);
  const divider = smoothstep(max(fwidth(ax), 0.007), 0.002, abs(hlUV.x.add(hlW * 0.1)));
  const headlightLens = roundedRect(hlUV, vec2(hlW - 0.012, hlH - 0.012), 0.006)
    .mul(headlight).mul(one.sub(max(divider, turnFront)));
  const drlDist = abs(hlUV.y.add(hlH * 0.6));
  const drlEdge = max(fwidth(drlDist), 0.006);
  const drl = smoothstep(drlEdge, 0.0, drlDist).mul(headlight).mul(one.sub(turnFront));
  const lightBar = spec.lightBar ? roundedRect(vec2(p.x, p.y.sub(hlY)), vec2(0.76, 0.012), 0.006).mul(front) : float(0.0);
  const rearBar = spec.lightBar ? roundedRect(vec2(p.x, p.y.sub(tlY)), vec2(0.76, 0.012), 0.006).mul(rear) : float(0.0);
  const grille = spec.lightBar ? float(0.0) : roundedRect(vec2(p.x, p.y.sub(grY)), vec2(grW, grH), 0.015).mul(front);
  const intake = roundedRect(vec2(p.x, p.y.sub(inY)), vec2(inW, inH), 0.04).mul(front);
  const plateFront = roundedRect(vec2(p.x, p.y.sub(plateF)), vec2(CAR_PLATE.width / 2, CAR_PLATE.height / 2), 0.008).mul(front);
  const tlUV = vec2(ax.sub(tlX), p.y.sub(tlY));
  const taillight = roundedRect(tlUV, vec2(tlW, tlH), 0.022)
    .mul(smoothstep(0.02, 0.25, n.z.negate()))
    .mul(step(p.z, rearZone))
    .mul(isBody);
  // Sedans use horizontal lenses; taller SUV lamps stack their three sections vertically.
  const tailAxis = tlH > tlW ? tlUV.y.div(tlH) : tlUV.x.div(tlW);
  const tailDivider = coverage(min(abs(tailAxis.sub(0.52)), abs(tailAxis.add(0.55))).sub(0.025));
  const tailLens = roundedRect(tlUV, vec2(tlW - 0.006, tlH - 0.006), 0.017)
    .mul(taillight).mul(one.sub(tailDivider));
  const turnRearSection = smoothstep(0.50, 0.54, tailAxis);
  const reverseRearSection = smoothstep(-0.53, -0.57, tailAxis);
  const turnRear = turnRearSection.mul(tailLens);
  const redLens = tailLens.mul(one.sub(max(turnRearSection, reverseRearSection)));
  const plateRear = roundedRect(vec2(p.x, p.y.sub(plateR)), vec2(CAR_PLATE.width / 2, CAR_PLATE.height / 2), 0.008).mul(rear);
  const platePocket = roundedRect(vec2(p.x, p.y.sub(plateR + 0.01)), vec2(0.29, 0.095), 0.03).mul(rear);
  const trunkHandle = roundedRect(vec2(p.x, p.y.sub(plateR + 0.125)), vec2(0.18, 0.012), 0.008).mul(rear);
  const plateRecess = max(
    roundedRect(vec2(p.x, p.y.sub(plateF)), vec2(0.275, 0.067), 0.012).mul(front),
    roundedRect(vec2(p.x, p.y.sub(plateR)), vec2(0.275, 0.067), 0.02).mul(rear)
  );
  const rearValance = smoothstep(rearSill + 0.07, rearSill + 0.015, p.y).mul(rear);
  const reflector = roundedRect(vec2(ax.sub(0.64), p.y.sub(spec.bumpers[1][0] + 0.065)), vec2(0.065, 0.012), 0.006).mul(rear);
  const trunkWidth = mix(float(tlX - tlW - 0.025), float(tlX), smoothstep(tlY - tlH, spec.tail.edge[1], p.y));
  const trunkEdge = max(ax.sub(trunkWidth), float(spec.bumperLine[1]).sub(p.y));
  const panelSeam = max(
    smoothstep(0.006, 0.0025, abs(p.y.sub(spec.bumperLine[0]))).mul(step(ax, hlX - hlW * 0.6)).mul(front),
    coverage(abs(trunkEdge).sub(0.003)).mul(rear)
  );
  const cowlPanel = smoothstep(cab.cowl + 0.085, cab.cowl + 0.07, p.z)
    .mul(smoothstep(cab.cowl - 0.04, cab.cowl - 0.02, p.z))
    .mul(step(0.6, n.y))
    .mul(isBody);
  const mirrorGlass = isMirror.mul(step(0.55, n.z.negate()));
  const lamp = max(max(headlight, taillight), max(lightBar, rearBar));
  const plates = max(plateFront, plateRear);
  const cladding =
    spec.cladding > 0
      ? max(smoothstep(spec.cladding + 0.01, spec.cladding - 0.01, p.y), smoothstep(archR + 0.075, archR + 0.06, wheelDist))
        .mul(isBody)
        .mul(one.sub(lamp))
        .mul(one.sub(plates))
      : float(0.0);

  // 5-spoke alloys (branchless 5-ray star SDF) with rim ring & hub, lug ribs on the tyre tread
  const wDir = wheelVec.div(max(wheelDist, 0.0001));
  let spokes = float(0.0);
  for (let k = 0; k < 5; k++) {
    const ang = (k * Math.PI * 2) / 5;
    const cs = Math.cos(ang);
    const sn = Math.sin(ang);
    const alongSpoke = wDir.x.mul(cs).add(wDir.y.mul(sn));
    const perp = abs(wDir.x.mul(sn).sub(wDir.y.mul(cs))).mul(wheelDist);
    spokes = max(spokes, smoothstep(0.034, 0.018, perp).mul(step(0.0, alongSpoke)));
  }
  const rimRing = smoothstep(wheelR.mul(0.56), wheelR.mul(0.6), wheelDist);
  const centerHub = smoothstep(0.068, 0.042, wheelDist);
  const centerCap = smoothstep(0.03, 0.018, wheelDist);
  const valveDot = smoothstep(0.028, 0.014, length(wheelVec.sub(vec2(0.0, wheelR.mul(-0.48)))));
  const alloyMetal = spec.aero
    ? float(0.65).add(spokes.mul(0.16)).mul(one.sub(centerCap.mul(0.35)))
    : clamp(max(max(spokes, valveDot), max(rimRing, centerHub)).sub(centerCap.mul(0.85)), 0.0, 1.0);

  // Black plastic & rubber (grilles, seals, trims, tyres, cladding) is matte; lamps, glass & chrome are glossy
  const matte = max(
    max(max(isTyre, isTrim), max(intake, grille)),
    max(max(rearValance, under), max(max(cowlPanel, cladding), max(rearWiper, seal.mul(one.sub(max(glass, chromeBelt))))))
  );

  // ---- Colour ---------------------------------------------------------------------------------------------------
  // Plain paint: the instance's colour
  const painted = paint;

  // Panel shading: soft occlusion low down & under the arch lips; unpainted cladding (SUVs); door shut lines &
  // handles; trunk / hood shut lines; black cowl panel under the windshield
  const archLip = smoothstep(archR + 0.05, archR - 0.005, wheelDist).mul(smoothstep(0.6, 0.9, ax));
  const ao = smoothstep(0.2, 0.62, p.y).mul(0.22).add(0.78).mul(one.sub(archLip.mul(0.55)));
  const onDoors = isSide.mul(smoothstep(sillY + 0.04, sillY + 0.07, p.y)).mul(smoothstep(0.0, -0.015, p.y.sub(belt)));
  let seams = float(0.0);
  for (const zd of spec.doors) seams = max(seams, smoothstep(0.009, 0.003, abs(p.z.sub(zd))));
  for (const zh of spec.handles) {
    seams = max(seams, roundedRect(vec2(p.z.sub(zh), p.y.sub(belt.sub(0.095))), vec2(0.06, 0.011), 0.008));
  }
  let body = mix(painted.mul(ao), color(0x1e2124), cladding);
  body = body.mul(one.sub(seams.mul(onDoors).mul(0.55))).mul(one.sub(panelSeam.mul(0.5)));
  body = mix(body, color(0x15181b), cowlPanel);

  // Nose: slatted grilles and broad divided reflectors inside squared lamp housings, with outer amber indicators.
  const slats = step(0.5, fract(p.y.mul(42.0))).mul(0.4).add(0.6);
  body = mix(body, color(0x111417).mul(slats), max(intake, grille));
  const lensShade = smoothstep(0.0, hlH, abs(hlUV.y)).mul(0.35).add(0.65);
  const lampColor = mix(mix(color(0x30383e), color(0xc2ccd2).mul(lensShade), headlightLens), color(0xe4e9eb), drl);
  body = mix(body, mix(lampColor, color(0xc5802b), turnFront), headlight);
  // Tail: thin rubber seals around divided red, amber and clear lenses.
  const tailShade = smoothstep(0.0, tlH, abs(tlUV.y)).mul(-0.3).add(1.0);
  const tailColor = mix(mix(color(0xae1821).mul(tailShade), color(0xc56b18), turnRearSection), color(0xbac4c9), reverseRearSection);
  body = mix(body, color(0x15181b), rearValance);
  body = mix(body, color(0x7a0a10), reflector);
  body = mix(body, color(0x222326), taillight);
  body = mix(body, tailColor, tailLens);
  body = mix(body, color(0xdbe3e6), lightBar);
  body = mix(body, color(0x9b1420), rearBar);
  // Shaded recess and handle sit in the painted trunk / hatch, above the bumper.
  const pocketShade = smoothstep(plateR - 0.09, plateR + 0.115, p.y).mul(-0.25).add(0.9);
  body = mix(body, body.mul(pocketShade), platePocket);
  body = mix(body, color(0x303438), trunkHandle);
  body = mix(body, color(0x24292d), plateRecess);
  body = mix(body, color(0xf4f4ef), plates);
  const plateVariant = floor(fract(paint.r.mul(7).add(paint.g.mul(13)).add(paint.b.mul(17))).mul(CAR_PLATE.variants));
  const plateUV = vec2(mix(p.x.negate(), p.x, front).div(CAR_PLATE.width).add(0.5), p.y.sub(mix(float(plateR), float(plateF), front)).div(CAR_PLATE.height).add(0.5));
  const plateColor = texture(carPlateTexture(Boolean(spec.panelVan)), vec2(clamp(plateUV.x, 0.001, 0.999), clamp(plateUV.y, 0.005, 0.995).add(plateVariant).div(CAR_PLATE.variants))).rgb;
  body = mix(body, plateColor, plates);
  body = mix(body, color(0x0e1013), under);

  // Glasshouse: tinted glass, black seals & B / C pillars, painted roof & A pillars, chrome sill strip, CHMSL
  const glassCol = mix(color(0x0a1016), color(0x1a2632), smoothstep(0.2, 0.9, n.y));
  let windowCol = mix(mix(mix(mix(paint, color(0x111315), seal), glassCol, glass), color(0xc9ced3), chromeBelt), color(0x6a0a0e), chmsl);
  windowCol = mix(windowCol, color(0x15181b), rearWiper);
  if (spec.panelVan) {
    const sliding = abs(max(abs(p.z.add(0.36)).sub(1.31), abs(p.y.sub(1.43)).sub(1.0)));
    const seam = coverage(sliding.sub(0.004)).mul(isSide);
    const runner = roundedRect(vec2(p.z.add(0.5), p.y.sub(1.21)), vec2(1.65, 0.012), 0.005).mul(isSide);
    const rearSplit = coverage(abs(p.x).sub(0.004)).mul(step(p.z, -2.8));
    body = body.mul(one.sub(max(seam, max(runner, rearSplit)).mul(0.5)));
    windowCol = windowCol.mul(one.sub(max(seam, rearSplit).mul(0.5)));
  }

  // Mirror caps (paint, glass facing back), trims, alloys & tyres
  const mirrorCol = mix(paint, color(0x7c8a94), mirrorGlass);
  const alloyCol = mix(color(0x171c21), color(spec.aero ? 0x7c858b : 0xaeb6bb), alloyMetal);
  const treadZone = smoothstep(wheelR.mul(0.74), wheelR.mul(0.83), wheelDist);
  const tyreBase = smoothstep(wheelR.mul(0.85), wheelR.mul(0.94), wheelDist).mul(0.22).add(0.78);
  const tyreCol = color(0x16181b).mul(tyreBase.add(spokes.mul(treadZone).mul(0.24)));

  let col = mix(body, windowCol, isWindow);
  col = mix(col, mirrorCol, isMirror);
  col = mix(col, color(0x1b1e21), isTrim);
  col = mix(col, alloyCol, isAlloy);
  col = mix(col, tyreCol, isTyre);
  const sign = spec.taxiSign ? taxiSignLayout(spec) : null;
  const signOn = fixed ? float(0) : state.w; // (on the player's car the fourth component is its reverse lamps)
  const signFace = isSign.mul(step(0.5, n.z)).mul(signOn);
  const signColor = sign ? texture(taxiSignTexture(), vec2(p.x.div(sign.width).add(0.5), p.y.sub(sign.y).div(sign.height).add(0.5))).rgb : color(0x161b19);
  col = mix(col, mix(color(0x161b19), signColor, signFace), isSign);

  // ---- Roughness & metalness ---------------------------------------------------------------------------------------
  const alloySpokes = (spec.aero ? float(1.0) : max(spokes, rimRing)).mul(isAlloy);
  const glossy = max(max(max(glass, chromeBelt), mirrorGlass), lamp);
  let rough = mix(float(0.3), float(0.15), glossy);
  rough = mix(rough, float(0.4), plates);
  rough = mix(rough, float(0.82), max(matte, isAlloy.sub(alloySpokes)));

  let metal = mix(float(0.34), float(0.14), glass);
  metal = mix(metal, float(0.6), max(lamp, mirrorGlass));
  metal = mix(metal, float(0.95), chromeBelt);
  metal = mix(metal, float(0.86), alloySpokes);
  metal = mix(metal, float(0.08), plates);
  metal = mix(metal, float(0.04), matte);

  // ---- Emissive: running, brake, reverse & turn lights, CHMSL ------------------------------------------------
  const brake = state.x;
  const blink = max(state.y.mul(step(0.0, p.x)), state.z.mul(step(p.x, 0.0)));
  const nightHeadlamp = smoothstep(0.60, 1.15, cityUniforms.uInteriorGlow);
  const headlamps = color(0xfff8ec)
    .mul(headlightLens.mul(2.2).add(drl.mul(0.65)).add(lightBar.mul(0.8)))
    .mul(nightHeadlamp)
    .mul(one.sub(turnFront.mul(blink)));
  const tail = color(0xff0a12).mul(max(redLens.mul(tailShade), rearBar).mul(brake.mul(2.1).add(nightHeadlamp.mul(0.4))));
  const stop = color(0xff0a12).mul(chmsl.mul(brake).mul(2.1));
  const turn = color(0xff9a14).mul(max(turnFront, turnRear).mul(blink).mul(2.2));

  const mat = new THREE.MeshStandardNodeMaterial();
  if (fixed) mat.userData.carState = stateUniform;
  mat.colorNode = col;
  mat.roughnessNode = rough;
  mat.metalnessNode = metal;
  mat.emissiveNode = headlamps.add(tail).add(stop).add(turn).add(signColor.mul(signFace).mul(nightHeadlamp.mul(0.8).add(0.15)));
  // positionNode runs after instancing; mask unused signs without resetting the chassis to model space.
  if (spec.taxiSign) mat.maskNode = isSign.mul(one.sub(signOn)).lessThan(0.5);
  // the player's car: reverse lamps from its state's fourth component (slop-newyork 21f6dde)
  if (fixed) mat.emissiveNode = mat.emissiveNode.add(color(0xf0f6ff).mul(tailLens).mul(reverseRearSection).mul(state.w).mul(1.8));

  _carMaterialCache.set(cacheKey, mat);
  return mat;
}

// ============================================================================
// 4. LOFTED CITY BUS GEOMETRY & TSL MATERIAL
// ============================================================================
// A 40-ft low-floor city bus lofted with the car body machinery: rounded plan-view corners, a raked windshield, a
// tight roof radius and arches over the wheels; bumpers, the folded front bike rack, stalk mirrors and the roof AC &
// battery pods are separate pieces of the same mesh (partId). Windows, doors, livery & lamps are painted by
// createLoftedBusMaterial(); destination signs are textured panels (buildBusSignGeometry).
const BUS_PARTS = {
  BODY: 0,
  TRIM: 1,
  POD: 2,
  BELLOWS: 3,
  SIGN: 4
};

// Aalborg's city buses (Nordjyllands Trafikselskab) wear the Plusbus colours: a white lower body, a yellow stripe under the black
// window band, a light-blue roof line, roof and roof pods
const NT_LIVERY = { base: 0xefede6, accent: 0xf2cc12, accentBand: [1.03, 1.19], roof: 0x8fd0e6, roofY: 2.72, skirt: false };

const BUS_SPEC = {
  name: 'bus', aLine: false, livery: NT_LIVERY, route: '12', length: 11.56, width: 2.6, massRatio: 0.15,
  headlight: [0.79, 0.8], // midpoint of each pair of white lamps; excludes the outer amber indicator
  zFront: 5.78,
  zRear: -5.78,
  wheelRadius: 0.48,
  wheelZ: 3.6,
  wheelX: 1.24,
  archGap: 0.09,
  archFlare: 0,
  tuck: 0.05,
  stationStep: 0.62,
  lowerRound: 2.6,
  upperRound: 6,
  upperSamples: [0.3, 0.56, 0.74, 0.88, 1],
  halfWidth: [[5.78, 1.3], [-5.78, 1.3]],
  sill: [[5.78, 0.36], [-5.78, 0.36]],
  shoulder: [[5.78, 1.05], [-5.78, 1.05]],
  edge: [[5.78, 2.96], [-5.78, 2.96]],
  crown: [[5.78, 0.045], [-5.78, 0.045]],
  tumble: [[5.78, 0.17], [-5.78, 0.17]],
  nose: { halfWidth: [0.28, 1.02, 2], edge: [0.24, 2.68, 2], crown: [0.24, 0.005, 2], sill: [0.07, 0.44, 2], shoulder: [0.2, 0.95, 2] },
  tail: { halfWidth: [0.24, 1.06, 2], edge: [0.2, 2.72, 2], crown: [0.2, 0.005, 2], sill: [0.09, 0.46, 2], shoulder: [0.2, 0.95, 2] },
  rake: 0.15, // how far the top of the windshield leans back
  window: [1.24, 2.44], // side window band (y)
  frontDoor: [4.36, 5.36], // curb-side (-x) doors (z ranges)
  rearDoor: [-1.52, -0.5]
};

// Rigid fallback: lane occupancy and SAT currently model one chassis, including its swept corners.
const BUS_LONG_SPEC = {
  ...BUS_SPEC, name: 'bus-long', route: '16', length: 18.75, zFront: 9.375, zRear: -9.375,
  wheelZ: 7.1, axles: [7.1, 0.2, -6.9], joint: -2.0, stationStep: 0.72,
  halfWidth: [[9.375, 1.3], [-9.375, 1.3]],
  frontDoor: [7.96, 8.96], rearDoor: [-0.9, 0.15], thirdDoor: [-6.3, -5.25]
};

// The Plusbus: a Solaris Urbino 24 electric (24.7 m, three modules on two bellows; js/articulated-bus.js has the layout and the
// kinematics). One spec per module, each centred on its own origin: the front module has the MetroStyle cab, the rear one the tail
// lamps; the joint faces are flat. Doors (curb side, double leaf) and axles are module-local z. The livery follows a photo of the
// Aalborg Plusbus: a white lower body, a yellow stripe under the black window band, a light-blue roof line, roof and roof pods (battery
// pods along all three modules); silver bellows.
const URBINO_FLAT = { halfWidth: [0.05, 1.2, 2], edge: [0.05, 2.9, 2], crown: [0.05, 0.005, 2], sill: [0.03, 0.38, 2], shoulder: [0.05, 1.0, 2] };
const urbinoModule = (name, length, extra) => {
  const h = length / 2;
  return {
    ...BUS_SPEC, name, aLine: false, length, width: 2.55, zFront: h, zRear: -h, stationStep: 0.6,
    halfWidth: [[h, 1.275], [-h, 1.275]],
    edge: [[h, 3.0], [-h, 3.0]],
    nose: URBINO_FLAT, tail: URBINO_FLAT, cab: false, tailFace: false, rake: 0,
    livery: NT_LIVERY,
    route: '2H',
    ...extra
  };
};
const URBINO_24_SPECS = [
  urbinoModule('urbino24-front', 10.0, {
    cab: true, metro: true, rake: 0.24, axles: [2.3, -3.6], wheelZ: 2.3,
    nose: { halfWidth: [0.34, 1.0, 2], edge: [0.3, 2.62, 2], crown: [0.3, 0.005, 2], sill: [0.08, 0.44, 2], shoulder: [0.24, 0.95, 2] },
    doors: [[3.25, 4.45], [-2.2, -1.0]], windowSpan: [-4.75, 3.2], pods: [[-1.2, 4.2]]
  }),
  urbinoModule('urbino24-middle', 7.0, { axles: [-2.35], wheelZ: -2.35, doors: [[-0.55, 0.65]], windowSpan: [-3.25, 3.25], pods: [[0, 5.4]] }),
  urbinoModule('urbino24-rear', 6.3, {
    tailFace: true, axles: [-0.8], wheelZ: -0.8,
    tail: { halfWidth: [0.24, 1.08, 2], edge: [0.2, 2.76, 2], crown: [0.2, 0.005, 2], sill: [0.09, 0.46, 2], shoulder: [0.2, 0.95, 2] },
    doors: [[1.55, 2.75], [-2.7, -1.5]], windowSpan: [-2.25, 2.9], pods: [[0.6, 3.4]]
  })
];
// Line 2's other direction: the same front module under the other destination sign
const URBINO_24_FRONT_BACK = { ...URBINO_24_SPECS[0], name: 'urbino24-front-v', route: '2V' };

/** The bellows sleeve straight, 0.7 m long and centred on the origin: instanced for the AI Plusbuses (js/traffic.js) */
function buildBusBellowsGeometry() {
  const { mesh, update } = createBusBellows(undefined);
  update({ x: 0, z: 0.35, yaw: 0 }, { x: 0, z: -0.35, yaw: 0 }, 0);
  return mesh.geometry;
}

// The windshield rake: the upper front leans back by up to BUS_SPEC.rake, fading out along the first metre
function busRake(y, z, s = BUS_SPEC) {
  const along = Math.min(1, Math.max(0, (z - (s.zFront - 1.0)) / 1.0));
  const up = Math.min(1, Math.max(0, (y - 1.0) / 1.75));
  return s.rake * along * along * Math.pow(up, 1.3);
}

function buildLoftedBusBodyGeometry(s = BUS_SPEC) {
  const body = buildBodyLoft(s, 1);
  const pos = body.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setZ(i, pos.getZ(i) - busRake(pos.getY(i), pos.getZ(i), s));
  body.computeVertexNormals();
  const signs = buildBusSignGeometry(s);
  const parts = [part(body, BUS_PARTS.BODY), ...(signs ? [part(signs, BUS_PARTS.SIGN)] : [])];

  // Bumpers and stalk mirrors (a module of an articulated bus has them only at the cab / tail end)
  if (s.cab !== false) parts.push(part(roundedBox(1.24, 0.12, 0.24, 0.07, 0.03).translate(0, 0.5, s.zFront - 0.05), BUS_PARTS.TRIM));
  if (s.tailFace !== false) parts.push(part(roundedBox(1.24, 0.11, 0.22, 0.06, 0.03).translate(0, 0.48, s.zRear + 0.05), BUS_PARTS.TRIM));
  for (const side of s.cab !== false ? [-1, 1] : []) {
    // Mirror stalk from the roof corner, curving forward & out to a tall mirror head ahead of the windshield corner
    const stalk = new THREE.BoxGeometry(0.035, 0.035, 0.5)
      .rotateX(0.55)
      .rotateY(side * 0.35)
      .translate(side * 1.2, 2.58, s.zFront - 0.12);
    const head = roundedBox(0.075, 0.2, 0.06, 0.03, 0.012).translate(side * 1.36, 2.24, s.zFront + 0.12);
    parts.push(part(stalk, BUS_PARTS.TRIM), part(head, BUS_PARTS.TRIM));
  }

  // Roof equipment: air-conditioning pod at the rear, hybrid battery pod ahead of it
  const roofY = s.edge[0][1] + s.crown[0][1];
  if (s.pods) {
    // an electric bus: battery pods [centre z, length] under one fairing each, the AC unit on the front one
    for (const [z, len] of s.pods) parts.push(part(roundedBox(1.0, 0.13, len, 0.1, 0.05).translate(0, roofY + 0.12, z), BUS_PARTS.POD));
  } else {
    parts.push(part(roundedBox(0.98, 0.15, 2.5, 0.12, 0.05).translate(0, roofY + 0.1, s.zRear + 2.23), BUS_PARTS.POD));
    parts.push(part(roundedBox(0.82, 0.1, 3.0, 0.08, 0.04).translate(0, roofY + 0.06, s.zFront - 4.68), BUS_PARTS.POD));
  }

  if (s.joint !== undefined) {
    const sections = [];
    for (let i = 0; i <= 20; i++) {
      const z = s.joint + 0.52 - i * 0.052;
      const w = i % 2 ? 1.32 : 1.36;
      const top = i % 2 ? 3.025 : 3.07;
      sections.push(mirrorSection([[w, 0.4], [w, 2.85], [w - 0.08, top]], [0, top], z));
    }
    parts.push(part(new LoftGeometry(sections), BUS_PARTS.BELLOWS));
  }

  // Arch liners
  for (const side of [-1, 1]) {
    for (const z of s.axles || [s.wheelZ, -s.wheelZ]) {
      const well = new THREE.CircleGeometry(s.wheelRadius + s.archGap + 0.01, 10, 0, Math.PI)
        .rotateY(side * Math.PI * 0.5)
        .translate(side * (s.wheelX - 0.2), s.wheelRadius, z);
      parts.push(part(well, BUS_PARTS.TRIM));
    }
  }
  return mergeGeometries(parts);
}

/**
 * The bellows between two modules of an articulated bus as a ribbed sleeve in world space, redrawn each frame from the two faces it
 * joins: `update(a, b, y)` takes the rear face of the leading module and the front face of the trailing one ({ x, z, yaw }, forward
 * (sin yaw, cos yaw)) and the ground height; the sleeve bends along a Hermite curve between them, its ribs turning with it.
 */
function createBusBellows(material) {
  const rings = 15;
  const right = (i) => {
    const w = i % 2 ? 1.19 : 1.24;
    const top = i % 2 ? 2.93 : 2.98;
    return [[w, 0.42], [w, 1.6], [w, 2.82], [w - 0.08, top]];
  };
  const perRing = right(0).length * 2 + 1;
  const positions = new Float32Array((rings + 1) * perRing * 3);
  const indices = [];
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < perRing - 1; j++) {
      const a = i * perRing + j, b = a + 1, c = a + perRing, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setIndex(indices);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false; // its vertices move every frame, its bounds would have to as well
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const update = (a, b, y) => {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const ta = { x: -Math.sin(a.yaw) * len, z: -Math.cos(a.yaw) * len };
    const tb = { x: -Math.sin(b.yaw) * len, z: -Math.cos(b.yaw) * len };
    const dyaw = Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw));
    let k = 0;
    for (let i = 0; i <= rings; i++) {
      const t = i / rings, t2 = t * t, t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      const cx = h00 * a.x + h10 * ta.x + h01 * b.x + h11 * tb.x;
      const cz = h00 * a.z + h10 * ta.z + h01 * b.z + h11 * tb.z;
      const yaw = a.yaw + dyaw * t;
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      const half = right(i);
      const pts = [...half.map(([x, py]) => [-x, py]), [0, half[half.length - 1][1] + 0.02], ...[...half].reverse()];
      for (const [x, py] of pts) {
        positions[k++] = cx + rx * x;
        positions[k++] = y + py;
        positions[k++] = cz + rz * x;
      }
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.computeVertexNormals();
  };
  return { mesh, update };
}

/**
 * Destination sign panels for the bus's sign texture (route badge + destination): above the windshield, on the curb
 * side by the front door, and the route badge alone above the rear window. Same object space as the bus body.
 */
function buildBusSignGeometry(s = BUS_SPEC) {
  const panels = [];
  const yF = s.metro ? 2.68 : 2.55;
  if (s.cab !== false) {
    const front = new THREE.PlaneGeometry(1.9, 0.27);
    front.rotateX(-Math.atan2(s.rake * 1.3 * 0.62, 1.75));
    front.translate(0, yF, s.zFront - busRake(yF, s.zFront, s) + 0.012);
    panels.push(front);
    const side = new THREE.PlaneGeometry(1.15, 0.2).rotateY(-Math.PI / 2);
    const sideZ = s.zFront - 1.88;
    side.translate(-(carBodyHalfWidthAt(s, sideZ, 2.58) + 0.006), 2.58, sideZ);
    panels.push(side);
  }
  if (s.tailFace !== false) {
    const rear = new THREE.PlaneGeometry(0.52, 0.2);
    const uv = rear.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * 0.29);
    rear.rotateY(Math.PI).translate(0, 2.55, s.zRear - 0.012);
    panels.push(rear);
  }
  return panels.length ? mergeGeometries(panels) : null;
}

// Bus wheel: tall tyre with a deep steel disc, 10 lug nuts and a hub cap on both outer and inner faces (spins about x, centred on the origin)
function buildBusWheelGeo(side) {
  const r = BUS_SPEC.wheelRadius;
  const w = 0.3;
  const tyre = new THREE.LatheGeometry(
    [
      new THREE.Vector2(r * 0.72, -w * 0.5),
      new THREE.Vector2(r * 0.97, -w * 0.38),
      new THREE.Vector2(r, 0),
      new THREE.Vector2(r * 0.97, w * 0.38),
      new THREE.Vector2(r * 0.72, w * 0.5)
    ],
    20
  );
  const disc = new THREE.LatheGeometry(
    [new THREE.Vector2(r * 0.72, w * 0.5), new THREE.Vector2(r * 0.66, w * 0.4), new THREE.Vector2(r * 0.56, w * 0.18), new THREE.Vector2(0.15, w * 0.16)],
    20
  );
  const backDisc = new THREE.LatheGeometry(
    [
      new THREE.Vector2(0, -w * 0.16),
      new THREE.Vector2(0.15, -w * 0.16),
      new THREE.Vector2(r * 0.56, -w * 0.18),
      new THREE.Vector2(r * 0.66, -w * 0.4),
      new THREE.Vector2(r * 0.72, -w * 0.5)
    ],
    20
  );
  const cap = new THREE.CylinderGeometry(0.1, 0.13, 0.12, 14).translate(0, w * 0.2, 0);
  const backCap = new THREE.CylinderGeometry(0.13, 0.1, 0.12, 14).translate(0, -w * 0.2, 0);
  const parts = [
    part(tyre, CAR_PARTS.TYRE),
    part(disc, CAR_PARTS.ALLOY),
    part(backDisc, CAR_PARTS.ALLOY),
    part(cap, CAR_PARTS.ALLOY),
    part(backCap, CAR_PARTS.ALLOY)
  ];
  for (const g of parts) g.rotateZ(-side * Math.PI * 0.5);
  return mergeGeometries(parts);
}

let _busWheelMat = null;

function createBusWheelMaterial() {
  if (_busWheelMat) return _busWheelMat;
  const p = attribute('position', 'vec3');
  const partId = attribute('partId', 'float');
  const isTyre = step(abs(partId.sub(CAR_PARTS.TYRE)), 0.25);
  const radial = length(vec2(p.z, p.y));
  const angle = vec2(p.z, p.y).div(max(radial, 0.0001));
  let lugs = float(0.0);
  for (let k = 0; k < 10; k++) {
    const a = (k * Math.PI * 2) / 10;
    lugs = max(lugs, smoothstep(0.024, 0.014, length(vec2(p.z, p.y).sub(vec2(Math.cos(a) * 0.205, Math.sin(a) * 0.205)))));
  }
  const groove = smoothstep(0.006, 0.0, abs(radial.sub(0.29)));
  const steel = color(0xb9c0c6).mul(float(1.0).sub(groove.mul(0.5)));
  const hub = mix(steel, color(0x6b7176), smoothstep(0.13, 0.1, radial));
  const disc = mix(hub, color(0x2a2e33), lugs.mul(0.8));
  const sidewall = smoothstep(0.37, 0.43, radial).mul(0.25).add(0.75);
  const tread = step(0.5, fract(angle.y.mul(9.0).add(angle.x.mul(9.0)))).mul(0.08);
  const mat = new THREE.MeshStandardNodeMaterial();
  mat.colorNode = mix(disc, color(0x17191c).mul(sidewall.add(tread)), isTyre);
  mat.roughnessNode = mix(float(0.35), float(0.88), isTyre);
  mat.metalnessNode = mix(float(0.75), float(0.0), isTyre);
  _busWheelMat = mat;
  return mat;
}

const _busDestinationTextures = new Map();
const BUS_DESTINATIONS = {
  12: ['12', 'GISTRUP'],
  16: ['16', 'CITY SYD'],
  '2H': ['2', 'HOSPITALSBYEN'],
  '2V': ['2', 'VÆDDELØBSBANEN']
};

function createBusDestinationTexture(route) {
  if (_busDestinationTextures.has(route)) return _busDestinationTextures.get(route);
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0c0f14';
  ctx.fillRect(0, 0, 256, 64);
  // [line, destination]: NT city lines through the district (OSM route relations); 2 is the Plusbus, one key per direction
  const [line, destination] = BUS_DESTINATIONS[route] || [route, ''];
  ctx.fillStyle = '#ffad35';
  ctx.font = 'bold 30px "Arial Narrow", Arial, sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(line, 8, 33);
  ctx.font = 'bold 23px "Arial Narrow", Arial, sans-serif';
  ctx.fillText(destination, 70, 33, 180);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  _busDestinationTextures.set(route, tex);
  return tex;
}

const _busLoftedMats = new Map();

/**
 * Creates the TSL procedural material for city buses:
 * - Wraparound split windshield with gasket & centre post, destination sign band above it; rear window & engine
 *   louvres on the rear face
 * - Continuous side window band with mullions, the driver's window, glazed curb-side front & rear doors
 * - Movia yellow, black glazing to the roof edge, A-line corner panels and a dark skirt
 * - Headlamps, turn signals (per-instance `busState`: brake, left (+x), right (-x)), tail / brake light columns,
 *   plates; black trims & light-grey roof pods
 */
function createLoftedBusMaterial(s = BUS_SPEC, { player = false } = {}) {
  // the player's bus reads its state from a uniform (mat.userData.busState) instead of the instanced attribute; w = doors open (0..1)
  const key = player ? `${s.name}:player` : s.name;
  if (_busLoftedMats.has(key)) return _busLoftedMats.get(key);
  const p = attribute('position', 'vec3');
  const n = attribute('normal', 'vec3');
  const partId = attribute('partId', 'float');
  const stateUniform = player ? uniform(new THREE.Vector4(0, 0, 0, 0)) : null;
  const state = player ? stateUniform : attribute('busState', 'vec4');
  const isBody = step(abs(partId.sub(BUS_PARTS.BODY)), 0.25);
  const isTrim = step(abs(partId.sub(BUS_PARTS.TRIM)), 0.25);
  const isPod = step(abs(partId.sub(BUS_PARTS.POD)), 0.25);
  const isBellows = step(abs(partId.sub(BUS_PARTS.BELLOWS)), 0.25);
  const isSign = step(abs(partId.sub(BUS_PARTS.SIGN)), 0.25);
  const signColor = texture(createBusDestinationTexture(s.route || (s.aLine ? '6A' : '5C')), attribute('uv', 'vec2')).rgb;
  const ax = abs(p.x);
  const one = float(1.0);

  // a module of an articulated bus: only the cab end is a front, only the tail end a rear; joint faces are black rubber frames
  const frontFace = smoothstep(0.1, 0.35, n.z).mul(step(s.zFront - 0.9, p.z)).mul(isBody);
  const rearFace = smoothstep(0.1, 0.35, n.z.negate()).mul(step(p.z, s.zRear + 0.9)).mul(isBody);
  const front = s.cab === false ? float(0) : frontFace;
  const rear = s.tailFace === false ? float(0) : rearFace;
  const jointFace = max(s.cab === false ? frontFace : float(0), s.tailFace === false ? rearFace : float(0));
  const side = smoothstep(0.5, 0.75, abs(n.x)).mul(isBody);
  const curb = step(p.x, 0.0);

  // Windshield (wrapping round the corners; the MetroStyle one runs from the lamps to the sign), sign band, gasket; rear window & louvres
  const [gy, gw, gh] = s.metro ? [1.97, 1.22, 0.72] : [1.82, 1.2, 0.58];
  const frontGlass = roundedRect(vec2(p.x, p.y.sub(gy)), vec2(gw, gh), 0.14).mul(smoothstep(0.012, 0.024, ax)).mul(front);
  const frontSeal = roundedRect(vec2(p.x, p.y.sub(gy)), vec2(gw + 0.04, gh + 0.04), 0.16).mul(front);
  const signBand = roundedRect(vec2(p.x, p.y.sub(s.metro ? 2.68 : 2.55)), vec2(1.02, 0.16), 0.04).mul(front);
  const rearGlass = roundedRect(vec2(p.x, p.y.sub(2.06)), vec2(0.92, 0.36), 0.08).mul(rear);
  const rearSeal = roundedRect(vec2(p.x, p.y.sub(2.06)), vec2(0.96, 0.4), 0.1).mul(rear);
  const louvres = roundedRect(vec2(p.x, p.y.sub(0.98)), vec2(0.78, 0.34), 0.05).mul(rear);
  const slats = step(0.5, fract(p.y.mul(16.0))).mul(0.45).add(0.4);

  // Side window band with mullions; driver's window; curb-side doors (glazed leaves, frames)
  const [wy0, wy1] = s.window;
  const winMid = (wy0 + wy1) / 2;
  const winHalf = (wy1 - wy0) / 2;
  const [wz0, wz1] = s.windowSpan || [s.zRear + 0.46, s.zFront - 1.46];
  const winZ = (wz0 + wz1) / 2;
  const winLen = (wz1 - wz0) / 2;
  const sideBand = roundedRect(vec2(p.z.sub(winZ), p.y.sub(winMid)), vec2(winLen, winHalf), 0.08).mul(side);
  const mullion = smoothstep(0.03, 0.045, abs(fract(p.z.mul(0.8).add(0.35)).sub(0.5).mul(1.25)));
  const sideSeal = roundedRect(vec2(p.z.sub(winZ), p.y.sub(winMid)), vec2(winLen + 0.04, winHalf + 0.04), 0.1).mul(side);
  const driverWin = s.cab === false ? float(0)
    : roundedRect(vec2(p.z.sub(s.zFront - 0.92), p.y.sub(winMid + 0.04)), vec2(0.5, winHalf + 0.04), 0.1).mul(side).mul(one.sub(curb));
  // a door's leaves swing out and aside as state.w goes to 1: the opening shows the lit interior
  const doorOpen = state.w;
  const door = (z0, z1) => {
    const zc = (z0 + z1) / 2;
    const hw = (z1 - z0) / 2;
    const frame = roundedRect(vec2(p.z.sub(zc), p.y.sub(1.44)), vec2(hw, 1.0), 0.05);
    const leaves = roundedRect(vec2(abs(p.z.sub(zc)).sub(hw * 0.5), p.y.sub(1.5)), vec2(hw * 0.4, 0.84), 0.035);
    const opening = roundedRect(vec2(p.z.sub(zc), p.y.sub(1.4)), vec2(doorOpen.mul(hw * 0.92).add(0.001), 0.96), 0.03);
    return { frame: frame.mul(side).mul(curb), glass: leaves.mul(side).mul(curb), open: opening.mul(side).mul(curb) };
  };
  const doorList = s.doors || [s.frontDoor, s.rearDoor, ...(s.thirdDoor ? [s.thirdDoor] : [])];
  const doors = doorList.map(([z0, z1]) => door(z0, z1));
  const anyOf = (key) => doors.reduce((a, d) => max(a, d[key]), float(0));
  const doorFrame = anyOf('frame');
  const doorway = player ? anyOf('open').mul(step(0.01, doorOpen)) : float(0);
  const glass = clamp(max(max(frontGlass, rearGlass), max(max(sideBand.mul(mullion), driverWin), anyOf('glass'))), 0.0, 1.0);
  const seal = clamp(max(max(frontSeal, rearSeal), max(max(sideSeal, signBand), max(doorFrame, jointFace))), 0.0, 1.0);

  const shadeY = smoothstep(0.34, 1.2, p.y).mul(0.12).add(0.88);
  const glazingBand = smoothstep(1.19, 1.22, p.y).mul(one.sub(smoothstep(0.65, 0.95, n.y)));
  const corner = s.aLine ? max(
    step(p.x, -0.72).mul(step(s.zFront - 0.95, p.z)),
    step(0.72, p.x).mul(step(p.z, s.zRear + 0.95))
  ) : float(0.0);
  const skirt = smoothstep(0.43, 0.4, p.y);
  const L = s.livery;
  const paint = L
    ? mix(color(L.base), color(L.accent), step(L.accentBand[0], p.y).mul(step(p.y, L.accentBand[1])).mul(side))
    : mix(color(0xf7c600), color(0xc91d2b), corner);
  // a coloured roof: everything above roofY, and the roof's top surfaces
  const roofPaint = L?.roof ? max(smoothstep(L.roofY - 0.012, L.roofY + 0.012, p.y), smoothstep(0.65, 0.95, n.y).mul(step(2.0, p.y))) : float(0);
  const lower = L?.skirt === false ? float(0) : skirt;
  const livery = mix(mix(mix(paint, color(0x14191d), glazingBand), color(L?.roof ?? 0), roofPaint), color(0x1c2026), lower).mul(shadeY);

  // Lamps: twin round headlamps & amber turn signals in black pods; red tail / brake light columns, amber turn &
  // white reverse lamps at the rear corners; plates
  const pod = roundedRect(vec2(ax.sub(0.86), p.y.sub(0.8)), vec2(0.27, 0.085), 0.06).mul(front);
  const headLamp = max(
    smoothstep(0.05, 0.04, length(vec2(ax.sub(0.72), p.y.sub(0.8)))),
    smoothstep(0.05, 0.04, length(vec2(ax.sub(0.86), p.y.sub(0.8))))
  ).mul(pod);
  const turnFront = smoothstep(0.045, 0.035, length(vec2(ax.sub(1.02), p.y.sub(0.8)))).mul(pod);
  const tailCol = roundedRect(vec2(ax.sub(1.04), p.y.sub(0.92)), vec2(0.075, 0.27), 0.05).mul(rear);
  const tailLamp = tailCol.mul(smoothstep(0.93, 0.95, p.y));
  const turnRear = tailCol.mul(smoothstep(0.92, 0.9, p.y)).mul(smoothstep(0.76, 0.78, p.y));
  const reverse = tailCol.mul(smoothstep(0.75, 0.73, p.y));
  const plate = roundedRect(vec2(p.x, p.y.sub(0.77)), vec2(CAR_PLATE.width / 2, CAR_PLATE.height / 2), 0.008).mul(max(front.mul(step(ax, 0.3)), rear));

  let body = mix(livery, color(0x15191e), seal);
  body = mix(body, color(0x1a1e23).mul(slats), louvres);
  body = mix(body, color(0x111418), pod);
  body = mix(body, mix(color(0xdcefff), color(0xffa21a), turnFront), max(headLamp, turnFront));
  body = mix(body, color(0x9a0d14), tailLamp);
  body = mix(body, color(0xc8641a), turnRear);
  body = mix(body, color(0xe8eef2), reverse);
  const plateUV = vec2(mix(p.x.negate(), p.x, front).div(CAR_PLATE.width).add(0.5), p.y.sub(0.77).div(CAR_PLATE.height).add(0.5));
  body = mix(body, texture(carPlateTexture(true), vec2(clamp(plateUV.x, 0.001, 0.999), clamp(plateUV.y, 0.005, 0.995).div(CAR_PLATE.variants))).rgb, plate);
  const glassTint = mix(color(0x0e1a26), color(0x1b3046), clamp(p.y.sub(1.3).mul(0.8), 0.0, 1.0));
  body = mix(body, glassTint, glass);
  // the doorway: the floor and the shadowed saloon inside, a yellow grab pole in each leaf's opening
  const pole = smoothstep(0.03, 0.015, abs(fract(p.z.mul(1.25)).sub(0.5))).mul(step(0.45, p.y));
  const interior = mix(mix(color(0x3d3934), color(0x15161a), smoothstep(0.42, 1.1, p.y)), color(0xc9a227), pole);
  body = mix(body, interior, doorway);

  const col = mix(mix(mix(body, color(0x1b1f24), isTrim), color(L?.roof ?? 0xc9ced3), isPod), color(0x424549), isBellows);

  const mat = new THREE.MeshStandardNodeMaterial();
  mat.colorNode = mix(col, color(0x000000), isSign);
  mat.roughnessNode = mix(mix(mix(float(0.3), float(0.16), max(glass, max(headLamp, tailCol))), float(0.7), max(isTrim, seal.mul(one.sub(glass)))), float(0.72), max(isPod, isBellows));
  mat.metalnessNode = mix(mix(float(0.22), float(0.7), glass), float(0.05), max(max(isTrim, isPod), max(isBellows, isSign)));

  const brake = state.x;
  const blink = max(state.y.mul(step(0.0, p.x)), state.z.mul(step(p.x, 0.0)));
  const nightHeadlamp = smoothstep(0.60, 1.15, cityUniforms.uInteriorGlow);
  mat.emissiveNode = color(0xd9efff)
    .mul(pod.mul(0.45).add(headLamp.mul(1.35)))
    .mul(nightHeadlamp)
    .add(color(0xff9a14).mul(max(turnFront, turnRear).mul(blink).mul(2.0)))
    .add(color(0xff0a12).mul(tailLamp.mul(brake.mul(1.5).add(0.75))))
    .add(signColor.mul(isSign))
    .add(color(0xffe2b0).mul(doorway.mul(smoothstep(2.4, 1.6, p.y)).mul(nightHeadlamp.mul(0.25).add(0.03))));

  if (player) mat.userData.busState = stateUniform;
  _busLoftedMats.set(key, mat);
  return mat;
}

// ============================================================================
// 5. QUADCOPTER DRONE (the fly mode)
// ============================================================================
// An X-frame quadcopter about 0.6 m across the prop tips: a rounded centre body, four arms at 45° to the nose, motors with two-blade
// props (each in its own pivot, spun by the controller, with a faint disc that shows when they spin), two landing legs with foot bars,
// a gimbal camera under the nose and LED arm lights (white at the front, red at the rear). The origin is at the feet: y = 0 is where
// the drone stands. Forward is +z, like every other actor.
const DRONE = {
  armReach: 0.215, // centre to motor axis (m), along the diagonals
  propRadius: 0.105,
  bodyY: 0.115, // centre of the body above the feet
  legHeight: 0.085
};

function createDroneModel() {
  const root = new THREE.Group();
  root.name = 'PlayerDrone';
  const tiltPivot = new THREE.Group();
  root.add(tiltPivot);

  const shell = new THREE.MeshStandardNodeMaterial({ color: 0x3a3f46, roughness: 0.48, metalness: 0.08 });
  const cover = new THREE.MeshStandardNodeMaterial({ color: 0xd9dcdf, roughness: 0.38, metalness: 0.05 });
  const carbon = new THREE.MeshStandardNodeMaterial({ color: 0x1b1e22, roughness: 0.55, metalness: 0.2 });
  const metal = new THREE.MeshStandardNodeMaterial({ color: 0x9aa0a6, roughness: 0.3, metalness: 0.75 });
  const propMat = new THREE.MeshStandardNodeMaterial({ color: 0x15171a, roughness: 0.6, metalness: 0.0, side: THREE.DoubleSide });
  const discMat = new THREE.MeshBasicNodeMaterial({ color: 0xbfc8d2, transparent: true, opacity: 0.0, side: THREE.DoubleSide, depthWrite: false });
  const glass = new THREE.MeshStandardNodeMaterial({ color: 0x0a0d12, roughness: 0.08, metalness: 0.4 });
  const ledFront = new THREE.MeshBasicNodeMaterial({ color: 0xf4f7ff });
  const ledRear = new THREE.MeshBasicNodeMaterial({ color: 0xff2a1f });
  const add = (geometry, material, x, y, z, parent = tiltPivot) => {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  const y0 = DRONE.bodyY;

  // centre body: a rounded hull (scaled sphere) under a light top cover, battery bay behind
  const hull = add(new THREE.SphereGeometry(1, 24, 14), shell, 0, y0, 0.005);
  hull.scale.set(0.072, 0.034, 0.118);
  const top = add(new THREE.SphereGeometry(1, 24, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), cover, 0, y0 + 0.012, 0.012);
  top.scale.set(0.064, 0.03, 0.1);
  add(new THREE.BoxGeometry(0.08, 0.03, 0.1), carbon, 0, y0 + 0.028, -0.06);

  // arms and motors along the diagonals; props in pivots over the motors
  const props = [];
  const leds = [];
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const ang = Math.atan2(sx, sz);
    const len = DRONE.armReach;
    const arm = add(new THREE.BoxGeometry(0.022, 0.016, len), carbon, sx * len * 0.5 * Math.SQRT1_2, y0 + 0.004, sz * len * 0.5 * Math.SQRT1_2);
    arm.rotation.y = ang;
    const mx = sx * len * Math.SQRT1_2, mz = sz * len * Math.SQRT1_2;
    add(new THREE.CylinderGeometry(0.019, 0.022, 0.03, 20), carbon, mx, y0 + 0.02, mz);
    add(new THREE.CylinderGeometry(0.02, 0.02, 0.006, 20), metal, mx, y0 + 0.037, mz);
    const pivot = new THREE.Group();
    pivot.position.set(mx, y0 + 0.044, mz);
    tiltPivot.add(pivot);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(DRONE.propRadius * 2, 0.003, 0.017), propMat);
    blade.rotation.x = 0.12 * sx * sz; // blade pitch, opposite on the two diagonals (counter-rotating pairs)
    blade.castShadow = true;
    pivot.add(blade);
    pivot.add(new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.012, 12), metal));
    const disc = new THREE.Mesh(new THREE.CircleGeometry(DRONE.propRadius, 32), discMat);
    disc.rotation.x = -Math.PI / 2;
    pivot.add(disc);
    props.push({ pivot, dir: sx * sz > 0 ? 1 : -1 });
    // LED under the motor: white at the front, red at the rear
    leds.push(add(new THREE.SphereGeometry(0.008, 10, 8), sz > 0 ? ledFront : ledRear, mx, y0 + 0.002, mz));
  }

  // landing legs: two posts each side down to a foot bar
  for (const sx of [1, -1]) {
    for (const sz of [1, -1]) {
      const leg = add(new THREE.CylinderGeometry(0.005, 0.005, DRONE.legHeight + 0.02, 8), carbon, sx * 0.05, DRONE.legHeight * 0.5 + 0.004, sz * 0.055);
      leg.rotation.z = sx * 0.18;
    }
    const foot = add(new THREE.CylinderGeometry(0.006, 0.006, 0.16, 8), carbon, sx * 0.066, 0.006, 0);
    foot.rotation.x = Math.PI / 2;
  }

  // gimbal camera under the nose
  const gimbal = new THREE.Group();
  gimbal.position.set(0, y0 - 0.04, 0.085);
  tiltPivot.add(gimbal);
  add(new THREE.CylinderGeometry(0.006, 0.006, 0.02, 8), metal, 0, 0.016, 0, gimbal);
  const head = add(new THREE.SphereGeometry(0.022, 18, 12), shell, 0, 0, 0, gimbal);
  head.scale.set(1, 0.9, 1.05);
  const lens = add(new THREE.CylinderGeometry(0.011, 0.012, 0.012, 16), glass, 0, 0, 0.02, gimbal);
  lens.rotation.x = Math.PI / 2;

  return { root, tiltPivot, props, discMat, gimbal, leds };
}

export {
  CAR_PARTS,
  BODY_SPECS,
  carLayout,
  carBodyHalfWidthAt,
  buildCarSidePatch,
  buildSteerableWheelGeo,
  buildCarGeometry,
  buildCarProxyGeometry,
  createLoftedCarMaterial,
  carPlateTexture,
  BUS_SPEC,
  BUS_LONG_SPEC,
  URBINO_24_SPECS,
  URBINO_24_FRONT_BACK,
  createBusBellows,
  buildBusBellowsGeometry,
  buildLoftedBusBodyGeometry,
  buildBusSignGeometry,
  buildBusWheelGeo,
  createBusWheelMaterial,
  createLoftedBusMaterial,
  createDroneModel,
  DRONE
};
