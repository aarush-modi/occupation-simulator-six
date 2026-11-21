// Turning an interactable into an intent: skill checks first when the current objective asks for one,
// then the intent goes to the server, whose denial (if any) is shown as a toast.
import { useShift } from './store';
import { send, onDenied } from './net';
import { indexBlueprint, matchesObjective, denialText, splitTarget } from './world';
import { blip } from '../game/audio';

let cachedBp = null, cachedIdx = null;
export function getIndex() {
  const bp = useShift.getState().blueprint;
  if (!bp) return null;
  if (bp !== cachedBp) { cachedBp = bp; cachedIdx = indexBlueprint(bp); }
  return cachedIdx;
}

let lastIt = null;
export let lastGrabAt = 0;

onDenied((reason) => {
  const idx = getIndex();
  blip(180, 0.12, 0.08, 'square');
  useShift.getState().toastMsg(idx ? denialText(idx, reason, lastIt) : reason);
});

/** Send an intent as-is (also the debug hook's `act`). */
export function act(intent, it = null) {
  lastIt = it ?? inferInteractable(intent);
  if (intent.t === 'grab') lastGrabAt = performance.now();
  return send(intent);
}

function inferInteractable(intent) {
  const target = intent.target;
  if (!target) return null;
  const [st, sub] = splitTarget(target);
  return sub != null ? { station: st } : null;
}

const SKILLS = {
  timing: (obj) => ({ type: 'timing', title: obj.label, help: 'Press Space (or snap a fist) when the marker is in the green.', band: [0.56, 0.72], attempts: 3, hitMsg: 'Nailed it!', overMsg: 'Too late', underMsg: 'Too early' }),
  steady: (obj) => ({ type: 'steady', title: obj.label, help: 'Keep it in the green: A / D or the mouse wheel.', band: [0.42, 0.62], hold: 2.5, drift: 0.5, start: 0.8, format: (v) => `${Math.round(v * 100)}%` }),
  hold: (obj) => ({ type: 'presshold', title: obj.label, help: 'Hold E (or push your palm toward the camera) until the ring fills.', duration: 1.4 }),
};

/** Use the focused interactable. */
export function use(it) {
  const s = useShift.getState();
  if (!it || !s.state || s.state.phase !== 'play' || s.skill) return;
  const obj = s.state.objectives[s.state.cur];
  const closed = it.station && s.state.closed.includes(it.station);
  const unmet = it.kind === 'press' && (it.requires ?? []).some((slot) => !Object.values(s.state.items).some((x) => x.at === `${it.station}.${slot}` && !x.holder));
  // Skill check only when this action would actually complete the objective; otherwise let the server explain.
  if (obj && obj.skill && obj.skill !== 'none' && SKILLS[obj.skill] && matchesObjective(obj, it) && !closed && !unmet) {
    const skill = SKILLS[obj.skill](obj);
    s.set({
      skill: {
        ...skill,
        onDone: (score) => {
          act({ ...it.intent, skillScore: Math.max(0, Math.min(1, score ?? 0)) }, it);
        },
      },
    });
    return;
  }
  act(it.intent, it);
}

export function closeSkill(result) {
  const s = useShift.getState();
  const sk = s.skill;
  s.set({ skill: null });
  sk?.onDone?.(result);
}
