import * as THREE from 'three/webgpu';
import { Fn, attribute, uniform, uv, vec2, vec3, float, sin, cos, fract, floor, exp, abs, length, smoothstep, step, mix, max } from 'three/tsl';

// js/nightlife-scene.js
// The lights of the bars, pubs and nightclubs (pure side: js/nightlife.js; data: data/city/nightlife.json). Two instanced draws
// for every venue in the city, both animated on the GPU from one clock uniform (no per-frame CPU work per venue):
//   * signs   a neon panel above each door: a tube outline and blinking "lettering" in the venue's colour, pulsing on its beat;
//   * spill   an L of two additive quads per venue: a wash of colour up the facade from the door, and on the pavement in front a
//             pool of light with moving disco spots in the venue's two colours, swept round and flashed on the beat.
// Plus a few REAL point lights, borrowed from the street lamps' fixed pool (js/street-furniture.js reserveLights: the light count
// never changes, so no shader recompiles), placed in front of the venues nearest the camera and cycling their colours, so people,
// cars and facades in the street pick up the club light.
// `level` (js/nightlife.js nightlifeLevel: 0 Midday, 0.45 Blue Hour, 1 Night) eases in and out over a couple of seconds.

const SPILL_W = 7; // m along the wall
const SPILL_D = 6; // m out onto the street
const WASH_H = 5; // m up the facade
const SIGN_Y = 3.1; // m above the pavement
const SIGN_SIZE = { nightclub: [3.2, 0.8], bar: [2.2, 0.6], pub: [1.9, 0.62], biergarten: [1.9, 0.62] };
const REAL_LIGHTS = 3;
const REAL_REACH = 70; // m: real lights only for venues this close to the camera
const EASE = 1.6; // s to ease the level

/** The L of the spill: a ground quad (part 0) and a facade quad (part 1), local frame x along the wall, +z out of it, y up. */
function spillGeometry() {
  const g = new THREE.BufferGeometry();
  const w = SPILL_W / 2;
  const pos = [
    // ground, 4 cm above the pavement, from the wall out
    -w, 0.04, 0.05, w, 0.04, 0.05, w, 0.04, SPILL_D, -w, 0.04, SPILL_D,
    // facade, 6 cm off the wall
    -w, 0, 0.06, w, 0, 0.06, w, WASH_H, 0.06, -w, WASH_H, 0.06
  ];
  const uvs = [0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1];
  const part = [0, 0, 0, 0, 1, 1, 1, 1];
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('nlPart', new THREE.Float32BufferAttribute(part, 1));
  g.setIndex([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7]);
  return g;
}

/** Shader of the beat: 1 on the beat, decaying (js/nightlife.js beatPulse). */
const pulseOf = (t, bpm, phase, decay) => exp(fract(t.mul(bpm).div(60).add(phase)).mul(60).div(bpm).div(decay).negate());

/**
 * @param scene     the three.js scene
 * @param state     js/nightlife.js nightlife state (venues with looks, level)
 * @param options   { groundHeight: { heightAt(x, z) } | null, furniture: (the street furniture, for reserveLights) | null }
 */
