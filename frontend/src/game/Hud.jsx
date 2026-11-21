'use client';
import { useEffect, useRef, useState } from 'react';
import { useGame, STEPS, shiftClock, live } from './store';
import { interactables } from './world';
import { startAudio, blip } from './audio';
import { cam, onGesture, GESTURE_HINT } from './webcam/gestures';
import WebcamPanel from './webcam/WebcamPanel';
import { gestureList } from './Player';
import * as flow from './flow';
const { triggerKick } = flow;

const ui = {
  font: "'Inter', 'Segoe UI', system-ui, sans-serif",
  panel: { background: 'linear-gradient(180deg, rgba(12,12,14,0.78), rgba(12,12,14,0.62))', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, backdropFilter: 'blur(6px)' },
};

function useTick(ms = 250) {
  const [, set] = useState(0);
  useEffect(() => { const i = setInterval(() => set((x) => x + 1), ms); return () => clearInterval(i); }, [ms]);
}

function Objective() {
  useTick(500);
  const step = useGame((s) => s.step);
  const startedAt = useGame((s) => s.startedAt);
  const alarm = useGame((s) => s.alarm);
  const o = STEPS[step];
  return (
    <div style={{ position: 'absolute', top: 24, left: 24, width: 340, padding: '14px 16px', ...ui.panel, borderLeft: `3px solid ${alarm ? '#ff3b2f' : '#f2b233'}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, letterSpacing: 2, color: '#a9a39a', textTransform: 'uppercase' }}>
        <span>Floorhand · Tour 1</span><span style={{ color: '#f2d9a6', fontVariantNumeric: 'tabular-nums' }}>{shiftClock(startedAt)}</span>
      </div>
      <div style={{ marginTop: 8, fontSize: 18, fontWeight: 700, color: alarm ? '#ff6a5c' : '#fff' }}>{o.title}</div>
      {o.hint && <div style={{ marginTop: 4, fontSize: 13, color: '#c9c3b8' }}>{o.hint}</div>}
    </div>
  );
}

function Prompt() {
  const focus = useGame((s) => s.focus);
  const skill = useGame((s) => s.skill);
  useGame((s) => s.step);
  const it = focus && interactables.get(focus);
  const label = it?.label?.();
  return (
    <>
      <div style={{ position: 'absolute', left: '50%', top: '50%', width: 6, height: 6, marginLeft: -3, marginTop: -3, borderRadius: 6, background: label ? '#f2b233' : 'rgba(255,255,255,0.75)', boxShadow: '0 0 6px rgba(0,0,0,0.6)' }} />
      {label && !skill && (
        <div style={{ position: 'absolute', left: '50%', top: '58%', transform: 'translateX(-50%)', padding: '8px 14px', ...ui.panel, color: '#fff', fontSize: 15, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {label}
          </div>
          {cam.enabled && gestureList(it)[0] && (
            <div style={{ fontSize: 13, color: '#f2b233' }}>Webcam: {GESTURE_HINT[gestureList(it)[0]]}</div>
          )}
        </div>
      )}
    </>
  );
}

function Subtitle() {
  const sub = useGame((s) => s.subtitle);
  if (!sub) return null;
  return (
    <div style={{ position: 'absolute', left: '50%', bottom: 70, transform: 'translateX(-50%)', maxWidth: 760, textAlign: 'center', padding: '10px 18px', ...ui.panel, color: '#fff', fontSize: 18, lineHeight: 1.4 }}>
      <span style={{ color: '#f2b233', fontWeight: 700 }}>{sub.who}: </span>{sub.text}
    </div>
  );
}

/* ---------- Skill checks ---------- */
export function Meter({ value, band, label, color = '#f2b233' }) {
  return (
    <div style={{ width: 460 }}>
      <div style={{ position: 'relative', height: 26, borderRadius: 6, background: '#1b1b1d', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.15)' }}>
        <div style={{ position: 'absolute', left: '72%', width: '28%', top: 0, bottom: 0, background: 'rgba(255,59,47,0.35)' }} />
        <div style={{ position: 'absolute', left: `${band[0] * 100}%`, width: `${(band[1] - band[0]) * 100}%`, top: 0, bottom: 0, background: 'rgba(60,255,138,0.45)' }} />
        <div style={{ position: 'absolute', left: `calc(${value * 100}% - 2px)`, width: 4, top: -2, bottom: -2, background: color, boxShadow: `0 0 10px ${color}` }} />
      </div>
      {label && <div style={{ marginTop: 8, color: '#ddd', fontSize: 13 }}>{label}</div>}
    </div>
  );
}

export function Timing({ skill, close }) {
  const [v, setV] = useState(0);
  const [left, setLeft] = useState(skill.attempts);
  const [msg, setMsg] = useState('');
  const [hitMsg, setHitMsg] = useState(false);
  const best = useRef(0);
  const st = useRef({ v: 0, dir: 1, paused: false });
  useEffect(() => {
    let raf, last = performance.now();
    const loop = (t) => {
      const dt = (t - last) / 1000; last = t;
      const s = st.current;
      if (!s.paused) {
        s.v += s.dir * dt * 0.75;
        if (s.v > 1) { s.v = 1; s.dir = -1; } if (s.v < 0) { s.v = 0; s.dir = 1; }
        setV(s.v); live.torque = s.v;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  useEffect(() => {
    return onGesture((name) => {
      if (name !== 'fist' || st.current.paused) return;
      const x = st.current.v;
      const [a, b] = skill.band;
      const mid = (a + b) / 2, half = (b - a) / 2;
      const hit = x >= a && x <= b;
      const score = hit ? 1 - Math.abs(x - mid) / half * 0.4 : Math.max(0, 0.5 - Math.abs(x - mid));
      best.current = Math.max(best.current, score);
      st.current.paused = true;
      blip(hit ? 1200 : 220, 0.12, 0.12, hit ? 'sine' : 'square');
      setHitMsg(hit);
      setMsg(hit ? (skill.hitMsg ?? `In spec: ${Math.round(18000 + (x - a) * 30000).toLocaleString()} ft-lbs`) : x > b ? (skill.overMsg ?? 'Over-torqued!') : (skill.underMsg ?? 'Under-torqued'));
      const remaining = left - 1;
      setTimeout(() => {
        if (hit || remaining <= 0) { live.torque = 0; close(best.current); }
        else { setLeft(remaining); setMsg(''); st.current.paused = false; }
      }, 1100);
    });
  }, [left, skill, close]);
  return (
    <>
      <Meter value={v} band={skill.band} label={`Attempts left: ${left}`} />
      <div style={{ height: 22, marginTop: 8, color: hitMsg ? '#5dff9a' : '#ff7a6b', fontWeight: 700 }}>{msg}</div>
    </>
  );
}

export function Steady({ skill, close }) {
  const [v, setV] = useState(skill.start ?? 0.75);
  const [held, setHeld] = useState(0);
  const st = useRef({ v: skill.start ?? 0.75, vel: 0, held: 0, done: false });
  useEffect(() => {
    cam.wheel = 0;
    let raf, last = performance.now(), t0 = performance.now(), inBandTime = 0, total = 0;
    const loop = (t) => {
      const dt = Math.min((t - last) / 1000, 0.05); last = t;
      const s = st.current;
      if (s.done) return;
      const time = (t - t0) / 1000;
      const drift = (Math.sin(time * 1.3) * 0.6 + Math.sin(time * 2.9 + 1) * 0.4 + 0.25) * skill.drift;
      const input = cam.wheel * 6;
      cam.wheel = 0;
      s.vel += (drift - input * 0.9) * dt * 2.2;
      s.vel *= Math.pow(0.08, dt);
      s.v = Math.min(1, Math.max(0, s.v + s.vel * dt));
      const inBand = s.v >= skill.band[0] && s.v <= skill.band[1];
      total += dt; if (inBand) { inBandTime += dt; s.held += dt; } else s.held = Math.max(0, s.held - dt * 1.5);
      live.pressure = s.v;
      setV(s.v); setHeld(s.held);
      if (s.held >= skill.hold) {
        s.done = true;
        blip(1300, 0.15, 0.12);
        setTimeout(() => close(Math.min(1, inBandTime / Math.max(total, 0.001) + 0.2)), 500);
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [skill, close]);
  const psi = Math.round(1500 + v * 4500);
  return (
    <>
      <Meter value={v} band={skill.band} label={skill.format ? skill.format(v) : `${psi.toLocaleString()} psi`} color={v > 0.72 ? '#ff3b2f' : '#f2b233'} />
      <div style={{ marginTop: 10, width: 460, height: 8, background: '#222', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${(held / skill.hold) * 100}%`, height: '100%', background: '#3cff8a', transition: 'width 0.1s linear' }} />
      </div>
      <div style={{ marginTop: 6, color: '#aaa', fontSize: 12 }}>Hold in the green: {held.toFixed(1)} / {skill.hold}s</div>
    </>
  );
}

