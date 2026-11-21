// Pure full-body control engine (F3). Input: MediaPipe PoseLandmarker landmarks (33 points, normalized image
// coords, unmirrored, each { x, y, z, visibility }) and optionally the metric world landmarks. Output: the same
// `cam` fields and gesture names as the seated engine in gestures.js, so the game consumes both identically.
// No DOM access: `now` is injected so tests can drive time.
//
//   walking / running -> cam.forward  (alternating arm swing OR alternating knee lifts; legs need not be in view)
//   torso turn        -> cam.turn     (shoulder-line yaw vs calibration, deadzone + smoothing + rate limit, N7)
//   reach             -> 'fist'       (wrist out past the shoulder or toward the screen, at chest height)
//   lower both hands  -> 'pushDown'   (both wrists drop from chest to below the hips)
//   lift both hands   -> 'release'    (both wrists rise from the waist to above the shoulders)
//   press and hold    -> 'palmPush' + cam.palmPush while held
//   wave              -> 'wave'       (a hand above the shoulder swinging sideways)
//   two hands level   -> cam.wheel    (roll of the wrist-to-wrist line, like holding a steering wheel)
//   one / both hands held still above the head -> 'one' / 'two' (choice prompts)
// A squat (hips dropping) and arm swing while running never emit 'fist'.
import { cam, emitGesture } from './gestures.js';

// MediaPipe pose landmark indices
export const P = {
  nose: 0, lShoulder: 11, rShoulder: 12, lElbow: 13, rElbow: 14, lWrist: 15, rWrist: 16,
  lPinky: 17, rPinky: 18, lIndex: 19, rIndex: 20, lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnkle: 27, rAnkle: 28,
};

export const POSE_TUNE = {
  minVis: 0.5, // shoulders + hips below this visibility = tracking lost (N5)
  legVis: 0.3, // knees below this cannot drive running
  legTrust: 0.65, // legs drive running / squat only when they were clearly in view at calibration and are now
  calibMs: 1500, calibSamples: 20, calibMaxDrift: 0.25, // calibration restarts if the hips move > 0.25 torso
  // running in place
  stepThresh: 0.1, // knee-height difference (torso lengths) that counts as one leg up
  armThresh: 0.1, // left-minus-right wrist swing (torso lengths) that counts as one arm forward
  armMaxUp: 0.1, // wrists above this (torso lengths below the shoulder) are a reach / wave, not a walking swing
  armMaxOut: 0.3, // an arm out to the side is a reach, not a swing
  stepWindowMs: 1400, // cadence window
  stepGapMs: 700, // no swing / knee crossing for this long = stopped (forward then reaches 0 ~0.2 s later)
  fullCadence: 2.2, // swings/s for full speed
  minSteps: 3, // alternating swings inside the window before moving (one arm / a weight shift does nothing)
  fwdRiseTau: 0.3, fwdFallTau: 0.06, // s
  // torso turn
  yawTau: 0.18, // s, heading smoothing
  yawDead: 0.3, // rad (~17 degrees) of shoulder yaw ignored: normal swaying does not turn
  yawGain: 1.5, // (rad/s) per rad beyond the deadzone
  turnMax: 0.8, // rad/s
  turnAccel: 2.5, // rad/s^2, rate limit on cam.turn for comfort
  // reach / press
  chestTop: -0.35, chestBottom: 0.7, // wrist height band relative to the shoulder (torso lengths, + = down)
  reachOut: 0.75, // lateral wrist extension past the shoulder (torso lengths)
  reachFwd: 0.45, // wrist ahead of the shoulder in depth (torso lengths)
  reachHoldMs: 120,
  raiseUp: 0.05, // a wrist this high (torso lengths below the shoulder, or above it) = raised hand = use
  raiseHoldMs: 250,
  pressHoldMs: 350,
  squatDrop: 0.2, // hips this far below their calibrated height (torso lengths) = squatting
  squatLeg: 0.8, // or hip-to-ankle height below this fraction of calibration
  squatQuietMs: 700, // no grab for this long after a squat
  // lower / lift
  moveWindowMs: 1000,
  // wave
  waveAmp: 0.12, waveRevs: 3, waveWindowMs: 1400,
  // wheel
  wheelSign: -1,
  cooldownMs: 700,
};
const T = POSE_TUNE;

