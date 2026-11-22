'use client';
// HUD for generated shifts, in the lobby's pixel style (app/ui/hud.css) and kept to the essentials: what to do now,
// how the shift is going, who is talking, and how to answer them.
import { useEffect, useRef, useState } from 'react';
import { Textarea } from '@ui-sdk/react/textarea';
import { useShift } from './store';
import { createRoom, localPose, sampleNpc } from './net';
import { KIND_GESTURES, matchesObjective, gestureHint } from './world';
import { playerStep, STANDING_START } from '../shared/sim.js';
import WebcamPanel from '../game/webcam/WebcamPanel';
import { cam, GESTURE_HINT, onGesture } from '../game/webcam/gestures';
import { BODY_GESTURE_HINT } from '../game/webcam/pose';
import { startAudio } from '../game/audio';
import { toggleMic, stopMic, voiceSupported, autoStartMic, speakTo } from './voice';
import { workView } from './workView';

// Kept for other screens that style themselves inline.
export const ui = { font: 'var(--font-pixel), ui-monospace, monospace', accent: '#f2b233' };

function useTick(ms = 500) {
  const [, set] = useState(0);
  useEffect(() => { const i = setInterval(() => set((x) => x + 1), ms); return () => clearInterval(i); }, [ms]);
}

export const fmtTime = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const remaining = (game) => fmtTime(game.deadline === null ? 0 : game.deadline - game.clock);
const MATCH_RESULT = { win: 'You won', loss: 'You lost', draw: 'Draw' };
const myStep = (s) => { const step = s.state ? playerStep(s.state, s.you) : null; return step && !step.waiting ? step.obj : null; };

// The coworker who coaches: the blueprint's mentor, else the first NPC who is not the waiting customer.
export function mentorOf(bp) {
  return bp.npcs.find(npc => npc.id === bp.mentor) ?? bp.npcs.find(npc => npc.id !== bp.order?.npc) ?? null;
}

function Meter({ value, max = STANDING_START, blocks = 20 }) {
  const lit = Math.round((Math.max(0, value) / max) * blocks);
  return <div className="ws-meter">{Array.from({ length: blocks }, (_, i) => <i key={i} data-on={i < lit || undefined} />)}</div>;
}

function SparringPanel({ bp, game }) {
  const rival = bp.npcs.find(npc => npc.id === bp.game.opponent);
  const action = game.opponent.action;
  const message = game.status === 'rest' ? 'Next round soon' : game.status === 'waiting' ? 'Waiting for the bell' :
    action === 'windup' ? (cam.mode === 'body' ? 'Incoming strike' : 'Incoming. Raise both palms') : action === 'cover' ? 'Rival is guarding' :
    cam.mode === 'body' ? 'Reach forward to strike' : 'Make a fist to strike';
  return (
    <section className="ws-card ws-task" aria-label="Match">
      <div className="ws-task-top"><span className="ws-label">Round {game.round} / {bp.game.rounds}</span><span className="ws-label">{game.status === 'waiting' ? '-' : remaining(game)}</span></div>
      <div className="ws-task-title">{game.points} <span className="ws-label">you</span> &nbsp; {game.rivalPoints} <span className="ws-label">{rival?.name ?? 'rival'}</span></div>
      <div className="ws-task-real">{message}</div>
    </section>
  );
}

/** Where the current step happens, in plain words: the station, the counter something sits on, or who to talk to. */
export function whereText(bp, st, obj) {
  if (!obj || !bp || !st) return null;
  const station = (id) => bp.stations.find((s) => s.id === id)?.label;
  const spot = (at) => {
    if (!at) return null;
    const [id] = String(at).split('.');
    return String(at).includes('.') ? station(id) : /^S[1-8]$/.test(at) ? 'the supply counter by the door' : null;
  };
  if (obj.verb === 'talk') {
    const npc = st.people?.[obj.target] ?? bp.npcs.find((n) => n.id === obj.target);
    return npc ? `${npc.name}, ${String(npc.role).toLowerCase()}` : null;
  }
  if (obj.verb === 'grab') return spot(st.items?.[obj.target]?.at);
  return spot(obj.target);
}

