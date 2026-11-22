import assert from 'node:assert/strict';
import test from 'node:test';
import { closeUp, isMachineWork, updateWorkView, workView, WORK_RANGE } from '../src/engine/workView.js';

const frame = { pos: [0, 0, -4.7], rotY: 0 }; // back-wall station facing +z
const press = { id: 'press:espresso.brew', kind: 'press', station: 'espresso', target: 'espresso.brew', pos: [0.3, 1.3, -4.4] };

test('machine work is a press, a trade action, or seating something in a station', () => {
  assert.equal(isMachineWork(press), true);
  assert.equal(isMachineWork({ kind: 'use', station: 'bar', pos: [0, 1, 0] }), true);
  assert.equal(isMachineWork({ kind: 'place', station: 'bar', target: 'bar.glass' }), true);
  assert.equal(isMachineWork({ kind: 'place', target: 'S3' }), false, 'putting something on a counter is not');
  assert.equal(isMachineWork({ kind: 'grab', station: 'bar' }), false);
});

test('the close-up sits in front of the machine, above the part, looking at it', () => {
  const { eye, look } = closeUp(press, frame, 0.8);
  assert.deepEqual(look, press.pos);
  assert.ok(eye[2] > look[2] + 0.5, 'in front of the station face');
  assert.ok(eye[1] > look[1], 'looking slightly down at it');
  assert.equal(eye[0], look[0]);
});

test('walking up zooms in, walking breaks out, and stepping away re-arms it', () => {
  workView.key = null; workView.out = null;
  const at = (distance, walking = false, stepId = 's1') => updateWorkView({ it: press, stepId, distance, walking, frame, depth: 0.8 });
  assert.equal(at(WORK_RANGE + 0.5), null, 'too far');
  assert.ok(at(1.5), 'close: zoomed in');
  assert.equal(at(1.5, true), null, 'walking breaks out');
  assert.equal(at(1.4), null, 'stays out while still close');
  assert.equal(at(WORK_RANGE + 1.5), null);
  assert.ok(at(1.5), 'came back: zooms in again');
  at(1.5, true);
  assert.ok(at(1.5, false, 's2'), 'the next step can zoom straight away');
  assert.equal(updateWorkView({ it: null, stepId: 's2', distance: 1, walking: false, frame }), null);
});
