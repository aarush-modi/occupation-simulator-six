import assert from 'node:assert/strict';
import test from 'node:test';
import { DIAL, dialInput } from '../src/game/webcam/dial.js';
import { cam, createGestureEngine } from '../src/game/webcam/gestures.js';

// An open hand rotated by `angle` in the unmirrored image (+ = clockwise in the image).
function hand(angle) {
  const c = { x: 0.6, y: 0.5 };
  const rot = (x, y) => ({ x: c.x + x * Math.cos(angle) - y * Math.sin(angle), y: c.y + x * Math.sin(angle) + y * Math.cos(angle), z: 0 });
  const lm = Array.from({ length: 21 }, () => rot(0, 0));
  lm[0] = rot(0, 0.08);
  const xs = [0.03, 0.01, -0.01, -0.03];
  [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]].forEach((f, i) => f.forEach((j, k) => { lm[j] = rot(xs[i], -k * 0.03); }));
  [1, 2, 3, 4].forEach((j, k) => { lm[j] = rot(0.04 + k * 0.015, 0.05 - k * 0.01); });
  return lm;
}

test('dial: a held tilt keeps giving input, and the first tilt seen is neutral', () => {
  const state = { neutral: null, side: null, seen: -Infinity };
  assert.equal(dialInput(state, { side: 'right', roll: 0.3 }, 0), 0);
  // the player sees the mirrored preview, so a clockwise turn there lowers the image angle
  const held = [100, 500, 2000].map(t => dialInput(state, { side: 'right', roll: 0.3 - 0.4 }, t));
  for (const value of held) assert.ok(value > 0.5, `held clockwise input ${value}`);
  assert.ok(dialInput(state, { side: 'right', roll: 0.3 + 0.4 }, 2100) < -0.5);
  assert.equal(dialInput(state, { side: 'right', roll: 0.3 + DIAL.dead / 2 }, 2200), 0, 'small wobble is ignored');
});

test('dial: losing the hand resets neutral after a pause, and switching hands resets it at once', () => {
  const state = { neutral: null, side: null, seen: -Infinity };
  dialInput(state, { side: 'right', roll: 1 }, 0);
  assert.equal(dialInput(state, null, 300), 0);
  assert.equal(state.neutral, 1, 'a short dropout keeps neutral');
  dialInput(state, null, 300 + DIAL.forgetMs + 1);
  assert.equal(state.neutral, null);
  dialInput(state, { side: 'right', roll: 1 }, 2000);
  assert.equal(dialInput(state, { side: 'left', roll: 2 }, 2100), 0, 'the new hand starts at neutral');
});

test('dial: the seated engine reports the current tilt of a held hand every frame', () => {
  let now = 0;
  const engine = createGestureEngine(() => now);
  try {
    cam.enabled = true;
    cam.mode = 'seated';
    engine.calibrate(0);
    for (; now < 400; now += 33) engine.update(null, [hand(0)], undefined, ['right']);
    const level = cam.dial.roll;
    for (; now < 2000; now += 33) engine.update(null, [hand(-0.5)], undefined, ['right']);
    assert.equal(cam.dial.side, 'right');
    assert.ok(Math.abs(cam.dial.roll - level + 0.5) < 0.05, `held tilt ${cam.dial.roll - level}`);
    engine.update(null, [], undefined, []);
    assert.equal(cam.dial, null);
  } finally {
    cam.enabled = false;
    cam.mode = 'body';
  }
});
