// Machine close-up: when the player's step is to work a station (press a control, do a trade action, or seat
// something in it) and they walk up to it, the view moves in and frames that part of the machine, like leaning in
// to work it. Walking breaks out; the view stays out for that step until the player steps away and comes back.
export const WORK_RANGE = 2.3; // metres from the camera to the thing being worked
export const WORK_FOV = 50; // degrees (the normal view is wider)
const REARM = 1.0; // extra metres away before the close-up can engage again after walking out

export const workView = { key: null, out: null, target: null };

/** Interactable kinds that are worked at a machine. A place counts only into a station slot. */
export function isMachineWork(it) {
  return Boolean(it?.station) && (it.kind === 'press' || it.kind === 'use' || (it.kind === 'place' && String(it.target).includes('.')));
}

/**
 * Where the camera goes to work `it` at a station: in front of the station face, a little above the part, looking
 * at it. `frame` is the station's { pos, rotY }, `depth` its recipe depth.
 */
export function closeUp(it, frame, depth = 0.9) {
  const fx = Math.sin(frame.rotY), fz = Math.cos(frame.rotY); // the station faces +z rotated by rotY
  const look = it.pos;
  const intoFront = (look[0] - frame.pos[0]) * fx + (look[2] - frame.pos[2]) * fz; // how far forward the part sits
  const back = Math.max(0.55, depth / 2 - intoFront + 0.5);
  return { look: [...look], eye: [look[0] + fx * back, look[1] + 0.34, look[2] + fz * back] };
}

/**
 * Decide this frame's close-up. `it` is the interactable the current step needs (or null), `stepId` the step,
 * `distance` from the player's eye to it, `walking` whether the player is trying to move. Returns the close-up
 * target ({ eye, look }) or null.
 */
export function updateWorkView({ it, stepId, distance, walking, frame, depth }) {
  if (!isMachineWork(it) || !frame || distance == null) { workView.key = null; workView.target = null; return null; }
  const key = `${stepId}:${it.id}`;
  if (workView.out && workView.out !== key) workView.out = null; // a new step can zoom again
  if (workView.out === key && distance > WORK_RANGE + REARM) workView.out = null; // stepped away: re-arm
  if (walking && workView.key === key) workView.out = key;
  if (workView.out === key || distance > WORK_RANGE) { workView.key = null; workView.target = null; return null; }
  workView.key = key;
  workView.target = closeUp(it, frame, depth);
  return workView.target;
}
