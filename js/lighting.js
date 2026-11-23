import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  vec3,
  vec4,
  uniform,
  mix,
  dot,
  fog,
  pmremTexture,
  positionWorld,
  cameraPosition,
  length,
  normalize,
  max,
  exp,
  abs,
  select,
  inverseSqrt,
  output,
  renderGroup
} from 'three/tsl';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { SunLight } from 'three/addons/lights/SunLight.js';
import { SunLightNode } from 'three/addons/lights/SunLightNode.js';
import { DepthOnlySunLightNode } from './sun-shadow.js';
import { cityUniforms } from './tsl-materials.js';
import {
  copenhagenLocalDateTimeToUtc,
  solarPosition,
  sunDirection
} from './sun-position.js';

// js/lighting.js
// Physically-Based Atmospheric Sky (Preetham SkyMesh + Beer-Powder Clouds),
// Live PMREMGenerator IBL Cubemap, Three.js r186 SunLight (2-Cascade CSM),
// and Occlusion-Aware Urban Canyon Global Illumination for Three.js r186 WebGPURenderer

const DEFAULT_SCENE_DATE = '2026-10-26';
const CLEAR_MIDDAY_FOG_MAX_LUMINANCE = 0.48;
const CLEAR_MIDDAY_FOG_SKY_ROUGHNESS = 0.72;
const DEFAULT_FOG_MAX_LUMINANCE = 100.0;
const DEFAULT_FOG_SKY_ROUGHNESS = 0.3;
const FOG_LUMINANCE_WEIGHTS = [0.2126, 0.7152, 0.0722];

function fogAttenuation(opticalDepth) {
  return float(1.0).sub(exp(opticalDepth.negate()));
}

function limitFogRadiance(color, maxLuminance) {
  const weights = vec3(...FOG_LUMINANCE_WEIGHTS);
  const luminance = dot(color, weights);
  return color.mul(maxLuminance.div(max(luminance, maxLuminance)));
}

const TIME_PRESETS = {
  golden: {
    id: 'golden',
    name: 'Golden Hour · 16:10',
    localTime: '16:10',
    sunColor: 0xffca92,
    sunIntensity: 5.8,
    hemiSky: 0xa9c0d7,
    hemiGround: 0xc88a62, // Warm terracotta / limestone upward canyon bounce
    hemiIntensity: 1.62,
    skyTop: 0x91a9c1,
    skyHorizon: 0xe0d7ca,
    fogColor: 0xd5cec3,
    fogDensity: 0.00016,
    interiorGlow: 0.48,
    roadWetness: 0,
    envIntensity: 0.54,
    canyonBounce: 0.52,
    turbidity: 6.5,
    rayleigh: 1.9,
    mieCoefficient: 0.006,
    mieDirectionalG: 0.86,
    cloudCoverage: 0.18,
    cloudDensity: 0.28,
    skyExposure: 0.148,
    nightFactor: 0.0
  },
  midday: {
    id: 'midday',
    name: 'Sunny Midday · 12:00',
    localTime: '12:00',
    sunColor: 0xfff5e8,
    sunIntensity: 6.6,
    hemiSky: 0xb1c9dd,
    hemiGround: 0xb89678, // Warm sunlit masonry & pavement bounce
    hemiIntensity: 1.72,
    skyTop: 0x94b0cc,
    skyHorizon: 0xcbd6df,
    fogColor: 0xcbd4dc,
    fogDensity: 0.00013,
    interiorGlow: 0.24,
    roadWetness: 0,
    envIntensity: 0.58,
    canyonBounce: 0.58,
    turbidity: 5.8,
    rayleigh: 1.8,
    mieCoefficient: 0.005,
    mieDirectionalG: 0.84,
    cloudCoverage: 0.16,
    cloudDensity: 0.26,
    skyExposure: 0.142,
    nightFactor: 0.0
  },
  twilight: {
    id: 'twilight',
    name: 'Blue Hour · 17:20',
    localTime: '17:20',
    sunColor: 0x9bb9ee,
    sunIntensity: 3.1,
    hemiSky: 0x718ab4,
    hemiGround: 0x545a68,
    hemiIntensity: 1.22,
    skyTop: 0x172a48,
    skyHorizon: 0x7187a6,
    fogColor: 0x35465f,
    fogDensity: 0.00032,
    interiorGlow: 1.25,
    roadWetness: 0,
    envIntensity: 0.36,
    canyonBounce: 0.32,
    turbidity: 9.5,
    rayleigh: 3.4,
    mieCoefficient: 0.010,
    mieDirectionalG: 0.90,
    cloudCoverage: 0.20,
    cloudDensity: 0.30,
    skyExposure: 0.115,
    nightFactor: 0.52
  },
  midnight: {
    id: 'midnight',
    name: 'Copenhagen Night · 23:00',
    localTime: '23:00',
    sunColor: 0x8cb0e8,
    sunIntensity: 0,
    hemiSky: 0x263a62,
    hemiGround: 0x382e36,
    hemiIntensity: 0.72,
    skyTop: 0x060c1a,
    skyHorizon: 0x182640,
    fogColor: 0x0c1424,
    fogDensity: 0.00036,
    interiorGlow: 1.55,
    roadWetness: 0,
    envIntensity: 0.30,
    canyonBounce: 0.18,
    turbidity: 4.0,
    rayleigh: 1.5,
    mieCoefficient: 0.004,
    mieDirectionalG: 0.80,
    cloudCoverage: 0.22,
    cloudDensity: 0.25,
    skyExposure: 0.022,
    nightFactor: 0.86
  }
};