function TaskPanel() {
  useTick(500);
  const bp = useShift((s) => s.blueprint);
  const st = useShift((s) => s.state);
  const banner = useShift((s) => s.banner);
  const you = useShift((s) => s.you);
  const flash = useShift((s) => s.standingFlash);
  if (!bp || !st) return null;
  if (st.game?.kind === 'sparring') return <SparringPanel bp={bp} game={st.game} />;
  const challenge = st.game?.kind === 'challenge' ? st.game : null;
  const step = playerStep(st, you);
  const cur = step && !step.waiting ? step.obj : null;
  const roleLabel = (id) => bp.roles?.find(r => r.id === id)?.label ?? id;
  const title = step?.waiting ? `Waiting for ${roleLabel(step.waitingOn?.role)}` : cur ? cur.label : 'Your part is done';
  const index = st.done.length + (cur ? 1 : 0);
  const standing = st.standing?.value;
  const showFlash = flash && Date.now() - flash.at < 2600;
  return (
    <section className="ws-card ws-task" data-alarm={banner && !banner.calm ? '' : undefined} aria-label="Current task">
      <div className="ws-task-top">
        <span className="ws-label">{bp.occupation}</span>
        <span className="ws-label">{challenge ? (challenge.status === 'waiting' ? '-' : remaining(challenge)) : `${Math.min(index, st.objectives.length)} / ${st.objectives.length}`}</span>
      </div>
      <div className="ws-task-title">{title}</div>
      {cur && whereText(bp, st, cur) && <div className="ws-task-where">{cur.verb === 'talk' ? 'Talk to' : cur.verb === 'grab' ? 'From' : 'At'} {whereText(bp, st, cur)}</div>}
      {cur?.real && <div className="ws-task-real">{cur.real}</div>}
      {challenge && <div className="ws-task-real">Team {challenge.points} / {bp.game.goal}</div>}
      {typeof standing === 'number' && (
        <div className="ws-meter-row" data-low={standing <= 35 || undefined} aria-label={`Job standing ${standing} of ${STANDING_START}`}>
          <span className="ws-label">Standing</span>
          <Meter value={standing} />
        </div>
      )}
      {showFlash && <div key={flash.id} className="ws-delta" data-bad={flash.delta < 0 || undefined} data-good={flash.delta > 0 || undefined}>{flash.delta > 0 ? '+' : ''}{flash.delta} {flash.reason}</div>}
    </section>
  );
}

// The mentor says each step's tip once, when they are close enough to be talking to the player; a mentor across the
// room stays quiet rather than calling out of nowhere.
const COACH_RANGE = 5.5;
function Coach() {
  useTick(500);
  const bp = useShift((s) => s.blueprint);
  const cur = useShift(myStep);
  const say = useShift((s) => s.say);
  const spoken = useRef(new Set());
  const mentor = bp && mentorOf(bp);
  const at = mentor && (sampleNpc(mentor.id) ?? useShift.getState().state?.people?.[mentor.id])?.pos;
  const near = !mentor || (at && Math.hypot(at[0] - localPose.pos[0], at[2] - localPose.pos[2]) <= COACH_RANGE);
  useEffect(() => {
    if (!cur?.tip || !near || spoken.current.has(cur.id)) return;
    spoken.current.add(cur.id);
    say(mentor?.name ?? 'Coach', cur.tip);
  }, [mentor, cur, near, say]);
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
  return (
    <section className="ws-card ws-order" aria-label="Order">
      <div className="ws-task-top"><span className="ws-label">{customer.name}</span><span className="ws-label">{fmtTime(waited)}</span></div>
      <div className="ws-order-text">{order.text}</div>
      <div className="ws-bar" data-warn={share >= 0.75 || undefined} data-late={share >= 1 || undefined}><i style={{ width: `${Math.min(1, share) * 100}%` }} /></div>
    </section>
  );
}

function ConnBadge() {
  const conn = useShift((s) => s.conn);
  const n = useShift((s) => (s.state ? Object.keys(s.state.players).length : 0));
  const invite = useShift((s) => s.invite) || (typeof window !== 'undefined' && useShift.getState().roomId ? `${window.location.origin}/shift?room=${encodeURIComponent(useShift.getState().roomId)}` : '');
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(invite); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch {} };
  return (
    <div className="ws-card ws-conn">
      <i className="ws-dot" data-off={conn !== 'open' || undefined} />
      {conn === 'open' ? `${n} ${n === 1 ? 'player' : 'players'}` : 'Reconnecting'}
      {invite && <button className="ws-mini" data-done={copied || undefined} onClick={copy}>{copied ? 'Copied' : 'Invite'}</button>}
    </div>
  );
}

function Prompt() {
  const focus = useShift((s) => s.focus);
  const mic = useShift((s) => s.mic);
  const cur = useShift(myStep);
  // Aiming at what the current step needs: name the action in the job's own words (the step label).
  const label = focus && cur && matchesObjective(cur, focus) ? cur.label : focus?.label;
  const g = focus ? KIND_GESTURES[focus.kind]?.[0] : null;
  const hint = !focus ? null
    : cam.mode === 'body' ? BODY_GESTURE_HINT.fist
    : focus.kind === 'use' ? gestureHint(focus)
    : focus.kind === 'talk' ? (mic === 'listening' ? 'Just talk, or wave' : 'Wave, or type below')
    : cam.enabled ? GESTURE_HINT[g] : null;
  return (
    <>
      <div className="ws-cross" data-on={label ? '' : undefined} />
      {label && (
        <div className="ws-card ws-aim">
          <span className="ws-aim-label">{label}</span>
          {hint && <span className="ws-aim-hint">{hint}</span>}
          {workView.key && <span className="ws-aim-sub">Walk to step back</span>}
        </div>
      )}
    </>
  );
}

