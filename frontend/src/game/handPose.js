import { Vector3, MathUtils } from 'three';

export const FINGERS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
const knuckleX = [-0.036, -0.033, -0.011, 0.012, 0.032];
const fingerLengths = [0.06, 0.078, 0.089, 0.082, 0.065];
const PALM = 0.088;

// Three's camera looks down -Z. Match the mirrored preview and use hand size
// to estimate the reach of the whole hand because landmark Z is wrist-relative.
export function trackedWrist(out, landmarks, faceWidth, aspect) {
  const wrist = landmarks[0], middle = landmarks[9];
  const imagePalm = Math.hypot(middle.x - wrist.x, (middle.y - wrist.y) / aspect, (middle.z ?? 0) - (wrist.z ?? 0));
  const depth = MathUtils.clamp(0.22 + imagePalm / Math.max(0.065, faceWidth) * 0.48, 0.32, 0.60);
  return out.set((0.5 - wrist.x) * depth * 1.9, (0.46 - wrist.y) * depth * 1.55 - 0.08, -depth);
}

export function trackedFingers(out, landmarks, world, aspect) {
  const source = world?.length === 21 ? world : landmarks;
  const verticalScale = source === world ? 1 : 1 / aspect;
  const wrist = source[0];
  const dx = source[9].x - wrist.x, dy = (source[9].y - wrist.y) * verticalScale;
  const dz = (source[9].z ?? 0) - (wrist.z ?? 0);
  const span = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(span) || span < 0.001) return false;
  const scale = PALM / span;
  for (let i = 0; i < out.length; i++) {
    const joint = source[i];
    const x = (wrist.x - joint.x) * scale;
    const y = (wrist.y - joint.y) * verticalScale * scale;
    const z = ((joint.z ?? 0) - (wrist.z ?? 0)) * scale;
    if (![x, y, z].every(Number.isFinite)) return false;
    out[i].set(x, y, z).clampLength(0, 0.205);
  }
  return true;
}

export function restingFingers(out, side, grip) {
  out[0].set(0, 0, 0);
  for (const [finger, chain] of FINGERS.entries()) {
    for (let joint = 0; joint < chain.length; joint++) {
      const t = joint / 3;
      const curl = t * (0.21 + grip * 1.8);
      const splay = (finger - 2) * (1 + t * (1 - grip)) * 0.004;
      const start = finger === 0 ? 0.038 : 0.086;
      const x = (side === 'right' ? 1 : -1) * (knuckleX[finger] + splay + (finger === 0 ? t * (grip * 0.044 - 0.012) : 0));
      out[chain[joint]].set(x, -Math.sin(curl) * t * fingerLengths[finger] - (finger === 0 ? 0.012 : 0), -start - Math.cos(curl) * t * fingerLengths[finger]);
    }
  }
}

// Place the elbow on the intersection of two spheres, in the direction the arm naturally bends.
export function solveElbow(shoulder, wrist, elbow, bend, upper, lower, axis, pole) {
  axis.copy(wrist).sub(shoulder);
  const length = axis.length();
  if (length < 0.0001) axis.set(0, -1, 0);
  else axis.divideScalar(length);
  const reach = MathUtils.clamp(length, Math.abs(upper - lower) + 0.001, upper + lower - 0.001);
  wrist.copy(shoulder).addScaledVector(axis, reach);
  const along = (upper * upper + reach * reach - lower * lower) / (2 * reach);
  pole.copy(bend).addScaledVector(axis, -bend.dot(axis));
  if (pole.lengthSq() < 0.00001) {
    pole.set(0, 0, 1).addScaledVector(axis, -axis.z);
    if (pole.lengthSq() < 0.00001) pole.set(1, 0, 0);
  }
  return elbow.copy(shoulder).addScaledVector(axis, along)
    .addScaledVector(pole.normalize(), Math.sqrt(Math.max(0, upper * upper - along * along)));
}

export const handPoints = () => Array.from({ length: 21 }, () => new Vector3());
