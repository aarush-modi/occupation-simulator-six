// MediaPipe Pose points 2 and 5 are the eyes. Locomotion only needs the face and shoulders.
const CALIBRATION_SAMPLES = 8;
const WALK_LIFT = 0.08;
const RELEASE_LIFT = 0.045;
const RUN_LIFT = 0.18;
const START_HOLD_MS = 135;
const RUN_HOLD_MS = 260;
const FRESH_MS = 320;

function visible(point) {
  return point && (point.visibility ?? 1) >= 0.43 && point.x > 0 && point.x < 1 && point.y > 0 && point.y < 1;
}

function measure(points) {
  const [nose, eyeLeft, eyeRight, shoulderLeft, shoulderRight] = [0, 2, 5, 11, 12].map(index => points?.[index]);
  if (![nose, eyeLeft, eyeRight, shoulderLeft, shoulderRight].every(visible)) return null;
  const span = Math.abs(shoulderLeft.x - shoulderRight.x);
  if (span < 0.075) return null;
  const eyes = (eyeLeft.y + eyeRight.y) / 2;
  return {
    left: (shoulderLeft.y - eyes) / span,
    right: (shoulderRight.y - eyes) / span,
    pitch: (nose.y - eyes) / span,
  };
}

export function createShoulderMovement() {
  let baseline = null;
  let samples = 0;
  let walkSince = null;
  let runSince = null;
  let walking = false;
  let moveUntil = 0;
  let runUntil = 0;
  let status = 'frame';

  function stop() {
    walkSince = runSince = null;
    walking = false;
    moveUntil = runUntil = 0;
  }

  return {
    reset() {
      stop();
      baseline = null;
      samples = 0;
      status = 'frame';
    },
    update(points, time) {
      const pose = measure(points);
      if (!pose) {
        stop();
        status = 'frame';
        return;
      }
      if (samples < CALIBRATION_SAMPLES) {
        baseline ??= { left: 0, right: 0, pitch: 0 };
        samples++;
        for (const key of Object.keys(baseline)) baseline[key] += (pose[key] - baseline[key]) / samples;
        status = samples < CALIBRATION_SAMPLES ? 'calibrating' : 'ready';
        return;
      }

      status = 'ready';
      const lift = Math.min(baseline.left - pose.left, baseline.right - pose.right);
      const headStill = Math.abs(pose.pitch - baseline.pitch) < 0.065;
      if (!headStill || lift < (walking ? RELEASE_LIFT : WALK_LIFT)) {
        stop();
        return;
      }

      walkSince ??= time;
      if (time - walkSince < START_HOLD_MS) return;
      walking = true;
      moveUntil = time + FRESH_MS;
      if (lift >= RUN_LIFT) {
        runSince ??= time;
        if (time - runSince >= RUN_HOLD_MS) runUntil = moveUntil;
      } else {
        runSince = null;
        runUntil = 0;
      }
    },
    get status() { return status; },
    get deadlines() { return { moveUntil, runUntil }; },
  };
}