export function PressHold({ skill, close }) {
  const [p, setP] = useState(0);
  useEffect(() => {
    let val = 0, raf, last = performance.now();
    const loop = (t) => {
      const dt = (t - last) / 1000; last = t;
      val = cam.palmPush ? val + dt / skill.duration : Math.max(0, val - dt);
      setP(Math.min(val, 1));
      if (val >= 1) { blip(600, 0.3, 0.14, 'square'); setTimeout(() => close(1), 300); return; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [skill, close]);
  const R = 46, Cc = 2 * Math.PI * R;
  return (
    <svg width="140" height="140" viewBox="0 0 120 120">
      <circle cx="60" cy="60" r={R} stroke="#2a2a2c" strokeWidth="10" fill="none" />
      <circle cx="60" cy="60" r={R} stroke="#ff3b2f" strokeWidth="10" fill="none" strokeDasharray={Cc} strokeDashoffset={Cc * (1 - p)} transform="rotate(-90 60 60)" strokeLinecap="round" />
      <text x="60" y="68" textAnchor="middle" fill="#fff" fontSize="20" fontWeight="800">{Math.round(p * 100)}%</text>
    </svg>
  );
}

export function Choice({ skill, close }) {
  useEffect(() => onGesture((name) => {
    if (name === 'one') close(0);
    if (name === 'two') close(1);
  }), [close]);
  return (
    <div style={{ width: 560 }}>
      <div style={{ color: '#eee', fontSize: 17, lineHeight: 1.5, marginBottom: 16 }}>&ldquo;{skill.prompt}&rdquo;</div>
      <div style={{ color: '#f2b233', fontSize: 13 }}>Hold up one or two fingers to choose.</div>
      {skill.options.map((o, i) => (
        <div key={i} style={{ display: 'block', width: '100%', textAlign: 'left', marginTop: 8, padding: '12px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.06)', color: '#fff', fontSize: 15 }}>
          <b style={{ color: '#f2b233', marginRight: 10 }}>{i + 1}</b>{o}
        </div>
      ))}
    </div>
  );
}

function Skill() {
  const skill = useGame((s) => s.skill);
  const closeSkill = useGame((s) => s.closeSkill);
  if (!skill) return null;
  const Comp = { timing: Timing, steady: Steady, presshold: PressHold, choice: Choice }[skill.type];
  return (
    <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', padding: '22px 26px', ...ui.panel, color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ fontSize: 12, letterSpacing: 3, color: '#f2b233', textTransform: 'uppercase', marginBottom: 6 }}>{skill.title}</div>
      {skill.help && <div style={{ fontSize: 13, color: '#bbb', marginBottom: 16, maxWidth: 460, textAlign: 'center' }}>{skill.help}</div>}
      <Comp skill={skill} close={closeSkill} />
    </div>
  );
}

function Alarm() {
  const alarm = useGame((s) => s.alarm);
  if (!alarm) return null;
  return (
    <>
      <style>{`@keyframes ws-pulse { 0%,100% { opacity: .15 } 50% { opacity: .55 } }`}</style>
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', boxShadow: 'inset 0 0 220px 40px rgba(255,20,10,0.9)', animation: 'ws-pulse 0.85s infinite' }} />
      <div style={{ position: 'absolute', top: 24, left: '50%', transform: 'translateX(-50%)', padding: '6px 16px', background: '#c9150b', color: '#fff', fontWeight: 900, letterSpacing: 4, borderRadius: 4 }}>WELL CONTROL · KICK DETECTED</div>
    </>
  );
}

function Intro() {
  const start = useGame((s) => s.start);
  useEffect(() => onGesture((name) => {
    if (name !== 'wave') return;
    startAudio();
    start();
    useGame.getState().say('Radio', 'Floor, doghouse. New hand is on deck. Rhodes, he is all yours.', 3600);
  }), [start]);
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'radial-gradient(ellipse at center, rgba(10,10,12,0.35), rgba(10,10,12,0.85))' }}>
      <div style={{ textAlign: 'center', color: '#fff', maxWidth: 620 }}>
        <div style={{ fontSize: 13, letterSpacing: 6, color: '#f2b233' }}>WORKSHIFT</div>
        <div style={{ fontSize: 54, fontWeight: 900, marginTop: 6, letterSpacing: -1 }}>Offshore Drilling Rig</div>
        <div style={{ fontSize: 17, color: '#d8d0c4', marginTop: 10 }}>You are a floorhand on a twelve hour tour. The well is at eleven thousand feet. Do your job, keep your crew safe.</div>
        <div style={{ marginTop: 22, fontSize: 16, color: '#f2b233' }}>Wave to start the shift</div>
      </div>
    </div>
  );
}