const vis = (p) => !!p && (p.visibility == null || p.visibility >= T.minVis);
const visLeg = (p) => !!p && (p.visibility == null || p.visibility >= T.legVis);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z ?? 0) + (b.z ?? 0)) / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const damp = (cur, target, tau, dt) => target + (cur - target) * Math.exp(-dt / Math.max(tau, 1e-4));

/** Raw per-frame body features, or null when the torso is not tracked. */
export function poseFeatures(lm, world) {
  if (!lm || lm.length < 29) return null;
  const ls = lm[P.lShoulder], rs = lm[P.rShoulder], lh = lm[P.lHip], rh = lm[P.rHip];
  if (!vis(ls) || !vis(rs) || !vis(lh) || !vis(rh)) return null;
  const sh = mid(ls, rs), hip = mid(lh, rh);
  const torso = dist(sh, hip);
  if (torso < 1e-3) return null;
  const sw = dist(ls, rs) / torso;

  // Shoulder-line yaw: + when the player turns to their left (their right shoulder comes toward the camera).
  // Prefer metric world landmarks; image z is roughly on the x scale.
  let dz = (ls.z ?? 0) - (rs.z ?? 0), dx = Math.abs(ls.x - rs.x);
  if (world && world[P.lShoulder] && world[P.rShoulder]) {
    dz = world[P.lShoulder].z - world[P.rShoulder].z;
    dx = Math.abs(world[P.lShoulder].x - world[P.rShoulder].x);
  }
  const zYaw = Math.atan2(dz, Math.max(dx, 1e-4));

  // legs: knee height relative to the hips (torso lengths, larger = knee raised)
  const lk = lm[P.lKnee], rk = lm[P.rKnee], la = lm[P.lAnkle], ra = lm[P.rAnkle];
  const legs = visLeg(lk) && visLeg(rk);
  const kneeL = legs ? (hip.y - lk.y) / torso : 0, kneeR = legs ? (hip.y - rk.y) / torso : 0;
  // ankles add to the knee signal when visible (a lifted foot rises further)
  const ankles = visLeg(la) && visLeg(ra);
  const step = legs ? (kneeL - kneeR) + (ankles ? 0.5 * ((hip.y - la.y) - (hip.y - ra.y)) / torso : 0) : 0;
  const leg = ankles ? ((la.y + ra.y) / 2 - hip.y) / torso : legs ? ((lk.y + rk.y) / 2 - hip.y) / torso * 1.9 : null;

  // arms, relative to their own shoulder (torso lengths). out: + = away from the body, down: + = below the shoulder,
  // fwd: + = toward the camera.
  const tw = world && world[P.lShoulder] && world[P.lHip]
    ? Math.hypot(...['x', 'y', 'z'].map((k) => (world[P.lShoulder][k] + world[P.rShoulder][k]) / 2 - (world[P.lHip][k] + world[P.rHip][k]) / 2))
    : 0;
  const arm = (side) => {
    const S = side === 'l' ? ls : rs, E = lm[side === 'l' ? P.lElbow : P.rElbow], W = lm[side === 'l' ? P.lWrist : P.rWrist];
    if (!vis(W)) return null;
    const outSign = side === 'l' ? 1 : -1; // unmirrored image: the player's left is at larger x
    let fwd = ((S.z ?? 0) - (W.z ?? 0)) / torso;
    const wi = side === 'l' ? P.lWrist : P.rWrist, si = side === 'l' ? P.lShoulder : P.rShoulder;
    if (tw > 1e-3 && world[wi] && world[si]) fwd = (world[si].z - world[wi].z) / tw;
    return {
      x: W.x, y: W.y,
      out: (W.x - S.x) * outSign / torso,
      down: (W.y - S.y) / torso,
      fwd,
      elbowDrop: E && vis(E) ? (E.y - W.y) / torso : 0, // elbow far below the wrist = bent arm, not a reach
      belowHip: (W.y - hip.y) / torso,
      aboveHead: lm[P.nose] && vis(lm[P.nose]) ? W.y < lm[P.nose].y - 0.1 * torso : W.y < S.y - 0.6 * torso,
    };
  };
  const legVisMin = Math.min(...[lk, rk].map((p) => (p?.visibility ?? 1)));
  return { sh, hip, torso, sw, zYaw, legs, step, leg, legVisMin, l: arm('l'), r: arm('r'), full: legs && ankles };
}