function Toast() {
  const t = useShift((s) => s.toast);
  if (!t) return null;
  return <div key={t.id} className="ws-card ws-toast" data-bad={t.kind !== 'info' || undefined}>{t.text}</div>;
}

function Banner() {
  const b = useShift((s) => s.banner);
  if (!b) return null;
  return (
    <>
      {!b.calm && <div className="ws-edge" />}
      <div key={b.id} className="ws-card ws-banner" data-calm={b.calm || undefined}>
        <span className="ws-label">{b.calm ? 'The plan changed' : 'Change of plan'}</span>
        <span>{b.who ? <span className="ws-accent">{b.who}: </span> : null}{b.text}</span>
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
    const t = setTimeout(() => setShow(null), 1500);
    return () => clearTimeout(t);
  }, [f]);
  if (!show) return null;
  return <div key={show.id} className="ws-card ws-done">Done: {show.label}</div>;
}

// Who is speaking, and what the player just said.
function Talk() {
  const sub = useShift((s) => s.subtitle);
  const h = useShift((s) => s.heard);
  if (!sub && !h) return null;
  const note = !h?.final ? null : h.offline ? 'Not connected' : !h.to ? 'No one is close enough to hear you' : null;
  return (
    <div className="ws-talk" aria-live="polite">
      {h && (
        <div className="ws-card ws-said" data-interim={!h.final || undefined}>
          {h.to ? `You to ${h.to}: ` : 'You: '}{h.text}{h.pending ? <span className="ws-dots" /> : null}
          {note && <small>{note}</small>}
        </div>
      )}
      {sub && <div className="ws-card ws-line"><span className="ws-label">{sub.who}</span>{sub.text}</div>}
    </div>
  );
}

const MIC_TEXT = { off: 'Mic off', starting: 'Mic', listening: 'Mic on', unsupported: 'No voice in this browser', denied: 'Mic blocked', error: 'Mic stopped' };

// Open mic: whatever the player says goes to the NPC in front of them. On by default.
function MicButton() {
  const mic = useShift((s) => s.mic);
  useEffect(() => () => stopMic(), []);
  useEffect(() => { if (voiceSupported()) autoStartMic(); else useShift.getState().set({ mic: 'unsupported' }); }, []);
  const on = mic === 'listening' || mic === 'starting';
  const blocked = mic === 'unsupported';
  const title = mic === 'denied' ? 'Allow the microphone for this site in the address bar, then click again.' : on ? 'Click to mute' : 'Click to talk out loud';
  return (
    <button className="ws-mic" onClick={blocked ? undefined : toggleMic} title={title} aria-pressed={on} disabled={blocked}
      data-on={on || undefined} data-bad={mic === 'denied' || mic === 'error' || undefined}>
      <i aria-hidden="true" />{MIC_TEXT[mic] ?? MIC_TEXT.off}
    </button>
  );
}

// Type to talk: the same as speaking. Enter sends, and Enter anywhere in the shift jumps here.
function ChatBar() {
  const [value, setValue] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      const box = ref.current ?? document.querySelector('.ws-chatbar textarea');
      if (e.key !== 'Enter' || e.isComposing || !box || document.activeElement === box) return;
      if (/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(document.activeElement?.tagName ?? '')) return;
      e.preventDefault();
      box.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const send = (text) => {
    const said = text.trim();
    if (!said) return;
    speakTo(said);
    setValue('');
  };
  return (
    <form className="ws-composer ws-chatbar" onSubmit={(e) => { e.preventDefault(); send(value); }}>
      <span className="ws-composer-caret" aria-hidden="true">&gt;</span>
      <Textarea ref={ref} className="ws-composer-input" aria-label="Say something to the person you are facing"
        placeholder="Say something..." value={value} onValueChange={setValue}
        autoResize rows={1} maxLength={280} submitShortcut="enter" onSubmit={send} spellCheck={false} />
    </form>
  );
}

function Intro() {
  const bp = useShift((s) => s.blueprint);
  const set = useShift((s) => s.set);
  // With a teammate on the other role, tell this player which part of the job is theirs.
  const myRole = useShift((s) => {
    const me = s.state?.players?.[s.you];
    return me?.role && me.lane && bp.roles && me.lane.length < bp.roles.length ? bp.roles.find(r => r.id === me.role) : null;
  });
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
    <div className="ws-sheet">
      <div className="ws-sheet-col">
        <span className="ws-label ws-accent">{bp.occupation}</span>
        <h1>{bp.title}</h1>
        <p>{bp.briefing}</p>
        {myRole && <p><span className="ws-accent">Your role: {myRole.label}.</span> {myRole.brief}</p>}
        <span className="ws-start">{mode === 'body' ? 'Wave to start' : 'Wave or raise both shoulders to start'}<span className="ws-dots" /></span>
      </div>
    </div>
  );
}

