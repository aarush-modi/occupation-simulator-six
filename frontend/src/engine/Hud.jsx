'use client';
// HUD for generated shifts (F7): task + list, crosshair prompt, denial toasts, NPC subtitles, event banner,
// connection state, skill widgets (reused from the rig game), webcam panel, briefing and review screens.
import { useEffect, useRef, useState } from 'react';
import { useShift } from './store';
import { closeSkill } from './actions';
import { createRoom } from './net';
import { KIND_GESTURES } from './world';
import { Timing, Steady, PressHold } from '../game/Hud';
import WebcamPanel from '../game/webcam/WebcamPanel';
import { cam, GESTURE_HINT, onGesture } from '../game/webcam/gestures';
import { BODY_GESTURE_HINT } from '../game/webcam/pose';
import { startAudio } from '../game/audio';

export const ui = {
  font: "'Inter', 'Segoe UI', system-ui, sans-serif",
  accent: '#f2b233',
  panel: { background: 'linear-gradient(180deg, rgba(12,12,14,0.8), rgba(12,12,14,0.66))', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, backdropFilter: 'blur(6px)' },
};

function useTick(ms = 500) {
  const [, set] = useState(0);
  useEffect(() => { const i = setInterval(() => set((x) => x + 1), ms); return () => clearInterval(i); }, [ms]);
}

export const fmtTime = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const VERB_ICON = { grab: '✋', place: '⤓', press: '◉', talk: '💬' };
const remaining = (game) => fmtTime(game.deadline === null ? 0 : game.deadline - game.clock);
const MATCH_RESULT = { win: 'You won', loss: 'You lost', draw: 'Draw' };

function SparringPanel({ bp, game }) {
  const rival = bp.npcs.find(npc => npc.id === bp.game.opponent);
  const action = game.opponent.action;
  const message = game.status === 'rest' ? 'Next round soon' : game.status === 'waiting' ? 'Waiting for the bell' :
    action === 'windup' ? (cam.mode === 'body' ? 'Incoming strike.' : 'Incoming strike. Raise both open palms.') : action === 'cover' ? 'Rival is guarding. Wait for an opening.' :
    cam.mode === 'body' ? 'Swing your arms to close in. Reach forward to strike.' : 'Raise your shoulders to close in. Make a fist to strike.';
  return (
    <section aria-label="Match scoreboard" style={{ position: 'absolute', top: 20, left: 20, width: 'min(380px, 55vw)', padding: '14px 16px', ...ui.panel, borderLeft: '3px solid #67acf7', color: '#fff' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13, color: '#d1d8e8' }}>
        <span>Round {game.round} / {bp.game.rounds}</span>
        <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{game.status === 'waiting' ? '–' : remaining(game)}</strong>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, margin: '10px 0 8px' }}>
        {[['Your corner', game.points, game.wins, '#85bfff'], [rival?.name ?? 'Opponent', game.rivalPoints, game.rivalWins, '#ff9e91']].map(([label, points, wins, color]) => (
          <div key={color} style={{ borderBottom: `2px solid ${color}`, paddingBottom: 5 }}>
            <div style={{ fontSize: 13 }}>{label}</div>
            <strong style={{ fontSize: 32, color }}>{points}</strong>
            <span style={{ marginLeft: 6, fontSize: 11, color: '#c1c9d7' }}>{wins} {wins === 1 ? 'round' : 'rounds'}</span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 12, color: '#c1c9d7' }}>First to {bp.game.pointsToWin} points or ahead at the bell</div>
      <div style={{ marginTop: 7, fontSize: 14, color: action === 'windup' ? '#ffb1a6' : '#fff' }}>{message}</div>
    </section>
  );
}