// Synthesise a 21-point hand (lm[0] = wrist, lm[9] = middle knuckle) in a body-relative "view" space, so the
// first-person hands follow the player's wrists (F8): resting at the sides sits low in view, chest-height
// reaches come up into the middle. Each hand stays on its own half (LocalPlayer picks sides by lm[0].x).
export function synthHands(lm, f) {
  if (!f) return [];
  const out = [];
  for (const side of ['l', 'r']) {
    const a = f[side];
    if (!a) continue;
    const W = lm[side === 'l' ? P.lWrist : P.rWrist];
    const ix = lm[side === 'l' ? P.lIndex : P.rIndex], pk = lm[side === 'l' ? P.lPinky : P.rPinky];
    const map = (p) => {
      const u = (p.x - f.sh.x) / f.torso, v = (p.y - f.sh.y) / f.torso;
      let x = 0.5 + u * 0.6;
      x = side === 'l' ? clamp(x, 0.53, 0.98) : clamp(x, 0.02, 0.47);
      return { x, y: clamp(0.35 + v * 0.45, 0.05, 1.1), z: p.z ?? 0 };
    };
    const w = map(W);
    let c;
    if (ix && pk && (ix.visibility == null || ix.visibility > 0.3)) {
      const m = map(mid(ix, pk));
      c = { x: m.x, y: m.y };
    } else c = { x: w.x, y: w.y - 0.06 };
    let dx = c.x - w.x, dy = c.y - w.y;
    const L = Math.hypot(dx, dy);
    if (L < 0.04) { dx = (dx / (L || 1)) * 0.04 || 0; dy = L ? (dy / L) * 0.04 : -0.04; }
    const nx = -dy, ny = dx; // perpendicular, same length as the palm
    const s = side === 'l' ? 1 : -1;
    const pt = (along, across) => ({ x: w.x + dx * along + nx * across * s, y: w.y + dy * along + ny * across * s, z: w.z });
    const hand = [{ x: w.x, y: w.y, z: w.z }];
    for (let k = 0; k < 4; k++) hand.push(pt(0.3 + 0.22 * k, 0.35 + 0.12 * k)); // thumb 1-4
    for (const off of [0.25, 0, -0.2, -0.4]) for (let k = 0; k < 4; k++) hand.push(pt(1 + 0.38 * k, off)); // 5-20
    out.push(hand);
  }
  return out;
}

