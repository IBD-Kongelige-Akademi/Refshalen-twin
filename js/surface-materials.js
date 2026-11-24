// js/surface-materials.js
// Procedural TSL ground materials for the Copenhagen twin (no textures, nothing downloaded):
//   kbh_fortov  Københavnerfortov: grey concrete slabs (50x50 or 62.5x62.5 cm, picked per pavement) in rows parallel to
//               the kerb, a line of small granite setts between every two slab rows, and a three-sett belt along the kerb
//   raadhus     Rådhusbelægning: 40x40 slabs in 3x3 groups framed by a line of setts
//   cobbles     brosten (staggered granite cobbles, ~14 cm)      setts   chaussésten (~10 cm)
//   asphalt     weathered asphalt (createAsphaltMaterial, after slop-newyork's road): grain, wheel tracks, utility cuts,
//               cracks & tar snakes, potholes, manhole covers; cycle tracks darker and cleaner
//   kerb        granite kerb stones with a joint every metre      paint/blue   worn white and Copenhagen-blue paint
// Pavement/ground meshes carry a `kuv` attribute (u along the street, v out from the kerb; see walk-space.js) and a
// per-polygon `seed`. Road meshes carry kuv = (arc length, lateral offset) so lane wheel tracks line up.

import * as THREE from 'three/webgpu';
import {
  Fn, If, float, vec2, vec3, vec4, attribute, positionWorld, normalWorldGeometry, cameraPosition, fwidth, floor, fract, mod, min,
  max, mix, step, smoothstep, sin, cos, atan, dot, abs, length, pow, exp, sqrt, clamp, context, metalness, texture
} from 'three/tsl';
import { cityUniforms, bumpNormal } from './tsl-materials.js';
import { poolLightAt } from './pool-light.js';

export const ssrReflectionWeight = Fn((builder) => builder.context.wetSurfaceReflection ?? metalness);

export const srgb = (r, g, b) => {
  const c = new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
  return vec3(c.r, c.g, c.b);
};