function Review() {
  const bp = useShift((s) => s.blueprint);
  const st = useShift((s) => s.state);
  const [busy, setBusy] = useState(false);
  const game = st.game;
  const failed = st.standing?.failed;
  const result = failed ? 'You lost the job' : game?.result ? MATCH_RESULT[game.result] : 'Shift complete';
  const elapsed = (st.score?.finishedAt ?? Date.now()) - (st.score?.startedAt ?? st.startedAt);
  const rows = [['Time', fmtTime(elapsed)]];
  if (game?.kind === 'sparring') rows.push(['Rounds won', `${game.wins} to ${game.rivalWins}`]);
  else {
    rows.push(['Steps done', `${st.done.length} / ${st.objectives.length}`]);
    if (typeof st.standing?.value === 'number') rows.push(['Standing', `${st.standing.value} / ${STANDING_START}`]);
    if (game?.kind === 'challenge') rows.push(['Team points', `${game.points} / ${bp.game.goal}`]);
    const customer = bp.order && bp.npcs.find(npc => npc.id === bp.order.npc);
    if (customer) rows.push([`${customer.name} waited`, fmtTime(elapsed)]);
  }
  const meant = st.objectives.filter((o) => st.done.includes(o.id) && o.real).slice(0, 4);
  const again = async () => {
    setBusy(true);
    try {
      const request = useShift.getState().occupation || bp.occupation;
      const { roomId } = await createRoom(request);
      window.location.href = `/shift?room=${encodeURIComponent(roomId)}&host=1&job=${encodeURIComponent(request)}`;
    } catch { window.location.reload(); }
  };
  const c = bp.career;
  return (
    <div className={`ws-sheet${failed ? ' ws-fired' : ''}`}>
      <div className="ws-sheet-col">
        <span className="ws-label ws-accent">{bp.occupation} · {bp.title}</span>
        <h1>{result}</h1>
        {failed && <p>{failed.reason}. In a real {bp.occupation} job, that is the kind of thing that costs you a shift.</p>}
        <div className="ws-grid">
          <div className="ws-card ws-rows">{rows.map(([k, v]) => <div key={k} className="ws-row"><span>{k}</span>{v}</div>)}</div>
          {meant.length > 0 && (
            <div className="ws-card ws-block">
              <b>What you really did</b>
              {meant.map((o) => <div key={o.id}><span className="ws-accent">{o.label}.</span> {o.real}</div>)}
            </div>
          )}
          {c && (
            <>
              <div className="ws-card ws-block"><b>A real day</b>{c.dayInLife}<span className="ws-label">{c.schedule}</span></div>
              <div className="ws-card ws-block"><b>Getting started</b>{c.start}</div>
              <div className="ws-card ws-block"><b>People love</b>{c.loves.map((t) => <div key={t}>+ {t}</div>)}</div>
              <div className="ws-card ws-block"><b>The hard parts</b>{c.hard.map((t) => <div key={t}>- {t}</div>)}</div>
            </>
          )}
          {!c && bp.facts?.length > 0 && <div className="ws-card ws-block"><b>The real job</b>{bp.facts.map((t) => <div key={t}>{t}</div>)}</div>}
        </div>
        <div className="ws-actions">
          <button className="ws-action" onClick={again} disabled={busy}>{busy ? 'Starting' : failed ? 'Try again' : 'Play again'}</button>
          <a className="ws-action" data-quiet="" href="/" style={{ textDecoration: 'none' }}>New job</a>
        </div>
      </div>
    </div>
  );
}

export default function Hud() {
  const phase = useShift((s) => s.state?.phase);
  const started = useShift((s) => s.started);
  const playing = phase === 'play' && started;
  return (
    <div className="ws-hud">
      {playing && <><Banner /><TaskPanel /><Coach /><Prompt /><Toast /><ObjectiveFlash /><Talk /><MicButton /><ChatBar /></>}
      {phase === 'play' && !started && <Intro />}
      {phase === 'review' && <Review />}
      {phase !== 'review' && <div className="ws-corner"><ConnBadge />{playing && <OrderTicket />}</div>}
      {/* The webcam panel was laid out in small sizes: scale the pixel type up to match. */}
      {phase !== 'review' && <div style={{ fontSizeAdjust: 0.56 }}><WebcamPanel /></div>}
    </div>
  );
}
