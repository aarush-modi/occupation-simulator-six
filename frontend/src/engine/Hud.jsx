'use client';
// HUD for generated shifts (F7): task + list, crosshair prompt, denial toasts, NPC subtitles, event banner,
// connection state, skill widgets (reused from the rig game), webcam panel, briefing and review screens.
import { useEffect, useState } from 'react';
import { useShift } from './store';
import { closeSkill } from './actions';
import { createRoom } from './net';
import { KIND_GESTURES } from './world';
import { Timing, Steady, PressHold } from '../game/Hud';
import WebcamPanel from '../game/webcam/WebcamPanel';
import { cam, GESTURE_HINT, onGesture } from '../game/webcam/gestures';
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
    action === 'windup' ? 'Incoming strike. Raise both open palms.' : action === 'cover' ? 'Rival is guarding. Wait for an opening.' :
    'Raise your shoulders to close in. Make a fist to strike.';
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
  const hint = focus?.kind === 'press' ? 'Push an open palm or pinch' : GESTURE_HINT[g];
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
    startAudio();
    set({ started: true });
  }), [set]);
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'radial-gradient(ellipse at center, rgba(10,10,12,0.35), rgba(10,10,12,0.85))', pointerEvents: 'auto' }}>
      <div style={{ textAlign: 'center', color: '#fff', maxWidth: 640, padding: 24 }}>
        <div style={{ fontSize: 13, letterSpacing: 6, color: ui.accent, textTransform: 'uppercase' }}>Workshift · {bp.occupation}</div>
        <div style={{ fontSize: 50, fontWeight: 900, marginTop: 6, letterSpacing: -1, lineHeight: 1.05 }}>{bp.title}</div>
        <div style={{ fontSize: 17, color: '#d8d0c4', marginTop: 14, lineHeight: 1.5 }}>{bp.briefing}</div>
        <div style={{ marginTop: 22, fontSize: 16, color: ui.accent }}>Raise both shoulders or wave to start</div>
      </div>
    </div>
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
        <div style={{ padding: 18, ...ui.panel, fontSize: 14, lineHeight: 1.55, color: '#ddd' }}>
          <div style={{ fontWeight: 800, color: '#fff', marginBottom: 8 }}>The real job</div>
          {bp.facts.map((f, i) => <div key={i} style={{ marginTop: i ? 8 : 0, display: 'flex', gap: 8 }}><span style={{ color: ui.accent }}>•</span><span>{f}</span></div>)}
          <div style={{ marginTop: 12, color: ui.accent }}>Was this you?</div>
        </div>
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
      {phase === 'play' && started && <><Banner /><TaskPanel /><Prompt /><Toast /><ObjectiveFlash /><Subtitle /><SkillDialog /></>}
      {phase === 'play' && !started && <Intro />}
      {phase === 'review' && <Review />}
      {phase !== 'review' && <ConnBadge />}
      {phase !== 'review' && <WebcamPanel />}
    </div>
  );
}
