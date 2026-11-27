import * as THREE from 'three/webgpu';
import { TELEPORT_LOCATIONS } from './city-config.js';

// js/cameras.js
// Multi-camera system supporting Third-Person Chase (with mouse/touch orbit + zoom),
// Low-Angle Action Cam, POV/Cockpit Cam, 6 Refshaleøen vantage cameras, and Auto-Director Drone.

const CAMERA_PRESETS = [
  { id: 'chase',       name: '3rd-Person Chase',         short: 'Chase',       category: 'follow', fov: 56 },
  { id: 'action',      name: 'Low-Angle Action',         short: 'Action',      category: 'follow', fov: 60 },
  { id: 'pov',         name: 'First-Person / Cockpit',   short: 'POV / Dash',  category: 'follow', fov: 68 },
  { id: 'reffen', name: 'Reffen', short: 'Reffen',        category: 'scenic', fov: 56 },
  { id: 'bw', name: 'B&W Hallerne', short: 'B&W',   category: 'scenic', fov: 54 },
  { id: 'mastekranen', name: 'Mastekranen', short: 'Mastekran',       category: 'scenic', fov: 50 },
  { id: 'operaen', name: 'Operaen', short: 'Operaen',     category: 'scenic', fov: 54 },
  { id: 'akademiet', name: 'Det Kongelige Akademi', short: 'Akademiet',  category: 'scenic', fov: 56 },
  { id: 'cc', name: 'Copenhagen Contemporary', short: 'CC', category: 'scenic', fov: 56 },
  { id: 'marmorkirken', name: 'Marmorkirken', short: 'Marmorkirken', category: 'scenic', fov: 50 },
  { id: 'operaparken', name: 'Operaparken', short: 'Operaparken', category: 'scenic', fov: 56 },
  { id: 'kai', name: 'KAI', short: 'KAI', category: 'scenic', fov: 56 },
  { id: 'banchina', name: 'La Banchina', short: 'Banchina',   category: 'scenic', fov: 56 },
  { id: 'bygning147', name: 'Bygning 147', short: 'Bygning 147', category: 'scenic', fov: 56 },
  { id: 'havnebus', name: 'Aboard the harbour bus', short: 'Havnebus', category: 'scenic', fov: 60 },
  { id: 'drone',       name: 'Auto-Director Aerial',     short: 'Director',    category: 'scenic', fov: 50 }
];

// Scenic vantage points: stand `back` metres behind and `up` metres above the teleport location (looking along its
// heading), or at a fixed `pos`, and look at the point `ahead` metres in front of it, `lookY` metres up.
const SCENIC_VIEWS = {
  reffen: { back: 25, up: 8, ahead: 45, lookY: 6, sway: 2.5 },
  bw: { back: 25, up: 8, ahead: 60, lookY: 10, sway: 3 },
  mastekranen: { back: 25, up: 6, ahead: 40, lookY: 25, sway: 3.5 },
  operaen: { back: 25, up: 6, ahead: 40, lookY: 12, sway: 2 },
  akademiet: { back: 20, up: 5, ahead: 40, lookY: 8, sway: 2 },
  cc: { back: 20, up: 6, ahead: 40, lookY: 8, sway: 3 },
  marmorkirken: { back: 30, up: 6, ahead: 110, lookY: 30, sway: 2 },
  operaparken: { back: 20, up: 6, ahead: 35, lookY: 4, sway: 3 },
  kai: { back: 20, up: 6, ahead: 45, lookY: 8, sway: 3 },
  banchina: { back: 15, up: 4, ahead: 60, lookY: 2, sway: 2 },
  bygning147: { back: 10, up: 3, ahead: 70, lookY: 9, sway: 1.5 }
};

// Degrees the chase & action cameras widen their field of view by per m/s, and at most (reached at 40 m/s, a little
// over the taxi's top speed)
const SPEED_FOV = 0.35;
const SPEED_FOV_MAX = 14;

