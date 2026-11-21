import assert from 'node:assert/strict';
import test from 'node:test';
import { createShoulderMovement } from '../src/game/webcam/shoulderMovement.js';
import { cam, createGestureEngine, onGesture, webcamPace } from '../src/game/webcam/gestures.js';

function upperBody({ left = 0, right = left, pitch = 0, shift = 0 } = {}) {
  const points = [];
  points[0] = { x: 0.50, y: 0.37 + pitch + shift, visibility: 1 };
  points[2] = { x: 0.46, y: 0.31 + shift, visibility: 1 };
  points[5] = { x: 0.54, y: 0.31 + shift, visibility: 1 };
  points[11] = { x: 0.29, y: 0.61 - left + shift, z: 0, visibility: 1 };
  points[12] = { x: 0.71, y: 0.61 - right + shift, z: 0, visibility: 1 };
  return points;
}

function calibrate(movement) {
  for (let time = 0; time < 400; time += 50) movement.update(upperBody(), time);
  assert.equal(movement.status, 'ready');
}

test('a sustained small shrug starts movement using only upper-body landmarks', () => {
  const movement = createShoulderMovement();
  calibrate(movement);
  movement.update(upperBody({ left: 0.045 }), 500);
  assert.equal(movement.deadlines.moveUntil, 0);
  movement.update(upperBody({ left: 0.045 }), 655);
  assert.ok(movement.deadlines.moveUntil > 655);
  assert.equal(movement.deadlines.runUntil, 0);
  movement.update(upperBody(), 700);
  assert.equal(movement.deadlines.moveUntil, 0);
});

test('a larger held shrug sprints and a smaller lift walks again', () => {
  const movement = createShoulderMovement();
  calibrate(movement);
  for (let time = 500; time <= 1000; time += 50) movement.update(upperBody({ left: 0.089 }), time);
  assert.ok(movement.deadlines.runUntil > 1000);
  movement.update(upperBody({ left: 0.05 }), 1050);
  assert.ok(movement.deadlines.moveUntil > 1050);
  assert.equal(movement.deadlines.runUntil, 0);
});

test('a one-sided reach, shifting the torso, and looking down do not start movement', () => {
  const movement = createShoulderMovement();
  calibrate(movement);
  for (let time = 500; time < 800; time += 50) movement.update(upperBody({ left: 0.065, right: 0 }), time);
  for (let time = 800; time < 1100; time += 50) movement.update(upperBody({ shift: 0.1 }), time);
  for (let time = 1100; time < 1400; time += 50) movement.update(upperBody({ left: 0.05, pitch: 0.05 }), time);
  assert.equal(movement.deadlines.moveUntil, 0);
});

test('losing a shoulder clears motion immediately', () => {
  const movement = createShoulderMovement();
  calibrate(movement);
  movement.update(upperBody({ left: 0.05 }), 500);
  movement.update(upperBody({ left: 0.05 }), 650);
  const obscured = upperBody();
  obscured[11].visibility = 0.12;
  movement.update(obscured, 700);
  assert.deepEqual(movement.deadlines, { moveUntil: 0, runUntil: 0 });
});

test('raising both shoulders produces a start gesture and pinching still works while walking', () => {
  let now = 0;
  const engine = createGestureEngine(() => now);
  const events = [];
  const unsubscribe = onGesture(name => events.push(name));
  const hand = Array.from({ length: 21 }, () => ({ x: 0.61, y: 0.6 }));
  hand[5] = { x: 0.63, y: 0.57 };
  hand[17] = { x: 0.58, y: 0.57 };
  hand[10] = { x: 0.60, y: 0.54 };
  hand[12] = { x: 0.60, y: 0.51 };
  hand[4] = { x: 0.64, y: 0.54 };
  hand[8] = { x: 0.642, y: 0.543 };
  try {
    cam.enabled = true;
    cam.mode = 'seated';
    engine.calibrate(0);
    for (; now < 500; now += 50) engine.update(null, [], upperBody());
    for (; now < 750; now += 50) engine.update(null, [], upperBody({ left: 0.045 }));
    engine.update(null, [hand], upperBody({ left: 0.045 }));
    assert.equal(webcamPace(now), 1);
    assert.deepEqual(events.filter(name => ['move', 'pinch'].includes(name)), ['move', 'pinch']);
    assert.equal(webcamPace(now + 350), 0);
  } finally {
    unsubscribe();
    cam.enabled = false;
    cam.mode = 'body';
  }
});

test('two raised open palms guard and a growing fist triggers a virtual strike', () => {
  let now = 0;
  const engine = createGestureEngine(() => now);
  const events = [];
  const unsubscribe = onGesture(name => events.push(name));
  const hand = (x, size, open) => {
    const lm = Array.from({ length: 21 }, () => ({ x, y: 0.53 }));
    for (const [i, knuckle] of [5, 9, 13, 17].entries()) {
      const fingerX = x + (i - 1.5) * size * 0.24;
      lm[knuckle] = { x: fingerX, y: 0.53 - size };
      lm[knuckle + 1] = { x: fingerX, y: 0.53 - size * 1.25 };
      lm[knuckle + 3] = { x: fingerX, y: 0.53 - size * (open ? 2 : 1.1) };
    }
    return lm;
  };
  try {
    engine.calibrate(0);
    engine.update(null, [hand(0.40, 0.04, true), hand(0.60, 0.04, true)], undefined);
    assert.equal(cam.guard, true);
    now = 50;
    engine.update(null, [hand(0.60, 0.04, false)], undefined);
    assert.equal(cam.guard, false);
    now = 175;
    engine.update(null, [hand(0.60, 0.07, false)], undefined);
    assert.ok(events.includes('strike'));
    engine.update(null, [], undefined);
    assert.equal(cam.guard, false);
  } finally {
    unsubscribe();
    engine.calibrate(0);
  }
});