function parseLightingQuery(search) {
  const query = new URLSearchParams(search || '');
  let date = null;
  let time = null;
  let wetness = null;

  const requestedDate = query.get('date');
  if (requestedDate) {
    try {
      copenhagenLocalDateTimeToUtc(requestedDate, '12:00');
      date = requestedDate;
    } catch { /* Ignore malformed optional query values. */ }
  }

  const requestedTime = query.get('time');
  if (requestedTime) {
    try {
      copenhagenLocalDateTimeToUtc(DEFAULT_SCENE_DATE, requestedTime);
      time = requestedTime;
    } catch { /* Ignore malformed optional query values. */ }
  }

  const requestedWetness = query.get('wet');
  if (requestedWetness !== null && requestedWetness.trim() !== '') {
    const parsedWetness = Number(requestedWetness);
    if (Number.isFinite(parsedWetness)) wetness = THREE.MathUtils.clamp(parsedWetness, 0, 1);
  }

  return {
    date,
    time,
    skyMode: query.get('sky') === 'overcast' ? 'overcast' : 'clear',
    wetness
  };
}

// SkyMesh's turbidity is deprecated (three.js r188) and stays at its default, 2: a preset's turbidity is folded into its
// mieCoefficient instead, which keeps the haze it had (slop-newyork b0af388)
const foldTurbidity = (mieCoefficient, turbidity) => mieCoefficient * turbidity / 2;
// The forward peak of the haze's in-scattering (see createAerialFogNode)
const HAZE_MIE_G = 0.7;

// A lighting state that blends into another (see LightingSystem.presetState, transitionTo): its colours (linear), the sun's
// direction and the amounts
const COLOR_KEYS = ['sunLightColor', 'sunColor', 'hemiSky', 'hemiGround', 'skyTop', 'skyHorizon', 'fogColor'];
const AMOUNT_KEYS = ['sunIntensity', 'hemiIntensity', 'fogDensity', 'cloudCoverage', 'cloudDensity', 'rayleigh', 'mieCoefficient',
  'mieDirectionalG', 'skySaturation', 'nightFactor', 'interiorGlow', 'roadWetness', 'canyonBounce', 'envIntensity',
  'fogMaxLuminance', 'fogSkyRoughness'];

