const legPoints = [11, 12, 23, 24, 25, 26, 27, 28];
const calibrationFrames = 8;
const minStepMs = 145;
const firstStepMs = 280;
const maxStepMs = 780;
const runStepMs = 360;

function visible(point) {
  return point && point.visibility >= 0.45 && point.x > 0 && point.x < 1 && point.y > 0 && point.y < 1;
}

function readLegs(points) {
  if (!legPoints.every(index => visible(points?.[index]))) return null;
  const torso = (points[23].y + points[24].y - points[11].y - points[12].y) / 2;
  if (torso < 0.065) return null;
  return { torso, knees: points[25].y - points[26].y, ankles: points[27].y - points[28].y };
}

export function createLegGait() {
  let baseline;
  let frames = 0;
  let phase = 0;
  let candidate = 0;
  let candidateAt = 0;
  let lastFoot = 0;
  let lastStep = -Infinity;
  let quickSteps = 0;
  let moveUntil = 0;
  let runUntil = 0;

  function stop() {
    phase = 0;
    candidate = 0;
    candidateAt = 0;
    lastFoot = 0;
    lastStep = -Infinity;
    quickSteps = 0;
    moveUntil = 0;
    runUntil = 0;
  }

  return {
    reset() {
      baseline = undefined;
      frames = 0;
      stop();
    },
    update(points, time) {
      const legs = readLegs(points);
      if (!legs) {
        if (frames < calibrationFrames) this.reset();
        else stop();
        return;
      }
      if (frames < calibrationFrames) {
        if (Math.abs(legs.ankles) > legs.torso * 0.13 || Math.abs(legs.knees) > legs.torso * 0.18) {
          this.reset();
          return;
        }
        baseline ??= { torso: 0, knees: 0, ankles: 0 };
        frames++;
        for (const key of Object.keys(baseline)) baseline[key] += (legs[key] - baseline[key]) / frames;
        return;
      }

      const ankles = (legs.ankles - baseline.ankles) / baseline.torso;
      const knees = (legs.knees - baseline.knees) / baseline.torso;
      // A lift needs a knee and ankle to rise together on one side relative to the other.
      // Squatting, head movement and weight shifts with planted feet leave the ankle gap small.
      const foot = Math.abs(ankles) >= 0.075 && Math.abs(knees) >= 0.095 && ankles * knees > 0 ? Math.sign(ankles) : 0;
      if (foot !== candidate) {
        candidate = foot;
        candidateAt = time;
      }
      if (foot === phase || (foot && time - candidateAt < 35)) return;
      phase = foot;
      if (!foot) return;
      const interval = time - lastStep;
      if (interval < minStepMs || (foot === lastFoot && interval <= maxStepMs)) return;

      lastStep = time;
      lastFoot = foot;
      if (interval > maxStepMs) {
        quickSteps = 0;
        moveUntil = time + firstStepMs;
        runUntil = 0;
        return;
      }
      quickSteps = interval <= runStepMs ? quickSteps + 1 : 0;
      moveUntil = time + Math.min(maxStepMs + 35, Math.max(375, interval * 1.16));
      runUntil = quickSteps >= 2 ? time + Math.max(330, interval * 1.4) : 0;
    },
    get deadlines() { return { moveUntil, runUntil }; },
  };
}