function TaskPanel() {
  useTick(500);
  const bp = useShift((s) => s.blueprint);
  const st = useShift((s) => s.state);
  const banner = useShift((s) => s.banner);
  if (!bp || !st) return null;
  if (st.game?.kind === 'sparring') return <SparringPanel bp={bp} game={st.game} />;
  const challenge = st.game?.kind === 'challenge' ? st.game : null;
  const rival = bp.game?.role === 'rival' ? bp.npcs.find(npc => npc.id === bp.game.partner) : null;
  const cur = st.objectives[st.cur];
  const done = new Set(st.done);
  const alarm = !!banner || (st.event?.fired && Date.now() - (st.event.at ?? 0) < 8000);
  return (
    <div style={{ position: 'absolute', top: 20, left: 20, width: 340, padding: '14px 16px 12px', ...ui.panel, borderLeft: `3px solid ${alarm ? '#ff3b2f' : ui.accent}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, letterSpacing: 2, color: '#a9a39a', textTransform: 'uppercase' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 240 }}>{bp.occupation}</span>
        <span style={{ color: '#f2d9a6', fontVariantNumeric: 'tabular-nums' }}>{challenge ? challenge.status === 'waiting' ? '–' : remaining(challenge) : fmtTime(Date.now() - st.startedAt)}</span>
      </div>
      {challenge && <div style={{ marginTop: 8, fontSize: 13, color: '#d1d8e8' }}>Team {challenge.points} / {bp.game.goal}{rival && ` · ${rival.name} ${challenge.rivalPoints}`}</div>}
      <div style={{ marginTop: 8, fontSize: 18, fontWeight: 700, color: '#fff', lineHeight: 1.3 }}>{cur ? cur.label : 'Shift complete'}</div>
      {cur?.tip && <div style={{ marginTop: 5, fontSize: 13, color: '#d8d0c4', lineHeight: 1.4 }}><span style={{ color: ui.accent, fontWeight: 700 }}>Pro tip </span>{cur.tip}</div>}
      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 3 }}>
        {st.objectives.map((o, i) => {
          const isDone = done.has(o.id) || i < st.cur;
          const isCur = i === st.cur;
          return (
            <div key={`${o.id}${i}`} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 13, color: isDone ? '#7d8a7f' : isCur ? '#fff' : '#a9a39a', textDecoration: isDone ? 'line-through' : 'none' }}>
              <span style={{ width: 16, flex: '0 0 16px', textAlign: 'center', color: isDone ? '#3cff8a' : isCur ? ui.accent : '#666', textDecoration: 'none' }}>{isDone ? '✓' : isCur ? '▸' : '·'}</span>
              <span>{o.label}{o.skill && o.skill !== 'none' && !isDone ? <span style={{ marginLeft: 6, fontSize: 10, letterSpacing: 1, color: ui.accent, textTransform: 'uppercase' }}>skill</span> : null}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// The coworker who coaches: the blueprint's mentor, else the first NPC who is not the waiting customer.
export function mentorOf(bp) {
  return bp.npcs.find(npc => npc.id === bp.mentor) ?? bp.npcs.find(npc => npc.id !== bp.order?.npc) ?? null;
}

// Says each step's tip when the step starts, once per step.
function Coach() {
  const bp = useShift((s) => s.blueprint);
  const cur = useShift((s) => s.state?.objectives?.[s.state.cur]);
  const say = useShift((s) => s.say);
  const spoken = useRef(new Set());
  useEffect(() => {
    if (!cur?.tip || spoken.current.has(cur.id)) return;
    spoken.current.add(cur.id);
    say(mentorOf(bp)?.name ?? 'Coach', cur.tip);
  }, [bp, cur, say]);
  return null;
}

// The customer waiting on this shift, with how long they have waited against their patience.
function OrderTicket() {
  useTick(500);
  const bp = useShift((s) => s.blueprint);
  const st = useShift((s) => s.state);
  const say = useShift((s) => s.say);
  const complained = useRef(false);
  const order = bp?.order;
  const customer = order && bp.npcs.find(npc => npc.id === order.npc);
  const waited = st ? Date.now() - st.startedAt : 0;
  const share = order ? waited / (order.patienceSec * 1000) : 0;
  useEffect(() => {
    if (order && customer && share >= 1 && !complained.current) {
      complained.current = true;
      say(customer.name, order.waiting);
    }
  }, [order, customer, share, say]);
  if (!order || !customer) return null;
  const color = share >= 1 ? '#ff6a5c' : share >= 0.75 ? ui.accent : '#3cff8a';
  const patience = fmtTime(order.patienceSec * 1000);
  return (
    <div style={{ position: 'absolute', top: 64, right: 20, width: 250, padding: '10px 14px 12px', ...ui.panel, borderTop: `3px solid ${color}`, color: '#fff' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 11, letterSpacing: 2, color: '#a9a39a', textTransform: 'uppercase' }}>
        <span>Order · {customer.name}</span>
        <span style={{ color, fontVariantNumeric: 'tabular-nums', letterSpacing: 0, fontSize: 13, fontWeight: 700 }}>{fmtTime(waited)}</span>
      </div>
      <div style={{ marginTop: 6, fontSize: 15, fontWeight: 700, lineHeight: 1.3 }}>{order.text}</div>
      <div style={{ marginTop: 8, height: 4, background: 'rgba(255,255,255,0.1)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(1, share) * 100}%`, height: '100%', background: color }} />
      </div>
      <div style={{ marginTop: 5, fontSize: 11, color: share >= 1 ? '#ff9a8a' : '#a9a39a' }}>{share >= 1 ? `Waiting longer than ${patience}` : `Happy to wait ${patience}`}</div>
    </div>
  );
}

