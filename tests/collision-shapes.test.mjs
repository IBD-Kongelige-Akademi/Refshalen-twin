import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyContact, buildingContact, collisionBody, colliderContainsPoint } from '../js/collision-shapes.js';

test('colliderContainsPoint: polygons with courtyards, rotated boxes, circles and plain bounds', () => {
  const ring = [0, 0, 20, 0, 20, 20, 0, 20];
  const courtyard = { minX: 0, maxX: 20, minZ: 0, maxZ: 20, ring, holes: [[5, 5, 15, 5, 15, 15, 5, 15]] };
  assert.equal(colliderContainsPoint(courtyard, 2, 2), true);
  assert.equal(colliderContainsPoint(courtyard, 10, 10), false, 'the courtyard is open');
  assert.equal(colliderContainsPoint(courtyard, 25, 2), false);
  const cs = Math.SQRT1_2;
  const diamond = { minX: -7.1, maxX: 7.1, minZ: -7.1, maxZ: 7.1, obb: { cx: 0, cz: 0, hx: 5, hz: 5, cs, sn: cs } };
  assert.equal(colliderContainsPoint(diamond, 0, 6.5), true);
  assert.equal(colliderContainsPoint(diamond, 6, 6), false, 'the bounds corner is outside the rotated box');
  const pole = { shape: 'circle', radius: 0.5, minX: -0.5, maxX: 0.5, minZ: -0.5, maxZ: 0.5, obb: { cx: 0, cz: 0 } };
  assert.equal(colliderContainsPoint(pole, 0.3, 0.3), true);
  assert.equal(colliderContainsPoint(pole, 0.45, 0.45), false);
  assert.equal(colliderContainsPoint({ minX: 0, maxX: 1, minZ: 0, maxZ: 1 }, 0.5, 0.5), true);
});

const box = (x, y, z, mode = 'car', heading = 0) => ({
  x, y, z, ...collisionBody(mode, mode === 'car' ? 1.35 : 0.48, heading)
});

test('collisionBody preserves circle, car, cargo bike, and drone footprints', () => {
  const person = collisionBody('person', 0.48, 0);
  assert.equal(person.radius, 0.48);
  assert.equal(person.extX, 0.48);
  assert.equal(person.top, 1.9);
  const car = collisionBody('car', 1.35, Math.PI / 2, 0, { width: 2, length: 5 });
  assert.equal(car.hx, 1);
  assert.equal(car.hz, 2.5);
  assert.ok(Math.abs(car.extX - 2.5) < 1e-10);
  assert.equal(collisionBody('cargobike', 0.65, 0).hz, 1.34);
  const cityBike = collisionBody('cyclist', 0.65, 0);
  assert.equal(cityBike.oriented, true);
  assert.deepEqual([cityBike.hx, cityBike.hz], [0.34, 0.95]);
  assert.equal(collisionBody('cargobike', 1.4, 0).offsetForward, -0.06);
  assert.deepEqual([collisionBody('drone', 0.4, 0).bottom, collisionBody('drone', 0.4, 0).top, collisionBody('drone', 0.4, 0).radius], [0, 0.3, 0.4]);
  assert.equal(collisionBody('car', 1.35, 0, 0, { height: 2.65 }).top, 2.65);
});

test('bodyContact returns the B-to-A normal for circles and uses a stable zero-distance direction', () => {
  const contact = {};
  assert.equal(bodyContact(box(0, 0, 0, 'person'), box(0.7, 0, 0, 'person'), contact), true);
  assert.deepEqual([contact.nx, contact.nz, contact.depth], [-1, 0, 0.26]);
  assert.equal(bodyContact(box(0, 0, 0, 'person'), box(0, 0, 0, 'person'), contact), true);
  assert.deepEqual([contact.nx, contact.nz], [1, 0]);
});

test('bodyContact uses exact oriented box and circle-to-box corner distance', () => {
  const contact = {};
  const sedan = box(0, 0, 0, 'car', Math.PI / 4);
  const pedestrian = box(1.8, 0, 2.1, 'person');
  assert.equal(bodyContact(pedestrian, sedan, contact), false, 'nearby projected bounds do not create a corner collision');
  const closer = box(0.9, 0, 1.6, 'person');
  assert.equal(bodyContact(closer, sedan, contact), true);
  const forward = { ...contact };
  assert.ok(Math.hypot(contact.nx, contact.nz) > 0.999999);
  assert.ok(contact.depth > 0);
  const reverse = {};
  assert.equal(bodyContact(sedan, closer, reverse), true);
  assert.ok(Math.abs(reverse.nx + forward.nx) < 1e-9 && Math.abs(reverse.nz + forward.nz) < 1e-9,
    'swapping argument order reverses the normal');
});

test('bodyContact ignores actors with separated vertical intervals', () => {
  const person = box(0, 0, 0, 'person');
  const drone = box(0.2, 4, 0, 'drone');
  assert.equal(bodyContact(person, drone, {}), false);
  const nearbyGroundBike = box(0.2, 0, 0, 'cyclist');
  const airbornePerson = { ...person, y: 2.2 };
  assert.equal(bodyContact(airbornePerson, nearbyGroundBike, {}), false);
});

test('legacy buildingContact keeps rounded corners and vertical overhang clearances', () => {
  const wall = { minX: 0, maxX: 10, minZ: 0, maxZ: 10, minY: 0, maxY: 10 };
  const person = collisionBody('person', 0.48, 0);
  const contact = {};
  assert.equal(buildingContact(wall, -0.4, 0, -0.4, person, contact), false);
  assert.equal(buildingContact(wall, -0.2, 0, -0.2, person, contact), true);
  assert.ok(Math.abs(Math.hypot(contact.nx, contact.nz) - 1) < 1e-10);
  assert.equal(buildingContact({ ...wall, minY: 4 }, 5, 0, 5, person, contact), false);
  assert.equal(buildingContact({ ...wall, maxY: 1.8 }, 5, 0, 5, person, contact), true);
});
