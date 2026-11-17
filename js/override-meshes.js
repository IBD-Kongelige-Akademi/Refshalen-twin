import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { texture, uv, positionWorld, float, vec3, floor, fract, sin, dot, smoothstep, step, mix } from 'three/tsl';
import { cityUniforms, apartmentOccupancy, apartmentLight } from './tsl-materials.js';
import { getAtlasSource } from './data-packs.js';
import { dataUrl } from './data-config.js';
import { detailGeometry } from './detail-overrides.js';

// js/override-meshes.js
// The GPU side of the detail overrides (js/detail-overrides.js, docs/detail-overrides.md): fetches an override GLB (out of its tile's mesh
// pack with an HTTP Range request when the data is packed, else <data base>/<path>), parses it with three's GLTFLoader (KHR_mesh_quantization
// and EXT_texture_webp are built in: no decoder to load), and disposes it with its tile. The GLB is already in the twin's local frame
// (x east, y up, z south): no transform is applied.

/** Makes a tile layer's mesh pack known to the packed data's range source (js/data-packs.js); a no-op for unpacked data. */
export function registerOverridePack(layer) {
  if (layer?.pack) getAtlasSource()?.register(layer.pack);
}

/** The GLB bytes of an override mesh; `signal` aborts (the shared Range request is cancelled once nobody waits for it). */
export async function fetchOverrideBytes(path, { signal = null, fetchImpl = globalThis.fetch } = {}) {
  const packed = getAtlasSource();
  if (packed?.hasFile?.(path)) return packed.bytes(path, signal);
  const r = await fetchImpl(dataUrl(path), signal ? { signal } : {});
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} ${path}`), { status: r.status });
  return new Uint8Array(await r.arrayBuffer());
}

// Night light behind an override's glass. A converter names its glazing materials (tools/overrides: glass, glassd, glassb, glassw, skyglass, tri, and
// Hotel Hvide Hus's rooms and lift); their textures draw dark panes in lighter frames, so the pane is found in the texture itself and no new texture
// is needed. Rooms of about 4 m by 3.2 m in world space are lit or dark together, as many as the generated facades light (apartmentOccupancy), in
// their lamp colours, and follow the same uInteriorGlow from dusk to night.
const GLAZING = /^(glass\w*|skyglass|tri|rooms|lift)$/;
const BLUE_PANES = /^(glassd|rooms|lift)$/; // their frames or panels are dark too: only the bluish pane is glass

/** A node material in the place of a glazing material of a loaded override, with the night light; other materials come back as they are. */
export function litGlazing(m) {
  if (!m?.map || !GLAZING.test(m.name || '')) return m;
  const mat = new THREE.MeshStandardNodeMaterial();
  mat.name = m.name;
  mat.map = m.map;
  mat.color.copy(m.color);
  mat.roughness = m.roughness;
  mat.metalness = m.metalness;
  mat.side = m.side;
  mat.vertexColors = m.vertexColors;
  mat.userData = m.userData;
  const tex = texture(m.map, uv()).rgb;
  const dark = float(1).sub(smoothstep(0.16, 0.26, dot(tex, vec3(0.3, 0.5, 0.2))));
  const pane = BLUE_PANES.test(m.name) ? dark.mul(step(tex.r.mul(1.45), tex.b)) : dark;
  const room = floor(positionWorld.mul(vec3(1 / 4.2, 1 / 3.2, 1 / 4.2)));
  const pick = fract(sin(dot(room, vec3(12.9898, 78.233, 37.719))).mul(43758.5453));
  const lit = step(float(1).sub(apartmentOccupancy()), pick);
  const shade = fract(pick.mul(7.31));
  mat.emissiveNode = apartmentLight(shade).mul(mix(float(0.55), float(1), shade)).mul(lit).mul(pane).mul(cityUniforms.uInteriorGlow).mul(0.45);
  m.dispose();
  return mat;
}

const abortError = () => (typeof DOMException === 'function' ? new DOMException('aborted', 'AbortError') : Object.assign(new Error('aborted'), { name: 'AbortError' }));

/** Frees what a loaded override owns: geometries, materials, textures (and their decoded bitmaps). */
export function disposeOverride(group) {
  group?.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry?.dispose();
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m) continue;
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) {
        const t = m[k];
        if (!t) continue;
        t.dispose();
        t.image?.close?.();
      }
      m.dispose();
    }
    o.dispatchEvent({ type: 'dispose' });
  });
  group?.removeFromParent();
}

/**
 * Loads an override entry's mesh -> THREE.Group named `override-<id>` (userData.buildingId = id, userData.override = entry), shadows on.
 * Rejects with an AbortError when `signal` fires before it is ready (nothing stays allocated).
 */
export async function loadOverrideMesh(entry, { signal = null, fetchImpl = globalThis.fetch } = {}) {
  const bytes = await fetchOverrideBytes(entry.mesh.path, { signal, fetchImpl });
  if (signal?.aborted) throw abortError();
  const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
  const loader = new GLTFLoader();
  const gltf = await (loader.parseAsync ? loader.parseAsync(buffer, '') : new Promise((resolve, reject) => loader.parse(buffer, '', resolve, reject)));
  const group = new THREE.Group();
  group.name = `override-${entry.id}`;
  group.userData.buildingId = entry.id;
  group.userData.override = entry;
  group.add(gltf.scene);
  group.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    const m = o.material;
    if (m?.map) { m.map.anisotropy = 8; m.map.needsUpdate = true; }
    o.material = litGlazing(m);
  });
  group.updateMatrixWorld(true);
  if (signal?.aborted) { disposeOverride(group); throw abortError(); }
  return group;
}

/** One mesh (vertex colours, double-sided) of the parametric details of `items` = [[building record, details]], or null when empty. */
export function detailsMesh(items, material) {
  const position = [];
  const normal = [];
  const color = [];
  const index = [];
  for (const [b, details] of items) {
    const s = detailGeometry(b, details);
    const base = position.length / 3;
    position.push(...s.position);
    normal.push(...s.normal);
    color.push(...s.color);
    for (const i of s.index) index.push(base + i);
  }
  if (!index.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
  g.setIndex(new THREE.BufferAttribute(position.length / 3 > 65535 ? new Uint32Array(index) : new Uint16Array(index), 1));
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, material);
  mesh.name = 'override-details';
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}