function Review() {
  const s = useGame();
  const kickSecs = s.annularAt && s.alarmAt ? (s.annularAt - s.alarmAt) / 1000 : null;
  const pct = (x) => (x == null ? '-' : `${Math.round(x * 100)}%`);
  const safety = Math.round(((s.choice === 0 ? 1 : 0.2) * 0.5 + (kickSecs != null ? Math.max(0, 1 - Math.max(0, kickSecs - 10) / 40) : 0) * 0.5) * 100);
  const rows = [
    ['Make-up torque', pct(s.scores.torque)],
    ['Pressure control', pct(s.scores.choke)],
    ['Kick: time to close annular', kickSecs != null ? `${kickSecs.toFixed(1)} s` : '-'],
    ['Kick: pressure bleed-off', pct(s.scores.kickChoke)],
    ['Flow check decision', s.choice === 0 ? 'Ran the flow check' : 'Skipped it'],
  ];
  return (
    <div style={{ position: 'absolute', inset: 0, background: 'rgba(8,8,10,0.86)', display: 'grid', placeItems: 'center', color: '#fff', overflow: 'auto' }}>
      <div style={{ width: 860, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, padding: 24 }}>
        <div style={{ gridColumn: '1 / -1' }}>
          <div style={{ fontSize: 13, letterSpacing: 6, color: '#f2b233' }}>SHIFT REVIEW</div>
          <div style={{ fontSize: 42, fontWeight: 900 }}>Tour complete. Safety rating {safety}/100</div>
        </div>
        <div style={{ padding: 18, ...ui.panel }}>
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
              <span style={{ color: '#bbb' }}>{k}</span><b>{v}</b>
            </div>
          ))}
          {s.choice === 1 && <div style={{ marginTop: 12, color: '#ff8a7a', fontSize: 14 }}>Skipping a flow check after a kick is how blowouts happen. Pressure to keep schedule is one of the most common factors behind well control incidents.</div>}
        </div>
        <div style={{ padding: 18, ...ui.panel, fontSize: 14, lineHeight: 1.55, color: '#ddd' }}>
          <div style={{ fontWeight: 800, color: '#fff', marginBottom: 8 }}>The real job</div>
          <div><b>Ladder:</b> roustabout, floorhand, derrickhand, assistant driller, driller, toolpusher.</div>
          <div style={{ marginTop: 6 }}><b>Schedule:</b> rotations like two weeks on, two weeks off, working 12-hour tours.</div>
          <div style={{ marginTop: 6 }}><b>Workers love:</b> long stretches of time off, strong crew bonds, good pay for entry-level work.</div>
          <div style={{ marginTop: 6 }}><b>Workers hate:</b> noise, weather, fatigue, time away from family, and real physical risk.</div>
          <div style={{ marginTop: 10, color: '#f2b233' }}>Was this you?</div>
        </div>
        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 12 }}>
          <button onClick={() => window.location.reload()} style={{ padding: '12px 26px', fontWeight: 800, borderRadius: 8, border: 0, background: '#f2b233', color: '#111', cursor: 'pointer', fontSize: 16 }}>Play again</button>
          <a href="/" style={{ padding: '12px 26px', fontWeight: 700, borderRadius: 8, background: 'rgba(255,255,255,0.08)', color: '#fff', textDecoration: 'none', fontSize: 16 }}>Back to lobby</a>
        </div>
      </div>
    </div>
  );
}

export default function Hud() {
  const phase = useGame((s) => s.phase);
  const skill = useGame((s) => s.skill);
  useEffect(() => {
    // dev helper: ?kick=1 jumps straight to the emergency
    window.__workshift = { state: () => useGame.getState(), flow, set: (p) => useGame.getState().set(p), close: (r) => useGame.getState().closeSkill(r) };
  }, []);
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', fontFamily: ui.font }}>
      <div style={{ position: 'absolute', inset: 0, pointerEvents: phase === 'play' && !skill ? 'none' : 'auto' }}>
        {phase === 'play' && <><Alarm /><Objective /><Prompt /><Subtitle /><Skill /></>}
        {phase === 'intro' && <Intro />}
        {phase === 'review' && <Review />}
      </div>
      {phase !== 'review' && <WebcamPanel />}
    </div>
  );
}