const hash2D = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));
const hash1D = Fn(([n]) => fract(sin(float(n).mul(127.1).add(311.7)).mul(43758.5453)));
export const noise2D = Fn(([p]) => {
  const pv = vec2(p).toVar();
  const i = floor(pv).toVar();
  const f = fract(pv).toVar();
  const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0))).toVar();
  const a = hash2D(i);
  const b = hash2D(i.add(vec2(1.0, 0.0)));
  const c = hash2D(i.add(vec2(0.0, 1.0)));
  const d = hash2D(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

// colour of one granite sett/cobble from two hashes: blue-grey, grey, pink or dark, with per-stone brightness
const stoneColour = Fn(([h, h2]) => {
  let c = srgb(86, 91, 100);
  c = mix(c, srgb(112, 112, 114), step(0.3, h));
  c = mix(c, srgb(132, 110, 108), step(0.62, h));
  c = mix(c, srgb(64, 66, 72), step(0.84, h));
  return c.mul(h2.mul(0.34).add(0.83));
});

// slab colour (light warm grey, a few cooler or darker ones), 0..1 hashes per slab
const slabColour = Fn(([h, h2]) => {
  let c = mix(srgb(140, 137, 130), srgb(176, 172, 164), h);
  c = mix(c, srgb(124, 128, 132), step(0.78, h2).mul(0.8));
  c = mix(c, srgb(164, 152, 138), step(0.9, h).mul(0.6));
  return c;
});

// dirt, wear and speckle shared by the pavement materials; returns a brightness multiplier
const grime = Fn(([wp, fpWorld]) => {
  const large = noise2D(wp.mul(0.45)).mul(0.5).add(noise2D(wp.mul(2.7)).mul(0.5));
  const fine = float(1.0).sub(smoothstep(0.015, 0.09, fpWorld));
  const speck = noise2D(wp.mul(48.0)).sub(0.5).mul(0.1).mul(fine);
  return float(0.86).add(large.mul(0.22)).add(speck);
});

const roadWetness = () => clamp(cityUniforms.uRoadWetness, 0.0, 1.0);
const puddleField = (wp) => noise2D(wp.mul(0.12)).mul(0.65).add(noise2D(wp.mul(0.42)).mul(0.35));
const puddleMask = (wp) => {
  const wet = roadWetness();
  const onset = smoothstep(0.0, 0.2, wet);
  return smoothstep(float(0.84).sub(wet.mul(0.18)), float(0.90).sub(wet.mul(0.18)), puddleField(wp)).mul(onset);
};

export function wetFinish(colour, roughness, wp) {
  const wet = roadWetness();
  const puddle = puddleMask(wp);
  const dampRoughness = mix(roughness, float(0.15), wet);
  return vec4(colour.mul(float(1.0).sub(wet.mul(0.4))), mix(dampRoughness, float(0.02), puddle));
}

export const wetReflectionWeightAt = (wp) => roadWetness().mul(0.06).add(puddleMask(wp).mul(0.28));

// stone cell inside a sett/cobble field. `edgeM` = distance to the stone edge in metres
function stoneShade(edgeM, fp, gap) {
  const aa = max(fp, 0.002);
  return smoothstep(gap.sub(aa), gap.add(aa), edgeM);
}

// ---- Københavnerfortov -------------------------------------------------------------------------------------------
const fortov = Fn(([u, v, seed, wp]) => {
  const fp = max(fwidth(u), fwidth(v)).max(0.0004).toVar();
  const fpw = length(vec2(fwidth(wp.x), fwidth(wp.y)));
  const s = mix(float(0.5), float(0.625), step(0.5, seed)).toVar(); // slab size for this pavement
  const belt = float(0.3);
  const vv = v.sub(belt);
  const period = s.mul(2.0).add(0.1);
  const m = mod(vv, period).toVar();
  const inBelt = float(1.0).sub(step(belt, v));
  const lineMask = step(s.mul(2.0), m).mul(float(1.0).sub(inBelt));
  const settMask = clamp(inBelt.add(lineMask), 0.0, 1.0);

  // slab: rows of 2 between sett lines
  const rowHi = step(s, m);
  const row = floor(vv.div(period)).mul(2.0).add(rowHi);
  const lv = m.sub(rowHi.mul(s));
  const col = floor(u.div(s));
  const lu = u.sub(col.mul(s));
  const cell = vec2(col, row);
  const h = hash2D(cell.add(vec2(seed.mul(37.0), 11.0)));
  const h2 = hash2D(cell.mul(1.7).add(vec2(5.3, seed.mul(9.0))));
  const edge = min(min(lu, s.sub(lu)), min(lv, s.sub(lv)));
  const jw = float(0.0045);
  const jointCov = float(1.0).sub(smoothstep(0.0, max(jw.mul(2.0), fp), edge)).mul(min(float(1.0), jw.mul(2.0).div(max(jw.mul(2.0), fp))));
  const bevel = float(1.0).sub(smoothstep(0.0, 0.02, edge).mul(0.0)).sub(float(1.0).sub(smoothstep(0.004, 0.022, edge)).mul(0.07));
  const slabBase = slabColour(h, h2).mul(float(0.95).add(noise2D(vec2(lu, lv).mul(5.0).add(cell.mul(3.1))).mul(0.1)));
  const slabAvg = srgb(150, 146, 139);
  let slab = mix(slabBase.mul(bevel), srgb(52, 50, 47), jointCov.mul(0.9));
  slab = mix(slab, slabAvg.mul(0.97), smoothstep(0.12, 0.5, fp));

  // setts: belt along the kerb (3 staggered rows) or the line between slab rows
  const beltRow = floor(v.div(0.1));
  const rowId = mix(float(10.0).add(floor(vv.div(period))), beltRow, inBelt);
  const rv = mix(m.sub(s.mul(2.0)).div(0.1), v.div(0.1), inBelt);
  const sx = u.div(0.1).add(mix(float(0.0), beltRow.mul(0.5), inBelt));
  const sc = vec2(floor(sx), rowId);
  const sh = hash2D(sc.add(vec2(3.7, seed.mul(5.0))));
  const sh2 = hash2D(sc.mul(2.3).add(vec2(8.1, 1.3)));
  const lx = fract(sx);
  const ly = fract(rv);
  const sEdge = min(min(lx, float(1.0).sub(lx)), min(ly, float(1.0).sub(ly))).mul(0.1);
  const stone = stoneShade(sEdge, fp, float(0.005));
  const dome = float(0.9).add(smoothstep(0.0, 0.02, sEdge).mul(0.12));
  let sett = mix(srgb(44, 40, 34), stoneColour(sh, sh2).mul(dome), stone);
  sett = mix(sett, srgb(98, 96, 98), smoothstep(0.03, 0.1, fp));

  const colour = mix(slab, sett, settMask).mul(grime(wp, fpw));
  const rough = mix(float(0.88), float(0.74), settMask);
  return wetFinish(colour, rough, wp);
});

// ---- Rådhusbelægning ---------------------------------------------------------------------------------------------
const raadhus = Fn(([u, v, seed, wp]) => {
  const fp = max(fwidth(u), fwidth(v)).max(0.0004).toVar();
  const fpw = length(vec2(fwidth(wp.x), fwidth(wp.y)));
  const G = float(1.3);
  const gu = mod(u, G);
  const gv = mod(v, G);
  const gid = vec2(floor(u.div(G)), floor(v.div(G)));
  const isFrame = max(step(1.2, gu), step(1.2, gv));
  const iu = min(floor(gu.div(0.4)), float(2.0));
  const iv = min(floor(gv.div(0.4)), float(2.0));
  const lu = gu.sub(iu.mul(0.4));
  const lv = gv.sub(iv.mul(0.4));
  const cell = gid.mul(3.0).add(vec2(iu, iv));
  const h = hash2D(cell.add(vec2(seed.mul(13.0), 3.0)));
  const h2 = hash2D(cell.mul(1.3).add(vec2(2.2, seed.mul(7.0))));
  const edge = min(min(lu, float(0.4).sub(lu)), min(lv, float(0.4).sub(lv)));
  const jw = float(0.005);
  const jointCov = float(1.0).sub(smoothstep(0.0, max(jw.mul(2.0), fp), edge)).mul(min(float(1.0), jw.mul(2.0).div(max(jw.mul(2.0), fp))));
  let slab = mix(srgb(160, 157, 150), srgb(178, 175, 167), h);
  slab = mix(slab, srgb(140, 142, 144), step(0.82, h2).mul(0.7)).mul(float(0.95).add(noise2D(vec2(lu, lv).mul(6.0).add(cell)).mul(0.1)));
  slab = mix(slab, srgb(50, 48, 45), jointCov.mul(0.9));
  slab = mix(slab, srgb(160, 157, 150), smoothstep(0.12, 0.5, fp));
  const sc = floor(vec2(u, v).div(0.1));
  const lx = fract(u.div(0.1));
  const ly = fract(v.div(0.1));
  const sEdge = min(min(lx, float(1.0).sub(lx)), min(ly, float(1.0).sub(ly))).mul(0.1);
  let sett = mix(srgb(44, 40, 34), stoneColour(hash2D(sc.add(vec2(1.9, 7.7))), hash2D(sc.mul(2.1))), stoneShade(sEdge, fp, float(0.005)));
  sett = mix(sett, srgb(98, 96, 98), smoothstep(0.03, 0.1, fp));
  return wetFinish(mix(slab, sett, isFrame).mul(grime(wp, fpw)), mix(float(0.88), float(0.74), isFrame), wp);
});

// ---- cobbles and setts -------------------------------------------------------------------------------------------
function stoneField(size, gapFrac, tint) {
  return Fn(([u, v, seed, wp]) => {
    const fp = max(fwidth(u), fwidth(v)).max(0.0004);
    const fpw = length(vec2(fwidth(wp.x), fwidth(wp.y)));
    const row = floor(v.div(size));
    const x = u.div(size).add(hash1D(row.add(seed.mul(41.0))));
    const col = floor(x);
    const c = vec2(fract(x), fract(v.div(size))).mul(2.0).sub(1.0);
    const id = vec2(col, row);
    const h = hash2D(id.add(vec2(seed.mul(9.0), 4.0)));
    const h2 = hash2D(id.mul(1.9).add(vec2(6.0, 2.0)));
    // rounded stone: superellipse-ish distance, a little lopsided per stone
    const d = max(abs(c.x), abs(c.y)).mul(0.6).add(length(c).mul(0.4)).add(h2.sub(0.5).mul(0.06));
    const edgeM = float(1.0).sub(d).mul(size).mul(0.5);
    const gap = float(size).mul(gapFrac);
    const stone = stoneShade(edgeM, fp, gap);
    const shade = float(1.08).sub(d.mul(d).mul(0.3));
    let col3 = stoneColour(h, h2).mul(tint).mul(shade);
    col3 = mix(srgb(38, 34, 28), col3, stone);
    col3 = mix(col3, srgb(96, 93, 92).mul(tint), smoothstep(float(size).mul(0.35), float(size).mul(0.9), fp));
    return wetFinish(col3.mul(grime(wp, fpw)), mix(float(0.95), float(0.7), stone), wp);
  });
}

// ---- gravel and plain concrete -----------------------------------------------------------------------------------
/** Dry fine gravel by world position, shared by register polygons and the lake-path ground band. */
export const gravelRGB = Fn(([wp]) => {
  const fpw = length(vec2(fwidth(wp.x), fwidth(wp.y)));
  const fine = float(1.0).sub(smoothstep(0.01, 0.08, fpw));
  const g = noise2D(wp.mul(70.0)).mul(0.5).add(noise2D(wp.mul(16.0)).mul(0.5));
  const big = noise2D(wp.mul(0.7));
  return mix(srgb(142, 130, 110), srgb(168, 156, 134), big).mul(float(0.88).add(g.mul(0.24).mul(fine)));
});

const gravel = Fn(([u, v, seed, wp]) => wetFinish(gravelRGB(wp), float(0.98), wp));

const concrete = Fn(([u, v, seed, wp]) => {
  const fp = max(fwidth(u), fwidth(v)).max(0.0004);
  const fpw = length(vec2(fwidth(wp.x), fwidth(wp.y)));
  const lu = mod(u, 1.0);
  const lv = mod(v, 1.0);
  const edge = min(min(lu, float(1.0).sub(lu)), min(lv, float(1.0).sub(lv)));
  const jointCov = float(1.0).sub(smoothstep(0.0, max(0.01, fp), edge)).mul(min(float(1.0), float(0.01).div(max(0.01, fp))));
  const c = mix(srgb(150, 148, 144), srgb(52, 50, 47), jointCov.mul(0.8));
  return vec4(c.mul(grime(wp, fpw)), 0.9);
});

// ---- asphalt -----------------------------------------------------------------------------------------------------
// After slop-newyork's road (dcb453f, acaccfd, 1e92837, ed9b796, 627f7b3, 057bed2, 91dc313), on Aalborg's roads: the wear
// and repairs follow each road (kuv: u metres along it, v across it, as the meshes carry them), the grain, relief and the
// round things (potholes, oil drips, stone chips, manhole covers) the world. Physically based albedos (weathered asphalt
// about 9%, fresh blacktop and tar sealant 4-5%), the aggregate grain filtered like a texture so it reaches down the street,
// the stones' relief shading through the bump where the pixel resolves it and roughening the specular where it doesn't,
// and a rough (EON) diffuse. Wet and puddled as the other ground materials (wetFinish); lit by the street-light pools.

// Value noise from a table: 256 x 256 random lattice values in four independent channels, interpolated by the texture unit
// (the fade applied to the coordinates first): one fetch for what noise2D works out from four hashes, and four layers at once.
// tableCell: one cell's four values, unfiltered. tableNoiseFiltered: filtered for the pixel's footprint (trilinear and
// anisotropic from the gradients gx, gy of p across the pixel, taken in uniform control flow). tableNoiseFine: interpolated
// in full precision from the cell's corners, smooth enough for bump relief.
const NOISE_TABLE = 256;
let _noiseTable = null;
function noiseTable() {
  if (_noiseTable) return _noiseTable;
  const data = new Uint8Array(NOISE_TABLE * NOISE_TABLE * 4);
  let s = 0x2545f491;
  for (let i = 0; i < data.length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    data[i] = s >>> 24;
  }
  _noiseTable = new THREE.DataTexture(data, NOISE_TABLE, NOISE_TABLE, THREE.RGBAFormat);
  _noiseTable.wrapS = _noiseTable.wrapT = THREE.RepeatWrapping;
  _noiseTable.magFilter = THREE.LinearFilter;
  _noiseTable.minFilter = THREE.LinearMipmapLinearFilter;
  _noiseTable.generateMipmaps = true;
  _noiseTable.anisotropy = 16;
  _noiseTable.needsUpdate = true;
  return _noiseTable;
}
const tableNoise = Fn(([p]) => {
  const pv = vec2(p).toVar();
  const i = floor(pv);
  const f = pv.sub(i);
  const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
  return texture(noiseTable(), fract(i.mul(1.0 / NOISE_TABLE)).add(u.add(0.5).mul(1.0 / NOISE_TABLE))).level(0);
});
const tableCell = (i) => texture(noiseTable(), fract(vec2(i).mul(1.0 / NOISE_TABLE)).add(0.5 / NOISE_TABLE)).level(0);
const tableNoiseFiltered = Fn(([p, gx, gy]) => {
  const pv = vec2(p).toVar();
  const i = floor(pv);
  const f = pv.sub(i);
  const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
  return texture(noiseTable(), fract(i.mul(1.0 / NOISE_TABLE)).add(u.add(0.5).mul(1.0 / NOISE_TABLE)))
    .grad(vec2(gx).mul(1.0 / NOISE_TABLE), vec2(gy).mul(1.0 / NOISE_TABLE));
});
const tableNoiseFine = Fn(([p]) => {
  const pv = vec2(p).toVar();
  const i = floor(pv).toVar();
  const f = pv.sub(i);
  const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0))).toVar();
  const a = tableCell(i), b = tableCell(i.add(vec2(1.0, 0.0)));
  const c = tableCell(i.add(vec2(0.0, 1.0))), d = tableCell(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

// `detail()` only where `active`, else `flat`: detail faded out (or absent) is skipped rather than computed and multiplied by 0
function fadedDetail(active, flat, detail) {
  const out = float(flat).toVar();
  If(active, () => {
    out.assign(detail());
  });
  return out;
}

/**
 * One family of cracks: lines running along v, one in each band `spacing` metres wide across u, set at random in its band,
 * meandering over metres, jagged over centimetres, and broken into runs (`runShare` of the line's length). `sealedShare` of
 * the lines carry a band of tar sealant 3-6 cm wide, the rest are open cracks 2-6 mm wide. fu & fv are the pixel's footprint
 * along u & v; each line is box-filtered for the footprint across it. Returns (open crack, sealant) coverage.
 */
function crackFamily(u, v, fu, fv, spacing, seed, sealedShare, runShare) {
  const band = floor(u.div(spacing)).toVar();
  const line = tableCell(vec2(band, seed)).toVar();
  const course = tableNoise(vec2(v.mul(0.22), band.mul(7.13).add(seed))).x.sub(0.5).mul(spacing * 0.1)
    .add(tableNoise(vec2(v.mul(3.1), band.mul(3.71).add(seed + 0.5))).y.sub(0.5).mul(0.04))
    .add(tableNoise(vec2(v.mul(17.0), band.mul(1.37).add(seed + 0.25))).z.sub(0.5).mul(0.012));
  const dist = abs(u.sub(band.add(line.x.mul(0.6).add(0.2)).mul(spacing)).sub(course));
  const run = smoothstep(0.5 - runShare * 0.5, 0.56 - runShare * 0.5, tableNoise(vec2(v.mul(0.14), band.mul(5.31).add(seed + 0.75))).w);
  const sealed = step(1.0 - sealedShare, line.y);
  const halfWidth = mix(line.z.mul(0.002).add(0.001), line.z.mul(0.015).add(0.015), sealed);
  const across = fu.add(fv.mul(0.3));
  const effWidth = max(halfWidth, across.mul(0.6));
  const cover = float(1.0).sub(smoothstep(effWidth, effWidth.add(across), dist)).mul(halfWidth.div(effWidth)).mul(run);
  return vec2(cover.mul(float(1.0).sub(sealed)), cover.mul(sealed));
}

/**
 * Cracks along the road (u along it, v across it; foot = the pixel's footprint in u & v): across the carriageway as it
 * shrinks in the cold (transverse, every several metres), along it at the joints between paving passes (longitudinal, near
 * the lane lines), about half sealed with tar ("tar snakes"); worn stretches have broken up into blocks a metre or so
 * across. `amount` scales how cracked the surface is (0: none). Returns (open crack, sealant) coverage.
 */
const roadCracks = Fn(([u, v, foot, worn, amount]) => {
  const out = vec2(0.0).toVar();
  If(min(foot.x, foot.y).lessThan(0.3).and(amount.greaterThan(0.0)), () => {
    const transverse = crackFamily(u, v, foot.x, foot.y, 6.5, 11.0, 0.55, 0.45);
    const longitudinal = crackFamily(v, u, foot.y, foot.x, 3.0, 151.0, 0.55, 0.35);
    out.assign(max(transverse, longitudinal).mul(amount));
    If(worn.greaterThan(0.001).and(min(foot.x, foot.y).lessThan(0.03)), () => {
      const blocksU = crackFamily(u, v, foot.x, foot.y, 1.3, 83.0, 0.0, 0.7);
      const blocksV = crackFamily(v, u, foot.y, foot.x, 1.1, 197.0, 0.0, 0.7);
      out.x.assign(max(out.x, max(blocksU.x, blocksV.x).mul(worn).mul(amount)));
    });
  });
  return out;
});

/**
 * The asphalt's relief as octaves of footprint-filtered value noise (frequency in cells a metre, height in metres, lattice
 * turn in radians): the megatexture of a worn surface and the macrotexture of its stones (5-11 mm, ~0.8 mm RMS height,
 * ~0.26 RMS slope). Value noise of height (n - 0.5) * a over cells 1 / f m across has an RMS slope of 0.384 a f per axis.
 */
const ASPHALT_RELIEF = [
  { f: 8.5, a: 0.005, turn: 0.3 },
  { f: 19.0, a: 0.0022, turn: 1.1 },
  { f: 36.0, a: 0.0016, turn: 2.3 },
  { f: 90.0, a: 0.003, turn: 0.7 },
  { f: 200.0, a: 0.002, turn: 1.9 }
];
const reliefResolved = (i, foot) => float(1.0).sub(smoothstep(0.2, 0.5, min(foot.x, foot.y).mul(ASPHALT_RELIEF[i].f)));
const reliefUnresolved = (i, foot) =>
  smoothstep(0.2, 0.5, foot.x.mul(ASPHALT_RELIEF[i].f)).add(smoothstep(0.2, 0.5, foot.y.mul(ASPHALT_RELIEF[i].f))).mul(0.5);
function reliefOctave(i, xz, gx, gy) {
  const { f, turn } = ASPHALT_RELIEF[i];
  const c = Math.cos(turn) * f, s = Math.sin(turn) * f;
  const turned = (q) => vec2(q.x.mul(c).sub(q.y.mul(s)), q.x.mul(s).add(q.y.mul(c)));
  return tableNoiseFiltered(turned(xz).add(13.7 * i), turned(gx), turned(gy)).x.sub(0.5).mul(ASPHALT_RELIEF[i].a);
}

/**
 * An asphalt surface. tone scales its albedo (cycle tracks are a darker, cleaner mix); tracks: polished lane wheel tracks
 * (on v = 1.5 + 3k, 0.85 m either side); patchRate: the share of 11 x 6 m cells with a utility-cut patch or trench;
 * cracking: how cracked it is; manholes / potholes: whether it has them (the carriageway does).
 */
function createAsphaltMaterial({ tone = 0.7, tracks = 0, patchRate = 0.3, cracking = 1, manholes = false, potholes = false, polygonOffset = 0 } = {}) {
  const mat = new THREE.MeshPhysicalNodeMaterial({ metalness: 0, roughness: 0.65, side: THREE.DoubleSide });
  const kuv = attribute('kuv', 'vec2');
  const u = kuv.x, v = kuv.y;
  const wp = positionWorld.xz;

  // (tone 0.7 by default: slop-newyork's 9% weathered asphalt reads light under Aalborg's brighter exposure)
  const cAsphaltDark = srgb(62, 64, 67).mul(tone);
  const cAsphaltLight = srgb(106, 108, 112).mul(tone);
  const cOldPatch = srgb(119, 120, 122).mul(tone);
  const cFreshPatch = srgb(59, 60, 63);
  const cSealant = srgb(52, 53, 55);
  const cIron = srgb(122, 120, 117);
  const cGrime = srgb(59, 54, 49);

  // the pixel's world size (the long axis of its footprint), its footprint along x & z and along the road (u & v)
  const pixelSize = length(fwidth(wp));
  const footprint = fwidth(wp);
  const roadFoot = fwidth(kuv);

  // Utility-cut patches & trenches in the road's own frame: one 11 x 6 m cell in `patchRate`; squarish cuts, or long
  // narrow trenches along the road or across it. patchDist: signed distance to the patch's edge (m, < 0 inside)
  const pCell = floor(vec2(u.div(11.0), v.div(6.0)));
  const pa = tableCell(pCell.add(vec2(31.0, 7.0))), pb = tableCell(pCell.add(vec2(101.0, 37.0)));
  const hasPatch = step(1.0 - patchRate, pa.x);
  const trench = step(0.6, pa.y);
  const alongRoad = step(0.5, pa.z);
  const pCentre = pCell.add(0.5).add(vec2(pa.w, pb.x).sub(0.5).mul(mix(float(0.4), float(0.08), trench))).mul(vec2(11.0, 6.0));
  const cutHalf = vec2(pb.y.mul(1.8).add(0.6), pb.z.mul(1.0).add(0.5));
  const trenchNarrow = fract(pa.x.mul(7.31).add(pb.w.mul(3.17))).mul(0.25).add(0.3);
  const trenchHalf = mix(vec2(trenchNarrow, pb.w.mul(1.0).add(1.6)), vec2(pb.w.mul(2.0).add(2.4), trenchNarrow), alongRoad);
  const pq = abs(vec2(u, v).sub(pCentre)).sub(mix(cutHalf, trenchHalf, trench));
  const patchDist = max(pq.x, pq.y);
  const patchCover = smoothstep(pixelSize, pixelSize.negate(), patchDist).mul(hasPatch);
  // the tar sealing the saw-cut edge of each patch, a few centimetres wide
  const sealWidth = max(float(0.022), pixelSize.mul(0.75));
  const patchSeal = float(1.0).sub(smoothstep(sealWidth, sealWidth.add(pixelSize), abs(patchDist))).mul(float(0.022).div(sealWidth)).mul(hasPatch);
  const patchFresh = step(0.55, pb.x);

  // Worn stretches (0 .. 1): about a quarter of the surface, in patches a block or so across
  const worn = smoothstep(0.5, 0.78, tableNoise(wp.mul(0.045).add(71.0)).x);

  // Potholes, mostly in the worn stretches: a ragged bowl a hand or two across, only traced in their 7 m cells
  const pothole = potholes ? Fn(() => {
    const px = float(pixelSize).toVar();
    const hCell = floor(wp.div(7.0)).toVar();
    const ha = tableCell(hCell.add(vec2(53.0, 211.0))).toVar();
    const out = float(0.0).toVar();
    If(ha.z.greaterThanEqual(float(0.985).sub(worn.mul(0.1))), () => {
      const hCentre = hCell.add(ha.xy.mul(0.6).add(0.2)).mul(7.0);
      const hRadius = ha.w.mul(0.24).add(0.12);
      const hDist = length(wp.sub(hCentre)).mul(tableNoise(wp.mul(6.0)).w.sub(0.5).mul(0.5).add(1.0));
      out.assign(smoothstep(hRadius.add(px), hRadius.mul(0.35), hDist));
    });
    return out;
  })() : float(0.0);

  // Cracks & tar snakes, none in the (newer) patches
  const cracks = roadCracks(u, v, roadFoot, worn, float(cracking)).mul(float(1.0).sub(patchCover));
  const crack = cracks.x;
  const tarSnake = cracks.y;

  // Exposed light stone chips: one candidate per 2.4 cm cell of a lattice turned off the road, two in five showing (8-14 mm)
  const chipCell = 0.024;
  const chips = Fn(() => {
    const px = float(pixelSize).toVar();
    return fadedDetail(px.lessThan(0.012), 0.036, () => {
      const q = vec2(wp.x.mul(0.8).sub(wp.y.mul(0.6)), wp.x.mul(0.6).add(wp.y.mul(0.8))).div(chipCell);
      const cell = floor(q).toVar();
      const ca = tableCell(cell), cb = tableCell(cell.add(vec2(127.0, 61.0)));
      const d0 = fract(q).sub(ca.xy.mul(0.4).add(0.3)).toVar();
      const shape = ca.z.toVar();
      const heading = shape.mul(Math.PI * 7.0);
      const dir = vec2(cos(heading), sin(heading));
      const along = dot(d0, dir);
      const across = dot(d0, vec2(dir.y, dir.x.mul(-1.0)));
      const radius = ca.w.mul(0.13).add(0.17);
      const d = length(vec2(along, across.mul(shape.mul(0.6).add(1.0)))).sub(radius);
      const aa = px.div(chipCell);
      const stone = smoothstep(aa.mul(0.5), aa.mul(-0.5), d).mul(step(0.6, cb.x));
      return mix(float(0.036), stone.mul(cb.y.mul(0.6).add(0.4)), smoothstep(0.012, 0.006, px));
    });
  })();

  // Oil & coolant drips: ragged dark blots a hand or two across, one 2.5 m cell in three (fewer on cycle tracks)
  const oilDrip = Fn(() => {
    const px = float(pixelSize).toVar();
    const oilCell = floor(wp.div(2.5)).toVar();
    const oil = tableCell(oilCell.add(vec2(17.0, 233.0))).toVar();
    return fadedDetail(oil.x.greaterThanEqual(manholes ? 0.66 : 0.9), 0.0, () => {
      const oilCentre = oilCell.add(oil.yz.mul(0.6).add(0.2)).mul(2.5);
      const oilDist = length(wp.sub(oilCentre)).mul(tableNoise(wp.mul(5.0)).z.sub(0.5).mul(0.8).add(1.0));
      const oilRadius = oil.w.mul(0.25).add(0.1);
      return smoothstep(oilRadius.add(px), oilRadius.mul(0.3), oilDist).mul(fract(oil.x.mul(5.37)).mul(0.6).add(0.4));
    });
  })();

  // Cast-iron manhole covers, one 14 m cell in three: a 66 cm cover in a steel frame with a waffle or ring-and-spoke pattern
  // and two pick holes; tyres polish the raised faces to bare iron, grime packs the recesses. x = cover & frame, y = bare
  // polished iron, z = relief (m)
  const manhole = manholes ? Fn(() => {
    const mhCell = floor(wp.div(14.0));
    const mh = tableCell(mhCell.add(vec2(71.0, 149.0))).toVar();
    const mhOffset = wp.sub(mhCell.add(mh.xy.mul(0.6).add(0.2)).mul(14.0)).toVar();
    const px = float(pixelSize).toVar();
    const r = length(mhOffset).toVar();
    const out = vec3(0.0).toVar();
    If(mh.z.greaterThanEqual(0.66).and(r.lessThan(px.add(0.4))), () => {
      const aa = max(px, float(0.002));
      const inside = smoothstep(aa.mul(0.5).add(0.4), aa.mul(-0.5).add(0.4), r);
      const frame = smoothstep(0.33, aa.add(0.33), r);
      const rim = smoothstep(0.285, aa.add(0.285), r);
      const seam = float(1.0).sub(smoothstep(0.004, aa.add(0.004), abs(r.sub(0.33))));
      const turn = mh.w.mul(Math.PI * 2.0);
      const c = cos(turn), s = sin(turn);
      const q = vec2(mhOffset.x.mul(c).sub(mhOffset.y.mul(s)), mhOffset.x.mul(s).add(mhOffset.y.mul(c))).toVar();
      const edge = aa.div(0.05).mul(0.5);
      const boss = abs(fract(q.div(0.05)).sub(0.5));
      const waffle = smoothstep(edge.add(0.32), float(0.32).sub(edge), max(boss.x, boss.y));
      const ringEdge = aa.div(0.045).mul(0.5);
      const ring = smoothstep(ringEdge.add(0.28), float(0.28).sub(ringEdge), abs(fract(r.div(0.045)).sub(0.5)));
      const spokeAngle = fract(atan(q.y, q.x).mul(12.0 / (Math.PI * 2.0)));
      const spokeDist = float(0.5).sub(abs(spokeAngle.sub(0.5))).mul(r).mul(Math.PI * 2.0 / 12.0);
      const spoke = smoothstep(aa.mul(0.5).add(0.008), aa.mul(-0.5).add(0.008), spokeDist);
      const pattern = mix(waffle, max(ring, spoke.mul(step(0.06, r))), step(0.5, fract(mh.w.mul(13.7))));
      const raised = mix(float(0.5), pattern, smoothstep(0.02, 0.008, px));
      const pick = float(1.0).sub(smoothstep(0.012, aa.add(0.012), min(length(q.sub(vec2(0.24, 0.0))), length(q.add(vec2(0.24, 0.0))))));
      const polished = max(raised, max(rim, frame.mul(0.85))).mul(float(1.0).sub(seam)).mul(float(1.0).sub(pick));
      out.assign(vec3(inside, polished, polished.mul(0.004).sub(seam.mul(0.008)).sub(pick.mul(0.012))));
    });
    return out;
  })() : vec3(0.0);
  const isManhole = manhole.x;
  const mhPolish = manhole.y;

  // Polished lane wheel tracks: lane centres on v = 1.5 + 3k, tracks 0.85 m either side
  const laneD = abs(fract(v.div(3.0)).sub(0.5)).mul(3.0);
  const wheelTrack = exp(pow(laneD.sub(0.85).div(0.3), 2.0).negate()).mul(tracks);

  const puddle = puddleMask(wp);

  // Colour: footprint-filtered aggregate grit in two octaves on lattices turned off the road and off each other, faint pours
  // & mottling, oily wear stains; the repairs, chips, drips, potholes, sealant, cracks and the manhole covers on top
  const albedo = Fn(() => {
    const camDist = length(positionWorld.sub(cameraPosition)).toVar();
    const detail = smoothstep(240.0, 22.0, camDist).toVar();
    const gx = vec2(wp.dFdx()).toVar();
    const gy = vec2(wp.dFdy()).toVar();
    const grit = (q) => vec2(q.x.mul(0.8).sub(q.y.mul(0.6)), q.x.mul(0.6).add(q.y.mul(0.8))).mul(14.0);
    const fineGrit = (q) => vec2(q.x.mul(0.93).add(q.y.mul(0.37)), q.y.mul(0.93).sub(q.x.mul(0.37))).mul(33.0);
    const microAggregate = tableNoiseFiltered(grit(wp), grit(gx), grit(gy)).x
      .add(tableNoiseFiltered(fineGrit(wp).add(17.0), fineGrit(gx), fineGrit(gy)).z.sub(0.5));
    const fineGrain = tableNoiseFiltered(wp.mul(3.2), gx.mul(3.2), gy.mul(3.2)).y;
    const pour = tableNoise(wp.mul(0.18)).z;
    const oilyStain = fadedDetail(camDist.lessThan(240.0), 0.0, () =>
      smoothstep(0.58, 0.84, tableNoise(wp.mul(0.42)).w).mul(detail));
    const mottle = tableNoise(wp.mul(0.9).add(41.0)).x.mul(0.65).add(tableNoise(wp.mul(2.3).add(7.0)).y.mul(0.35));
    const base = mix(cAsphaltDark, cAsphaltLight,
      microAggregate.sub(0.5).mul(0.3).add(fineGrain.sub(0.5).mul(0.16)).add(pour.sub(0.5).mul(0.08))
        .add(smoothstep(0.3, 0.7, mottle).sub(0.5).mul(0.08)).add(0.45))
      .mul(float(1.0).sub(oilyStain.mul(0.18)))
      .mul(float(1.0).add(wheelTrack.mul(0.08)));
    const patchCol = mix(mix(base, cOldPatch, 0.45).mul(1.08), cFreshPatch, patchFresh);
    const repaired = mix(base, patchCol, patchCover)
      .mul(float(1.0).sub(patchSeal.mul(0.5)))
      .add(chips.mul(0.065).mul(float(1.0).sub(patchCover.mul(patchFresh))).mul(float(1.0).sub(max(tarSnake, crack))))
      .mul(float(1.0).sub(oilDrip.mul(0.45)))
      .mul(float(1.0).sub(pothole.mul(0.4)));
    const sealedCracked = mix(repaired, cSealant, tarSnake).mul(float(1.0).sub(crack.mul(0.75)));
    return mix(sealedCracked, mix(cGrime, cIron, mhPolish), isManhole);
  })();

  // Roughness: the stones' polished faces & the binder (rougher where it has ravelled), widened by the slope variance of the
  // relief too fine for the pixel (GGX alpha^2 grows by twice its per-axis slope variance); sealant, drips, fresh patches &
  // the wheel tracks smoother, potholes & cracks rougher; bare iron polished, the grime around it rough
  const dryRoughness = Fn(() => {
    const foot = vec2(footprint).toVar();
    let unresolved = float(0.0);
    for (let i = 0; i < ASPHALT_RELIEF.length; i++) {
      const slope = 0.384 * ASPHALT_RELIEF[i].a * ASPHALT_RELIEF[i].f;
      unresolved = unresolved.add(reliefUnresolved(i, foot).mul(2.0 * slope * slope));
    }
    // (0.86, rougher than slop-newyork's 0.58: under Aalborg's exposure a glossier road mirrors the bright sky at grazing
    // angles and glares white towards the low winter sun; this keeps a soft sheen and the polished wheel tracks)
    const micro = float(0.86).add(worn.mul(0.04)).add(tableNoise(wp.mul(0.7).add(5.0)).w.sub(0.5).mul(0.08));
    const asphalt = sqrt(sqrt(pow(micro, 4.0).add(unresolved)));
    const dry = mix(asphalt, float(0.45), max(patchSeal, tarSnake))
      .sub(oilDrip.mul(0.15))
      .sub(patchCover.mul(patchFresh).mul(0.06))
      .sub(wheelTrack.mul(0.08))
      .add(pothole.mul(0.1))
      .add(crack.mul(0.1));
    return mix(dry, mix(float(0.88), float(0.56), mhPolish), isManhole);
  })();

  // wet & puddled as the other ground materials (potholes hold water first: they darken further)
  const finished = wetFinish(albedo.mul(float(1.0).sub(pothole.mul(roadWetness()).mul(0.3))), dryRoughness, wp);
  mat.colorNode = finished.xyz;
  mat.roughnessNode = finished.w;
  mat.emissiveNode = finished.xyz.mul(poolLightAt(positionWorld)); // street-light pools (js/pool-light.js)
  mat.metalnessNode = mhPolish.mul(isManhole).mul(float(1.0).sub(puddle));
  // rough diffuse (EON): the stones shadow & mask each other; sealant is smoother, water levels it
  mat.diffuseRoughnessNode = float(0.4).mul(float(1.0).sub(tarSnake.mul(0.6)))
    .mul(float(1.0).sub(max(puddle, roadWetness().mul(0.6))));

  // Relief: a gentle swell of the paving, the megatexture & the stones (filtered for the pixel), stone chips, crack grooves,
  // raised patches with their tar seals, tar-snake beads, pothole bowls and the manhole covers; flat in standing water
  mat.normalNode = Fn(() => {
    const px = float(pixelSize).toVar();
    const coarseFade = smoothstep(0.12, 0.035, px).toVar();
    const midFade = smoothstep(0.035, 0.012, px).toVar();
    const ramp = max(float(0.012), px.mul(2.0));
    const gx = vec2(wp.dFdx()).toVar();
    const gy = vec2(wp.dFdy()).toVar();
    const swell = tableNoiseFine(wp.mul(0.55).add(23.0)).x.sub(0.5).mul(0.02)
      .add(tableNoiseFine(wp.mul(1.9)).y.sub(0.5).mul(0.005));
    const ripples = fadedDetail(px.lessThan(0.3), 0.0, () =>
      tableNoiseFine(wp.mul(3.6).add(61.0)).z.sub(0.5).mul(0.004).mul(smoothstep(0.3, 0.1, px)));
    const foot = vec2(footprint).toVar();
    let relief = float(0.0);
    for (let i = 0; i < ASPHALT_RELIEF.length; i++) relief = relief.add(reliefOctave(i, wp, gx, gy).mul(reliefResolved(i, foot)));
    const height = swell.add(ripples).add(relief.mul(float(1.0).sub(roadWetness().mul(0.5))))
      .add(chips.mul(0.0015).mul(midFade))
      .add(tarSnake.mul(0.0018))
      .sub(crack.mul(0.003).mul(smoothstep(0.03, 0.006, px)))
      .add(smoothstep(ramp, ramp.negate(), patchDist).mul(hasPatch).mul(0.004))
      .add(float(1.0).sub(smoothstep(0.0, max(float(0.03), ramp), abs(patchDist))).mul(hasPatch).mul(0.0015))
      .sub(pothole.mul(0.03));
    const manholeRelief = manhole.z.sub(0.004).mul(coarseFade);
    return bumpNormal(mix(height, manholeRelief, isManhole).mul(float(1.0).sub(puddle)));
  })();

  // Keep wet SSR eligibility in material context so reflection passes can use an unnamed color target (as make() does)
  mat.contextNode = context({ wetSurfaceReflection: wetReflectionWeightAt(wp) });
  if (polygonOffset) {
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = polygonOffset;
    mat.polygonOffsetUnits = polygonOffset;
  }
  return mat;
}

const granite = Fn(([u, v, seed, wp]) => {
  const fpw = length(vec2(fwidth(wp.x), fwidth(wp.y)));
  const fine = float(1.0).sub(smoothstep(0.01, 0.08, fpw));
  const top = step(0.6, normalWorldGeometry.y);
  const spk = hash2D(floor(wp.mul(220.0)));
  const speckle = step(0.85, spk).mul(0.18).sub(step(spk, 0.1).mul(0.14)).mul(fine);
  const grain = noise2D(wp.mul(30.0)).mul(0.14).add(noise2D(wp.mul(5.0)).mul(0.12));
  const lu = fract(u);
  const joint = float(1.0).sub(smoothstep(0.0, 0.012, min(lu, float(1.0).sub(lu))));
  const c = mix(srgb(122, 120, 119), srgb(166, 164, 161), top).mul(float(0.9).add(grain).add(speckle));
  return vec4(c.mul(float(1.0).sub(joint.mul(0.45))), 0.78);
});

// ---- grass -------------------------------------------------------------------------------------------------------
// One colour field for the lawn: the ground polygons and the tufts of js/grass.js both read it at the world position,
// so the blades grow out of ground of exactly their own colour. Mown parkland: large soft patches (sun, shade, wear), a
// slow dry-to-lush drift, broad mowing bands, a little clover.
export const grassColour = Fn(([wp]) => {
  const patch = noise2D(wp.mul(0.11)).mul(0.55).add(noise2D(wp.mul(0.43).add(vec2(9.1, 3.3))).mul(0.45));
  const lush = srgb(64, 98, 38);
  const mid = srgb(88, 120, 48);
  const dry = srgb(128, 134, 70);
  let c = mix(lush, mid, smoothstep(0.25, 0.6, patch));
  c = mix(c, dry, smoothstep(0.62, 0.9, noise2D(wp.mul(0.05).add(vec2(41.0, 7.0)))).mul(0.65));
  const band = sin(wp.x.mul(1.9).add(wp.y.mul(0.7)).add(noise2D(wp.mul(0.2)).mul(5.0))).mul(0.5).add(0.5);
  c = c.mul(float(0.94).add(band.mul(0.1)));
  const clover = smoothstep(0.7, 0.8, noise2D(wp.mul(0.9).add(vec2(2.0, 5.0))));
  return mix(c, srgb(78, 122, 62), clover.mul(0.35));
});

const grassGround = Fn(([u, v, seed, wp]) => {
  const fpw = length(vec2(fwidth(wp.x), fwidth(wp.y)));
  const fine = float(1.0).sub(smoothstep(0.02, 0.25, fpw)); // blade-scale grain fades out before it can shimmer
  const grain = noise2D(wp.mul(70.0)).sub(0.5).mul(0.2).add(noise2D(wp.mul(17.0)).sub(0.5).mul(0.14)).mul(fine);
  return vec4(grassColour(wp).mul(float(0.82).add(grain)), 0.96);
});

const paintFn = (colour, rough) => Fn(([u, v, seed, wp]) => {
  const fpw = length(vec2(fwidth(wp.x), fwidth(wp.y)));
  const fine = float(1.0).sub(smoothstep(0.02, 0.2, fpw));
  const worn = smoothstep(0.62, 0.8, noise2D(wp.mul(7.0)).mul(0.6).add(noise2D(wp.mul(35.0)).mul(0.4).mul(fine)));
  const c = mix(colour, srgb(66, 67, 70), worn.mul(0.5));
  return vec4(c.mul(float(0.94).add(noise2D(wp.mul(60.0)).mul(0.1).mul(fine))), rough);
});

export function createRoadSurfaceMaterials() {
  const kuv = attribute('kuv', 'vec2');
  const seed = attribute('seed', 'float');
  const wp = positionWorld.xz;
  const make = (fn, { withSeed = false, polygonOffset = 0, side = THREE.DoubleSide, wet = false } = {}) => {
    const out = fn(kuv.x, kuv.y, withSeed ? seed : float(0.25), wp);
    const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0, side });
    mat.colorNode = out.xyz;
    mat.emissiveNode = out.xyz.mul(poolLightAt(positionWorld)); // street-light pools (js/pool-light.js)
    mat.roughnessNode = out.w;
    if (wet) {
      // Keep wet SSR eligibility in material context so reflection passes can use an unnamed color target.
      // The main scene MRT reads this scalar; the material remains dielectric for lighting and reflection optics.
      mat.contextNode = context({
        wetSurfaceReflection: wetReflectionWeightAt(wp)
      });
    }
    if (polygonOffset) {
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = polygonOffset;
      mat.polygonOffsetUnits = polygonOffset;
    }
    return mat;
  };
  const white = paintFn(srgb(232, 232, 226), 0.62);
  const bluePaint = paintFn(srgb(14, 86, 164), 0.74);
  const redPaint = paintFn(srgb(139, 64, 47), 0.78);
  const yellowPaint = paintFn(srgb(194, 164, 73), 0.76);
  const pavement = (fn, options = {}) => make(fn, { withSeed: true, polygonOffset: -1, ...options });
  return {
    // the carriageway: wheel tracks, utility cuts, cracks, potholes & manhole covers; cycle tracks darker and cleaner
    asphalt: createAsphaltMaterial({ tracks: 1, patchRate: 0.3, cracking: 1, manholes: true, potholes: true }),
    cycle: createAsphaltMaterial({ tone: 0.58, patchRate: 0.08, cracking: 0.4 }),
    kerb: make(granite),
    paint: make(white, { polygonOffset: -2 }),
    blue: make(bluePaint, { polygonOffset: -3 }),
    red: make(redPaint, { polygonOffset: -2 }),
    yellow: make(yellowPaint, { polygonOffset: -2 }),
    ground: {
      kbh_fortov: pavement(fortov, { wet: true }),
      raadhus: pavement(raadhus, { wet: true }),
      cobbles: pavement(stoneField(0.14, 0.07, vec3(1.0, 0.97, 0.92)), { wet: true }),
      setts: pavement(stoneField(0.1, 0.05, vec3(1.0)), { wet: true }),
      gravel: pavement(gravel, { wet: true }),
      grass: make(grassGround, { withSeed: true, polygonOffset: -2 }),
      other: pavement(concrete),
      asphalt_road: createAsphaltMaterial({ patchRate: 0.12, cracking: 0.6, polygonOffset: -1 })
    }
  };
}