export function createNightlifeScene(scene, state, { groundHeight = null, furniture = null } = {}) {
  const group = new THREE.Group();
  group.name = 'nightlife';
  scene.add(group);
  const uTime = uniform(0);
  const uLevel = uniform(0);
  let signs = null, spill = null, venues = [];
  let shown = 0;
  let borrowed = [];
  const near = [], scratch = [];
  let nearX = Infinity, nearZ = Infinity;
  let heightsAt = -Infinity;
  const stats = { venues: 0, clusters: 0, drawCalls: 0, lights: 0 };

  // ---------------------------------------------------------------- materials
  const signMat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, fog: false, toneMapped: true });
  signMat.colorNode = Fn(() => {
    const a = attribute('nlA', 'vec4'); // sign rgb, bpm
    const b = attribute('nlB', 'vec4'); // spot rgb, phase
    const p = uv();
    // tube outline: a thin glowing border, inset from the panel's edge
    const ex = abs(p.x.sub(0.5)).mul(2), ey = abs(p.y.sub(0.5)).mul(2);
    const border = exp(abs(max(ex, ey).sub(0.86)).mul(-40));
    // "lettering": tube strokes in blocks along the middle band, some blinking by hash
    const cell = floor(p.x.mul(9));
    const h = fract(sin(cell.mul(12.9898).add(b.w.mul(78.233))).mul(43758.5453));
    const stroke = exp(abs(p.y.sub(0.5)).mul(-14)).mul(step(0.18, fract(p.x.mul(9)))).mul(step(fract(p.x.mul(9)), 0.82)).mul(step(0.18, h));
    const blink = step(0.5, fract(uTime.mul(0.5).add(h))).mul(0.5).add(0.5);
    const beat = pulseOf(uTime, a.w, b.w, float(0.18));
    const glow = border.mul(1.2).add(stroke.mul(blink).mul(1.4));
    const col = mix(a.xyz, b.xyz, step(0.85, h).mul(0.7));
    // a dark backing panel; the tubes on it bright (bloom does the halo)
    return vec3(0.02, 0.02, 0.025).add(col.mul(glow).mul(beat.mul(0.35).add(0.75)).mul(5.5)).mul(uLevel.mul(0.92).add(0.08));
  })();

  const spillMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
  spillMat.colorNode = Fn(() => {
    const a = attribute('nlA', 'vec4');
    const b = attribute('nlB', 'vec4');
    const part = attribute('nlPart', 'float');
    const p = uv();
    const beat = pulseOf(uTime, a.w, b.w, float(0.13));
    // metres from the door (u = 0.5 on the wall line)
    const gx = p.x.sub(0.5).mul(SPILL_W), gz = p.y.mul(SPILL_D);
    const r = length(vec2(gx, gz));
    const pool = exp(r.mul(-0.55)).mul(smoothstep(SPILL_D, SPILL_D * 0.55, gz)).mul(smoothstep(SPILL_W / 2, SPILL_W / 2 - 1.2, abs(gx)));
    // disco spots: a grid of dots, rotating round the door, flashing on the beat in the two colours
    const ang = uTime.mul(0.45).add(b.w.mul(6.283));
    const c = cos(ang), s = sin(ang);
    const rx = gx.mul(c).sub(gz.mul(s)), rz = gx.mul(s).add(gz.mul(c));
    const q = vec2(rx, rz).mul(0.85);
    const dot = smoothstep(0.24, 0.08, length(fract(q).sub(0.5)));
    const pick = fract(sin(floor(q.x).mul(17.1).add(floor(q.y).mul(31.7))).mul(4375.85));
    const spotCol = mix(a.xyz, b.xyz, step(0.5, pick));
    const spots = spotCol.mul(dot).mul(beat.mul(0.8).add(0.2)).mul(exp(r.mul(-0.32))).mul(1.4);
    const ground = a.xyz.mul(pool).mul(beat.mul(0.35).add(0.45)).add(spots);
    // the facade wash: up from the door, narrowing with height
    const wx = abs(p.x.sub(0.5)).mul(SPILL_W);
    const wash = mix(a.xyz, b.xyz, sin(uTime.mul(0.7).add(b.w.mul(9))).mul(0.5).add(0.5)).mul(exp(wx.mul(-0.6)).mul(exp(p.y.mul(WASH_H).mul(-0.55))))
      .mul(beat.mul(0.5).add(0.5)).mul(0.9);
    return mix(ground, wash, part).mul(uLevel).mul(0.55);
  })();

  // ---------------------------------------------------------------- building the venues' instances
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _y = new THREE.Vector3(0, 1, 0);

  function groundAt(x, z) {
    const h = groundHeight?.heightAt?.(x, z);
    return Number.isFinite(h) ? h : 0;
  }

  function placeAll() {
    if (!venues.length) return;
    for (let i = 0; i < venues.length; i++) {
      const v = venues[i];
      const y = groundAt(v.x + v.nx * 1.5, v.z + v.nz * 1.5);
      v.y = y;
      const yaw = Math.atan2(v.nx, v.nz); // local +z -> the wall's outward normal
      _q.setFromAxisAngle(_y, yaw);
      _p.set(v.x, y, v.z);
      _m.compose(_p, _q, _s.set(1, 1, 1));
      spill.setMatrixAt(i, _m);
      const [w, h] = SIGN_SIZE[v.kind] || SIGN_SIZE.bar;
      _p.set(v.x + v.nx * 0.18, y + SIGN_Y, v.z + v.nz * 0.18);
      _m.compose(_p, _q, _s.set(w, h, 1));
      signs.setMatrixAt(i, _m);
    }
    spill.instanceMatrix.needsUpdate = true;
    signs.instanceMatrix.needsUpdate = true;
  }

  function setVenues() {
    for (const m of [signs, spill]) if (m) { group.remove(m); m.geometry.dispose(); }
    venues = state.venues;
    stats.venues = venues.length;
    stats.clusters = state.clusters.length;
    if (!venues.length) { signs = spill = null; return; }
    const n = venues.length;
    const A = new Float32Array(n * 4), B = new Float32Array(n * 4);
    venues.forEach((v, i) => {
      A.set([...v.look.sign, v.look.bpm], i * 4);
      B.set([...v.look.spot, v.look.phase], i * 4);
    });
    const sg = new THREE.PlaneGeometry(1, 1);
    sg.setAttribute('nlA', new THREE.InstancedBufferAttribute(A, 4));
    sg.setAttribute('nlB', new THREE.InstancedBufferAttribute(B, 4));
    signs = new THREE.InstancedMesh(sg, signMat, n);
    signs.name = 'nightlife-signs';
    const lg = spillGeometry();
    lg.setAttribute('nlA', new THREE.InstancedBufferAttribute(A, 4));
    lg.setAttribute('nlB', new THREE.InstancedBufferAttribute(B, 4));
    spill = new THREE.InstancedMesh(lg, spillMat, n);
    spill.name = 'nightlife-spill';
    spill.renderOrder = 5;
    for (const m of [signs, spill]) {
      m.frustumCulled = false; // the venues spread over the city; the two draws are cheap, culling them per venue is not worth it
      m.castShadow = m.receiveShadow = false;
      m.userData.noCull = true;
      group.add(m);
    }
    heightsAt = -Infinity;
    placeAll();
  }

  // ---------------------------------------------------------------- real lights
  function assignReal(cx, cz) {
    // the venues nearest the camera (loudness-weighted), each with a light 2 m out from its door
    near.length = 0;
    scratch.length = 0;
    for (let i = 0; i < venues.length; i++) if (Math.hypot(venues[i].x - cx, venues[i].z - cz) < REAL_REACH) scratch.push(i);
    scratch.sort((i, j) => Math.hypot(venues[i].x - cx, venues[i].z - cz) / venues[i].look.loud - Math.hypot(venues[j].x - cx, venues[j].z - cz) / venues[j].look.loud);
    for (let k = 0; k < scratch.length && k < borrowed.length; k++) near.push(scratch[k]);
  }

  function updateReal(level) {
    let on = 0;
    for (let k = 0; k < borrowed.length; k++) {
      const light = borrowed[k];
      const i = near[k];
      if (i === undefined || level <= 0.01) { light.intensity = 0; continue; }
      const v = venues[i];
      const L = v.look;
      const t = uTime.value;
      const beats = t * L.bpm / 60 + L.phase;
      const frac = beats - Math.floor(beats);
      const beat = Math.exp(-(frac * 60 / L.bpm) / 0.12);
      const swap = Math.floor(beats / 2) % 2; // the colour changes every two beats
      const c = swap ? L.spot : L.sign;
      light.color.setRGB(c[0], c[1], c[2]);
      light.position.set(v.x + v.nx * 2, (v.y || 0) + 2.3, v.z + v.nz * 2);
      light.distance = 14;
      light.intensity = (14 + 26 * beat) * L.loud * level;
      on++;
    }
    stats.lights = on;
  }

  // ---------------------------------------------------------------- per frame
  /**
   * @param dt      s since the last frame
   * @param cx, cz  camera / focus position
   * @param clock   s; the audio clock when the sound runs, so the lights flash on the beats heard (js/nightlife-audio.js)
   */
  function update(dt, cx, cz, clock) {
    if (state.venues !== venues) setVenues();
    const target = state.level;
    shown += Math.sign(target - shown) * Math.min(Math.abs(target - shown), dt / EASE);
    uTime.value = clock;
    uLevel.value = shown;
    const visible = shown > 0.004 && venues.length > 0;
    group.visible = visible;
    stats.drawCalls = visible ? 2 : 0;
    // the terrain under the venues streams in after them: re-seat the instances every few seconds while visible
    const now = performance.now();
    if (visible && now - heightsAt > 4000) { heightsAt = now; placeAll(); }
    const wantLights = visible ? REAL_LIGHTS : 0;
    if (furniture?.reserveLights && borrowed.length !== wantLights) {
      borrowed = furniture.reserveLights(wantLights);
      nearX = Infinity;
    }
    if (borrowed.length) {
      if (Math.hypot(cx - nearX, cz - nearZ) > 4) { nearX = cx; nearZ = cz; assignReal(cx, cz); }
      updateReal(shown);
    } else stats.lights = 0;
  }

  function dispose() {
    if (furniture?.reserveLights) furniture.reserveLights(0);
    for (const m of [signs, spill]) if (m) m.geometry.dispose();
    signMat.dispose();
    spillMat.dispose();
    scene.remove(group);
  }

  return { group, update, dispose, stats, get level() { return shown; } };
}