export function createPoseEngine(now = () => performance.now()) {
  const base = { n: 0, torso: 0, sw: 0, hipY: 0, leg: 0, legN: 0, zYaw: 0, hip0: null };
  const last = {}; // gesture cooldowns
  const holds = {};
  const steps = []; // step timestamps
  const hist = []; // { t, l, r, hipY }
  let calibUntil = 0;
  let lastT = null;
  let legUp = 0; // -1 right leg up, +1 left leg up, 0 none yet
  let armUp = 0; // -1 right arm forward, +1 left arm forward
  const armSteps = []; // arm swing timestamps
  let yawS = 0;
  let reaching = { l: false, r: false };
  let raised = { l: false, r: false };
  let pressFired = false;
  let squatAt = -1e9;
  let prevRoll = null;

  function emit(name, t) {
    if (last[name] && t - last[name] < T.cooldownMs) return;
    last[name] = t;
    emitGesture(name, t);
  }
  function held(name, cond, ms, t) {
    if (!cond) { delete holds[name]; return false; }
    if (holds[name] == null) holds[name] = t;
    return t - holds[name] >= ms;
  }
  function stop() {
    cam.forward = 0; cam.turn = 0; cam.palmPush = false; cam.pitch = 0;
    steps.length = 0; armSteps.length = 0; hist.length = 0; legUp = 0; armUp = 0; yawS = 0; prevRoll = null;
    reaching = { l: false, r: false }; raised = { l: false, r: false }; pressFired = false;
    for (const k in holds) delete holds[k];
  }

  return {
    base,
    get calibrating() { return !cam.calibrated; },
    calibrate(ms = T.calibMs) {
      Object.assign(base, { n: 0, torso: 0, sw: 0, hipY: 0, leg: 0, legN: 0, zYaw: 0, hip0: null });
      calibUntil = now() + ms;
      cam.calibrated = false; cam.status = 'calibrating'; cam.calibProgress = 0;
      stop();
    },
    update(lm, world) {
      const t = now();
      const dt = lastT == null ? 1 / 30 : clamp((t - lastT) / 1000, 0, 0.25);
      lastT = t;
      const f = poseFeatures(lm, world);
      cam.face = false;
      cam.hands = f ? (f.l ? 1 : 0) + (f.r ? 1 : 0) : 0;
      cam.frame = { pose: lm ?? null, hands: f ? synthHands(lm, f) : [] };
      cam.body = { visible: !!f, full: !!f?.full, running: false, turning: 0, squat: false };

      // calibration: stand still, full body in frame
      if (!cam.calibrated) {
        cam.forward = 0; cam.turn = 0; cam.pitch = 0;
        if (f) {
          if (base.hip0 && dist(f.hip, base.hip0) > T.calibMaxDrift * base.torso) {
            // moved: restart the averaging (keep the time window going)
            Object.assign(base, { n: 0, torso: 0, sw: 0, hipY: 0, leg: 0, legN: 0, zYaw: 0, hip0: null });
          }
          if (!base.hip0) base.hip0 = { x: f.hip.x, y: f.hip.y };
          base.n++;
          const k = 1 / base.n;
          base.torso += (f.torso - base.torso) * k;
          base.sw += (f.sw - base.sw) * k;
          base.hipY += (f.hip.y - base.hipY) * k;
          base.zYaw += (f.zYaw - base.zYaw) * k;
          if (f.leg != null && f.legVisMin >= T.legTrust) { base.legN++; base.leg += (f.leg - base.leg) / base.legN; }
          cam.calibHint = null;
        } else cam.calibHint = 'Stand in front of the camera with your shoulders and hips in view';
        cam.calibProgress = Math.min(1, base.n / T.calibSamples, 1 - Math.max(0, calibUntil - t) / T.calibMs);
        if (t < calibUntil || base.n < T.calibSamples) return;
        cam.calibrated = true; cam.status = 'tracking'; cam.calibHint = null; cam.calibProgress = 1;
      }

      // N5: tracking loss stops movement immediately
      if (!f) { cam.status = 'lost'; stop(); return; }
      cam.status = 'tracking';
      cam.pitch = 0;

      // squat: hips drop below their calibrated height, or the legs fold
      const hipDrop = (f.hip.y - base.hipY) / base.torso;
      // Legs off-frame are guessed by MediaPipe and jitter: only trust them when they were seen at calibration
      // and are clearly visible now. Without trusted legs there is no squat or knee-running detection.
      const legsOk = base.legN >= T.calibSamples * 0.6 && f.legs && f.legVisMin >= T.legTrust;
      const squat = legsOk && (hipDrop > T.squatDrop || (f.leg != null && base.leg > 0 && f.leg < base.leg * T.squatLeg));
      if (squat) squatAt = t;
      cam.body.squat = squat;

      // --- running in place: count alternating knee lifts (hysteresis on the left-minus-right knee height)
      if (legsOk && !squat) {
        const side = f.step > T.stepThresh ? 1 : f.step < -T.stepThresh ? -1 : 0;
        if (side && side !== legUp) { steps.push(t); legUp = side; }
      }
      // --- walking arm swing: the wrists alternate forward/up and back/down (hysteresis on left minus right).
      // Works with only the upper body in frame. Raised hands (reach, wave) are not a swing.
      const swingArm = (a) => a.down > T.armMaxUp && a.out < T.armMaxOut && a.fwd < T.reachFwd;
      if (f.l && f.r && !squat && swingArm(f.l) && swingArm(f.r)) {
        const swing = (f.r.down - f.l.down) + 0.5 * (f.l.fwd - f.r.fwd); // + = left arm forward
        const side = swing > T.armThresh ? 1 : swing < -T.armThresh ? -1 : 0;
        if (side && side !== armUp) { armSteps.push(t); armUp = side; }
      }
      while (steps.length && t - steps[0] > T.stepWindowMs) steps.shift();
      while (armSteps.length && t - armSteps[0] > T.stepWindowMs) armSteps.shift();
      const src = armSteps.length > steps.length ? armSteps : steps;
      const moving = src.length >= T.minSteps && t - src[src.length - 1] < T.stepGapMs;
      const cadence = src.length / (T.stepWindowMs / 1000);
      const fwdTarget = moving ? clamp(cadence / T.fullCadence, 0, 1) : 0;
      cam.forward = damp(cam.forward, fwdTarget, fwdTarget > cam.forward ? T.fwdRiseTau : T.fwdFallTau, dt);
      if (fwdTarget === 0 && cam.forward < 0.03) cam.forward = 0;
      cam.body.running = moving;
      const armWalking = armSteps.length >= T.minSteps && t - armSteps[armSteps.length - 1] < T.stepGapMs;
      cam.body.cadence = cadence;

      // --- torso turn: shoulder yaw vs calibration. The z cue gives the sign; the narrowing shoulder line
      // (against the calibrated width) backs up the magnitude.
      const dyaw = f.zYaw - base.zYaw;
      const wYaw = Math.acos(clamp(f.sw / Math.max(base.sw, 1e-3), 0, 1));
      const yawRaw = Math.abs(dyaw) < 0.06 ? dyaw : Math.sign(dyaw) * (0.6 * Math.abs(dyaw) + 0.4 * wYaw);
      yawS = damp(yawS, yawRaw, T.yawTau, dt);
      const mag = Math.max(0, Math.abs(yawS) - T.yawDead);
      const turnTarget = Math.sign(yawS) * Math.min(T.turnMax, mag * T.yawGain);
      const maxStep = T.turnAccel * dt;
      cam.turn += clamp(turnTarget - cam.turn, -maxStep, maxStep);
      if (turnTarget === 0 && Math.abs(cam.turn) < 0.02) cam.turn = 0;
      cam.body.turning = cam.turn;

      // --- arms
      hist.push({ t, l: f.l, r: f.r });
      while (hist.length && t - hist[0].t > Math.max(T.waveWindowMs, T.moveWindowMs)) hist.shift();
      const chest = (a) => a && a.down > T.chestTop && a.down < T.chestBottom;
      const fwdReach = (a) => chest(a) && a.fwd > T.reachFwd && a.elbowDrop < 0.3;
      const outReach = (a) => chest(a) && a.out > T.reachOut;
      const quiet = squat || t - squatAt < T.squatQuietMs || moving; // no grabs while squatting or running

      // reach -> 'fist' on the rising edge of an extended arm, held briefly to reject noise
      for (const s of ['l', 'r']) {
        const a = f[s];
        const ext = !!a && (fwdReach(a) || outReach(a));
        if (!ext) { reaching[s] = false; delete holds['reach' + s]; continue; }
        if (quiet) { reaching[s] = true; continue; } // an arm already out when the squat ends does not count
        if (!reaching[s] && held('reach' + s, true, T.reachHoldMs, t)) { reaching[s] = true; emit('fist', t); }
      }

      // raised hand: either wrist up at shoulder height or above, held briefly -> 'fist' (the universal "use" in
      // body mode; LocalPlayer applies it to whatever is highlighted). Not while walking or squatting.
      for (const s of ['l', 'r']) {
        const a = f[s];
        const up = !!a && a.down < T.raiseUp && !armWalking;
        if (!up) { delete holds['raise' + s]; if (!a || a.down > T.raiseUp + 0.15) raised[s] = false; continue; }
        if (!raised[s] && held('raise' + s, true, T.raiseHoldMs, t)) { raised[s] = true; emit('fist', t); }
      }

      cam.body.raise = f.l?.down < T.raiseUp || f.r?.down < T.raiseUp ? (armWalking ? 'blocked: walking' : 'up') : 'down';
      cam.body.legs = legsOk;

      // press: a hand pushed forward and held -> continuous cam.palmPush + one 'palmPush' per press
      const pressing = !squat && (fwdReach(f.l) || fwdReach(f.r));
      const pressHeld = held('press', pressing, T.pressHoldMs, t);
      cam.palmPush = pressHeld;
      if (pressHeld && !pressFired) { pressFired = true; emit('palmPush', t); }
      if (!pressing) pressFired = false;

      // lower / lift with both hands (compares against the last second)
      if (f.l && f.r) {
        const past = hist.filter((h) => t - h.t < T.moveWindowMs && h.l && h.r);
        const wasHigh = past.some((h) => h.l.down < T.chestBottom && h.r.down < T.chestBottom);
        const wasLow = past.some((h) => h.l.belowHip > -0.15 && h.r.belowHip > -0.15);
        if (wasHigh && f.l.belowHip > 0 && f.r.belowHip > 0) emit('pushDown', t);
        if (wasLow && f.l.down < -0.1 && f.r.down < -0.1) emit('release', t);
      }

      // wave: a hand above its shoulder reversing sideways direction >= 3 times
      for (const s of ['l', 'r']) {
        if (!f[s] || f[s].down > -0.05) continue;
        const xs = hist.filter((h) => t - h.t < T.waveWindowMs && h[s] && h[s].down < -0.05).map((h) => h[s].x / f.torso);
        let rev = 0, dir = 0, anchor = xs[0];
        for (const x of xs) {
          const d = x - anchor;
          if (Math.abs(d) > T.waveAmp) { const sg = Math.sign(d); if (dir && sg !== dir) rev++; dir = sg; anchor = x; }
        }
        if (rev >= T.waveRevs) { emit('wave', t); for (const h of hist) h[s] = null; }
      }

      // one / both hands held still above the head -> 'one' / 'two'
      const still = (s) => {
        const xs = hist.filter((h) => t - h.t < 500 && h[s]).map((h) => h[s].x / f.torso);
        return xs.length > 2 && Math.max(...xs) - Math.min(...xs) < 0.15;
      };
      const upL = !!f.l?.aboveHead && still('l'), upR = !!f.r?.aboveHead && still('r');
      if (held('two', upL && upR, 450, t)) { delete holds.two; emit('two', t); }
      if (held('one', upL !== upR, 450, t)) { delete holds.one; emit('one', t); }

      // wheel: roll of the wrist-to-wrist line while both hands are at chest height
      if (chest(f.l) && chest(f.r)) {
        const roll = Math.atan2(f.l.y - f.r.y, f.l.x - f.r.x);
        if (prevRoll != null) {
          const dr = roll - prevRoll;
          if (Math.abs(dr) < 0.6) cam.wheel += dr * T.wheelSign;
        }
        prevRoll = roll;
      } else prevRoll = null;
    },
  };
}

export const BODY_GESTURE_HINT = {
  fist: 'Raise a hand',
  pushDown: 'Lower both hands',
  release: 'Lift both hands',
  palmPush: 'Press and hold',
  wave: 'Wave',
  one: 'One hand up',
  two: 'Both hands up',
};
