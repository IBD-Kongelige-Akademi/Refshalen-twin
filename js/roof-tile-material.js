// js/roof-tile-material.js
// The roofs' colour with clay tile on the pitched tegl roofs. The vertex colour is the roof's measured tone; a tiled roof is marked in its
// `roofMat` attribute (x = roughness + ROOF_TILE_FLAG, y = metalness). The pattern lies in the plane of each roof face: courses run across the
// slope, so it follows every pitch and hip without texture coordinates in the data. Up close: the overlap's shadow under each course, the curve
// across each tile and a tone per tile. Further off it fades to its mean, so distant roofs neither shimmer nor change in brightness.
import { Fn, attribute, cross, dot, float, floor, fract, fwidth, length, mix, normalWorld, normalize, positionWorld, smoothstep, step, vec2, vec3, cos } from 'three/tsl';
import { noise2D } from './surface-materials.js';

export const ROOF_TILE_FLAG = 2; // added to the roughness of a tiled roof (roughness itself is under 1)
const COURSE = 0.3; // m up the slope
const TILE_W = 0.21; // m across it
const PATTERN_MEAN = 0.9; // the mean of the pattern, which distant roofs take

/** The roof's mark: 1 on a tiled roof. */
export const roofTiled = () => step(float(ROOF_TILE_FLAG - 0.5), attribute('roofMat', 'vec2').x);
/** The roof's roughness without the mark. */
export const roofRoughness = () => attribute('roofMat', 'vec2').x.sub(roofTiled().mul(ROOF_TILE_FLAG));

/** The factor on a roof's tone: the tile pattern on a pitched face of a tiled roof, else 1. */
export const roofTileFactor = Fn(() => {
  const wp = positionWorld;
  const n = normalize(normalWorld);
  const slope = normalize(vec3(0, 1, 0).sub(n.mul(n.y)).add(vec3(1e-4, 0, 0)));
  const across = cross(n, slope);
  const s = dot(wp, slope).div(COURSE);
  const u = dot(wp, across).div(TILE_W);
  const row = floor(s);
  const fs = fract(s);
  // the next course up overlaps this one: dark just under its edge, lightening down the tile
  const overlap = mix(float(0.62), float(1.04), smoothstep(0.0, 0.2, float(1).sub(fs)).mul(smoothstep(0.0, 0.5, fs).mul(0.35).add(0.65)));
  const curve = float(0.9).add(cos(fract(u).sub(0.5).mul(6.28318)).mul(0.1));
  const tone = float(0.88).add(noise2D(vec2(floor(u), row).mul(0.73)).mul(0.24));
  const pattern = overlap.mul(curve).mul(tone);
  const blur = length(vec2(fwidth(s), fwidth(u)));
  const near = float(1).sub(smoothstep(0.25, 0.9, blur));
  const pitched = float(1).sub(smoothstep(0.96, 0.995, n.y));
  // from afar a roof keeps a large-scale weathering, as old tile does
  const weather = float(0.94).add(noise2D(vec2(dot(wp, across), dot(wp, slope)).mul(0.12)).mul(0.12));
  return mix(float(1), mix(float(PATTERN_MEAN), pattern, near).mul(weather), roofTiled().mul(pitched));
});
