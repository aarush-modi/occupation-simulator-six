import { create } from 'zustand';
import { BACKEND } from './config.js';
import { playVoice } from '../game/audio.js';

// Client-side view of one shift room. `state` is the latest authoritative snapshot (see CONTRACTS.md "Sim").
export const useShift = create((set, get) => ({
  roomId: null,
  isHost: false,
  occupation: '',
  conn: 'connecting', // connecting | open | reconnecting
  status: 'connecting', // connecting | generating | ready | failed
  error: null,
  generatingSince: 0,
  blueprint: null,
  you: null,
  state: null,
  started: false, // local "Start shift" gate (pointer lock + audio need a click)
  focus: null, // interactable under the crosshair
  skill: null, // open skill widget
  toast: null, // { text, kind, id }
  subtitle: null, // { who, text, id }
  banner: null, // { text, who, id }
  lastObjective: null, // { label, id } flash when an objective completes
  standingFlash: null, // { delta, reason, id, at } the latest change to the job standing
  invite: '', // link a teammate opens to join this room
  mic: 'off', // off | starting | listening | unsupported | denied | error  (voice chat with NPCs, see voice.js)
  heard: null, // { text, to, pending, final, id } what the player just said, and to whom
  set: (patch) => set(patch),
  setFocus: (focus) => { if (get().focus?.id !== focus?.id || get().focus?.label !== focus?.label) set({ focus }); },
  toastMsg: (text, kind = 'warn', ms = 2400) => {
    const id = Math.random();
    set({ toast: { text, kind, id } });
    setTimeout(() => { if (get().toast?.id === id) set({ toast: null }); }, ms);
  },
  // Lines queue so a completion remark and the next coaching tip do not cut each other off.
  say: (who, text, ms) => lines.push({ who, text, ms }, set),
  // The player talked over the NPC: stop the voice, drop queued lines. Returns the line that was cut, or null.
  interruptNpc: () => lines.interrupt(set),
  speakingLine: () => lines.current,
  showBanner: (text, who, ms = 7000, calm = false) => {
    const id = Math.random();
    set({ banner: { text, who, id, calm } });
    setTimeout(() => { if (get().banner?.id === id) set({ banner: null }); }, ms);
  },
}));

// Plays one NPC line at a time: subtitle plus speech. The next line starts once the subtitle time has passed and
// the voice has finished. Old lines are dropped when the queue backs up, so speech never lags far behind play.
// `interrupt` cuts the current line off (the player started talking over it) and drops the rest.
export function createLineQueue({ speakLine = speak, prefetch = prefetchVoice, setTimer = setTimeout, max = 3 } = {}) {
  const queue = [];
  let busy = false;
  let current = null; // { id, who, text, stop }
  function next(set) {
    const line = queue.shift();
    if (!line) { busy = false; current = null; set({ subtitle: null }); return; }
    busy = true;
    const id = Math.random();
    set({ subtitle: { who: line.who, text: line.text, id } });
    let waiting = 2;
    const done = () => { if (current?.id === id && --waiting === 0) next(set); };
    current = { id, who: line.who, text: line.text, stop: null };
    const stop = speakLine(line.who, line.text, done);
    if (current?.id === id) current.stop = typeof stop === 'function' ? stop : null;
    setTimer(done, line.ms ?? Math.min(9000, 2200 + line.text.length * 55));
  }
  return {
    push(line, set) {
      prefetch(line.who, line.text); // synthesize while earlier lines play
      queue.push(line);
      while (queue.length > max) queue.shift();
      if (!busy) next(set);
    },
    interrupt(set) {
      const cut = current;
      queue.length = 0;
      current = null;
      busy = false;
      cut?.stop?.();
      set({ subtitle: null });
      return cut ? { who: cut.who, text: cut.text } : null;
    },
    get current() { return current ? { who: current.who, text: current.text } : null; },
    get pending() { return queue.length; },
  };
}
const lines = createLineQueue();