function lightingState() {
  const st = { sun: null, sunDir: new THREE.Vector3(0, 1, 0), skyExposure: 1 };
  for (const k of COLOR_KEYS) st[k] = new THREE.Color();
  for (const k of AMOUNT_KEYS) st[k] = 0;
  return st;
}

function copyState(a, out) {
  out.sun = a.sun;
  out.sunDir.copy(a.sunDir);
  out.skyExposure = a.skyExposure;
  for (const k of COLOR_KEYS) out[k].copy(a[k]);
  for (const k of AMOUNT_KEYS) out[k] = a[k];
  return out;
}

// From unit vector a towards b, along the sky
function slerpDirection(a, b, t, out) {
  const angle = Math.acos(Math.min(1, Math.max(-1, a.dot(b))));
  const s = Math.sin(angle);
  if (s < 1e-4) return out.copy(t < 0.5 ? a : b);
  return out.copy(a).multiplyScalar(Math.sin((1 - t) * angle) / s).addScaledVector(b, Math.sin(t * angle) / s);
}

// t of the way from a to b: colours and amounts linearly, the sun along the sky, the sky's exposure on a log scale
function blendStates(a, b, t, out) {
  for (const k of COLOR_KEYS) out[k].copy(a[k]).lerp(b[k], t);
  for (const k of AMOUNT_KEYS) out[k] = a[k] + (b[k] - a[k]) * t;
  out.skyExposure = a.skyExposure * Math.pow(b.skyExposure / a.skyExposure, t);
  slerpDirection(a.sunDir, b.sunDir, t, out.sunDir);
  out.sun = b.sun; // (the clock and the sun's position report where it is going)
  return out;
}

