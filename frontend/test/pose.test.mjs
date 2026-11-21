// Full-body webcam engine (F3, N5, N7) driven by synthetic 33-landmark MediaPipe pose sequences.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPoseEngine, P } from '../src/game/webcam/pose.js';
import { cam, onGesture } from '../src/game/webcam/gestures.js';

const FPS = 30;

// A neutral standing pose in unmirrored image coords (player's left at larger x). Torso length = 0.2.
function standing(o = {}) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.25, z: 0, visibility: 0.99 }));
  const set = (i, x, y, z = 0) => { lm[i] = { x, y, z, visibility: 0.99 }; };
  const hipDrop = o.hipDrop ?? 0; // squat
  const yaw = o.yaw ?? 0; // + = player turns to their left
  const half = 0.07 * Math.cos(yaw), dz = 0.07 * Math.sin(yaw);
  set(P.nose, 0.5, 0.2);
  set(P.lShoulder, 0.5 + half, 0.3 + hipDrop * 0.8, dz);
  set(P.rShoulder, 0.5 - half, 0.3 + hipDrop * 0.8, -dz);
  set(P.lHip, 0.54, 0.5 + hipDrop);
  set(P.rHip, 0.46, 0.5 + hipDrop);
  const kl = o.kneeL ?? 0, kr = o.kneeR ?? 0; // knee lift (image units)
  set(P.lKnee, 0.545, 0.68 - kl + hipDrop * 0.4);
  set(P.rKnee, 0.455, 0.68 - kr + hipDrop * 0.4);
  set(P.lAnkle, 0.545, 0.86 - kl * 0.8);
  set(P.rAnkle, 0.455, 0.86 - kr * 0.8);
  const sy = 0.3 + hipDrop * 0.8;
  for (const [side, sx, sgn] of [['l', 0.5 + half, 1], ['r', 0.5 - half, -1]]) {
    const arm = o[side] ?? 'rest';
    let e, w, wz = 0;
    if (arm === 'rest') { e = [sx + 0.01 * sgn, sy + 0.1]; w = [sx + 0.015 * sgn, sy + 0.2]; }
    else if (arm === 'forward') { e = [sx, sy + 0.03]; w = [sx - 0.01 * sgn, sy + 0.05]; wz = -0.15; } // toward the camera
    else if (arm === 'out') { e = [sx + 0.1 * sgn, sy + 0.01]; w = [sx + 0.19 * sgn, sy + 0.02]; }
    else if (arm === 'low') { e = [sx + 0.01 * sgn, sy + 0.12]; w = [sx + 0.01 * sgn, sy + 0.25]; }
    set(side === 'l' ? P.lElbow : P.rElbow, e[0], e[1]);
    set(side === 'l' ? P.lWrist : P.rWrist, w[0], w[1], wz);
    set(side === 'l' ? P.lIndex : P.rIndex, w[0], w[1] + 0.02, wz);
    set(side === 'l' ? P.lPinky : P.rPinky, w[0] + 0.01 * sgn, w[1] + 0.02, wz);
  }
  return lm;
}

function rig() {
  let t = 0;
  const eng = createPoseEngine(() => t);
  const got = [];
  const off = onGesture((n) => got.push(n));
  const step = (lm, frames = 1) => { for (let i = 0; i < frames; i++) { t += 1000 / FPS; eng.update(typeof lm === 'function' ? lm(t) : lm); } };
  eng.calibrate();
  step(standing(), 50); // ~1.7 s standing still
  assert.equal(cam.calibrated, true);
  assert.equal(cam.status, 'tracking');
  got.length = 0;
  return { eng, got, step, off, now: () => t };
}

test('pose: alternating knee lifts drive forward, and it stops within ~0.5 s', () => {
  const r = rig();
  // ~3 steps/s: each knee up 0.07 (0.35 torso lengths), alternating
  const run = (t) => { const ph = Math.sin((t / 1000) * Math.PI * 3); return standing({ kneeL: Math.max(0, ph) * 0.07, kneeR: Math.max(0, -ph) * 0.07 }); };
  r.step(run, 60);
  assert.ok(cam.forward > 0.3, `forward ${cam.forward}`);
  assert.equal(cam.body.running, true);
  assert.deepEqual(r.got.filter((g) => g === 'fist'), [], 'arm swing while running does not grab');
  r.step(standing(), Math.round(0.6 * FPS));
  assert.equal(cam.forward, 0);
  r.off();
});

test('pose: standing still gives no movement and no gestures', () => {
  const r = rig();
  // tiny landmark jitter
  r.step((t) => standing({ kneeL: 0.004 * Math.sin(t / 37), kneeR: 0.004 * Math.cos(t / 53), yaw: 0.02 * Math.sin(t / 91) }), 120);
  assert.equal(cam.forward, 0);
  assert.equal(cam.turn, 0);
  assert.equal(cam.palmPush, false);
  assert.deepEqual(r.got, []);
  r.off();
});

