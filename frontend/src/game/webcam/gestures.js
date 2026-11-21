// Pure gesture + head-control engine. Input: MediaPipe landmarks (normalized image coords, unmirrored).
// Output: continuous control values in `cam` and discrete gesture events via onGesture().

export const cam = {
  enabled: false,
  calibrated: false,
  mode: 'body', // body (full-body pose) | seated (face + hands)
  status: 'off', // off | loading | calibrating | tracking | lost | error
  error: null,
  face: false,
  hands: 0,
  forward: 0, // -0.6..1 from lean
  turn: 0, // rad/s, + = turn left
  pitch: 0, // target pitch (rad)
  wheel: 0, // accumulated wheel input, consumed by skills
  palmPush: false,
  lastGesture: null,
  frame: null, // last raw frame for the preview
};

const listeners = new Set();
export function onGesture(cb) { listeners.add(cb); return () => listeners.delete(cb); }
// Shared by the seated (face + hands) engine and the full-body pose engine (pose.js).
export function emitGesture(name, t) {
  cam.lastGesture = { name, t };
  for (const cb of listeners) cb(name);
}

export const TUNE = {
  leanFwd: 1.08, leanFwdFull: 1.22, leanBack: 0.92, leanBackFull: 0.82,
  yawDead: 0.07, yawGain: 5.0, turnMax: 1.6,
  pitchGain: 3.2, pitchMax: 0.7,
  fingerExt: 1.15, // tip-to-wrist vs pip-to-wrist ratio for an extended finger
  palmPush: 0.95, // palm length / face width when pushed toward the camera
  wheelSign: -1,
  cooldownMs: 700,
};

const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function handFeatures(lm) {
  const wrist = lm[0];
  const ext = (tip, pip) => d2(lm[tip], wrist) > d2(lm[pip], wrist) * TUNE.fingerExt;
  const index = ext(8, 6), middle = ext(12, 10), ring = ext(16, 14), pinky = ext(20, 18);
  const thumb = d2(lm[4], lm[17]) > d2(lm[3], lm[17]) * 1.05 && d2(lm[4], lm[5]) > d2(lm[0], lm[5]) * 0.45;
  const count = index + middle + ring + pinky;
  const palm = d2(lm[0], lm[9]);
  const center = { x: (lm[0].x + lm[5].x + lm[9].x + lm[13].x + lm[17].x) / 5, y: (lm[0].y + lm[5].y + lm[9].y + lm[13].y + lm[17].y) / 5 };
  const roll = Math.atan2(lm[17].y - lm[5].y, lm[17].x - lm[5].x);
  const top = Math.min(lm[4].y, lm[8].y, lm[12].y, lm[16].y, lm[20].y, lm[5].y, lm[9].y);
  return {
    center, palm, roll, count, thumb, top,
    fist: count === 0,
    open: count >= 4,
    one: index && !middle && !ring && !pinky,
    two: index && middle && !ring && !pinky,
  };
}

export function faceFeatures(lm) {
  const top = lm[10], chin = lm[152], l = lm[234], r = lm[454], nose = lm[1];
  const width = d2(l, r);
  const height = d2(top, chin);
  const midX = (l.x + r.x) / 2;
  const eyeY = (lm[33].y + lm[263].y) / 2;
  return {
    width, height, eyeY, top: top.y, chin: chin.y, cx: midX, cy: (top.y + chin.y) / 2,
    yaw: (nose.x - midX) / width, // + when user turns to their left (unmirrored image)
    pitch: (nose.y - eyeY) / height,
  };
}

