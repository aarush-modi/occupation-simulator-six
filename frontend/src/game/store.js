import { create } from 'zustand';

export const STEPS = {
  report: { title: 'Report to Toolpusher Rhodes', hint: 'He is outside the doghouse.' },
  ppe: { title: 'Suit up', hint: 'Hard hat and gloves from the PPE locker.' },
  pipeGrab: { title: 'Fetch a drill pipe joint', hint: 'Pipe rack, starboard side.' },
  pipePlace: { title: 'Stab the pipe in the mousehole', hint: 'Next to the rotary table. Pipe is heavy.' },
  torque: { title: 'Make up the connection', hint: 'Iron roughneck control stand. Stop the torque in the green.' },
  gauge: { title: 'Read mud pump 1 pressure', hint: 'Gauge on the mud pump.' },
  choke: { title: 'Trim pressure at the choke manifold', hint: 'Hold the needle in the green.' },
  wait: { title: 'Stand by for the next connection', hint: 'Driller is circulating.' },
  kickGuard: { title: 'KICK! Lift the BOP panel guard', hint: 'BOP control panel by the doghouse.' },
  kickButton: { title: 'KICK! Close the annular preventer', hint: 'Hold E on the red button.' },
  kickChoke: { title: 'KICK! Bleed pressure through pump 2 line', hint: 'Choke manifold. Harder this time.' },
  judgment: { title: 'Report to Rhodes', hint: 'He wants a word.' },
  done: { title: 'Shift complete', hint: '' },
};

// Per-frame values read in useFrame (no React re-render).
export const live = { pressure: 0.45, torque: 0, shake: 0 };

const ORDER = ['report', 'ppe', 'pipeGrab', 'pipePlace', 'torque', 'gauge', 'choke', 'wait', 'kickGuard', 'kickButton', 'kickChoke', 'judgment', 'done'];

export const useGame = create((set, get) => ({
  phase: 'intro', // intro | play | review
  step: 'report',
  held: null,
  ppe: false,
  hat: false,
  gloves: false,
  pipeInHole: false,
  guardOpen: false,
  pump1Closed: false,
  alarm: false,
  focus: null,
  skill: null,
  choice: null,
  subtitle: null,
  startedAt: 0,
  alarmAt: 0,
  annularAt: 0,
  scores: { torque: null, choke: null, kickChoke: null },
  log: [],

  start: () => set({ phase: 'play', startedAt: performance.now() }),
  setFocus: (focus) => { if (get().focus !== focus) set({ focus }); },
  advance: (to) => {
    const next = to ?? ORDER[ORDER.indexOf(get().step) + 1];
    set({ step: next });
  },
  say: (who, text, ms = 4200) => {
    const id = Math.random();
    set({ subtitle: { who, text, id } });
    speak(who, text);
    setTimeout(() => { if (get().subtitle?.id === id) set({ subtitle: null }); }, ms);
  },
  openSkill: (skill) => set({ skill }),
  closeSkill: (result) => {
    const s = get().skill;
    set({ skill: null });
    s?.onDone?.(result);
  },
  set: (patch) => set(patch),
}));

const VOICES = { Rhodes: { pitch: 0.8, rate: 0.95 }, Okafor: { pitch: 1.0, rate: 1.1 }, Dez: { pitch: 1.2, rate: 1.05 }, Radio: { pitch: 1, rate: 1 } };
function speak(who, text) {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = VOICES[who] ?? VOICES.Radio;
    u.pitch = v.pitch; u.rate = v.rate; u.volume = 0.9;
    window.speechSynthesis.speak(u);
  } catch {}
}

export function shiftClock(startedAt) {
  if (!startedAt) return '06:00';
  const mins = 6 * 60 + ((performance.now() - startedAt) / 1000) * 2; // 120x
  const h = Math.floor(mins / 60) % 24;
  const m = Math.floor(mins % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