class LightingSystem {
  constructor(scene, renderer = null) {
    this.scene = scene;
    this.renderer = renderer;
    this.activePresetId = 'golden';
    const search = typeof window === 'undefined' ? '' : window.location.search;
    const overrides = parseLightingQuery(search);
    this.dateOverride = overrides.date;
    this.timeOverride = overrides.time;
    this.skyMode = overrides.skyMode;
    this.wetnessOverride = overrides.wetness;

    // Assign SunLight its node implementation for WebGPURenderer (Light.registerNode since r187; r186 used the library)
    const sunLightNode = renderer && renderer.backend && renderer.backend.isWebGPUBackend
      ? DepthOnlySunLightNode
      : SunLightNode;
    if (SunLight.registerNode) {
      SunLight.registerNode(sunLightNode);
    } else if (renderer && renderer.library) {
      renderer.library.addLight(sunLightNode, SunLight);
    }

    this.scene.fog = new THREE.FogExp2(0xdcc5ae, 0.00024);
    // Leave scene.background = null because SkyMesh renders the 360° sky dome, and setting
    // a THREE.Color on scene.background sets forceClear=true in WebGPURenderer's Background.update,
    // which would otherwise clear Cascade 0 when rendering Cascade 1 in SunShadowNode!
    this.scene.background = null;

    // Physical Preetham SkyMesh + Beer-Powder Clouds (from three/addons/objects/SkyMesh.js). Its unit box must contain
    // the camera wherever it flies over the 1:1 city (it renders at the far plane
    // whatever its size)
    this.sky = new SkyMesh();
    this.sky.scale.setScalar(200000);
    this.sky.rayleigh.value = 2.8;
    this.sky.mieCoefficient.value = 0.008 * 8.0 / 2; // (turbidity 8 folded in, see foldTurbidity)
    this.sky.mieDirectionalG.value = 0.88;
    this.sky.cloudScale.value = 0.00018;
    this.sky.cloudSpeed.value = 0.000015;
    this.sky.cloudCoverage.value = 0.36;
    this.sky.cloudDensity.value = 0.38;
    this.sky.cloudElevation.value = 0.52;

    // Calibrate SkyMesh raw radiance (EE=1000 * 0.04) into standard exposure=1.0 HDR range
    this.uSkyExposure = uniform(0.148);
    this.uNightFactor = uniform(0.0);
    this.uNightSkyColor = uniform(new THREE.Color(0x0b1528));
    this.uSkySaturation = uniform(0.72);
    this.uFogMaxLuminance = uniform(DEFAULT_FOG_MAX_LUMINANCE).setGroup(renderGroup);
    this.uFogSkyRoughness = uniform(DEFAULT_FOG_SKY_ROUGHNESS).setGroup(renderGroup);
    // The direct light the aerial haze scatters toward the eye (see createAerialFogNode, slop-newyork e9a03bd)
    this.uHazeSunDir = uniform(new THREE.Vector3(0, 1, 0)).setGroup(renderGroup);
    this.uHazeSunColor = uniform(new THREE.Color(0x000000)).setGroup(renderGroup);
    // What is shown, and a change of time of day under way (blending `from` into `to`, see transitionTo)
    this.state = lightingState();
    this.from = lightingState();
    this.to = lightingState();
    this.transition = null;
    const rawSkyNode = this.sky.material.colorNode;
    this.sky.material.colorNode = Fn(() => {
      const dayCol = rawSkyNode.rgb.mul(this.uSkyExposure);
      const luminance = dot(dayCol, vec3(0.2126, 0.7152, 0.0722));
      // Mix toward equal-energy grey to pale the physical zenith without changing its luminance.
      const paleDayCol = mix(vec3(luminance), dayCol, this.uSkySaturation);
      const finalSky = mix(paleDayCol, this.uNightSkyColor, this.uNightFactor);
      return vec4(finalSky, float(1.0));
    })();

    this.scene.add(this.sky);

    // Reusable PMREMGenerator & offscreen envScene (mirrors webgpu_generator_city.html)
    this.pmremGenerator = renderer ? new THREE.PMREMGenerator(renderer) : null;
    this.envScene = new THREE.Scene();
    this.envRenderTarget = null;

    // Three.js r186 SunLight with automatic 2-Cascade Shadow Map (SunLightShadow + SunShadowNode)
    // Shines from its position vector toward the origin (no .target needed)
    const initialSun = this.getPresetSun(TIME_PRESETS.golden).direction;
    this.sunLight = new SunLight(0xffca92, 5.8);
    this.sunLight.position.set(initialSun.x, initialSun.y, initialSun.z);
    this.sunLight.castShadow = true;
    // Keep 3072px cascades on devices that can hold the 6144px-wide shadow atlas; use 2048 otherwise.
    // The near cascade spans about 100 m at street level (see update).
    const maxTex = (renderer && renderer.backend && renderer.backend.device && renderer.backend.device.limits.maxTextureDimension2D) || 4096;
    const tile = maxTex >= 6144 ? 3072 : 2048;
    this.sunLight.shadow.mapSize.set(tile, tile);
    this.sunLight.shadow.camera.near = 0.5;
    this.sunLight.shadow.camera.far = 400;
    // Suppress shadow acne along the surface normal in world units
    // so short casters like cars, curbs, tree trunks, and pedestrians keep crisp contact shadows
    this.sunLight.shadow.normalBias = 0.05;
    this.scene.add(this.sunLight);

    // Subtle Hemisphere Sky + Warm Terracotta/Limestone Ground Bounce Fill
    // (Kept intentionally lower than sunLight so urban canyon shadows remain deep and crisp)
    this.hemiLight = new THREE.HemisphereLight(0x9abbe6, 0xc88a62, 1.05);
    this.hemiLight.position.set(0, 300, 0);
    this.scene.add(this.hemiLight);

    this.applyPreset('golden');

    // Sky-matched aerial perspective (replaces the flat FogExp2 colour): distant surfaces fade into a diffuse baked-sky
    // sample just above the horizon through an exponential haze layer, so elevated views stay clearer than the horizon.
    this.uFogDensity = uniform(this.currentFogDensity || TIME_PRESETS.golden.fogDensity).setGroup(renderGroup);
    this.uFogHeight = uniform(900.0).setGroup(renderGroup);
    if (this.envRenderTarget) this.scene.fogNode = this.createAerialFogNode();
  }

