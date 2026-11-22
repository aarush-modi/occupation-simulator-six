// Voice chat with NPCs: an open mic transcribed by the browser's speech recognition. Each finished sentence goes
// to the NPC the player is looking at, else the closest one in earshot, as a { t: 'speak' } intent. The server
// answers with a normal 'say' event, which the subtitle queue shows and reads aloud.
import { useShift, npcVoiceBusy } from './store';
import { localPose, sampleNpc, send, onEvents } from './net';
import { pickListener, isEcho, MIC_RANGE } from './listener';
import { lockTalk } from './talkLock';

const REPLY_WAIT_MS = 9000;
const Recognition = () => (typeof window === 'undefined' ? null : window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null);
export const voiceSupported = () => Boolean(Recognition());

let rec = null, wanted = false, restarts = 0, startedAt = 0, clearTimer = null, replyTimer = null;

function setHeard(heard, ms) {
  clearTimeout(clearTimer);
  useShift.getState().set({ heard });
  if (ms) clearTimer = setTimeout(() => { if (useShift.getState().heard?.id === heard.id) useShift.getState().set({ heard: null }); }, ms);
}

// The NPC answered: stop showing the "thinking" dots.
onEvents((events) => {
  const s = useShift.getState();
  const h = s.heard;
  if (!h?.pending) return;
  if (events.some((ev) => ev.type === 'say' && ev.npc === h.npc && (!ev.playerId || ev.playerId === s.you))) {
    clearTimeout(replyTimer);
    setHeard({ ...h, pending: false }, 3500);
  }
});

function canTalk(s) {
  return s.started && s.state?.phase === 'play';
}

/** Say `text` to the NPC in front of the player (from the mic or the typed chat bar). Returns who heard, or null. */
let interruptedNext = false; // the next utterance cut an NPC off

export function speakTo(text, { fromMic = false } = {}) {
  const s = useShift.getState();
  if (!canTalk(s)) return null;
  const people = {};
  for (const person of Object.values(s.state.people ?? {})) {
    const p = sampleNpc(person.id) ?? person;
    people[person.id] = { id: person.id, name: person.name, pos: p.pos };
  }
  // Typed lines go to whoever is in earshot. The open mic also hears the player talking to someone in the real
  // room, so it only addresses an NPC under the crosshair or close and straight ahead, and ignores one-word noise.
  const aimed = s.focus?.kind === 'talk';
  const listener = fromMic && !aimed && text.trim().split(/\s+/).length < 2 ? null
    : pickListener({ focus: s.focus, people, pos: localPose.pos, yaw: localPose.yaw, ...(fromMic ? { range: MIC_RANGE, minFacing: 0.55 } : {}) });
  const id = Math.random();
  if (!listener) { if (!fromMic) setHeard({ text, to: null, final: true, id }, 3500); return null; }
  const interrupted = interruptedNext;
  interruptedNext = false;
  if (!send({ t: 'speak', npc: listener.id, text, ...(interrupted ? { interrupted: true } : {}) })) { setHeard({ text, to: null, final: true, offline: true, id }, 3500); return null; }
  setHeard({ text, to: listener.name, npc: listener.id, pending: true, final: true, id });
  lockTalk(listener.id, REPLY_WAIT_MS);
  clearTimeout(replyTimer);
  replyTimer = setTimeout(() => { if (useShift.getState().heard?.id === id) useShift.getState().set({ heard: null }); }, REPLY_WAIT_MS);
  return listener;
}

function onResult(e) {
  // While an NPC speaks, their own voice coming back through the speakers is ignored, but the player talking over
  // them (words that are not in the NPC's line) cuts the NPC off, like in a real conversation.
  if (npcVoiceBusy()) {
    const latest = e.results[e.results.length - 1]?.[0]?.transcript ?? '';
    const line = useShift.getState().speakingLine?.()?.text ?? useShift.getState().subtitle?.text ?? '';
    if (latest.trim().split(/\s+/).length < 2 || isEcho(latest, line)) return;
    useShift.getState().interruptNpc();
    interruptedNext = true;
  }
  let interim = '';
  for (let i = e.resultIndex; i < e.results.length; i++) {
    const r = e.results[i];
    const text = r[0]?.transcript?.trim() ?? '';
    if (!text) continue;
    if (r.isFinal) speakTo(text, { fromMic: true });
    else interim += `${text} `;
  }
  const s = useShift.getState();
  if (interim && canTalk(s) && !s.heard?.pending) setHeard({ text: interim.trim(), to: null, final: false, id: Math.random() }, 2500);
}

function begin() {
  const R = Recognition();
  const r = new R();
  rec = r;
  r.continuous = true;
  r.interimResults = true;
  r.lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
  const mine = () => rec === r; // a stopped session's late callbacks must not touch the new one
  r.onstart = () => { if (!mine()) return; startedAt = performance.now(); useShift.getState().set({ mic: 'listening' }); };
  r.onresult = (e) => { if (mine()) onResult(e); };
  r.onerror = (e) => {
    if (!mine()) return;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { wanted = false; useShift.getState().set({ mic: 'denied' }); }
    else if (e.error === 'audio-capture') { wanted = false; useShift.getState().set({ mic: 'error' }); }
    // 'no-speech', 'aborted' and 'network' end the session; onend restarts it.
  };
  r.onend = () => {
    if (!mine()) return;
    rec = null;
    if (!wanted) { if (['listening', 'starting'].includes(useShift.getState().mic)) useShift.getState().set({ mic: 'off' }); return; }
    // Browsers end recognition after a pause: start again, backing off if it keeps dying straight away.
    restarts = performance.now() - startedAt < 1500 ? restarts + 1 : 0;
    if (restarts > 5) { wanted = false; useShift.getState().set({ mic: 'error' }); return; }
    setTimeout(() => { if (wanted && !rec) begin(); }, restarts ? 400 * restarts : 0);
  };
  try { r.start(); } catch { rec = null; wanted = false; useShift.getState().set({ mic: 'error' }); }
}

export function startMic() {
  if (!voiceSupported()) { useShift.getState().set({ mic: 'unsupported' }); return; }
  wanted = true; restarts = 0;
  useShift.getState().set({ mic: 'starting' });
  if (!rec) begin();
}

export function stopMic() {
  wanted = false;
  const r = rec;
  rec = null;
  try { r?.stop(); } catch {}
  useShift.getState().set({ mic: 'off', heard: null });
}

let autoTried = false;
/** Switch the mic on when the shift starts, once; a player who mutes it stays muted. */
export function autoStartMic() {
  if (autoTried) return;
  autoTried = true;
  if (voiceSupported() && useShift.getState().mic === 'off') startMic();
}

export function toggleMic() {
  const m = useShift.getState().mic;
  if (m === 'listening' || m === 'starting') stopMic(); else startMic();
}
