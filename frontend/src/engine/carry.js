// Rules for putting down a carried item with webcam gestures. The AI-generated plan (state.objectives) says where
// the item in hand goes next, so walking arm swings and stray reaches near other spots do not drop it.
import { playerStep } from '../shared/sim.js';

export const CARRY_GRACE_MS = 1500; // no put-down gesture this soon after a grab

/** The item in hand is one the current objective needs. */
export function carryingNeeded(state, you) {
  const held = state?.players?.[you]?.held;
  const obj = state ? playerStep(state, you)?.obj : null;
  return Boolean(held && obj && (obj.item === held || (obj.verb !== 'grab' && obj.target === held)));
}

/**
 * Whether a put-down gesture on `it` should count. `matches`: the target is the current objective's.
 * `moving`: the webcam says the player is walking or turning.
 */
export function mayRelease({ it, matches, state, you, now, grabAt, moving }) {
  if (now - grabAt < CARRY_GRACE_MS || moving) return false;
  if (it.kind === 'handoff') return true;
  return !carryingNeeded(state, you) || matches;
}