  getPresetSun(preset) {
    // Date/time query values override solar geometry; the selected preset still owns the lighting mood.
    const date = this.dateOverride || DEFAULT_SCENE_DATE;
    const time = this.timeOverride || preset.localTime;
    const instant = copenhagenLocalDateTimeToUtc(date, time);
    return {
      instant,
      position: solarPosition(instant),
      direction: sunDirection(instant)
    };
  }

  createAerialFogNode() {
    const toFrag = positionWorld.sub(cameraPosition);
    const dist = length(toFrag);
    const dir = toFrag.div(max(dist, 0.001));
    const horizonDir = normalize(vec3(dir.x, max(dir.y, 0.015), dir.z));
    // A rough PMREM sample suppresses the narrow solar lobe before it enters the haze.
    // Clear midday also gets a scene-linear luminance ceiling; uniform scaling preserves sky hue.
    const skyColor = limitFogRadiance(
      pmremTexture(this.envRenderTarget.texture, horizonDir, this.uFogSkyRoughness).rgb,
      this.uFogMaxLuminance
    );
    // Mean haze density exp(-y / H) along the ray between the fragment and the camera
    const H = this.uFogHeight;
    const ya = max(positionWorld.y, 0.0);
    const yb = max(cameraPosition.y, 0.0);
    const dy = yb.sub(ya);
    const ea = exp(ya.div(H).negate());
    const eb = exp(yb.div(H).negate());
    const meanDensity = select(abs(dy).greaterThan(1.0), ea.sub(eb).mul(H).div(dy), ea);
    const tau = this.uFogDensity.mul(dist).mul(meanDensity);
    const factor = fogAttenuation(tau);
    // Sunlight the haze along the view ray scatters toward the eye, with a forward-peaked Mie phase (Henyey-Greenstein):
    // the air glows down a street that faces a low sun, from a few hundred metres on; further out the sky-coloured fog,
    // which carries the sun's glow already, takes over (slop-newyork e9a03bd / a79eadf)
    const g = HAZE_MIE_G;
    const k = float(1 + g * g).sub(dot(dir, this.uHazeSunDir).mul(2 * g));
    const phase = inverseSqrt(k.mul(k).mul(k)).mul((1 - g * g) / (4 * Math.PI));
    const inscatter = this.uHazeSunColor.mul(phase).mul(float(1.0).sub(exp(tau.negate()))).mul(float(1.0).sub(factor));
    return Fn(() => vec4(mix(output.rgb, skyColor, factor).add(inscatter), output.a))();
  }

  bakeEnvironmentMap() {
    if (!this.pmremGenerator) return;
    // Bake physical SkyMesh (without solar disc) into scene.environment for realistic canyon IBL.
    // Reuses a single RenderTarget so texture identity never changes.
    this.sky.showSunDisc.value = 0;
    this.envScene.add(this.sky);
    this.envRenderTarget = this.pmremGenerator.fromScene(this.envScene, 0, 0.1, 100, {
      renderTarget: this.envRenderTarget
    });
    this.scene.environment = this.envRenderTarget.texture;
    this.sky.showSunDisc.value = 1;
    this.scene.add(this.sky);
  }