function ConnBadge() {
  const conn = useShift((s) => s.conn);
  const n = useShift((s) => (s.state ? Object.keys(s.state.players).length : 0));
  const color = conn === 'open' ? '#3cff8a' : '#f2b233';
  const text = conn === 'open' ? `Connected · ${n} ${n === 1 ? 'player' : 'players'}` : conn === 'reconnecting' ? 'Reconnecting...' : 'Connecting...';
  return (
    <div style={{ position: 'absolute', top: 20, right: 20, padding: '7px 12px', ...ui.panel, color: '#ddd', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: 8, height: 8, borderRadius: 8, background: color, boxShadow: `0 0 8px ${color}` }} />{text}
    </div>
  );
}

function Prompt() {
  const focus = useShift((s) => s.focus);
  const skill = useShift((s) => s.skill);
  const label = focus?.label;
  const g = focus ? KIND_GESTURES[focus.kind]?.[0] : null;
  // Full-body mode: a raised hand uses whatever is highlighted.
  const hint = cam.mode === 'body' ? BODY_GESTURE_HINT.fist : focus?.kind === 'press' ? 'Push an open palm or pinch' : GESTURE_HINT[g];
  return (
    <>
      <div style={{ position: 'absolute', left: '50%', top: '50%', width: 6, height: 6, marginLeft: -3, marginTop: -3, borderRadius: 6, background: label ? ui.accent : 'rgba(255,255,255,0.8)', boxShadow: '0 0 6px rgba(0,0,0,0.6)' }} />
      {label && !skill && (
        <div style={{ position: 'absolute', left: '50%', top: '57%', transform: 'translateX(-50%)', padding: '8px 14px', ...ui.panel, color: '#fff', fontSize: 15, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {label}
          </div>
          {cam.enabled && g && <div style={{ fontSize: 12, color: ui.accent }}>{hint ?? g}</div>}
        </div>
      )}
    </>
  );
}

function Toast() {
  const t = useShift((s) => s.toast);
  if (!t) return null;
  const info = t.kind === 'info';
  return (
    <div key={t.id} style={{ position: 'absolute', left: '50%', top: '65%', transform: 'translateX(-50%)', padding: '9px 16px', borderRadius: 8, background: info ? 'rgba(20,60,36,0.9)' : 'rgba(120,20,14,0.92)', border: `1px solid ${info ? 'rgba(60,255,138,0.4)' : 'rgba(255,120,100,0.45)'}`, color: '#fff', fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap', animation: 'ws-pop 0.18s ease-out' }}>
      {info ? '' : '⚠ '}{t.text}
    </div>
  );
}

function Subtitle() {
  const sub = useShift((s) => s.subtitle);
  if (!sub) return null;
  return (
    <div style={{ position: 'absolute', left: '50%', bottom: 64, transform: 'translateX(-50%)', maxWidth: 760, textAlign: 'center', padding: '10px 18px', ...ui.panel, color: '#fff', fontSize: 18, lineHeight: 1.4 }}>
      <span style={{ color: ui.accent, fontWeight: 700 }}>{sub.who}: </span>{sub.text}
    </div>
  );
}

function Banner() {
  const b = useShift((s) => s.banner);
  if (!b) return null;
  return (
    <>
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', boxShadow: 'inset 0 0 200px 30px rgba(255,20,10,0.85)', animation: 'ws-pulse 0.9s infinite' }} />
      <div style={{ position: 'absolute', top: 20, left: '50%', transform: 'translateX(-50%)', maxWidth: 620, textAlign: 'center', borderRadius: 8, overflow: 'hidden', boxShadow: '0 6px 30px rgba(0,0,0,0.5)' }}>
        <div style={{ padding: '6px 16px', background: '#c9150b', color: '#fff', fontWeight: 900, letterSpacing: 4, fontSize: 13 }}>CHANGE OF PLAN</div>
        <div style={{ padding: '10px 16px', background: 'rgba(20,8,8,0.88)', color: '#fff', fontSize: 16, lineHeight: 1.4 }}>
          {b.who && <b style={{ color: '#ff9a8a' }}>{b.who}: </b>}{b.text}
        </div>
      </div>
    </>
  );
}

function ObjectiveFlash() {
  const f = useShift((s) => s.lastObjective);
  const [show, setShow] = useState(null);
  useEffect(() => {
    if (!f) return;
    setShow(f);
    const t = setTimeout(() => setShow(null), 1600);
    return () => clearTimeout(t);
  }, [f]);
  if (!show) return null;
  return (
    <div key={show.id} style={{ position: 'absolute', left: '50%', top: '38%', transform: 'translateX(-50%)', padding: '8px 16px', borderRadius: 999, background: 'rgba(20,60,36,0.88)', border: '1px solid rgba(60,255,138,0.45)', color: '#c9ffd9', fontSize: 15, fontWeight: 700, whiteSpace: 'nowrap', animation: 'ws-pop 0.2s ease-out' }}>
      ✓ {show.label}
    </div>
  );
}

function SkillDialog() {
  const skill = useShift((s) => s.skill);
  if (!skill) return null;
  const Comp = { timing: Timing, steady: Steady, presshold: PressHold }[skill.type];
  if (!Comp) return null;
  return (
    <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', padding: '22px 26px', ...ui.panel, color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', pointerEvents: 'auto' }}>
      <div style={{ fontSize: 12, letterSpacing: 3, color: ui.accent, textTransform: 'uppercase', marginBottom: 6 }}>{skill.title}</div>
      {skill.help && <div style={{ fontSize: 13, color: '#bbb', marginBottom: 16, maxWidth: 460, textAlign: 'center' }}>{skill.help}</div>}
      <Comp skill={skill} close={closeSkill} />
    </div>
  );
}

function Intro() {
  const bp = useShift((s) => s.blueprint);
  const set = useShift((s) => s.set);
  useEffect(() => onGesture((name) => {
    if (name !== 'wave' && name !== 'move') return;
    startAudio({ workplace: true, outdoors: bp.venue?.enclosure === 'outdoor' || bp.venue?.enclosure === 'open_front' });
    set({ started: true });
  }), [set, bp.venue?.enclosure]);
  // The start hint depends on the webcam mode, which the panel can switch at any time.
  const [mode, setMode] = useState(cam.mode);
  useEffect(() => {
    const id = setInterval(() => setMode(cam.mode), 250);
    return () => clearInterval(id);
  }, []);
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'radial-gradient(ellipse at center, rgba(10,10,12,0.35), rgba(10,10,12,0.85))', pointerEvents: 'auto' }}>
      <div style={{ textAlign: 'center', color: '#fff', maxWidth: 640, padding: 24 }}>
        <div style={{ fontSize: 13, letterSpacing: 6, color: ui.accent, textTransform: 'uppercase' }}>Workshift · {bp.occupation}</div>
        <div style={{ fontSize: 50, fontWeight: 900, marginTop: 6, letterSpacing: -1, lineHeight: 1.05 }}>{bp.title}</div>
        <div style={{ fontSize: 17, color: '#d8d0c4', marginTop: 14, lineHeight: 1.5 }}>{bp.briefing}</div>
        <div style={{ marginTop: 22, fontSize: 16, color: ui.accent }}>{mode === 'body' ? 'Swing your arms or wave to start' : 'Raise both shoulders or wave to start'}</div>
      </div>
    </div>
  );
}

