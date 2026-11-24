import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, positionView, roughness, vec2, vec4, mix, smoothstep } from 'three/tsl';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { fsr1 } from 'three/addons/tsl/display/FSR1Node.js';
import { ssrReflectionWeight } from './surface-materials.js';
import { createPostProcessing } from './post-processing.js';
import { ClusteredLighting } from 'three/addons/lighting/ClusteredLighting.js';
import { isTypingInField, TELEPORT_LOCATIONS } from './city-config.js';
import { CITY_TELEPORT_LOCATIONS } from './city-teleports.js';
import { buildWorld } from './world.js';
import { rememberBuildingLevel } from './buildings-stream.js';
import { ThirdPersonControllerManager } from './controllers.js';
import { TouchControls } from './touch-controls.js';
import { GamepadControls } from './gamepad-controls.js';
import { HudNav } from './hud-nav.js';
import { padFamily, padHints, applyPadLabels } from './input-hints.js';
import { CameraSystem, CAMERA_PRESETS } from './cameras.js';
import { LightingSystem } from './lighting.js';
import { setupSceneCulling, updateSceneCulling } from './scene-culling.js';
import { CityAudioSystem } from './audio-system.js';
import { nightlife, nightlifeLevel } from './nightlife.js';
import { createNightlifeScene } from './nightlife-scene.js';
import { createPhotoDrawBudget, createPhotoRenderCallback } from './facade-lod.js';
import { OverviewMap } from './overview-map.js';
import { createTour } from './tour.js';
import { createRace, finishSegments } from './race.js';
import { MODE_LABEL, MODE_ICON, formatTime, raceMode } from './race-scores.js';
import { createStartScreen } from './start-screen.js';
import { t, getLang, setLang, onLangChange, translateDocument } from './i18n.js';

// js/main.js
// Main entry point in Three.js WebGPURenderer & TSL (three.js dev, see index.html).
// Boots the Aalborg twin (js/world.js builds the city from the tile index, or data/cph-geodata.json without one).