  // The lighting state of preset p: its mood, under the sun of the date and time shown, clear or overcast, at the wetness set
  presetState(p, out = lightingState()) {
    const sun = this.getPresetSun(p);
    const overcast = this.skyMode === 'overcast';
    const overcastDaylight = overcast && sun.position.elevation > 0;
    const sunFactor = sun.position.elevation > 0 ? (overcast ? 0.4 : 1) : 0;
    const clearMidday = p.id === 'midday' && !overcast;
    out.sun = sun;
    out.sunDir.set(sun.direction.x, sun.direction.y, sun.direction.z);
    out.sunLightColor.setHex(p.sunColor);
    out.sunIntensity = p.sunIntensity * sunFactor;
    out.sunColor.setHex(p.sunColor).multiplyScalar(sunFactor);
    out.hemiSky.setHex(overcastDaylight ? 0xc4cdd4 : p.hemiSky);
    out.hemiGround.setHex(overcastDaylight ? 0x898b88 : p.hemiGround);
    out.hemiIntensity = overcastDaylight ? Math.max(1.9, p.hemiIntensity * 1.3) : p.hemiIntensity;
    out.skyTop.setHex(overcastDaylight ? 0xaab6bf : p.skyTop);
    out.skyHorizon.setHex(overcastDaylight ? 0xc9ced1 : p.skyHorizon);
    out.fogColor.setHex(overcastDaylight ? 0xc0c7ca : p.fogColor);
    out.fogDensity = overcast ? 0.0004 : p.fogDensity;
    out.cloudCoverage = overcast ? 0.78 : p.cloudCoverage;
    out.cloudDensity = overcast ? 0.6 : p.cloudDensity;
    const turbidity = overcastDaylight ? Math.max(8, p.turbidity) : p.turbidity;
    out.rayleigh = overcastDaylight ? p.rayleigh * 0.75 : p.rayleigh;
    out.mieCoefficient = foldTurbidity(clearMidday ? 0.0035 : p.mieCoefficient, turbidity);
    out.mieDirectionalG = p.mieDirectionalG;
    out.skyExposure = p.skyExposure;
    out.skySaturation = overcastDaylight ? 0.54 : (p.id === 'twilight' ? 0.58 : (p.nightFactor > 0 ? 0.82 : 0.72));
    out.nightFactor = p.nightFactor;
    out.interiorGlow = p.interiorGlow;
    out.roadWetness = this.wetnessOverride ?? (overcast ? 0.35 : p.roadWetness);
    out.canyonBounce = p.canyonBounce;
    out.envIntensity = p.envIntensity * (overcastDaylight ? 1.12 : 1);
    out.fogMaxLuminance = clearMidday ? CLEAR_MIDDAY_FOG_MAX_LUMINANCE : DEFAULT_FOG_MAX_LUMINANCE;
    out.fogSkyRoughness = clearMidday ? CLEAR_MIDDAY_FOG_SKY_ROUGHNESS : DEFAULT_FOG_SKY_ROUGHNESS;
    return out;
  }

  // Show a preset at once
  applyPreset(presetId, force = false) {
    const p = TIME_PRESETS[presetId] || TIME_PRESETS.golden;
    if (!force && this.activePresetId === p.id && !this.transition && this.envRenderTarget !== null) {
      return;
    }
    // (the sky mode or the wetness changed while a change to this preset is under way: it carries on, to the new state)
    if (this.transition && this.activePresetId === p.id) {
      this.presetState(p, this.to);
      return;
    }
    this.activePresetId = p.id;
    this.transition = null;
    this.applyState(this.presetState(p, this.state));
  }

  // Change to a preset over `seconds`, from what is shown now: lights, sky, fog and the city's uniforms ease across
  // (slop-newyork e4de807); the sun moves along the sky
  transitionTo(presetId, seconds = 2) {
    const p = TIME_PRESETS[presetId] || TIME_PRESETS.golden;
    if (!(seconds > 0) || !this.state.sun) { // (nothing shown yet: there is nothing to blend from)
      this.applyPreset(p.id, true);
      return;
    }
    copyState(this.state, this.from);
    this.presetState(p, this.to);
    this.activePresetId = p.id;
    this.transition = { start: performance.now(), seconds, baked: -Infinity };
  }