function Bullets({ items, color = ui.accent }) {
  return items.map((text, i) => <div key={i} style={{ marginTop: i ? 7 : 0, display: 'flex', gap: 8 }}><span style={{ color }}>•</span><span>{text}</span></div>);
}

function Demand({ label, demand }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <span style={{ fontWeight: 700, color: '#fff' }}>{label}</span>
        <span aria-label={`${demand.level} of 5`} style={{ display: 'flex', gap: 3 }}>
          {[1, 2, 3, 4, 5].map(n => <span key={n} style={{ width: 18, height: 6, borderRadius: 3, background: n <= demand.level ? ui.accent : 'rgba(255,255,255,0.12)' }} />)}
        </span>
      </div>
      <div style={{ marginTop: 3, color: '#bbb', fontSize: 13 }}>{demand.note}</div>
    </div>
  );
}

// What the real job is like, so the player can judge whether it suits them.
function Career({ career, facts, occupation }) {
  const card = { padding: 18, ...ui.panel, fontSize: 14, lineHeight: 1.55, color: '#ddd' };
  const heading = { fontWeight: 800, color: '#fff', marginBottom: 8 };
  return (
    <>
      <div style={card}>
        <div style={heading}>A real day as a {occupation}</div>
        <div>{career.dayInLife}</div>
        <div style={{ marginTop: 8, color: '#bbb', fontSize: 13 }}><b style={{ color: '#ddd' }}>Hours:</b> {career.schedule}</div>
        <Demand label="Physical" demand={career.physical} />
        <Demand label="People" demand={career.people} />
        <Demand label="Pressure" demand={career.pressure} />
      </div>
      <div style={card}>
        <div style={heading}>What people love</div>
        <Bullets items={career.loves} color="#3cff8a" />
      </div>
      <div style={card}>
        <div style={heading}>The hard parts</div>
        <Bullets items={career.hard} color="#ff8a7a" />
      </div>
      <div style={{ ...card, gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div>
          <div style={heading}>How to get started</div>
          <div>{career.start}</div>
        </div>
        <div>
          <div style={heading}>Did you know</div>
          <Bullets items={facts} />
        </div>
      </div>
      <div style={{ gridColumn: '1 / -1', color: ui.accent, fontSize: 16, fontWeight: 700 }}>Could you see yourself doing this every day?</div>
    </>
  );
}

function Review() {
  const bp = useShift((s) => s.blueprint);
  const st = useShift((s) => s.state);
  const [busy, setBusy] = useState(false);
  const game = st.game;
  const result = game?.result ? MATCH_RESULT[game.result] : 'Shift complete';
  const elapsed = (st.score?.finishedAt ?? Date.now()) - (st.score?.startedAt ?? st.startedAt);
  const metrics = [['Time', fmtTime(elapsed)]];
  const skilled = st.objectives.filter((o) => o.skill && o.skill !== 'none');
  const skillVals = skilled.map((o) => st.score?.skills?.[o.id]).filter((v) => typeof v === 'number');
  const avg = skillVals.length ? skillVals.reduce((a, b) => a + b, 0) / skillVals.length : null;
  if (game?.kind === 'sparring') metrics.push(['Rounds won', game.wins], ['Opponent rounds won', game.rivalWins]);
  else {
    metrics.push(['Steps completed', `${st.done.length} / ${st.objectives.length}`]);
    if (game?.kind === 'challenge') metrics.push(['Team points', `${game.points} / ${bp.game.goal}`]);
    const customer = bp.order && bp.npcs.find(npc => npc.id === bp.order.npc);
    if (customer) {
      const patience = bp.order.patienceSec * 1000;
      metrics.push([`${customer.name}'s wait`, elapsed <= patience ? `${fmtTime(elapsed)} ✓` : `${fmtTime(elapsed)}, hoped for ${fmtTime(patience)}`]);
    }
  }
  const again = async () => {
    setBusy(true);
    try {
      const request = useShift.getState().occupation || bp.occupation;
      const { roomId } = await createRoom(request);
      window.location.href = `/shift?room=${encodeURIComponent(roomId)}&host=1&job=${encodeURIComponent(request)}`;
    } catch { window.location.reload(); }
  };
  return (
    <div style={{ position: 'absolute', inset: 0, background: 'rgba(8,8,10,0.86)', display: 'grid', placeItems: 'center', color: '#fff', overflow: 'auto', pointerEvents: 'auto' }}>
      <div style={{ width: 'min(880px, 92vw)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, padding: 24 }}>
        <div style={{ gridColumn: '1 / -1' }}>
          <div style={{ fontSize: 13, letterSpacing: 6, color: ui.accent }}>SHIFT REVIEW</div>
          <div style={{ fontSize: 40, fontWeight: 900, lineHeight: 1.1, marginTop: 4 }}>{bp.title}</div>
          <div style={{ color: '#bbb', marginTop: 6, fontSize: 16 }}>{result} · {fmtTime(elapsed)}{avg != null ? ` · skill ${Math.round(avg * 100)}%` : ''}</div>
        </div>
        <div style={{ padding: 18, ...ui.panel }}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>Your shift</div>
          {[...metrics, ...skilled.map((o) => [o.label, typeof st.score?.skills?.[o.id] === 'number' ? `${Math.round(st.score.skills[o.id] * 100)}%` : '-']),
            ...(st.event?.fired ? [['Handled the change of plan', '✓']] : [])].map(([k, v], i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.07)', fontSize: 14 }}>
              <span style={{ color: '#bbb' }}>{k}</span><b style={{ whiteSpace: 'nowrap' }}>{v}</b>
            </div>
          ))}
        </div>
        {bp.career ? <Career career={bp.career} facts={bp.facts} occupation={bp.occupation} /> : (
          <div style={{ padding: 18, ...ui.panel, fontSize: 14, lineHeight: 1.55, color: '#ddd' }}>
            <div style={{ fontWeight: 800, color: '#fff', marginBottom: 8 }}>The real job</div>
            <Bullets items={bp.facts} />
            <div style={{ marginTop: 12, color: ui.accent }}>Was this you?</div>
          </div>
        )}
        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 12 }}>
          <button onClick={again} disabled={busy} style={{ padding: '12px 26px', fontWeight: 800, borderRadius: 8, border: 0, background: ui.accent, color: '#111', cursor: 'pointer', fontSize: 16 }}>{busy ? 'Starting...' : 'Play again'}</button>
          <a href="/" style={{ padding: '12px 26px', fontWeight: 700, borderRadius: 8, background: 'rgba(255,255,255,0.08)', color: '#fff', textDecoration: 'none', fontSize: 16 }}>Back to lobby</a>
        </div>
      </div>
    </div>
  );
}

export const KEYFRAMES = `@keyframes ws-pulse { 0%,100% { opacity: .15 } 50% { opacity: .55 } }
@keyframes ws-pop { from { opacity: 0; transform: translateX(-50%) scale(0.94) } to { opacity: 1; transform: translateX(-50%) scale(1) } }
@keyframes ws-spin { to { transform: rotate(360deg) } }`;

export default function Hud() {
  const phase = useShift((s) => s.state?.phase);
  const started = useShift((s) => s.started);
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', fontFamily: ui.font, zIndex: 10 }}>
      <style>{KEYFRAMES}</style>
      {phase === 'play' && started && <><Banner /><TaskPanel /><OrderTicket /><Coach /><Prompt /><Toast /><ObjectiveFlash /><Subtitle /><SkillDialog /></>}
      {phase === 'play' && !started && <Intro />}
      {phase === 'review' && <Review />}
      {phase !== 'review' && <ConnBadge />}
      {phase !== 'review' && <WebcamPanel />}
    </div>
  );
}