test('pose: a sustained torso turn steers with the right sign and settles when facing forward', () => {
  const r = rig();
  r.step(standing({ yaw: 0.8 }), 60); // turn to the left (past the ~17 degree deadzone)
  assert.ok(cam.turn > 0.3, `turn left ${cam.turn}`);
  // rate-limited: per-frame change never exceeds turnAccel * dt
  let prev = cam.turn, maxJump = 0;
  for (let i = 0; i < 45; i++) { r.step(standing()); maxJump = Math.max(maxJump, Math.abs(cam.turn - prev)); prev = cam.turn; }
  assert.equal(cam.turn, 0, 'settles to 0');
  assert.ok(maxJump <= 2.5 / FPS + 1e-9, `jump ${maxJump}`);
  r.step(standing({ yaw: -0.8 }), 60); // turn to the right
  assert.ok(cam.turn < -0.3, `turn right ${cam.turn}`);
  r.step(standing(), 60);
  assert.equal(cam.turn, 0);
  r.off();
});

test('pose: a small heading wobble stays inside the deadzone', () => {
  const r = rig();
  r.step((t) => standing({ yaw: 0.25 * Math.sin(t / 120) }), 90); // normal swaying
  assert.equal(cam.turn, 0);
  r.off();
});

test('pose: reaching toward the screen or out to the side grabs', () => {
  const r = rig();
  r.step(standing({ r: 'forward' }), 10);
  assert.deepEqual(r.got, ['fist']);
  r.step(standing(), 30);
  r.got.length = 0;
  r.step(standing({ l: 'out' }), 10);
  assert.deepEqual(r.got, ['fist']);
  r.off();
});

test('pose: holding a press gives palmPush, continuously', () => {
  const r = rig();
  r.step(standing({ l: 'forward' }), 20);
  assert.ok(r.got.includes('palmPush'));
  assert.equal(cam.palmPush, true);
  assert.equal(r.got.filter((g) => g === 'palmPush').length, 1, 'one event per press');
  r.step(standing(), 3);
  assert.equal(cam.palmPush, false);
  r.off();
});

test('pose: a squat, even with arms forward for balance, does not grab', () => {
  const r = rig();
  // drop the hips over 0.5 s with arms going forward, hold, come back up, lower arms
  r.step((t) => standing({ hipDrop: 0.03 }), 4);
  r.step(standing({ hipDrop: 0.1, l: 'forward', r: 'forward' }), 30);
  r.step(standing({ hipDrop: 0.03, l: 'forward', r: 'forward' }), 4);
  r.step(standing(), 30);
  assert.ok(!r.got.includes('fist'), `got ${r.got}`);
  r.off();
});

test('pose: lowering both hands after a reach places (pushDown); waving above the shoulder is a wave', () => {
  const r = rig();
  r.step(standing({ l: 'forward', r: 'forward' }), 10);
  r.step(standing({ l: 'low', r: 'low' }), 8);
  assert.ok(r.got.includes('pushDown'), `got ${r.got}`);
  r.step(standing(), 30);
  r.got.length = 0;
  // right hand above the shoulder swinging sideways
  r.step((t) => {
    const lm = standing();
    const x = 0.36 + 0.05 * Math.sin((t / 1000) * Math.PI * 4);
    lm[P.rWrist] = { x, y: 0.18, z: 0, visibility: 0.99 };
    lm[P.rElbow] = { x: 0.4, y: 0.26, z: 0, visibility: 0.99 };
    return lm;
  }, 45);
  assert.ok(r.got.includes('wave'), `got ${r.got}`);
  // a raised hand is also the body-mode "use" gesture, so 'fist' may fire too; LocalPlayer applies it to the focus
  r.off();
});

test('pose: tracked hands follow the wrists and keep their sides', () => {
  const r = rig();
  r.step(standing(), 1);
  const [a, b] = cam.frame.hands;
  assert.equal(cam.frame.hands.length, 2);
  assert.equal(a.length, 21);
  assert.ok(a[0].x > 0.5 && b[0].x < 0.5, 'left hand on the image right (unmirrored)');
  const restY = a[9].y;
  r.step(standing({ l: 'out' }), 1);
  assert.ok(cam.frame.hands[0][9].y < restY, 'raised hand moves up in view');
  r.off();
});

test('pose: missing or low-visibility landmarks mean tracking lost and no movement', () => {
  const r = rig();
  const run = (t) => { const ph = Math.sin((t / 1000) * Math.PI * 3); return standing({ kneeL: Math.max(0, ph) * 0.07, kneeR: Math.max(0, -ph) * 0.07 }); };
  r.step(run, 60);
  assert.ok(cam.forward > 0.3);
  r.step(null, 1);
  assert.equal(cam.status, 'lost');
  assert.equal(cam.forward, 0);
  assert.equal(cam.turn, 0);
  r.step(run, 30);
  const lm = standing();
  lm[P.lHip] = { ...lm[P.lHip], visibility: 0.1 };
  r.step(lm, 1);
  assert.equal(cam.status, 'lost');
  assert.equal(cam.forward, 0);
  r.step(standing(), 1);
  assert.equal(cam.status, 'tracking');
  r.off();
});