class CameraSystem {
  constructor(domElement, controllerManager) {
    this.domElement = domElement;
    this.controllerManager = controllerManager;

    this.camera = new THREE.PerspectiveCamera(
      56,
      window.innerWidth / window.innerHeight,
      0.35,
      60000 // out to the fogged horizon (reversed float depth keeps precision)
    );

    this.activePresetId = 'chase';
    this.harbourBuses = null; // js/harbour-bus.js, set by main.js: the boats the 'havnebus' camera rides on
    this.harbourBoat = 0;
    this.orbitYawOffset = 0.0;
    this.orbitPitchOffset = 0.09;
    this.zoomMultiplier = 1.0;
    this.isDragging = false;
    this.userOrbitTimer = 0;

    this.currentPos = new THREE.Vector3(0, 10, 380);
    this.currentLookAt = new THREE.Vector3(0, 8, 440);
    this.initialized = false;

    // Follow cameras (chase / action) are smoothed relative to the followed entity, see update()
    this.followEntity = null;
    this.followOffset = new THREE.Vector3();
    this.followLookOffset = new THREE.Vector3();
    this.followBaseY = 0;
    this.smoothedSpeed = 0;
    this._desiredPos = new THREE.Vector3();
    this._desiredLook = new THREE.Vector3();

    this.bindPointerControls();
  }