async function initApp() {
  const query = new URLSearchParams(location.search);
  const aoEnabled = query.get('ao') === '1';
  const container = document.getElementById('canvas-container');
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingStatus = document.getElementById('loading-status');
  const loadingTrack = loadingOverlay ? loadingOverlay.querySelector('.loader-track') : null;
  const loadingFill = document.getElementById('loading-progress');
  // The loading bar sweeps while the city is being built (the main thread is busy) and fills as the shaders compile
  const setLoadingProgress = (p) => {
    if (!loadingFill) return;
    if (loadingTrack) loadingTrack.classList.remove('is-indeterminate');
    loadingFill.style.transform = `scaleX(${Math.min(1, Math.max(0, p))})`;
  };

  // English or Danish (js/i18n.js): the page's static text first, so the loading screen is in the chosen language too
  translateDocument(document);
  if (loadingStatus) {
    loadingStatus.textContent = t('Initializing Three.js r{rev} WebGPURenderer & TSL Shaders...', { rev: THREE.REVISION });
  }

  // 1. Initialize Three.js WebGPURenderer with 32-bit float reversedDepthBuffer. Firefox stalls on multisampled floating-point
  // MRT render targets, so MSAA is off there (slop-newyork c8a904d)
  const isFirefox = typeof navigator !== 'undefined' && /Firefox\//.test(navigator.userAgent);
  const renderer = new THREE.WebGPURenderer({
    antialias: !isFirefox, // (at the scene's 3/4 resolution, see RENDER_SCALE)
    powerPreference: 'high-performance',
    reversedDepthBuffer: true
  });
  renderer.setPixelRatio(1.0);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.lighting = new ClusteredLighting(256, 32, 28, 48);
  container.appendChild(renderer.domElement);

  // Start-up phase timings (logged once as "[init] ...") to keep load-time regressions traceable
  let initTimings = [];
  let initMark = performance.now();
  const markInit = (label) => {
    const now = performance.now();
    initTimings.push(`${label} ${Math.round(now - initMark)}ms`);
    initMark = now;
  };

  await renderer.init();
  // WebGPU only: on the WebGL2 fallback the city runs at a fraction of the frame rate and its people, whose poses are read from
  // a storage buffer, are not drawn (slop-newyork 7970ce9)
  if (!renderer.backend.isWebGPUBackend) {
    renderer.dispose();
    renderer.domElement.remove();
    if (loadingFill) loadingFill.parentElement.style.visibility = 'hidden';
    if (loadingStatus) loadingStatus.textContent = t('Aalborg Twin needs WebGPU, which this browser does not have. Try a recent Chrome, Edge or Safari.');
    return;
  }
  markInit('renderer');

  // 2. Build Scene & Physical Atmospheric Sky / PMREM IBL / 4096x4096 Shadow Lighting
  const scene = new THREE.Scene();
  const lightingSystem = new LightingSystem(scene, renderer);
  markInit('lighting');

  if (loadingStatus) {
    loadingStatus.textContent = t('Constructing Aalborg...');
  }

  // 3. Build the city from the Copenhagen geodata
  // Tile streaming: `?stream=<near radius in m>` overrides the default rings (near 750 m, mid 1250 m, js/tile-rings.js); the city
  // streams in around the start point: every visit begins at the Kortdage venue (TELEPORT_LOCATIONS.akkc), so a reload at the
  // conference stand puts the next visitor back in front of it
  const streamParam = Number(query.get('stream'));
  const streamMid = Number(query.get('streammid')); // optional override for a custom near ring
  const startPoint = TELEPORT_LOCATIONS.akkc;
  const start = { x: startPoint.x, z: startPoint.z };
  const world = await buildWorld(scene, {
    treeDate: lightingSystem.currentSunDateTime,
    markInit,
    debug: new URLSearchParams(location.search).get('debug') || '',
    water: new URLSearchParams(location.search).get('water') || '',
    tilesUrl: query.get('tiles') || null, // ?tiles=<url of a tile index directory> (default ./data/tiles)
    stream: Number.isFinite(streamParam) && streamParam > 0 ? { near: streamParam, ...(streamMid > streamParam ? { mid: streamMid } : {}) } : null,
    start
  });
  const { trafficSystem } = world;
  const allColliders = world.staticIndex ? [] : world.colliders; // a streamed city's colliders come and go: the controllers query world.staticIndex

  // 4. Initialize Third-Person Controllers (Person, Car, both Bikes, Drone) & Multi-Camera System
  const controllerManager = new ThirdPersonControllerManager(scene, allColliders);
  // People knocked down land on the same ground as the player and bounce off the same buildings & street furniture
  trafficSystem.setWorld?.({
    ground: (x, z) => controllerManager.getGroundHeight(x, z, 'person'),
    colliders: (x, z, r) => controllerManager.nearColliders(x, z, r),
    contact: (c, x, y, z, r, out) => controllerManager.sphereContact(c, x, y, z, r, out)
  });
  controllerManager.groundField = world.groundHeight || null;
  controllerManager.roofHeightAt = world.roofHeightAt || null;
  if (world.staticIndex) controllerManager.staticIndex = world.staticIndex; // streamed city: per-tile colliders
  // Every visit starts at rest at the venue; only the last mode used is remembered. The active mode is placed first, on the start
  // point itself; the others find clear spots around it and stay visible until the boot warm-up has compiled their shaders
  // (then controllerManager.showActiveOnly() hides them, and a mode switch carries the player over, see selectMode).
  let startMode = 'car';
  try {
    const saved = JSON.parse(localStorage.getItem('cph-player-state'));
    if (saved?.version === 1 && Object.hasOwn(controllerManager.entities, saved.activeMode)) startMode = saved.activeMode;
  } catch { /* Missing or unavailable storage does not prevent playing. */ }
  for (const mode of [startMode, ...Object.keys(controllerManager.entities).filter((m) => m !== startMode)]) {
    controllerManager.setMode(mode);
    controllerManager.teleportActiveTo(startPoint.x, startPoint.z, startPoint.heading);
  }
  controllerManager.setMode(startMode);

  function savePlayerState() {
    try {
      const entities = Object.fromEntries(Object.entries(controllerManager.entities).map(([mode, entity]) => [mode, {
        x: entity.position.x, y: entity.position.y, z: entity.position.z, heading: entity.heading
      }]));
      localStorage.setItem('cph-player-state', JSON.stringify({ version: 1, activeMode: controllerManager.activeMode, entities }));
    } catch { /* Storage may be disabled or full. */ }
  }

  const cameraSystem = new CameraSystem(renderer.domElement, controllerManager);
  world.attach?.({ camera: cameraSystem.camera, domElement: renderer.domElement, controllerManager });
  const touchControls = new TouchControls(controllerManager);
  touchControls.translate = t;
  const soundButton = document.getElementById('btn-sound');
  const audioSystem = new CityAudioSystem({ controllerManager, trafficSystem, audioSignals: world.audioSignals }, {
    onStateChange: updateSoundButton
  });
  function updateSoundButton() {
    if (!soundButton) return;
    soundButton.disabled = !audioSystem.supported;
    soundButton.setAttribute('aria-pressed', String(audioSystem.enabled));
    soundButton.setAttribute('aria-label', t(audioSystem.enabled ? 'Mute sound' : 'Enable sound'));
    soundButton.title = t(audioSystem.supported ? (audioSystem.enabled ? 'Mute sound [N]' : 'Enable sound [N]') : 'Web Audio is unavailable');
    soundButton.querySelector('use').setAttribute('href', audioSystem.enabled ? '#i-sound' : '#i-sound-off');
  }
  soundButton?.addEventListener('click', () => audioSystem.setEnabled(!audioSystem.enabled));
  updateSoundButton();
  // pagehide also covers navigation away on mobile; preserve the context across back-forward cache restores.
  window.addEventListener('pagehide', (event) => {
    savePlayerState();
    if (!event.persisted) audioSystem.dispose();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) savePlayerState(); });
  markInit('controllers');

  // Island-wide static geometry: chunk & distance-cull the small props, shadow stand-ins for the big casters
  // (scene-culling.js)
  const cullingRoots = world.cullingRoots
    .map((name) => scene.getObjectByName(name))
    .filter(Boolean);
  setupSceneCulling(scene, cullingRoots, lightingSystem.sunLight.shadow);
  markInit('culling');

  // (three.js binds InstancedMesh matrices as instanced vertex attributes that upload only when flagged, so they are no longer
  // swapped for storage buffers: slop-newyork 21f71bd)

  // 5. TSL RenderPipeline with FSR 1 upscaling, Half-Res Screen Space Reflections (SSRNode), Bloom & Filmic Toning
  //    Fade out distant and matte surfaces so SSR spends its rays on visible glossy reflections.
  const scenePass = pass(scene, cameraSystem.camera);
  // The multisampled colour attachments (output, normal, metalRough) only need resolving, never storing: discarding
  // them spares the GPU writing 3 x 4 samples per pixel to memory every frame (transient, memoryless attachments where
  // the browser supports them). The multisampled depth stays stored: SSR reads it.
  scenePass.renderTarget.storeMultisampledColorBuffer = false;
  const ssrFade = smoothstep(360.0, 180.0, positionView.z.negate());
  const maxSSRRoughness = 0.75;
  const sceneMRT = mrt({
    output: output,
    normal: normalView,
    metalRough: vec2(roughness.lessThan(maxSSRRoughness).select(ssrReflectionWeight().mul(ssrFade), 0), roughness)
  });
  sceneMRT.setBlendMode('normal', new THREE.BlendMode(THREE.MaterialBlending));
  sceneMRT.setBlendMode('metalRough', new THREE.BlendMode(THREE.MaterialBlending));
  scenePass.setMRT(sceneMRT);
  // The scene renders at 3/4 of the resolution (with MSAA) and FidelityFX Super Resolution 1 reconstructs the full
  // resolution, which cuts the GPU frame time by about a third (slop-newyork ce6de00); `?scale=1` renders it in full
  const scaleParam = Number(query.get('scale'));
  const RENDER_SCALE = scaleParam >= 0.5 && scaleParam <= 1 ? scaleParam : 0.75;
  scenePass.setResolutionScale(RENDER_SCALE);

  const scenePassColor = scenePass.getTextureNode('output');
  const scenePassDepth = scenePass.getTextureNode('depth');
  const scenePassNormal = scenePass.getTextureNode('normal');
  const scenePassMetalRough = scenePass.getTextureNode('metalRough');

  let aoPass = null;
  let postColor = scenePassColor;
  if (aoEnabled) {
    const { ao } = await import('three/addons/tsl/display/GTAONode.js');
    aoPass = ao(scenePassDepth, scenePassNormal, cameraSystem.camera);
    aoPass.radius.value = 0.25;
    aoPass.samples.value = 16;
    aoPass.resolutionScale = 0.5 * RENDER_SCALE; // half of the scene's resolution: no sharper at more, and the cost doubles
    const aoOutput = aoPass.getTextureNode().r;
    postColor = vec4(scenePassColor.rgb.mul(mix(1, aoOutput, 0.6)), scenePassColor.a);
  }

  const ssrPass = ssr(scenePassColor, scenePassDepth, scenePassNormal, {
    metalnessNode: scenePassMetalRough.r,
    roughnessNode: scenePassMetalRough.g,
    camera: cameraSystem.camera
  });
  ssrPass.resolutionScale = 0.5;
  ssrPass.blurQuality = 1;
  ssrPass.maxDistance.value = 42;
  ssrPass.thickness.value = 0.85;
  // Fewer coarse steps, then refine detected hits to keep reflection edges precise.
  ssrPass.quality.value = 0.25;
  ssrPass.binaryRefine = true;
  ssrPass.intensity.value = 0.50;
  ssrPass.screenEdgeFadeBlack = true;

  // Roughness mip blur must not spread reflections back onto matte or nonreflective surfaces.
  const reflectionMask = scenePassMetalRough.r.greaterThan(0).select(smoothstep(maxSSRRoughness, 0.55, scenePassMetalRough.g), 0);
  const reflections = ssrPass.mul(reflectionMask);
  const upscaled = RENDER_SCALE < 1 ? fsr1(postColor).getTextureNode() : postColor;
  const colorGrade = createPostProcessing(renderer, upscaled, reflections);
  const renderPipeline = new THREE.RenderPipeline(renderer, colorGrade.outputNode);

  // 6. Wire UI Controls (Strictly using safe DOM APIs: textContent, classList, addEventListener)
  const modeButtons = document.querySelectorAll('[data-mode]');
  const cameraButtons = document.querySelectorAll('[data-camera]');
  const timeButtons = document.querySelectorAll('[data-time]');
  const teleportButtons = document.querySelectorAll('[data-teleport]');
  const hudToggleBtn = document.getElementById('btn-toggle-hud');
  const modeSwitch = document.getElementById('mode-switch');
  const bikeTypeSwitch = document.getElementById('bike-type-switch');
  const bikeTypeButtons = bikeTypeSwitch ? [...bikeTypeSwitch.querySelectorAll('[data-bike-type]')] : [];
  let lastBikeMode = controllerManager.activeMode === 'cargobike' ? 'cargobike' : 'cyclist';
  const walkTypeSwitch = document.getElementById('walk-type-switch');
  const walkTypeButtons = walkTypeSwitch ? [...walkTypeSwitch.querySelectorAll('[data-walk-type]')] : [];
  touchControls.onAvailabilityChange = placeModeIndicator;

  const elFps = document.getElementById('hud-fps');
  const elMode = document.getElementById('hud-active-mode');
  const elCamera = document.getElementById('hud-active-camera');
  const elSpeed = document.getElementById('hud-speed');
  const elSpeedMeter = document.getElementById('hud-speed-meter');
  const elAltitude = document.getElementById('hud-altitude');
  const elLocation = document.getElementById('hud-location');
  const elControlsHint = document.getElementById('hud-controls-hint');
  // The gamepad's D-pad walks the HUD's buttons (time of day and the other dropdowns, modes, walker / bike type, cameras)
  const hudNav = new HudNav();
  const gamepadControls = new GamepadControls(controllerManager, cameraSystem, {
    onCycleMode: (step) => {
      const modes = ['person', 'car', 'cyclist', 'drone', 'bus'];
      const activeMode = controllerManager.activeMode === 'cargobike' ? 'cyclist' : controllerManager.activeMode;
      const nextMode = modes[(modes.indexOf(activeMode) + step + modes.length) % modes.length];
      selectMode(nextMode === 'cyclist' ? lastBikeMode : nextMode);
    },
    // Y: the next walker (Walk) or bike type (Cycle), as a click on the next button of the switch above the mode bar
    onCycleSubtype: () => {
      const mode = controllerManager.activeMode;
      const list = mode === 'person' ? walkTypeButtons : mode === 'cyclist' || mode === 'cargobike' ? bikeTypeButtons : [];
      if (!list.length) return;
      const i = list.findIndex((btn) => btn.classList.contains('active'));
      list[(i + 1) % list.length].click();
    },
    onToggleMap: () => mapSystem.toggleFullMap(!mapSystem.isFullMapOpen),
    onCloseMap: () => mapSystem.toggleFullMap(false),
    onMapInput: (panX, panY, zoom, dt) => mapSystem.gamepadInput(panX, panY, zoom, dt),
    onMapTeleport: () => mapSystem.teleportToCenter(),
    onMapWaypoint: () => mapSystem.waypointAtCenter(),
    onHorn: () => audioSystem.honk(controllerManager.getActiveEntity()),
    onToggleHud: () => hudToggleBtn?.click(),
    onToggleSound: () => audioSystem.setEnabled(!audioSystem.enabled),
    onNav: (dir) => hudNav.move(dir),
    navActive: () => hudNav.active,
    onNavPress: () => hudNav.press(),
    onNavBack: () => hudNav.back(),
    // the building in the middle of the screen (the chase camera looks over the player at it)
    onInspect: () => world.buildings?.toggleInfoAt?.(0, 0),
    // the Kortdage tour (js/tour.js): any press counts as activity, A / B / D-pad step through a guided tour
    onActivity: () => tour?.noteInput(),
    onTour: (cmd) => tour?.command(cmd),
    // the start screen (js/start-screen.js) takes every press while it is up
    startActive: () => Boolean(startScreen?.isOpen),
    onStartPad: (button) => startScreen?.handlePad(button)
  });
  // Collisions rumble the gamepad when the player's own vehicle is hit (the sound system hears every collision first)
  for (const system of [controllerManager, trafficSystem]) {
    system.setCollisionListener?.((impact) => {
      audioSystem.onCollision?.(impact);
      const player = controllerManager.getActiveEntity();
      if (impact.a === player || impact.b === player) gamepadControls.rumbleImpact(impact.speed, impact.kind);
    });
  }
  let tour = null; // created once the map and the building levels exist (below)
  let startScreen = null; // the start screen (js/start-screen.js), created after the race
  let race = null; // the Kortdage race (js/race.js), created after the tour

  // Keyboard guide for each mode: [keys, action]
  const controlHints = {
    person: [[['W', 'S'], 'Walk'], [['A', 'D'], 'Turn'], [['Shift'], 'Sprint'], [['Space'], 'Jump'], [['Drag'], 'Orbit']],
    car: [[['W', 'S'], 'Drive / Reverse'], [['A', 'D'], 'Steer'], [['B'], 'Horn'], [['Drag'], 'Orbit']],
    skate: [[['W', 'S'], 'Push / Brake'], [['A', 'D'], 'Lean & Turn'], [['Shift'], 'Push hard'], [['Space'], 'Jump'], [['Drag'], 'Orbit']],
    cyclist: [[['W', 'S'], 'Pedal / Brake'], [['A', 'D'], 'Lean & Turn'], [['Shift'], 'Sprint'], [['Drag'], 'Orbit']],
    drone: [[['W', 'S'], 'Fly'], [['A', 'D'], 'Yaw'], [['Space', 'E'], 'Climb / Take off'], [['Q', 'C'], 'Descend / Land'], [['Shift'], 'Sport']],
    bus: [[['W', 'S'], 'Drive / Brake'], [['A', 'D'], 'Steer'], [['Stop'], 'Doors open'], [['B'], 'Horn'], [['Drag'], 'Orbit']]
  };
  // Top speeds in km/h set the full scale of the speed meter for each active vehicle.
  const topSpeedKmh = { person: 30, car: 130, cyclist: 25, cargobike: 25, drone: 75, bus: 70 };

  // While a gamepad is connected the hints name its buttons instead of keys (js/input-hints.js): its family ('xbox' /
  // 'playstation'), or null for the keyboard
  let padHintFamily = null;
  let hintMode = null;
  function renderControlHints(mode) {
    hintMode = mode;
    if (!elControlsHint) return;
    const entries = padHintFamily ? padHints(mode, padHintFamily) : controlHints[mode] || [];
    const items = entries.map(([keys, action]) => {
      const item = document.createElement('span');
      item.className = 'hint';
      for (const key of keys) {
        const kbd = document.createElement('kbd');
        if (padHintFamily) kbd.className = 'pad-key';
        kbd.textContent = padHintFamily ? key : t(key);
        item.appendChild(kbd);
      }
      const label = document.createElement('span');
      label.className = 'hint-label';
      label.textContent = t(action);
      item.appendChild(label);
      return item;
    });
    elControlsHint.replaceChildren(...items);
  }

  // The accent-coloured pill under the selected mode glides from button to button
  function placeModeIndicator() {
    const active = modeSwitch ? modeSwitch.querySelector('.mode-btn.active') : null;
    if (!active) return;
    modeSwitch.style.setProperty('--ind-x', `${active.offsetLeft}px`);
    modeSwitch.style.setProperty('--ind-w', `${active.offsetWidth}px`);
  }

  // The new mode takes over where the old one was, facing the same way, so switching keeps the viewpoint: the drone takes off
  // just above it, and leaving the drone lands on the ground under it (teleport placement finds the nearest clear spot).
  function carryPlayer(from, fromMode) {
    const air = controllerManager.activeMode === 'drone';
    const altitude = air && fromMode !== 'drone' ? from.position.y + 3 : from.position.y;
    controllerManager.teleportActiveTo(from.position.x, from.position.z, from.heading, altitude);
  }

  function selectMode(mode, options = {}) {
    if (race?.blocking && !options.force) return; // the race keeps the vehicle it started with
    if (mode === 'cyclist' && lastBikeMode === 'cargobike') mode = lastBikeMode;
    const fromMode = controllerManager.activeMode;
    const from = controllerManager.getActiveEntity();
    controllerManager.setMode(mode);
    const activeMode = controllerManager.activeMode;
    if (activeMode !== fromMode && from) carryPlayer(from, fromMode);
    const bikeActive = activeMode === 'cyclist' || activeMode === 'cargobike';
    if (bikeActive) lastBikeMode = activeMode;
    const primaryMode = activeMode === 'cargobike' ? 'cyclist' : activeMode;
    touchControls.setMode(activeMode);
    gamepadControls.reset();
    modeButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === primaryMode);
    });
    if (bikeTypeSwitch) bikeTypeSwitch.hidden = !bikeActive;
    const walker = controllerManager.entities.person.avatar;
    if (walkTypeSwitch) walkTypeSwitch.hidden = activeMode !== 'person';
    walkTypeButtons.forEach((btn) => {
      const selected = btn.getAttribute('data-walk-type') === walker;
      btn.classList.toggle('active', selected);
      btn.setAttribute('aria-pressed', String(selected));
    });
    bikeTypeButtons.forEach((btn) => {
      const selected = btn.getAttribute('data-bike-type') === activeMode;
      btn.classList.toggle('active', selected);
      btn.setAttribute('aria-pressed', String(selected));
    });
    document.body.dataset.mode = primaryMode;
    placeModeIndicator();
    const ent = controllerManager.getActiveEntity();
    if (elMode) elMode.textContent = t(ent.label);
    const skating = activeMode === 'person' && (walker === 'skater' || walker === 'skateboarder');
    renderControlHints(skating ? 'skate' : primaryMode);

    // If currently on a static scenic camera, switch to 3rd-Person Chase so user sees their selected character/vehicle
    const currentCam = cameraSystem.getActivePreset();
    if (currentCam.category !== 'follow') {
      selectCamera('chase', false);
    }
  }

  function selectCamera(camId, snap = false) {
    cameraSystem.setCameraPreset(camId, snap);
    cameraButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-camera') === camId);
    });
    const preset = cameraSystem.getActivePreset();
    if (elCamera) elCamera.textContent = t(preset.name);
  }

  // Steps through CAMERA_PRESETS (V / Shift+V, and the arrows either side of the camera name)
  function cycleCamera(step) {
    const n = CAMERA_PRESETS.length;
    const idx = CAMERA_PRESETS.findIndex((p) => p.id === cameraSystem.activePresetId);
    selectCamera(CAMERA_PRESETS[(idx + step + n) % n].id, true);
  }

  // The toolbar's Time button shows the chosen preset's icon and name; its dropdown marks it
  const timeIcon = document.getElementById('time-current-icon');
  const timeLabel = document.getElementById('time-current-label');
  const timeMenuBtn = document.getElementById('btn-time');
  // Changes of time of day blend over a couple of seconds (`instant` for the first one: slop-newyork e4de807)
  const TIME_TRANSITION = 2;
  function selectTime(timeId, instant = false) {
    if (instant) {
      lightingSystem.applyPreset(timeId);
      colorGrade.applyPreset(lightingSystem.activePresetId);
    } else if (timeId !== lightingSystem.activePresetId) {
      lightingSystem.transitionTo(timeId, TIME_TRANSITION);
      colorGrade.transitionTo(lightingSystem.activePresetId, TIME_TRANSITION);
    }
    markTime(timeId);
  }
  function markTime(timeId) {
    timeButtons.forEach((btn) => {
      const selected = btn.getAttribute('data-time') === timeId;
      btn.classList.toggle('active', selected);
      btn.setAttribute('aria-pressed', String(selected));
      if (!selected) return;
      const name = btn.querySelector('.pop-name')?.textContent || timeId;
      if (timeIcon) timeIcon.setAttribute('href', `#${btn.dataset.icon}`);
      if (timeLabel) timeLabel.textContent = name;
      if (timeMenuBtn) timeMenuBtn.title = `${t('Time of day')}: ${name}`;
    });
  }

  // Popovers (native [popover]: light dismiss & Esc for free) open against the control that toggles them: data-anchor
  // names the element they sit above / below, data-align the one whose right edge they line up with
  const popovers = document.querySelectorAll('.popover[popover]');
  const supportsPopover = typeof HTMLElement.prototype.togglePopover === 'function';
  function closePopovers() {
    if (!supportsPopover) return;
    popovers.forEach((pop) => {
      if (pop.matches(':popover-open')) pop.hidePopover();
    });
  }
  popovers.forEach((pop) => {
    const invoker = document.querySelector(`[popovertarget="${pop.id}"]`);
    pop.addEventListener('beforetoggle', (e) => {
      const open = e.newState === 'open';
      if (invoker) invoker.classList.toggle('is-open', open);
      if (!open) return;
      const anchor = document.getElementById(pop.dataset.anchor) || invoker;
      const align = document.getElementById(pop.dataset.align) || invoker;
      if (!anchor || !align) return;
      const r = anchor.getBoundingClientRect();
      const spaceAbove = Math.max(0, r.top - 20);
      const spaceBelow = Math.max(0, window.innerHeight - r.bottom - 20);
      let above = pop.dataset.side === 'above';
      // The camera control moves to the top on touch screens; open toward the available space.
      if ((above ? spaceAbove : spaceBelow) < 160) above = spaceAbove > spaceBelow;
      pop.style.right = `${Math.max(8, window.innerWidth - align.getBoundingClientRect().right)}px`;
      if (above) {
        pop.style.top = 'auto';
        pop.style.bottom = `${window.innerHeight - r.top + 8}px`;
        pop.style.maxHeight = `${spaceAbove}px`;
      } else {
        pop.style.bottom = 'auto';
        pop.style.top = `${r.bottom + 8}px`;
        pop.style.maxHeight = `${spaceBelow}px`;
      }
    });
  });

  modeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      selectMode(btn.getAttribute('data-mode'));
    });
  });

  walkTypeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      controllerManager.setPersonAvatar(btn.getAttribute('data-walk-type'));
      selectMode('person');
    });
  });

  bikeTypeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      lastBikeMode = btn.getAttribute('data-bike-type');
      selectMode(lastBikeMode);
    });
  });

  cameraButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      selectCamera(btn.getAttribute('data-camera'), true);
      closePopovers();
    });
  });

  const camPrevBtn = document.getElementById('cam-prev');
  const camNextBtn = document.getElementById('cam-next');
  if (camPrevBtn) camPrevBtn.addEventListener('click', () => cycleCamera(-1));
  if (camNextBtn) camNextBtn.addEventListener('click', () => cycleCamera(1));

  timeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      selectTime(btn.getAttribute('data-time'));
      closePopovers();
    });
  });

  // A mouse click mustn't leave the focus on a HUD button, or Space (jump / ascend) and Enter would press it again
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button') : null;
    if (btn && e.detail > 0) btn.blur();
  });

  // Where you are: the street's name, drawn as a street-name sign
  let locationText = '';
  function renderLocation(label) {
    if (!elLocation || label === locationText) return;
    locationText = label;
    let place = '';
    let streets = label;
    const split = label.indexOf(' · ');
    if (split >= 0) {
      place = label.slice(0, split);
      streets = label.slice(split + 3);
    } else {
      place = label;
      streets = '';
    }
    const nodes = [];
    if (place) {
      const el = document.createElement('div');
      el.className = 'location-place';
      el.textContent = place;
      nodes.push(el);
    }
    if (streets) {
      const row = document.createElement('div');
      row.className = 'location-signs';
      if (streets.startsWith('near ')) {
        streets = streets.slice(5);
        const near = document.createElement('span');
        near.className = 'location-near';
        near.textContent = t('near');
        row.appendChild(near);
      }
      for (const name of streets.split(' & ')) {
        const sign = document.createElement('span');
        sign.className = 'street-sign';
        sign.textContent = name;
        row.appendChild(sign);
      }
      nodes.push(row);
    }
    elLocation.replaceChildren(...nodes);
  }

  function teleportTo(x, z, heading = Math.PI) {
    const destination = controllerManager.teleportActiveTo(x, z, heading);
    touchControls.reset();
    gamepadControls.reset();
    cameraSystem.resetForTeleport();
    selectCamera('chase', true);
    return destination;
  }

  // The district presets are always there; the citywide ones (js/city-teleports.js, positions on the citywide road graph) only where the
  // tile index covers them (world.tileExists), so a district-only build does not offer places it does not have.
  const presetFor = (key) => TELEPORT_LOCATIONS[key] || (CITY_TELEPORT_LOCATIONS[key] && world.tileExists?.(CITY_TELEPORT_LOCATIONS[key].x, CITY_TELEPORT_LOCATIONS[key].z) ? CITY_TELEPORT_LOCATIONS[key] : null);
  teleportButtons.forEach((btn) => {
    // Hide the buttons that have no location
    btn.hidden = !presetFor(btn.getAttribute('data-teleport'));
    btn.addEventListener('click', () => {
      const loc = presetFor(btn.getAttribute('data-teleport'));
      if (loc && !race?.blocking) {
        teleportTo(loc.x, loc.z, loc.heading);
      }
      closePopovers();
    });
  });
  const cityTitle = document.getElementById('tp-city-title');
  if (cityTitle) cityTitle.hidden = !Object.keys(CITY_TELEPORT_LOCATIONS).some((k) => presetFor(k));

  function updateHudToggle() {
    if (!hudToggleBtn) return;
    const isMin = document.body.classList.contains('hud-minimized');
    hudToggleBtn.setAttribute('aria-pressed', String(isMin));
    hudToggleBtn.setAttribute('aria-label', t(isMin ? 'Show HUD' : 'Hide HUD'));
    hudToggleBtn.title = t(isMin ? 'Show the HUD [H]' : 'Clean view: hide the HUD [H]');
  }
  if (hudToggleBtn) {
    hudToggleBtn.addEventListener('click', () => {
      document.body.classList.toggle('hud-minimized');
      updateHudToggle();
      if (document.body.classList.contains('hud-minimized')) closePopovers();
    });
  }

  // Radar minimap & full map ([M], js/overview-map.js): streets from the road graph at once, the ground (data/city/map.json) when it arrives
  const mapSystem = new OverviewMap({
    controllerManager,
    cameraSystem,
    trafficSystem,
    roadGraph: world.geo?.roadGraph || null,
    places: TELEPORT_LOCATIONS,
    locate: world.locationLabel,
    translate: t,
    onToggle: (open) => {
      controllerManager.resetInput();
      touchControls.setEnabled(!open);
      gamepadControls.setEnabled(!open);
      if (open) hudNav.hide();
      const mapHint = document.getElementById('fullmap-hover-info');
      if (open && touchControls.available && mapHint) mapHint.textContent = t('Tap to teleport · Drag to pan · Use + / − to zoom');
    },
    onTeleport: (x, z) => { if (!race?.blocking) teleportTo(x, z); }
  });
  world.fetchCityJson?.('map.json').then((doc) => mapSystem.setData(doc)).catch((e) => console.info('[map] no data/city/map.json:', e?.message || e));
  // line 2's route for the AI Plusbuses (tools/geodata/bus_lines.py)
  world.fetchCityJson?.('bus-lines.json').then((doc) => trafficSystem.setBusLines?.(doc)).catch((e) => console.info('[traffic] no data/city/bus-lines.json:', e?.message || e));
  // the bars, pubs and nightclubs (tools/geodata/nightlife.py): neon, coloured spill and beats after dark (js/nightlife*.js)
  const nightlifeScene = createNightlifeScene(scene, nightlife, { groundHeight: world.groundHeight, furniture: world.furniture });
  world.fetchCityJson?.('nightlife.json').then((doc) => nightlife.setVenues(doc.venues)).catch((e) => console.info('[nightlife] no data/city/nightlife.json:', e?.message || e));
  // Building model level (js/buildings-stream.js setLevel): plain LoD2 -> + Skraafoto photos -> + generated windows / doors -> + hero buildings
  const levelButtons = [...document.querySelectorAll('[data-building-level]')];
  const levelStatus = document.getElementById('bl-status');
  const buildingLayer = world.buildings?.setLevel ? world.buildings : null;
  const levelIds = levelButtons.map((btn) => btn.getAttribute('data-building-level'));
  let levelRun = 0;
  function showBuildingLevel(level) {
    levelButtons.forEach((btn) => {
      const selected = btn.getAttribute('data-building-level') === level;
      btn.classList.toggle('active', selected);
      btn.setAttribute('aria-pressed', String(selected));
    });
  }
  function selectBuildingLevel(level) {
    if (!buildingLayer || level === buildingLayer.level) return;
    showBuildingLevel(level);
    rememberBuildingLevel(level);
    const run = ++levelRun;
    if (levelStatus) levelStatus.textContent = t('Rebuilding the buildings…');
    buildingLayer.setLevel(level).finally(() => {
      if (run === levelRun && levelStatus) levelStatus.textContent = '';
    });
  }
  if (buildingLayer) {
    showBuildingLevel(buildingLayer.level);
    levelButtons.forEach((btn) => btn.addEventListener('click', () => selectBuildingLevel(btn.getAttribute('data-building-level'))));
  } else {
    document.getElementById('btn-buildings')?.setAttribute('hidden', '');
  }

  const openMapBtn = document.getElementById('btn-open-map');
  if (openMapBtn) openMapBtn.addEventListener('click', () => mapSystem.toggleFullMap(true));

  // The next (step 1) or previous (-1) building model level, wrapping around: [L] / [Shift+L]
  function cycleBuildingLevel(step) {
    if (!buildingLayer || !levelIds.length) return;
    const i = levelIds.indexOf(buildingLayer.level);
    selectBuildingLevel(levelIds[(i + step + levelIds.length) % levelIds.length]);
  }

  // The Kortdage tour (js/tour.js, js/tour-script.js, docs/tour.md): guided express / full tours, the drive tour on the GPS,
  // and the attract loop that starts after `?idle=` seconds (default 60, 0 = off) without input
  const tourCard = document.getElementById('tour-card');
  const tourFade = document.getElementById('tour-fade');
  const tourEls = tourCard ? {
    counter: tourCard.querySelector('.tour-counter'),
    title: tourCard.querySelector('.tour-title'),
    sub: tourCard.querySelector('.tour-sub'),
    caption: tourCard.querySelector('.tour-caption'),
    bar: tourCard.querySelector('.tour-progress-fill'),
    hint: tourCard.querySelector('.tour-hint')
  } : null;
  const setText = (el, text) => { if (el && el.textContent !== text) el.textContent = text; };
  const tourUi = {
    fade: (on) => tourFade?.classList.toggle('is-on', on),
    showCard(info) {
      if (!tourCard) return;
      tourCard.hidden = false;
      tourCard.dataset.kind = info.kind;
      tourCard.dataset.phase = info.phase || '';
      tourCard.classList.toggle('is-loop', info.loop);
      setText(tourEls.counter, info.counter);
      setText(tourEls.title, info.title);
      setText(tourEls.sub, info.sub || '');
      setText(tourEls.caption, info.caption);
      setText(tourEls.hint, info.loop ? t('Press any key or tap to explore Aalborg yourself') : '');
      if (tourEls.bar) tourEls.bar.style.transform = `scaleX(${info.progress || 0})`;
    },
    hideCard: () => { if (tourCard) tourCard.hidden = true; },
    setTouring: (on, state) => {
      document.body.classList.toggle('touring', on);
      // the attract loop takes over from the start screen, and hands back to it for the next visitor when input ends it
      // (after stop() has restored the player at AKKC)
      if (on) startScreen?.close();
      else if (state?.loop) queueMicrotask(() => startScreen?.open());
    },
    hideBuilding: () => { const panel = document.getElementById('building-info'); if (panel) panel.style.display = 'none'; },
    closePopovers
  };
  const idleParam = query.has('idle') ? Number(query.get('idle')) : 60;
  tour = createTour({
    teleportTo, selectMode, selectCamera, selectTime, selectBuildingLevel,
    controllerManager, cameraSystem, mapSystem, lightingSystem, audioSystem, buildings: buildingLayer,
    ui: tourUi,
    idleSeconds: Number.isFinite(idleParam) ? idleParam : 60,
    // the black hold after a teleport waits for the tiles that are still fetching or building (js/tile-streamer.js)
    isLoading: () => { const s = world.stream?.snapshot?.(); return s ? s.fetching + s.building > 0 : false; },
    // the director's shots hold the camera on a fixed view (cameras.js debugView); the tiles keep streaming round the player
    setView: (pose) => { cameraSystem.debugView = pose; },
    groundAt: (x, z) => world.groundHeight?.heightAt?.(x, z) ?? 0
  });
  document.querySelectorAll('[data-tour]').forEach((btn) => btn.addEventListener('click', () => { if (!race?.blocking) tour.start(btn.getAttribute('data-tour')); }));
  document.querySelectorAll('[data-tour-cmd]').forEach((btn) => btn.addEventListener('click', () => tour.command(btn.getAttribute('data-tour-cmd'))));
  // Activity: a press, click, touch or scroll ends the attract loop; a mouse move only keeps it from starting
  for (const type of ['pointerdown', 'wheel', 'touchstart']) {
    window.addEventListener(type, () => tour.noteInput(), { capture: true, passive: true });
  }
  window.addEventListener('pointermove', () => tour.noteInput({ end: false }), { passive: true });

  // The Kortdage race (js/race.js, js/race-scores.js, docs/race.md): AKKC to Jomfru Ane Gade against the clock, one handicapped
  // highscore list per kiosk. `?race=1` starts one after the boot, `?raceReset=1` clears the list (after a confirm).
  const raceEls = {
    hud: document.getElementById('race-hud'),
    time: document.querySelector('#race-hud .race-time'),
    dist: document.querySelector('#race-hud .race-dist'),
    count: document.getElementById('race-count'),
    result: document.getElementById('race-result'),
    mode: document.querySelector('#race-result .race-result-mode'),
    title: document.querySelector('#race-result .race-result-title'),
    sub: document.querySelector('#race-result .race-result-sub'),
    form: document.getElementById('race-form'),
    name: document.getElementById('race-name'),
    company: document.getElementById('race-company'),
    msg: document.querySelector('#race-form .race-form-msg'),
    board: document.getElementById('race-board'),
    boardPop: document.getElementById('race-board-pop'),
    startMode: document.getElementById('race-start-mode')
  };
  const metres = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);
  const modeLabel = (mode) => t(MODE_LABEL[mode] || mode);
  function renderRaceBoard(list, entries, highlight = null) {
    if (!list) return;
    if (!entries.length) {
      const empty = document.createElement('li');
      empty.className = 'race-board-empty';
      empty.textContent = t('No times yet. Be the first!');
      empty.style.display = 'block';
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...entries.map((e) => {
      const li = document.createElement('li');
      if (e === highlight) li.className = 'is-new';
      li.title = `${modeLabel(e.mode)}: ${formatTime(e.time)} (${t('handicapped')} ${formatTime(e.adjusted)})`;
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('class', 'icon');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', `#i-${MODE_ICON[e.mode] || 'car'}`);
      icon.appendChild(use);
      const who = document.createElement('span');
      who.className = 'race-who';
      who.textContent = e.name;
      if (e.company) {
        const company = document.createElement('small');
        company.textContent = e.company;
        who.appendChild(company);
      }
      const score = document.createElement('span');
      score.className = 'race-score';
      score.textContent = formatTime(e.adjusted);
      const raw = document.createElement('small');
      raw.textContent = `${modeLabel(e.mode)} ${formatTime(e.time)}`;
      score.appendChild(raw);
      li.append(icon, who, score);
      return li;
    }));
  }
  let raceMsgTimer = 0;
  const raceUi = {
    closePopovers,
    setRacing: (on) => document.body.classList.toggle('racing', on),
    showHud(info) {
      if (raceEls.hud) raceEls.hud.hidden = false;
      setText(raceEls.time, formatTime(info.time));
      setText(raceEls.dist, info.phase === 'running' ? `${metres(info.distance)} ${t('to go')}` : t('Get ready'));
      if (!raceEls.count) return;
      const text = info.phase === 'countdown' ? String(Math.max(1, info.count)) : info.go ? t('GO!') : '';
      raceEls.count.classList.remove('is-msg');
      raceEls.count.hidden = !text;
      setText(raceEls.count, text);
    },
    hideHud() {
      if (raceEls.hud) raceEls.hud.hidden = true;
      if (raceEls.count && !raceEls.count.classList.contains('is-msg')) raceEls.count.hidden = true;
    },
    aborted(reason) {
      if (!raceEls.count) return;
      const why = { mode: 'You changed vehicle', teleport: 'You teleported', idle: 'No input for a while' }[reason];
      raceEls.count.textContent = why ? `${t('Race cancelled')} · ${t(why)}` : t('Race cancelled');
      raceEls.count.classList.add('is-msg');
      raceEls.count.hidden = false;
      clearTimeout(raceMsgTimer);
      raceMsgTimer = setTimeout(() => { raceEls.count.hidden = true; raceEls.count.classList.remove('is-msg'); }, 2500);
    },
    showResult(result, top) {
      if (!raceEls.result) return;
      raceEls.result.hidden = false;
      raceEls.result.classList.toggle('is-done', result.rejected); // Race again / Close once there is nothing to save
      setText(raceEls.mode, `${modeLabel(result.mode)} · ${metres(result.length)} ${t('route')}`);
      setText(raceEls.title, formatTime(result.time));
      if (result.rejected) {
        setText(raceEls.sub, t('That was faster than this vehicle can go: no score this time. Did something glitch?'));
      } else {
        const pace = result.mode === 'car' ? '' : ` ${t('Handicapped to car time: {time}.', { time: formatTime(result.adjusted) })}`;
        setText(raceEls.sub, `${t('You reached Jomfru Ane Gade!')}${pace} ${t('That puts you #{rank} on the list.', { rank: result.rank })}`);
      }
      raceEls.form.hidden = result.rejected;
      setText(raceEls.msg, '');
      raceEls.name.value = '';
      raceEls.company.value = '';
      if (result.rejected) renderRaceBoard(raceEls.board, top);
      else raceEls.board.replaceChildren();
      controllerManager.resetInput();
      if (!result.rejected) setTimeout(() => raceEls.name.focus(), 50);
    },
    showBoard(top, entry, rank) {
      raceEls.form.hidden = true;
      raceEls.result.classList.add('is-done');
      setText(raceEls.sub, rank <= top.length ? t('Saved: you are #{rank}!', { rank }) : t('Saved: you are #{rank}. Top {n}:', { rank, n: top.length }));
      renderRaceBoard(raceEls.board, top, entry);
    },
    hideResult() {
      if (raceEls.result) raceEls.result.hidden = true;
      document.activeElement?.blur?.();
    }
  };
  race = createRace({
    controllerManager, mapSystem, teleportTo,
    finish: finishSegments(world.geo?.roadGraph),
    ui: raceUi
  });
  function startRace() {
    if (race.blocking) return;
    if (tour.active) tour.stop({ restore: false });
    race.begin();
  }
  document.getElementById('race-start')?.addEventListener('click', startRace);
  document.getElementById('race-giveup')?.addEventListener('click', () => race.abort('user'));
  document.getElementById('race-again')?.addEventListener('click', startRace);
  document.getElementById('race-close')?.addEventListener('click', () => { race.dismiss(); raceUi.hideResult(); });
  document.getElementById('race-skip')?.addEventListener('click', () => { race.dismiss(); raceUi.hideResult(); });
  raceEls.form?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!race.submit(raceEls.name.value, raceEls.company.value)) setText(raceEls.msg, t('Please enter a (polite) name'));
    else document.activeElement?.blur?.();
  });
  // typing a name is activity too (the global key handler skips text fields)
  raceEls.form?.addEventListener('input', () => tour.noteInput({ end: false }));
  document.getElementById('race-popover')?.addEventListener('beforetoggle', (e) => {
    if (e.newState !== 'open') return;
    const mode = raceMode(controllerManager.activeMode, controllerManager.entities.person.avatar);
    setText(raceEls.startMode, `${t('Racing as')}: ${modeLabel(mode)} · ${t('switch vehicle first to race another way')}`);
    renderRaceBoard(raceEls.boardPop, race.scores.top(10));
  });
  document.getElementById('race-export')?.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([race.scores.toCsv()], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `kortdage-race-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  // The start screen (js/start-screen.js, docs/start-screen.md): after every boot and every attract loop; `?intro=0` turns it off
  const startEl = document.getElementById('start-screen');
  const startModeButtons = startEl ? [...startEl.querySelectorAll('[data-start-mode]')] : [];
  const startActionButtons = startEl ? [...startEl.querySelectorAll('[data-start-action]')] : [];
  const startButtonFor = (item) => (item.kind === 'mode' ? startModeButtons : startActionButtons)
    .find((btn) => (btn.dataset.startMode || btn.dataset.startAction) === item.id);
  const startUi = {
    show() {
      if (!startEl) return;
      closePopovers();
      if (mapSystem.isFullMapOpen) mapSystem.toggleFullMap(false);
      startEl.hidden = false;
      document.body.classList.add('start-open');
    },
    hide() {
      if (startEl) startEl.hidden = true;
      document.body.classList.remove('start-open');
      document.activeElement?.blur?.();
    },
    markMode(mode) {
      startModeButtons.forEach((btn) => {
        const selected = btn.dataset.startMode === mode;
        btn.classList.toggle('active', selected);
        btn.setAttribute('aria-pressed', String(selected));
      });
    },
    focus(item) {
      const target = startButtonFor(item);
      // a highlight, not DOM focus: a Space keyup on a focused button would press it a second time
      [...startModeButtons, ...startActionButtons].forEach((btn) => btn.classList.toggle('pad-focus', btn === target));
      target?.scrollIntoView?.({ block: 'nearest' });
    }
  };
  startScreen = createStartScreen({
    ui: startUi,
    enabled: Boolean(startEl) && query.get('intro') !== '0',
    getMode: () => controllerManager.activeMode,
    onSelectMode: (mode) => selectMode(mode),
    onRace: startRace,
    onTour: () => tour.start('express'),
    onOpenChange: (open) => {
      // like the full map: nothing drives the player behind the screen
      controllerManager.resetInput();
      touchControls.setEnabled(!open);
      gamepadControls.reset();
      if (open) hudNav.hide();
    }
  });
  startModeButtons.forEach((btn) => btn.addEventListener('click', () => startScreen.click({ kind: 'mode', id: btn.dataset.startMode })));
  startActionButtons.forEach((btn) => btn.addEventListener('click', () => startScreen.click({ kind: 'action', id: btn.dataset.startAction })));
  // Keys go to the start screen before anything else (capture on window runs ahead of every other key listener):
  // movement (js/controllers.js), the shortcuts below and the map's [M] never see them. Browser combos still work.
  window.addEventListener('keydown', (e) => {
    if (!startScreen.isOpen || e.ctrlKey || e.metaKey || e.altKey || /^F\d+$/.test(e.code)) return;
    tour.noteInput({ end: false });
    if (e.repeat && ['Enter', 'NumpadEnter', 'Space', 'KeyR', 'KeyT', 'Escape'].includes(e.code)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    startScreen.handleKey(e.code, { shift: e.shiftKey });
    e.preventDefault();
    e.stopImmediatePropagation();
  }, { capture: true });

  if (query.get('raceReset') === '1' && race.scores.size && window.confirm(t('Clear all {n} race highscores on this machine?', { n: race.scores.size }))) race.scores.clear();

  // Global keyboard shortcuts for modes (1-5), cameras (V / 6-0), building level (L) and HUD (H)
  window.addEventListener('keydown', (e) => {
    if (isTypingInField(e)) return;
    if (tour.noteInput()) return; // the key ended the attract loop: nothing else
    if (tour.guided) {
      // a guided tour plays: → / Space next, ← back, Esc ends; the HUD (H) and sound (N) keys still work, nothing else
      const cmd = e.code === 'ArrowRight' || e.code === 'Space' ? 'next' : e.code === 'ArrowLeft' ? 'prev' : e.code === 'Escape' ? 'end' : null;
      if (cmd) {
        e.preventDefault();
        tour.command(cmd);
        return;
      }
      if (e.code !== 'KeyH' && e.code !== 'KeyN' && e.code !== 'KeyR') return;
    }
    if (e.code === 'Escape' && race.blocking && !mapSystem.isFullMapOpen) {
      race.abort('user');
      return;
    }
    switch (e.code) {
      case 'KeyR':
        if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) startRace();
        break;
      case 'Digit1':
        selectMode('person');
        break;
      case 'Digit2':
        selectMode('car');
        break;
      case 'Digit3':
        selectMode('cyclist');
        break;
      case 'Digit4':
        selectMode('drone');
        break;
      case 'Digit5':
        selectMode('bus');
        break;
      case 'Digit6':
        selectCamera('action', true);
        break;
      case 'Digit7':
        selectCamera('pov', true);
        break;
      case 'Digit8':
        selectCamera('akkc', true);
        break;
      case 'Digit9':
        selectCamera('musikkens', true);
        break;
      case 'Digit0':
        selectCamera('utzon', true);
        break;
      case 'KeyV':
        cycleCamera(e.shiftKey ? -1 : 1);
        break;
      case 'KeyH':
        if (hudToggleBtn) hudToggleBtn.click();
        break;
      case 'KeyL':
        if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) cycleBuildingLevel(e.shiftKey ? -1 : 1);
        break;
      case 'KeyN':
        if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) audioSystem.setEnabled(!audioSystem.enabled);
        break;
      case 'KeyB':
        if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey && !mapSystem.isFullMapOpen) audioSystem.honk(controllerManager.getActiveEntity());
        break;
    }
  });

  window.addEventListener('resize', () => {
    cameraSystem.onResize(window.innerWidth, window.innerHeight);
    renderer.setSize(window.innerWidth, window.innerHeight);
    placeModeIndicator();
    if (mapSystem.isFullMapOpen) {
      mapSystem.resizeFullCanvas();
      mapSystem.renderFullMap();
    }
  });

  // Initialize the UI and chase camera around the restored player, or the default car on a first visit.
  selectMode(controllerManager.activeMode);
  selectCamera('chase', true);
  selectTime('golden', true);

  // The language toggles (js/i18n.js): DA / EN in the toolbar, Dansk / English on the start screen. The static text is swapped
  // in place; the text the code wrote is written again
  document.querySelectorAll('[data-lang-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => setLang(getLang() === 'da' ? 'en' : 'da'));
  });
  onLangChange(() => {
    translateDocument(document);
    updateSoundButton();
    updateHudToggle();
    if (hintMode) renderControlHints(hintMode);
    if (elMode) elMode.textContent = t(controllerManager.getActiveEntity().label);
    if (elCamera) elCamera.textContent = t(cameraSystem.getActivePreset().name);
    markTime(lightingSystem.activePresetId);
    if (touchControls.mode) touchControls.setMode(touchControls.mode);
    locationText = '';
    mapSystem.refreshLanguage();
    placeModeIndicator();
  });
  // the web fonts change the buttons' widths once they arrive
  if (document.fonts) document.fonts.ready.then(placeModeIndicator);
  markInit('ui');

  // The loading screen stays up while the shaders compile (precompileShaders() & the warm-up frame, see the loop) and
  // until the first frame is on screen
  if (loadingStatus) {
    loadingStatus.textContent = t('Compiling Shaders & Render Pipelines...');
  }

  // 6b. compileAsync() uses shared renderer/shader-builder state. Keep calls sequential;
  // each call already submits GPU pipeline compilation in parallel.
  const nextTask = () => (globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0)));
  async function precompileShaders() {
    // An empty frame first: it sets up the post-processing chain, which configures the scene pass's render target
    // (MSAA samples, depth format), so the pipelines compiled below are the very ones the scene pass asks for
    scene.visible = false;
    renderPipeline.render();
    scene.visible = true;
    markInit('postFX');

    // Every visible object with frustum culling off (like the warm-up frame, see the loop). Plain meshes that share
    // a material share its shader, so one job compiles them in turn (the first build serves the rest); every
    // instanced mesh gets a build of its own unless its chunks share a pipeline
    const culled = [];
    const jobs = [];
    const jobByMaterial = new Map();
    const pipelines = new Set();
    scene.traverseVisible((o) => {
      if (o.frustumCulled) {
        culled.push(o);
        o.frustumCulled = false;
      }
      if (!o.isMesh && !o.isLine && !o.isPoints && !o.isSprite) return;
      // Use the first visible chunk: the original representative may be in an inactive tree cell. Shadow stand-ins
      // only draw in the shadow maps (the warm-up frame compiles those).
      if (o.userData.shadowProxy) return;
      const pipeline = o.userData.sharesPipelineWith || o;
      if (pipelines.has(pipeline)) return;
      pipelines.add(pipeline);
      if (o.isInstancedMesh || Array.isArray(o.material)) {
        jobs.push([o]);
        return;
      }
      let job = jobByMaterial.get(o.material);
      if (!job) {
        job = [];
        jobByMaterial.set(o.material, job);
        jobs.push(job);
      }
      job.push(o);
    });

    renderer.setRenderTarget(scenePass.renderTarget);
    renderer.setMRT(sceneMRT);
    const compile = async (object) => {
      await nextTask();
      try {
        await renderer.compileAsync(object, cameraSystem.camera, scene);
      } catch (e) {
        console.warn('[compile]', e); // the warm-up frame compiles it instead
      }
    };
    let done = 0;
    for (const job of jobs) {
      for (const object of job) await compile(object);
      done++;
      if (loadingStatus) {
        loadingStatus.textContent = `${t('Compiling Shaders & Render Pipelines...')} ${Math.round((done / jobs.length) * 100)}%`;
      }
      setLoadingProgress(done / jobs.length);
    }
    renderer.setMRT(null);
    renderer.setRenderTarget(null);
    for (const o of culled) o.frustumCulled = true;
  }

  await precompileShaders();
  markInit('compile');

  // Spread cold photo shader work across frames; the procedural walls remain visible while an overlay waits.
  const photoDrawBudget = createPhotoDrawBudget({ budgetMs: 4 });
  const photoBudgetDisabled = (query.get('debug') || '').split(',').includes('nophotobudget');
  renderer.setRenderObjectFunction(createPhotoRenderCallback(renderer, photoDrawBudget));

  // 6. Animation Loop
  let lastTime = performance.now();
  let elapsed = 0;
  let frameCount = 0;
  let fpsTimer = 0;
  let nextPlayerSave = 0;
  let warmedUp = false; // see the first frame below

  if (elFps) elFps.textContent = '60';

  // Handle for the headless verification scripts and the console (not used by the engine)
  globalThis.__twin = { scene, renderer, cameraSystem, controllerManager, lightingSystem, world, aoEnabled, aoPass, tour, race };
  // `?hooks` exposes the running twin to headless checks (tools/m3-check.py): a free camera and the live systems
  if (new URLSearchParams(location.search).has('hooks')) {
    Object.defineProperty(globalThis.__twin, 'shaderBudget', { get: () => photoDrawBudget.snapshot(), enumerable: true });
    const updateCamera = cameraSystem.update.bind(cameraSystem);
    Object.assign(globalThis.__twin, { THREE, trafficSystem, mapSystem, freeCam: null, frozen: false, stream: world.stream || null, nightlife, nightlifeScene, audioSystem });
    cameraSystem.update = (dt, time) => {
      updateCamera(dt, time);
      const f = globalThis.__twin.freeCam;
      if (!f) return;
      cameraSystem.camera.position.set(...f.pos);
      cameraSystem.camera.lookAt(...f.target);
      if (f.fov) cameraSystem.camera.fov = f.fov;
      cameraSystem.camera.updateProjectionMatrix();
      cameraSystem.camera.updateMatrixWorld(true);
      cameraSystem.currentPos.set(...f.pos);
    };
  }

  // `?hooks`: the frames that took over 60 ms, split by section (globalThis.__twin.frameLog), for tools/shoot-stream.py
  const frameProbe = new URLSearchParams(location.search).has('hooks') ? Object.assign([], { lastGeoms: 0, lastTex: 0 }) : null;
  if (frameProbe) globalThis.__twin.frameLog = frameProbe;
  renderer.setAnimationLoop((now) => {
    photoDrawBudget.beginFrame({ unlimited: !warmedUp || photoBudgetDisabled });
    const rawDt = (now - lastTime) * 0.001;
    lastTime = now;
    const dt = Math.min(Math.max(rawDt, 0.001), 0.05);
    elapsed += dt;

    // Update 3rd-person controllers, camera, signals, traffic & vehicle collisions, building LODs, and dynamic shadow focus
    const T0 = frameProbe ? performance.now() : 0;
    gamepadControls.tourMode = tour.guided;
    gamepadControls.update(dt);
    if (startScreen.isOpen) startEl.classList.toggle('has-pad', gamepadControls.connected);
    // a pad connected or gone: the HUD's hints switch between its buttons and the keyboard
    const family = gamepadControls.connected ? padFamily(gamepadControls.padId || '') : null;
    if (family !== padHintFamily) {
      padHintFamily = family;
      applyPadLabels(document, family);
      if (hintMode) renderControlHints(hintMode);
    }
    hudNav.tick();
    if (race.blocking && Math.abs(controllerManager.getActiveEntity().speed || 0) > 0.5) tour.noteInput({ end: false }); // racing (even on a gamepad stick) is activity
    tour.update(rawDt); // wall time: the tour keeps its pace at low frame rates; it holds the player still on a guided tour
    // the attract loop started (60 s without input): it ends a race, or closes its result card
    if (tour.active && race.active) {
      if (!race.abort('idle')) { race.dismiss(); raceUi.hideResult(); }
    }
    race.update(rawDt); // wall time too: the clock is a stopwatch; it holds the player on the line during the countdown
    controllerManager.update(dt, elapsed);
    cameraSystem.update(dt, elapsed);
    trafficSystem.update(
      dt,
      elapsed,
      cameraSystem.currentPos,
      controllerManager.getActiveEntity(),
      controllerManager.activeMode,
      cameraSystem.camera
    );
    if (!document.hidden && now >= nextPlayerSave) {
      savePlayerState();
      nextPlayerSave = now + 5000;
    }
    const T1 = frameProbe ? performance.now() : 0;
    world.update(cameraSystem.currentPos.x, cameraSystem.currentPos.z, lightingSystem.uNightFactor.value);
    const T2 = frameProbe ? performance.now() : 0;
    lightingSystem.update(cameraSystem.currentPos);
    colorGrade.update();
    mapSystem.update(now);
    audioSystem.update(dt, elapsed, cameraSystem.camera, lightingSystem.activePresetId === 'midnight');
    nightlife.setLevel(nightlifeLevel(lightingSystem.activePresetId, lightingSystem.uNightFactor.value));
    nightlifeScene.update(dt, cameraSystem.currentPos.x, cameraSystem.currentPos.z, audioSystem.beatClock ?? elapsed);
    if (warmedUp) updateSceneCulling(cameraSystem.camera.position); // the warm-up frame draws every chunk

    // Render frame via TSL RenderPipeline (SSR + Bloom)
    if (!warmedUp) {
      // First frame = pipeline warm-up behind the loading screen, for what precompileShaders() can't reach (the shadow
      // map passes): with frustum culling off, every visible material's pipelines compile now instead of stalling the
      // first time the camera turns towards it (one chunk / shadow stand-in per shared pipeline is enough)
      const culled = [];
      const pipelines = new Set();
      scene.traverseVisible((o) => {
        const pipeline = o.userData.sharesPipelineWith || o;
        if (pipelines.has(pipeline)) return;
        pipelines.add(pipeline);
        if (o.frustumCulled) {
          culled.push(o);
          o.frustumCulled = false;
        }
      });
      renderPipeline.render();
      for (const o of culled) o.frustumCulled = true;
      markInit('warmup');
    }
    const T3 = frameProbe ? performance.now() : 0;
    renderPipeline.render();
    if (frameProbe) {
      const T4 = performance.now();
      const g = renderer.info.memory.geometries;
      const tx = renderer.info.memory.textures;
      if (T4 - T0 > 60) frameProbe.push({ t: Math.round(now), total: Math.round(T4 - T0), traffic: Math.round(T1 - T0), world: Math.round(T2 - T1), other: Math.round(T3 - T2), render: Math.round(T4 - T3), dGeom: g - frameProbe.lastGeoms, dTex: tx - frameProbe.lastTex, calls: renderer.info.render.drawCalls });
      frameProbe.lastGeoms = g;
      frameProbe.lastTex = tx;
    }
    if (!warmedUp) {
      warmedUp = true;
      controllerManager.showActiveOnly(); // every mode's shaders are compiled now
      markInit('firstFrame');
      // The loading screen stays up until the GPU has got through the first frame (and the pipelines its warm-up
      // compiled), i.e. until the city is actually on screen
      const device = renderer.backend.device;
      Promise.resolve(device && device.queue.onSubmittedWorkDone()).catch(() => {}).then(() => {
        markInit('gpu');
        console.log(`[init] ${initTimings.join(', ')}`);
        initTimings = null;
        const tourParam = query.get('tour');
        // the start screen fades in under the loading screen, unless the URL starts a tour or the race
        if (!tourParam && query.get('race') !== '1') startScreen.open();
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
        audioSystem.ready = true;
        setLoadingProgress(1);
        // `?tour=express|full|drive|loop` starts a tour at once (loop: the express tour, looping, as after the idle time)
        tour.setReady();
        if (tourParam === 'loop') tour.start('express', { loop: true });
        else if (tourParam) tour.start(tourParam);
        else if (query.get('race') === '1') startRace();
      });
    }

    // Telemetry uses wall time, not the clamped simulation step, so slow frames and high-refresh displays report
    // their actual frame rate (updates DOM every 250ms).
    frameCount++;
    fpsTimer += Math.max(0, rawDt);
    if (fpsTimer >= 0.25) {
      const currentFps = Math.round(frameCount / fpsTimer);
      frameCount = 0;
      fpsTimer = 0;

      const activeEnt = controllerManager.getActiveEntity();
      const mode = controllerManager.activeMode;
      const kmh = Math.round(Math.abs(activeEnt.speed) * 3.6);
      // the drone's height over the ground (what its 120 m ceiling counts), else the height above the frame origin
      const altM = Math.max(0, Math.round(mode === 'drone'
        ? activeEnt.position.y - controllerManager.getGroundHeight(activeEnt.position.x, activeEnt.position.z, 'drone')
        : activeEnt.position.y));

      if (elFps) {
        elFps.textContent = String(currentFps);
        elFps.className = currentFps >= 50 ? 'fps-ok' : currentFps >= 30 ? 'fps-warn' : 'fps-bad';
      }
      if (elSpeed) elSpeed.textContent = String(kmh);
      const bikeBoosting = (mode === 'cyclist' || mode === 'cargobike') && controllerManager.keys.boost;
      const speedCap = bikeBoosting ? 30 : topSpeedKmh[mode] || 130;
      if (elSpeedMeter) elSpeedMeter.style.transform = `scaleX(${Math.min(1, kmh / speedCap)})`;
      document.body.classList.toggle('is-boosting', controllerManager.keys.boost && kmh > 0 && mode !== 'car' && mode !== 'bus');
      if (elAltitude) elAltitude.textContent = altM.toLocaleString('en-US');
      // The street corner of the player on the follow cameras, of the camera itself on the scenic ones
      const where = cameraSystem.getActivePreset().category === 'follow' ? activeEnt.position : cameraSystem.currentPos;
      renderLocation(world.locationLabel(where.x, where.z));
    }
  });
}

initApp();