  applyState(st, bake = true) {
    this.currentSunPosition = st.sun.position;
    this.currentSunDateTime = st.sun.instant;
    this.currentFogDensity = st.fogDensity;
    this.uFogMaxLuminance.value = st.fogMaxLuminance;
    this.uFogSkyRoughness.value = st.fogSkyRoughness;
    // the haze scatters the direct sunlight (none once the sun has set)
    this.uHazeSunDir.value.copy(st.sunDir);
    this.uHazeSunColor.value.copy(st.sunLightColor).multiplyScalar(st.sunIntensity * 0.5);

    this.sunLight.color.copy(st.sunLightColor);
    this.sunLight.intensity = st.sunIntensity;
    this.sunLight.position.copy(st.sunDir);
    this.sunLight.updateMatrixWorld();

    this.hemiLight.color.copy(st.hemiSky);
    this.hemiLight.groundColor.copy(st.hemiGround);
    this.hemiLight.intensity = st.hemiIntensity;

    this.scene.fog.color.copy(st.fogColor);
    this.scene.fog.density = st.fogDensity;
    if (this.uFogDensity) this.uFogDensity.value = st.fogDensity;

    // Update physical Preetham SkyMesh uniforms (its turbidity is folded into mieCoefficient, see foldTurbidity)
    this.sky.rayleigh.value = st.rayleigh;
    this.sky.mieCoefficient.value = st.mieCoefficient;
    this.sky.mieDirectionalG.value = st.mieDirectionalG;
    this.sky.cloudCoverage.value = st.cloudCoverage;
    this.sky.cloudDensity.value = st.cloudDensity;
    this.sky.sunPosition.value.copy(st.sunDir);
    this.uSkyExposure.value = st.skyExposure;
    this.uSkySaturation.value = st.skySaturation;
    this.uNightFactor.value = st.nightFactor;

    cityUniforms.uSunColor.value.copy(st.sunColor);
    cityUniforms.uSkyTopColor.value.copy(st.skyTop);
    cityUniforms.uSkyHorizonColor.value.copy(st.skyHorizon);
    cityUniforms.uSkySunDir.value.copy(st.sunDir);
    cityUniforms.uInteriorGlow.value = st.interiorGlow;
    cityUniforms.uRoadWetness.value = st.roadWetness;
    if (cityUniforms.uCanyonBounce) {
      cityUniforms.uCanyonBounce.value = st.canyonBounce;
    }

    this.scene.environmentIntensity = st.envIntensity;
    if (bake) this.bakeEnvironmentMap();
  }

  setSkyMode(mode) {
    const skyMode = mode === 'overcast' ? 'overcast' : 'clear';
    if (this.skyMode === skyMode) return;
    this.skyMode = skyMode;
    this.applyPreset(this.activePresetId, true);
  }

  update(focusPos) {
    if (this.transition) {
      // eased in and out. Baking the sky's environment map (the fog's colour too) takes a few ms of GPU time: during a change
      // it is baked 15 times a second, and on arrival
      const now = performance.now();
      const t = Math.min(1, (now - this.transition.start) / (this.transition.seconds * 1000));
      const bake = t >= 1 || now - this.transition.baked >= 1000 / 15;
      this.applyState(blendStates(this.from, this.to, t * t * (3 - 2 * t), this.state), bake);
      if (bake) this.transition.baked = now;
      if (t >= 1) this.transition = null;
    }
    // SunLightShadow fits and texel-snaps its 2 cascades to the view camera frustum.
    // A 400 m floor reaches long late-October shadows while keeping the near cascade close to its former span.
    const altitude = focusPos && Number.isFinite(focusPos.y) ? Math.max(0, focusPos.y) : 0;
    this.sunLight.shadow.camera.far = Math.max(400, Math.min(1200, 360 + altitude * 1.8));
  }
}

export { LightingSystem, fogAttenuation, limitFogRadiance };
