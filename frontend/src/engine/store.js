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
  say: (who, text, ms) => {
    const id = Math.random();
    set({ subtitle: { who, text, id } });
    speak(who, text);
    const dur = ms ?? Math.min(9000, 2200 + text.length * 55);
    setTimeout(() => { if (get().subtitle?.id === id) set({ subtitle: null }); }, dur);
  },
  showBanner: (text, who, ms = 7000) => {
    const id = Math.random();
    set({ banner: { text, who, id } });
    setTimeout(() => { if (get().banner?.id === id) set({ banner: null }); }, ms);
  },
}));

const voiceFor = (who) => {
  let h = 0;
  for (const c of String(who)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { pitch: 0.8 + (h % 50) / 100, rate: 0.98 + ((h >> 6) % 12) / 100 };
};

function speak(who, text) {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = voiceFor(who);
    u.pitch = v.pitch; u.rate = v.rate; u.volume = 0.9;
    window.speechSynthesis.speak(u);
  } catch {}
}
