import assert from 'node:assert/strict';
import test from 'node:test';
import { Vector3 } from 'three';
import { handPoints, restingFingers, solveElbow, trackedFingers, trackedWrist } from '../src/game/handPose.js';

test('the elbow bends with fixed limb lengths even when a target is out of reach', () => {
  const shoulder = new Vector3(0.22, -0.24, 0);
  const elbow = new Vector3(), axis = new Vector3(), pole = new Vector3();
  for (const wrist of [new Vector3(0.15, -0.3, -0.4), new Vector3(1.1, -0.6, -2), shoulder.clone()]) {
    solveElbow(shoulder, wrist, elbow, new Vector3(0.6, -1, 0.2), 0.32, 0.30, axis, pole);
    assert.ok(Math.abs(elbow.distanceTo(shoulder) - 0.32) < 1e-7);
    assert.ok(Math.abs(elbow.distanceTo(wrist) - 0.30) < 1e-7);
  }
});

test('finger retargeting preserves the bend when wrist-relative depth is available', () => {
  const relaxed = handPoints(), closed = handPoints(), rendered = handPoints();
  restingFingers(relaxed, 'right', 0);
  restingFingers(closed, 'right', 0.8);
  const mediaPipe = closed.map(p => ({ x: 0.02 - p.x, y: 0.01 - p.y, z: p.z + 0.1 }));
  assert.equal(trackedFingers(rendered, mediaPipe, mediaPipe, 4 / 3), true);
  assert.equal(rendered[0].lengthSq(), 0);
  assert.ok(rendered[12].distanceTo(closed[12]) < 0.006);
  assert.ok(rendered[12].y < relaxed[12].y - 0.03);
});

test('a bigger projected palm extends the wrist rather than scaling up the fingers', () => {
  const near = handPoints(), far = handPoints();
  near[0].set(0.66, 0.62, 0);
  near[9].set(0.68, 0.49, -0.04);
  far[0].copy(near[0]);
  far[9].copy(near[0]).lerp(near[9], 0.55);
  const nearerWrist = trackedWrist(new Vector3(), near, 0.16, 4 / 3);
  const fartherWrist = trackedWrist(new Vector3(), far, 0.16, 4 / 3);
  assert.ok(nearerWrist.z < fartherWrist.z);
  assert.ok(nearerWrist.x < 0 && fartherWrist.x < 0);
  const nearerJoints = handPoints(), fartherJoints = handPoints();
  assert.ok(trackedFingers(nearerJoints, near, null, 4 / 3));
  assert.ok(trackedFingers(fartherJoints, far, null, 4 / 3));
  assert.ok(nearerJoints[9].distanceTo(fartherJoints[9]) < 1e-7);
});
