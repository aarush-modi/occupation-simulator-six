// Turning an interactable into an intent: it goes straight to the server (no mini-games: every step is a plain
// grab, place, press or talk), and a denial is shown as a toast.
import { useShift } from './store';
import { send, onDenied } from './net';
import { indexBlueprint, denialText, splitTarget } from './world';
import { blip } from '../game/audio';
import { lockTalk } from './talkLock';

let cachedBp = null, cachedIdx = null;
export function getIndex() {
  const bp = useShift.getState().blueprint;
  if (!bp) return null;
  if (bp !== cachedBp) { cachedBp = bp; cachedIdx = indexBlueprint(bp); }
  return cachedIdx;
}

let lastIt = null;
export let lastGrabAt = 0;
export let latestHandAction = null;

onDenied((reason) => {
  const idx = getIndex();
  blip(180, 0.12, 0.08, 'square');
  useShift.getState().toastMsg(idx ? denialText(idx, reason, lastIt) : reason);
});

/** Send an intent as-is (also the debug hook's `act`). */
export function act(intent, it = null, side) {
  lastIt = it ?? inferInteractable(intent);
  if (intent.t === 'grab') lastGrabAt = performance.now();
  if (intent.t === 'talk') lockTalk(intent.npc, 6000);
  const sent = send(side ? { ...intent, hand: side } : intent);
  if (sent && it?.pos && ['grab', 'place', 'press', 'use', 'handoff'].includes(intent.t)) {
    latestHandAction = { side: side ?? 'right', kind: intent.t, target: [...it.pos], time: performance.now() };
  }
  return sent;
}

function inferInteractable(intent) {
  const target = intent.target;
  if (!target) return null;
  const [st, sub] = splitTarget(target);
  return sub != null ? { station: st } : null;
}

/** Use the focused interactable. */
export function use(it, side) {
  const s = useShift.getState();
  if (!it || !s.state || s.state.phase !== 'play') return;
  act(it.intent, it, side);
}