  bindPointerControls() {
    const canvas = this.domElement;
    const pointers = new Map();
    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || pointers.size >= 2) return;
      // Only two touch pointers may share a gesture; mouse and pen drags stay independent.
      if (pointers.size && (e.pointerType !== 'touch' || pointers.values().next().value.type !== 'touch')) return;
      e.preventDefault();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      canvas.setPointerCapture(e.pointerId);
      this.isDragging = true;
      this.userOrbitTimer = 4.0;
    });

    canvas.addEventListener('pointermove', (e) => {
      const pointer = pointers.get(e.pointerId);
      if (!pointer) return;
      e.preventDefault();
      const dx = e.clientX - pointer.x;
      const dy = e.clientY - pointer.y;
      const pair = pointers.size === 2 ? [...pointers.values()] : null;
      const previousDistance = pair ? Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) : 0;
      pointer.x = e.clientX;
      pointer.y = e.clientY;

      if (pair) {
        const distance = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
        if (previousDistance > 1 && distance > 1) {
          this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier * previousDistance / distance));
        }
      } else {
        this.orbitYawOffset -= dx * 0.0065;
        this.orbitPitchOffset = Math.max(-0.32, Math.min(0.68, this.orbitPitchOffset + dy * 0.005));
      }
      this.userOrbitTimer = 4.0;
    });

    const releasePointer = (id) => {
      if (!pointers.delete(id)) return;
      this.isDragging = pointers.size > 0;
      if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      canvas.addEventListener(type, (e) => releasePointer(e.pointerId));
    }
    const clearPointers = () => {
      for (const id of pointers.keys()) releasePointer(id);
    };
    this._clearPointers = clearPointers;
    window.addEventListener('blur', clearPointers);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearPointers();
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier + e.deltaY * 0.001));
    }, { passive: false });
  }

  setCameraPreset(presetId, snapImmediately = false) {
    const preset = CAMERA_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    this.activePresetId = preset.id;
    this.camera.fov = preset.fov;
    this.camera.updateProjectionMatrix();
    if (snapImmediately) {
      this.initialized = false;
    }
  }

  applyGamepadInput(lookX, lookY, zoom, dt) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    if (this.activePresetId !== 'chase' && this.activePresetId !== 'pov') return;
    // POV uses the orbit angles, but only chase renders a zoomed camera distance.
    if (this.activePresetId !== 'chase') zoom = 0;
    if (!lookX && !lookY && !zoom) return;
    this.orbitYawOffset -= lookX * 2.0 * dt;
    this.orbitPitchOffset = Math.max(-0.32, Math.min(0.68, this.orbitPitchOffset + lookY * 1.25 * dt));
    this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier + zoom * 0.9 * dt));
    this.userOrbitTimer = 4.0;
  }

  resetOrbit() {
    this.orbitYawOffset = 0;
    this.orbitPitchOffset = 0.09;
    this.zoomMultiplier = 1;
    this.userOrbitTimer = 0;
  }

  resetForTeleport() {
    // Arrive with a fresh chase view, without carrying a previous drive or gesture into the destination.
    this._clearPointers();
    this.isDragging = false;
    this.resetOrbit();
    this.smoothedSpeed = 0;
    this.followEntity = null;
    this.followOffset.set(0, 0, 0);
    this.followLookOffset.set(0, 0, 0);
    this.followBaseY = 0;
    this.setCameraPreset('chase', true);
  }

  getActivePreset() {
    return CAMERA_PRESETS.find((p) => p.id === this.activePresetId) || CAMERA_PRESETS[0];
  }

  onResize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  update(dt, elapsed) {
    const entity = this.controllerManager.getActiveEntity();
    // bare terrain height (the one ground model): camera floors and scenic viewpoints are relative to it
    const ground = (x, z) => this.controllerManager.getGroundHeight?.(x, z, 'car') ?? 0;
    const desiredPos = this._desiredPos;
    const desiredLook = this._desiredLook;

    if (this.userOrbitTimer > 0 && !this.isDragging) {
      this.userOrbitTimer = Math.max(0, this.userOrbitTimer - dt);
    }

    if (!this.isDragging && this.userOrbitTimer <= 0 && Math.abs(entity.speed) > 0.5) {
      this.orbitYawOffset -= Math.round(this.orbitYawOffset / (Math.PI * 2)) * (Math.PI * 2);
      this.orbitYawOffset += (0.0 - this.orbitYawOffset) * (1 - Math.exp(-dt * 2.2));
    }

    // The follow cameras keep their distance and widen their field of view with speed instead, eased so that it
    // opens as the entity speeds up (and narrows as it slows down)
    this.smoothedSpeed += (Math.abs(entity.speed) - this.smoothedSpeed) * (1 - Math.exp(-dt * 3.0));
    const preset = this.getActivePreset();
    const speedFov = this.activePresetId === 'chase' || this.activePresetId === 'action'
      ? Math.min(SPEED_FOV_MAX, this.smoothedSpeed * SPEED_FOV) : 0;
    if (Math.abs(this.camera.fov - (preset.fov + speedFov)) > 0.02) {
      this.camera.fov = preset.fov + speedFov;
      this.camera.updateProjectionMatrix();
    }

    const totalYaw = entity.heading + this.orbitYawOffset;

    switch (this.activePresetId) {
      case 'chase': {
        const dist = entity.chaseDistance * this.zoomMultiplier;
        const height = entity.chaseHeight * this.zoomMultiplier + Math.sin(this.orbitPitchOffset) * dist * 0.85;
        const horizDist = Math.cos(this.orbitPitchOffset) * dist;

        // the Plusbus is framed from its middle module, so the whole 24.7 m stays in view through a turn
        const anchor = entity.chaseAnchor;
        const ax = anchor ? anchor.x : entity.position.x;
        const az = anchor ? anchor.z : entity.position.z;
        const yaw = anchor ? anchor.yaw + this.orbitYawOffset : totalYaw;
        desiredPos.set(
          ax - Math.sin(yaw) * horizDist,
          Math.max(0.65 + ground(entity.position.x, entity.position.z), entity.position.y + height),
          az - Math.cos(yaw) * horizDist
        );

        // Looks past the entity (the Plusbus's middle module) along the camera's own orbit direction, so dragging the camera
        // around keeps it centred; without a drag that is straight ahead of it (slop-newyork 5a19021)
        const lookUpBias = entity.type === 'drone' ? 0.1
          : entity.type === 'car' ? 0.52
            : entity.type === 'cargobike' ? 1.2 : 1.55;
        const lookYaw = yaw;
        desiredLook.set(
          ax + Math.sin(lookYaw) * 5.2,
          entity.position.y + entity.cameraTargetOffset.y + lookUpBias,
          az + Math.cos(lookYaw) * 5.2
        );
        break;
      }

      case 'action': {
        const sideOffset = entity.type === 'car' ? 2.65
          : entity.type === 'bus' ? 3.6
            : entity.type === 'drone' ? 0.9
              : entity.type === 'cargobike' ? 1.3 : 0.95;
        const backDist = (entity.type === 'car' ? 3.6
          : entity.type === 'bus' ? 7.5
            : entity.type === 'drone' ? 2.2
              : entity.type === 'cargobike' ? 4.1 : 2.8);
        const lowY = entity.type === 'drone' ? entity.position.y + 0.35 : entity.position.y + (entity.type === 'bus' ? 1.6 : 0.92);

        desiredPos.set(
          entity.position.x - Math.sin(entity.heading) * backDist + Math.cos(entity.heading) * sideOffset,
          Math.max(0.55 + ground(entity.position.x, entity.position.z), lowY),
          entity.position.z - Math.cos(entity.heading) * backDist - Math.sin(entity.heading) * sideOffset
        );
        const lookAhead = entity.type === 'cargobike' ? 4.2 : 3.2;
        desiredLook.set(
          entity.position.x + Math.sin(entity.heading) * lookAhead,
          entity.position.y + (entity.type === 'cargobike' ? 1.25 : 1.05),
          entity.position.z + Math.cos(entity.heading) * lookAhead
        );
        break;
      }

      case 'pov': {
        let fwdOffset = 0.35;
        let eyeY = 1.68;
        if (entity.type === 'car') {
          fwdOffset = 0.55;
          eyeY = 1.52;
        } else if (entity.type === 'cyclist') {
          fwdOffset = 0.35;
          eyeY = 1.55;
        } else if (entity.type === 'cargobike') {
          fwdOffset = -0.42;
          eyeY = 1.68;
        } else if (entity.type === 'drone') {
          // FPV: the gimbal camera under the nose
          fwdOffset = 0.11;
          eyeY = 0.07;
        } else if (entity.type === 'bus') {
          // the driver's seat, behind the MetroStyle windshield
          fwdOffset = 3.9;
          eyeY = 2.25;
        }

        desiredPos.set(
          entity.position.x + Math.sin(entity.heading) * fwdOffset,
          entity.position.y + eyeY,
          entity.position.z + Math.cos(entity.heading) * fwdOffset
        );
        desiredLook.set(
          entity.position.x + Math.sin(totalYaw) * 40.0,
          entity.position.y + eyeY + Math.sin(-this.orbitPitchOffset) * 18.0 + 1.5,
          entity.position.z + Math.cos(totalYaw) * 40.0
        );
        break;
      }

      case 'reffen':
      case 'bw':
      case 'mastekranen':
      case 'operaen':
      case 'akademiet':
      case 'cc':
      case 'marmorkirken':
      case 'operaparken':
      case 'kai':
      case 'banchina':
      case 'bygning147': {
        const view = SCENIC_VIEWS[this.activePresetId];
        const loc = TELEPORT_LOCATIONS[this.activePresetId];
        const sway = Math.sin(elapsed * 0.24) * view.sway;
        if (view.pos) {
          desiredPos.set(view.pos[0] + sway, view.pos[1], view.pos[2]);
          desiredLook.set(...view.look);
        } else {
          const fx = Math.sin(loc.heading);
          const fz = Math.cos(loc.heading);
          desiredPos.set(loc.x - fx * view.back + fz * sway, view.up, loc.z - fz * view.back - fx * sway);
          desiredLook.set(loc.x + fx * view.ahead, view.lookY, loc.z + fz * view.ahead);
        }
        desiredPos.y += ground(desiredPos.x, desiredPos.z);
        desiredLook.y += ground(desiredLook.x, desiredLook.z);
        break;
      }

      case 'havnebus': {
        // On deck of a harbour bus (js/harbour-bus.js), by the rail, looking out over the water to the Holmen side (east) of the
        // harbour, a little ahead of the beam; the camera rides with the boat (snapped below, like the POV camera)
        const boats = this.harbourBuses?.boats || [];
        const boat = boats[this.harbourBoat % Math.max(boats.length, 1)];
        if (!boat) { desiredPos.copy(this.currentPos); desiredLook.copy(this.currentLookAt); break; }
        const m = boat.mesh.position;
        const h = boat.mesh.rotation.y;
        const fx = Math.sin(h), fz = Math.cos(h); // forward
        let sx = Math.cos(h), sz = -Math.sin(h);  // one beam
        if (sx < 0) { sx = -sx; sz = -sz; }       // the eastern beam: Holmen, the opera, Refshaleøen
        const lookAhead = 0.35;
        const dx = sx + fx * lookAhead, dz = sz + fz * lookAhead;
        const n = Math.hypot(dx, dz) || 1;
        const sway = Math.sin(elapsed * 0.6) * 0.08;
        desiredPos.set(m.x + sx * 2.3 - fx * 4.0, m.y + 3.4 + sway, m.z + sz * 2.3 - fz * 4.0);
        desiredLook.set(desiredPos.x + (dx / n) * 80, m.y + 6.0, desiredPos.z + (dz / n) * 80);
        break;
      }

      case 'drone': {
        // Slow orbit above the old town and the harbour front (Budolfi, Utzon Center)
        const angle = elapsed * 0.07 + 0.65;
        const radius = 380.0 + Math.sin(elapsed * 0.23) * 90.0;
        const alt = 230.0 + Math.cos(elapsed * 0.19) * 60.0;
        desiredPos.set(
          Math.cos(angle) * radius - 120.0,
          alt,
          Math.sin(angle) * radius - 250.0
        );
        desiredLook.set(-120.0, 10.0, -250.0);
        break;
      }
    }

    if (!this.initialized || this.activePresetId === 'pov' || this.activePresetId === 'havnebus') {
      this.currentPos.copy(desiredPos);
      this.currentLookAt.copy(desiredLook);
      this.initialized = true;
      this.followEntity = null; // the follow cameras re-anchor from here
    } else if (this.activePresetId === 'chase' || this.activePresetId === 'action') {
      // Smoothed in the followed entity's frame rather than in world space. A world-space follower trails a moving
      // target by a distance that depends on the frame time (about speed x dt), so with uneven frame times the camera
      // surged back and forth behind an accelerating or fast car. Relative to the entity a steady drive keeps the
      // camera steady, while turns, orbit drags & zoom are still eased. The entity's height is eased in world space
      // (curbs, park lawns, jumps, the drone climbing).
      if (this.followEntity !== entity) {
        // preset or mode switch: start from where the camera is and glide over to the new framing
        this.followEntity = entity;
        this.followBaseY = entity.position.y;
        this.followOffset.subVectors(this.currentPos, entity.position);
        this.followLookOffset.subVectors(this.currentLookAt, entity.position);
      }
      const k = 1 - Math.exp(-dt * 8.5);
      this.followBaseY += (entity.position.y - this.followBaseY) * k;
      this.followOffset.lerp(desiredPos.sub(entity.position), k);
      this.followLookOffset.lerp(desiredLook.sub(entity.position), k);
      this.currentPos.set(entity.position.x, this.followBaseY, entity.position.z).add(this.followOffset);
      this.currentLookAt.set(entity.position.x, this.followBaseY, entity.position.z).add(this.followLookOffset);
      this.currentPos.y = Math.max(0.55 + ground(this.currentPos.x, this.currentPos.z), this.currentPos.y);
    } else {
      this.followEntity = null;
      const k = 1 - Math.exp(-dt * 8.5);
      this.currentPos.lerp(desiredPos, k);
      this.currentLookAt.lerp(desiredLook, k);
    }

    this.camera.position.copy(this.currentPos);
    this.camera.lookAt(this.currentLookAt);
    // Fixed viewpoint for headless captures and photo comparison: { pos: [x, y, z], look: [x, y, z], fov? }
    if (this.debugView) {
      this.camera.position.set(...this.debugView.pos);
      this.camera.lookAt(...this.debugView.look);
      if (this.debugView.fov && this.camera.fov !== this.debugView.fov) {
        this.camera.fov = this.debugView.fov;
        this.camera.updateProjectionMatrix();
      }
    }
  }
}

export { CAMERA_PRESETS, CameraSystem };