test('pose: calibration needs only the upper body (legs out of frame)', () => {
  let t = 0;
  const eng = createPoseEngine(() => t);
  eng.calibrate();
  const noLegs = standing();
  for (const i of [P.lKnee, P.rKnee, P.lAnkle, P.rAnkle]) noLegs[i] = { ...noLegs[i], visibility: 0.05 };
  for (let i = 0; i < 60; i++) { t += 33; eng.update(noLegs); }
  assert.equal(cam.calibrated, true);
  assert.ok(Math.abs(eng.base.torso - 0.2) < 1e-6);
});

// Walking arm swing with the legs out of frame: wrists alternate forward/up and back/down.
function swinging(t, hz = 0.9, amp = 0.03) {
  const lm = standing();
  for (const i of [P.lKnee, P.rKnee, P.lAnkle, P.rAnkle]) lm[i] = { ...lm[i], visibility: 0.05 };
  const ph = Math.sin((t / 1000) * Math.PI * 2 * hz);
  for (const [w, sgn] of [[P.lWrist, 1], [P.rWrist, -1]]) lm[w] = { ...lm[w], y: lm[w].y - ph * sgn * amp, z: -ph * sgn * amp };
  return lm;
}

test('pose: swinging the arms like walking moves forward without the legs in view, and stops when they stop', () => {
  const r = rig();
  for (const i of [P.lKnee, P.rKnee, P.lAnkle, P.rAnkle]) assert.ok(true, i);
  r.step((t) => swinging(t), 75); // 2.5 s at a relaxed walking swing (~1.8 swings/s)
  assert.ok(cam.forward > 0.4, `forward ${cam.forward}`);
  assert.equal(cam.body.running, true);
  assert.deepEqual(r.got.filter((g) => g === 'fist'), [], 'walking arms do not grab');
  r.step(standing(), Math.round(0.9 * FPS));
  assert.equal(cam.forward, 0);
  r.off();
});

test('pose: a single arm movement (one swing) does not walk', () => {
  const r = rig();
  r.step((t) => swinging(Math.min(t % 100000, 0) + 250), 20); // one arm forward, held
  assert.equal(cam.forward, 0);
  r.off();
});

test('pose: raising a hand to shoulder height and holding it is a use (fist), once per raise', () => {
  const r = rig();
  const raised = () => { const lm = standing(); lm[P.rWrist] = { ...lm[P.rWrist], x: 0.42, y: 0.29 }; lm[P.rElbow] = { ...lm[P.rElbow], x: 0.41, y: 0.36 }; return lm; };
  r.step(raised(), 5); // 170 ms: not yet
  assert.deepEqual(r.got, []);
  r.step(raised(), 20);
  assert.deepEqual(r.got, ['fist']);
  r.step(standing(), 10);
  r.step(raised(), 20);
  assert.deepEqual(r.got, ['fist', 'fist']);
  r.off();
});

test('pose: walking arm swing at normal size does not make the player move from small sways', () => {
  const r = rig();
  r.step((t) => swinging(t, 0.9, 0.008), 90); // tiny arm sway
  assert.equal(cam.forward, 0);
  r.off();
});

test('pose: with only the upper body in frame (jittery guessed legs), raising a hand still grabs', () => {
  let t = 0;
  const eng = createPoseEngine(() => t);
  const got = [];
  const off = onGesture((n) => got.push(n));
  const ghostLegs = (lm, k) => {
    // MediaPipe's guesses for off-frame legs: low-ish visibility, jumping around
    const j = (i, a) => ({ ...lm[i], y: lm[i].y + a * Math.sin(k * 1.7 + i), visibility: 0.4 + 0.2 * Math.abs(Math.sin(k + i)) });
    for (const i of [P.lKnee, P.rKnee, P.lAnkle, P.rAnkle]) lm[i] = j(i, 0.06);
    return lm;
  };
  eng.calibrate();
  for (let k = 0; k < 60; k++) { t += 33; eng.update(ghostLegs(standing(), k)); }
  assert.equal(cam.calibrated, true);
  // the player also steps a little closer to the laptop: hips sit lower in the image (used to read as a squat)
  const closer = (k) => { const lm = ghostLegs(standing(), k); for (const i of [P.lHip, P.rHip]) lm[i] = { ...lm[i], y: lm[i].y + 0.06 }; return lm; };
  for (let k = 0; k < 30; k++) { t += 33; eng.update(closer(k)); }
  assert.equal(cam.forward, 0, 'ghost legs do not walk');
  got.length = 0;
  for (let k = 0; k < 20; k++) {
    t += 33;
    const lm = closer(k);
    lm[P.rWrist] = { ...lm[P.rWrist], x: 0.42, y: 0.28 };
    lm[P.rElbow] = { ...lm[P.rElbow], x: 0.41, y: 0.36 };
    eng.update(lm);
  }
  assert.deepEqual(got, ['fist']);
  off();
});
