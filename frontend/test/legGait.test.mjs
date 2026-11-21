import assert from 'node:assert/strict';
import test from 'node:test';
import { createLegGait } from '../src/game/webcam/legGait.js';
import { cam, createGestureEngine, onGesture, webcamPace } from '../src/game/webcam/gestures.js';

function pose({ left = 0, right = 0, squat = 0, lean = 0 } = {}) {
  const points = [];
  for (const [shoulder, hip, knee, ankle, x, lift] of [[11, 23, 25, 27, 0.43, left], [12, 24, 26, 28, 0.57, right]]) {
    points[shoulder] = { x: x + lean, y: 0.23 + squat, visibility: 1 };
    points[hip] = { x, y: 0.47 + squat, visibility: 1 };
    points[knee] = { x, y: 0.68 - lift - squat / 2, visibility: 1 };
    points[ankle] = { x, y: 0.91 - lift, visibility: 1 };
  }
  return points;
}

function calibrate(gait) {
  for (let sample = 0; sample < 8; sample++) gait.update(pose(), sample * 50);
}

function lift(gait, time, side, amount = 0.07) {
  gait.update(pose({ [side]: amount }), time);
  gait.update(pose({ [side]: amount }), time + 50);
}

test('one small step starts walking and alternating steps keep it going', () => {
  const gait = createLegGait();
  calibrate(gait);
  lift(gait, 500, 'left', 0.025);
  assert.ok(gait.deadlines.moveUntil > 550);
  gait.update(pose(), 700);
  lift(gait, 950, 'right');
  assert.ok(gait.deadlines.moveUntil > 950);
  assert.equal(gait.deadlines.runUntil, 0);
  gait.update(pose(), 1050);
  assert.ok(gait.deadlines.moveUntil < 1600);
});

test('faster alternating steps sprint and return to walking at slower cadence', () => {
  const gait = createLegGait();
  calibrate(gait);
  lift(gait, 500, 'left');
  lift(gait, 800, 'right');
  lift(gait, 1100, 'left');
  assert.ok(gait.deadlines.runUntil > 1100);
  lift(gait, 1570, 'right');
  assert.equal(gait.deadlines.runUntil, 0);
  assert.ok(gait.deadlines.moveUntil > 1570);
});

test('bending and squatting do not start movement, and repeated same-side lifts do not sustain it', () => {
  const gait = createLegGait();
  calibrate(gait);
  gait.update(pose({ lean: 0.1, squat: 0.09 }), 500);
  gait.update(pose({ squat: 0.11 }), 650);
  assert.equal(gait.deadlines.moveUntil, 0);
  lift(gait, 800, 'left');
  const firstStep = gait.deadlines.moveUntil;
  gait.update(pose(), 950);
  lift(gait, 1120, 'left');
  assert.equal(gait.deadlines.moveUntil, firstStep);
});

test('losing either ankle clears movement immediately', () => {
  const gait = createLegGait();
  calibrate(gait);
  lift(gait, 500, 'left');
  lift(gait, 800, 'right');
  lift(gait, 1100, 'left');
  const obscured = pose();
  obscured[27].visibility = 0.1;
  gait.update(obscured, 1200);
  assert.deepEqual(gait.deadlines, { moveUntil: 0, runUntil: 0 });
});

test('a hand grab still fires while leg tracking reports forward movement', () => {
  let now = 0;
  const engine = createGestureEngine(() => now);
  const gestures = [];
  const unsubscribe = onGesture(gesture => gestures.push(gesture));
  const face = Array.from({ length: 455 }, () => ({ x: 0.5, y: 0.3 }));
  face[234] = { x: 0.43, y: 0.3 };
  face[454] = { x: 0.57, y: 0.3 };
  face[10] = { x: 0.5, y: 0.2 };
  face[152] = { x: 0.5, y: 0.4 };
  const fist = Array.from({ length: 21 }, () => ({ x: 0.45, y: 0.5 }));
  try {
    cam.enabled = true;
    engine.calibrate(0);
    for (let i = 0; i < 21; i++) { now = i * 50; engine.update(face, [], pose()); }
    now = 1100;
    engine.update(face, [], pose({ left: 0.07 }));
    now = 1150;
    engine.update(face, [], pose({ left: 0.07 }));
    now = 1410;
    engine.update(face, [], pose({ right: 0.07 }));
    now = 1460;
    engine.update(face, [fist], pose({ right: 0.07 }));
    assert.equal(webcamPace(now), 1);
    assert.ok(gestures.includes('fist'));
  } finally {
    unsubscribe();
    cam.enabled = false;
  }
});