export function createGestureEngine(now = () => performance.now()) {
  const base = { width: 0, yaw: 0, pitch: 0, n: 0 };
  const hist = []; // { t, hands: [features] }
  const last = {}; // cooldowns
  const holds = {}; // gesture -> start time
  let prevFist = [false, false];
  let prevRoll = null;
  let calibUntil = 0;

  function emit(name, t) {
    if (last[name] && t - last[name] < TUNE.cooldownMs) return;
    last[name] = t;
    emitGesture(name, t);
  }
  function held(name, cond, ms, t) {
    if (!cond) { delete holds[name]; return false; }
    if (!holds[name]) holds[name] = t;
    if (t - holds[name] >= ms) { delete holds[name]; return true; }
    return false;
  }

  return {
    // Calibration needs both a minimum time and enough face samples, so a slow model warm-up can't leave it stuck.
    calibrate(ms = 1500) { base.width = 0; base.yaw = 0; base.pitch = 0; base.n = 0; calibUntil = now() + ms; cam.calibrated = false; cam.status = 'calibrating'; },
    get calibrating() { return !cam.calibrated; },
    base,
    update(faceLm, handsLm) {
      const t = now();
      const face = faceLm ? faceFeatures(faceLm) : null;
      const hands = (handsLm || []).map(handFeatures);
      cam.face = !!face;
      cam.hands = hands.length;

      // calibration: average neutral face until the time has passed and we have 20 samples
      if (!cam.calibrated && (t < calibUntil || base.n < 20)) {
        if (face) {
          base.n++;
          base.width += (face.width - base.width) / base.n;
          base.yaw += (face.yaw - base.yaw) / base.n;
          base.pitch += (face.pitch - base.pitch) / base.n;
        }
        cam.forward = 0; cam.turn = 0;
        return;
      }
      if (!cam.calibrated) { cam.calibrated = true; cam.status = 'tracking'; }

      // head controls
      if (face) {
        cam.status = 'tracking';
        const r = face.width / base.width;
        if (r > TUNE.leanFwd) cam.forward = Math.min(1, (r - TUNE.leanFwd) / (TUNE.leanFwdFull - TUNE.leanFwd));
        else if (r < TUNE.leanBack) cam.forward = -0.6 * Math.min(1, (TUNE.leanBack - r) / (TUNE.leanBack - TUNE.leanBackFull));
        else cam.forward = 0;
        const dy = face.yaw - base.yaw;
        const mag = Math.max(0, Math.abs(dy) - TUNE.yawDead);
        cam.turn = Math.sign(dy) * Math.min(TUNE.turnMax, mag * TUNE.yawGain);
        cam.pitch = Math.max(-TUNE.pitchMax, Math.min(TUNE.pitchMax, -(face.pitch - base.pitch) * TUNE.pitchGain));
      } else {
        cam.status = 'lost';
        cam.forward = 0; cam.turn = 0;
      }

      // history for motion gestures
      hist.push({ t, hands });
      while (hist.length && t - hist[0].t > 1600) hist.shift();

      // palm push (continuous)
      const fw = face?.width ?? base.width;
      const pushing = hands.some((h) => h.open && h.palm / fw > TUNE.palmPush);
      // discrete palmPush event once the push has been held briefly (continuous value stays in cam.palmPush)
      if (pushing && held('palmPush', true, 250, t)) emit('palmPush', t);
      if (!pushing) delete holds.palmPush;
      cam.palmPush = pushing;

      // wheel: roll delta of the first hand
      if (hands[0]) {
        const roll = hands[0].roll;
        if (prevRoll != null) {
          let dr = roll - prevRoll;
          if (dr > Math.PI) dr -= Math.PI * 2;
          if (dr < -Math.PI) dr += Math.PI * 2;
          if (Math.abs(dr) < 0.6) cam.wheel += dr * TUNE.wheelSign;
        }
        prevRoll = roll;
      } else prevRoll = null;

      // fist snap (any hand goes from not-fist to fist)
      hands.forEach((h, i) => { if (h.fist && !prevFist[i]) emit('fist', t); });
      // fist release: a hand that was a fist opens up again (let go of what it was holding)
      hands.forEach((h, i) => { if (prevFist[i] && !h.fist && h.count >= 3) emit('release', t); });
      prevFist = [hands[0]?.fist ?? false, hands[1]?.fist ?? false];

      if (face) {
        // A hand is "on the head" when its highest point (fingertips/knuckles) is above the hairline
        // and its centre is above eye level, horizontally near the face. One hand is enough, because
        // the other often leaves the frame or is not detected against hair.
        const onHead = (h) => h.top < face.top + face.height * 0.1 && h.center.y < face.eyeY && Math.abs(h.center.x - face.cx) < face.width * 1.3;
        const onHeadCount = hands.filter(onHead).length;
        cam.debug = { onHead: onHeadCount, hands: hands.length };
        if (held('handsOnHead', onHeadCount >= 1, 400, t)) emit('handsOnHead', t);
        const close = hands.length >= 2 && d2(hands[0].center, hands[1].center) < face.width * 0.75;
        if (held('rub', close && !hands.some(onHead), 600, t)) emit('rub', t);
        const twoFists = hands.length >= 2 && hands[0].fist && hands[1].fist && d2(hands[0].center, hands[1].center) < face.width * 1.8;
        if (held('twoFists', twoFists, 250, t)) emit('twoFists', t);
      }

      // push down with two fists: average y rose by > 0.12 within 700ms
      if (hands.length >= 2 && hands[0].fist && hands[1].fist) {
        const y = (hands[0].center.y + hands[1].center.y) / 2;
        const past = hist.find((h) => t - h.t < 700 && h.hands.length >= 2 && h.hands[0].fist && h.hands[1].fist);
        if (past && y - (past.hands[0].center.y + past.hands[1].center.y) / 2 > 0.12) emit('pushDown', t);
      }

      // swipe up: an open hand's y dropped by > 0.18 within 450ms
      for (let i = 0; i < hands.length; i++) {
        if (!hands[i].open) continue;
        const past = hist.find((h) => t - h.t < 450 && h.hands[i]?.open);
        if (past && past.hands[i].center.y - hands[i].center.y > 0.18) emit('swipeUp', t);
      }

      // wave: open hand x reverses direction >= 3 times within 1.4s
      if (hands[0]?.open) {
        const xs = hist.filter((h) => t - h.t < 1400 && h.hands[0]?.open).map((h) => h.hands[0].center.x);
        let rev = 0, dir = 0, anchor = xs[0];
        for (const x of xs) {
          const dx = x - anchor;
          if (Math.abs(dx) > 0.035) { const s = Math.sign(dx); if (dir && s !== dir) rev++; dir = s; anchor = x; }
        }
        if (rev >= 3) { emit('wave', t); hist.length = 0; }
      }

      // finger counts
      if (held('one', hands.some((h) => h.one), 450, t)) emit('one', t);
      if (held('two', hands.some((h) => h.two), 450, t)) emit('two', t);
    },
  };
}

export const GESTURE_HINT = {
  handsOnHead: 'Both hands on top of your head',
  rub: 'Rub your hands together',
  fist: 'Make a fist',
  twoFists: 'Grab with both fists',
  pushDown: 'Push both fists down',
  swipeUp: 'Swipe a hand up',
  palmPush: 'Push your palm toward the camera and hold',
  wave: 'Wave',
  release: 'Open your fist to let go',
  one: 'Point (1 finger)',
  two: 'Show 2 fingers',
};
