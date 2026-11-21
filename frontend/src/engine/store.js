import { create } from 'zustand';

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
  set: (patch) => set(patch),
  setFocus: (focus) => { if (get().focus?.id !== focus?.id || get().focus?.label !== focus?.label) set({ focus }); },
  toastMsg: (text, kind = 'warn', ms = 2400) => {
    const id = Math.random();
    set({ toast: { text, kind, id } });
    setTimeout(() => { if (get().toast?.id === id) set({ toast: null }); }, ms);
  },
  // Lines queue so a completion remark and the next coaching tip do not cut each other off.
  say: (who, text, ms) => lines.push({ who, text, ms }, set),
  showBanner: (text, who, ms = 7000) => {
    const id = Math.random();
    set({ banner: { text, who, id } });
    setTimeout(() => { if (get().banner?.id === id) set({ banner: null }); }, ms);
  },
}));

// Plays one NPC line at a time: subtitle plus speech. The next line starts once the subtitle time has passed and
// the voice has finished. Old lines are dropped when the queue backs up, so speech never lags far behind play.
export function createLineQueue({ speakLine = speak, setTimer = setTimeout, max = 3 } = {}) {
  const queue = [];
  let busy = false;
  function next(set) {
    const line = queue.shift();
    if (!line) { busy = false; set({ subtitle: null }); return; }
    busy = true;
    const id = Math.random();
    set({ subtitle: { who: line.who, text: line.text, id } });
    let waiting = 2;
    const done = () => { if (--waiting === 0) next(set); };
    speakLine(line.who, line.text, done);
    setTimer(done, line.ms ?? Math.min(9000, 2200 + line.text.length * 55));
  }
  return {
    push(line, set) {
      queue.push(line);
      while (queue.length > max) queue.shift();
      if (!busy) next(set);
    },
    get pending() { return queue.length; },
  };
}
const lines = createLineQueue();

const voiceFor = (who) => {
  let h = 0;
  for (const c of String(who)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { pitch: 0.8 + (h % 50) / 100, rate: 0.98 + ((h >> 6) % 12) / 100 };
};

function speak(who, text, onEnd = () => {}) {
  if (typeof window === 'undefined' || !window.speechSynthesis) return onEnd();
  try {
    const u = new SpeechSynthesisUtterance(text);
    const v = voiceFor(who);
    u.pitch = v.pitch; u.rate = v.rate; u.volume = 0.9;
    let ended = false;
    const end = () => { if (!ended) { ended = true; onEnd(); } };
    u.onend = end; u.onerror = end;
    // Some browsers never fire onend for a voice they cannot load: give up after a generous limit.
    setTimeout(end, 4000 + text.length * 90);
    window.speechSynthesis.speak(u);
  } catch { onEnd(); }
}