const voiceFor = (who) => {
  let h = 0;
  for (const c of String(who)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { pitch: 0.8 + (h % 50) / 100, rate: 0.98 + ((h >> 6) % 12) / 100 };
};

export const MAX_LINE_MS = 20000; // no NPC line plays longer than this

// When the NPC voice last finished, so the open mic can ignore the game hearing itself.
let ttsEndedAt = -Infinity, voicePlaying = false;
export function npcVoiceBusy(now = performance.now()) {
  if (voicePlaying) return true;
  if (typeof window !== 'undefined' && window.speechSynthesis?.speaking) return true;
  return now - ttsEndedAt < 700;
}

// Gemini voice clips from the backend, fetched once per speaker and line.
const clips = new Map(); // `${who}|${text}` -> Promise<ArrayBuffer | null>
let serverVoices = true; // false once the backend says it has no voice model (then the browser voice is used)
export function prefetchVoice(who, text) {
  const roomId = useShift.getState().roomId;
  if (!roomId || typeof window === 'undefined') return Promise.resolve(null);
  const key = `${who}|${text}`;
  if (!clips.has(key)) {
    const pending = fetch(`${BACKEND}/api/rooms/${encodeURIComponent(roomId)}/voice`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ who, text }), signal: AbortSignal.timeout(15000),
    }).then((r) => {
      if (r.status === 503) serverVoices = false;
      return r.ok ? r.arrayBuffer() : null;
    }).catch(() => null);
    pending.then((bytes) => { if (!bytes && clips.get(key) === pending) clips.delete(key); });
    clips.set(key, pending);
    while (clips.size > 80) clips.delete(clips.keys().next().value);
  }
  return clips.get(key);
}

// NPC speech in the speaker's Gemini voice. A clip that fails is tried once more; if it still fails the line stays
// a subtitle, so a speaker never switches to a different voice mid-shift. The browser's own voice is only used when
// the backend has no voices at all. Returns a stop function.
function speak(who, text, onEnd = () => {}) {
  let finished = false, stopped = false, handle = null;
  const finish = () => {
    if (finished) return;
    finished = true; voicePlaying = false; ttsEndedAt = performance.now();
    onEnd();
  };
  // Only actual playback mutes the mic, not the wait for the clip.
  const fallback = () => {
    if (stopped || serverVoices) return finish();
    voicePlaying = true; browserSpeak(who, text, finish);
  };
  const retry = () => new Promise((resolve) => setTimeout(resolve, 1200)).then(() => (stopped || !serverVoices ? null : prefetchVoice(who, text)));
  prefetchVoice(who, text).then((bytes) => bytes ?? retry()).then((bytes) => {
    if (stopped) return finish();
    if (!bytes) return fallback();
    voicePlaying = true;
    return playVoice(bytes, { maxMs: MAX_LINE_MS, onEnd: finish }).then((h) => { handle = h; if (stopped) h.stop(); }).catch(fallback);
  });
  return () => {
    stopped = true;
    handle?.stop();
    if (typeof window !== 'undefined' && window.speechSynthesis?.speaking) window.speechSynthesis.cancel();
    finish();
  };
}

function browserSpeak(who, text, onEnd) {
  if (typeof window === 'undefined' || !window.speechSynthesis) return onEnd();
  try {
    const u = new SpeechSynthesisUtterance(text);
    const v = voiceFor(who);
    u.pitch = v.pitch; u.rate = v.rate; u.volume = 0.9;
    let ended = false;
    const end = () => { if (!ended) { ended = true; onEnd(); } };
    u.onend = end; u.onerror = end;
    // Some browsers never fire onend for a voice they cannot load; and no line runs past the cap.
    setTimeout(() => { if (!ended) window.speechSynthesis.cancel(); end(); }, Math.min(MAX_LINE_MS, 4000 + text.length * 90));
    window.speechSynthesis.speak(u);
  } catch { onEnd(); }
}
