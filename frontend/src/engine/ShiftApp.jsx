'use client';
// /shift?room=ID[&host=1][&job=Barista]: joins the room and shows the loading chat while the shift is generated,
// offers a ready-made demo shift if generation fails (F7), then builds and runs the generated shift.
import { Suspense, useEffect, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { useShift } from './store';
import { connect, chooseDemo, fetchRoom, localPose, reconcile, samplePlayer } from './net';
import { act, use, getIndex } from './actions';
import { staticInteractables, RECIPES } from './world';
import { recipeColliders, shellColliders, ShellLighting } from './scene';
import World from './World.jsx';
import { LabelLayer, LabelProjector } from './Labels';
import LocalPlayer from './LocalPlayer';
import Hud from './Hud';
import { BACKEND } from './config';
import { PostFX } from '../game/Look';
import { Button } from '@ui-sdk/react/button';
import PixelSky from '../../app/ui/PixelSky';
import PromptBar from '../../app/ui/PromptBar';
import Avatar from '../../app/ui/Avatar';

const NAMES = ['Alex', 'Sam', 'Jordan', 'Riley', 'Casey', 'Morgan', 'Taylor', 'Jamie', 'Avery', 'Quinn'];

function playerName(isHost) {
  try {
    const k = 'workshift.name';
    let n = sessionStorage.getItem(k);
    if (!n) { n = NAMES[Math.floor(Math.random() * NAMES.length)]; sessionStorage.setItem(k, n); }
    return n;
  } catch { return isHost ? 'Host' : 'Guest'; }
}

function normalizeColliders(c, shellId) {
  const list = typeof c === 'function' ? c(shellId) : Array.isArray(c) ? c : c?.[shellId] ?? [];
  return (list ?? []).map((b) => (b.minX !== undefined ? b : { minX: b.pos[0] - b.size[0] / 2, maxX: b.pos[0] + b.size[0] / 2, minZ: b.pos[2] - b.size[b.size.length === 3 ? 2 : 1] / 2, maxZ: b.pos[2] + b.size[b.size.length === 3 ? 2 : 1] / 2 }));
}

function useDebugHook() {
  useEffect(() => {
    window.__shift = {
      get state() { return useShift.getState().state; },
      get blueprint() { return useShift.getState().blueprint; },
      get you() { return useShift.getState().you; },
      get focus() { return useShift.getState().focus; },
      store: useShift,
      act,
      use,
      interactables: () => { const s = useShift.getState(); const idx = getIndex(); return idx ? staticInteractables(idx, s.state, s.you) : []; },
      teleport: (x, z, yaw) => { reconcile.pos = [x, 0, z]; if (yaw !== undefined) reconcile.yaw = yaw; },
      pose: () => ({ ...localPose, pos: [...localPose.pos] }),
      sample: samplePlayer,
      start: () => useShift.getState().set({ started: true }),
      // Stand `standoff` m from a world point (on the room-centre side) and aim the crosshair at it.
      goto: (p, standoff = 1.1) => {
        let dx = 0 - p[0], dz = 0.5 - p[2];
        const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
        const x = p[0] + dx * standoff, z = p[2] + dz * standoff;
        const yaw = Math.atan2(-(p[0] - x), -(p[2] - z));
        const pitch = Math.atan2(p[1] - 1.62, Math.hypot(p[0] - x, p[2] - z));
        reconcile.pos = [x, 0, z]; reconcile.yaw = yaw; reconcile.pitch = pitch;
        return [x, z];
      },
      // Walk to an interactable by id ("grab:cup", "press:espresso.brew", ...) and aim at it.
      approach: (id, standoff) => {
        const s = useShift.getState(); const idx = getIndex();
        const it = staticInteractables(idx, s.state, s.you).find((x) => x.id === id);
        if (!it) return null;
        return window.__shift.goto(it.pos, standoff);
      },
    };
  }, []);
}

function Game() {
  const bp = useShift((s) => s.blueprint);
  const quality = useMemo(() => (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('quality') ?? 'high' : 'high'), []);
  const colliders = useMemo(() => {
    if (bp.game?.kind === 'sparring') return [];
    const out = normalizeColliders(shellColliders, bp.shell);
    for (const st of bp.stations) { const r = getIndex()?.stations[st.id]?.recipe; if (r) out.push(recipeColliders(r, st.anchor)); }
    for (const d of bp.decor ?? []) { const r = RECIPES[d.prop]; if (r) out.push(recipeColliders(r, d.anchor)); }
    return out;
  }, [bp]);
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000' }}>
      <Canvas shadows="soft" flat dpr={[1, 2]} camera={{ fov: 72, near: 0.05, far: 200, position: [0, 1.62, 4.3] }} gl={{ antialias: false, powerPreference: 'high-performance' }}>
        <Suspense fallback={null}>
          <ShellLighting id={bp.shell} venue={bp.venue} />
          <World />
          <LabelProjector />
          <LocalPlayer colliders={colliders} />
          <PostFX quality={quality} />
        </Suspense>
      </Canvas>
      <LabelLayer />
      <Hud />
    </div>
  );
}

// What the builder is doing, shown in turn while the shift generates.
const STEPS = ['Scouting a workplace', 'Laying out the stations', 'Casting your coworkers', 'Writing the real job details', 'Rehearsing the shift'];
const METER = 20;

function Screen({ children }) {
  return (
    <main className="ws-screen">
      <PixelSky />
      <div className="ws-stage"><div className="ws-column">{children}</div></div>
    </main>
  );
}

function Reply({ children }) {
  return <div className="ws-msg"><Avatar /><div className="ws-reply">{children}</div></div>;
}

function Lobby() {
  const s = useShift();
  const [now, setNow] = useState(performance.now());
  const [serverInvite, setServerInvite] = useState(null);
  useEffect(() => { const i = setInterval(() => setNow(performance.now()), 250); return () => clearInterval(i); }, []);
  useEffect(() => {
    if (!s.roomId) return;
    fetchRoom(s.roomId).then((r) => {
      // The server's invite URL uses the LAN address; the in-game "Copy invite link" button shares it.
      if (r.inviteUrl) setServerInvite(r.inviteUrl);
      if (r.occupation && !useShift.getState().occupation) useShift.getState().set({ occupation: r.occupation });
    }).catch((e) => { if (e.gone) useShift.getState().set({ status: 'gone' }); });
  }, [s.roomId]);
  const local = typeof window !== 'undefined' ? `${window.location.origin}/shift?room=${encodeURIComponent(s.roomId)}` : '';
  const base = serverInvite && !/localhost|127\.0\.0\.1/.test(window.location.hostname) ? local : serverInvite ?? local;
  const invite = base ? `${base}${s.occupation ? `&job=${encodeURIComponent(s.occupation)}` : ''}` : '';
  useEffect(() => { if (invite && useShift.getState().invite !== invite) useShift.getState().set({ invite }); }, [invite]);

  const go = (url) => { window.location.href = url; };
  const waited = s.generatingSince ? now - s.generatingSince : 0;
  const failed = s.status === 'failed';
  const ready = s.status === 'ready';
  const job = s.occupation;

  if (s.status === 'gone') {
    return (
      <Screen>
        <Reply>
          <div className="ws-reply-title">This shift has ended.</div>
          <div className="ws-reply-note">The room is no longer on the server. Start a new one below.</div>
        </Reply>
        <PromptBar initial={job} onStarted={go} />
      </Screen>
    );
  }

  const connecting = s.conn !== 'open' && s.status === 'connecting';
  // Generation usually takes about 40 s: fill quickly at first, never quite finish until it is ready.
  const share = ready ? 1 : failed ? 0 : 1 - Math.exp(-waited / 20000);
  const lit = Math.min(ready ? METER : METER - 1, Math.round(share * METER));
  const step = STEPS[Math.min(STEPS.length - 1, Math.floor(waited / 4000))];
  const title = connecting ? 'Connecting' : ready ? 'Your shift is ready. Walking you in' : s.isHost ? step : `Joining the ${job || 'shift'}`;
  const demo = () => chooseDemo(s.roomId, job).catch(() => {});

  return (
    <Screen>
      <div className="ws-thread" aria-live="polite">
        {s.isHost && job && <div className="ws-msg ws-msg-you"><div className="ws-bubble">{job}</div></div>}
        {failed ? (
          <Reply>
            <div className="ws-reply-title">I couldn&apos;t build that shift.</div>
            {s.error && <div className="ws-reply-note">{String(s.error).slice(0, 160)}</div>}
            {s.isHost ? (
              <div className="ws-actions">
                <Button className="ws-action" onClick={demo}>Play a ready-made shift</Button>
              </div>
            ) : <div className="ws-reply-note">Waiting for the host<span className="ws-dots" /></div>}
          </Reply>
        ) : (
          <Reply>
            <div className="ws-eyebrow">{s.isHost ? 'Building your shift' : 'Invited'}</div>
            <div className="ws-reply-title">{title}<span className="ws-dots" /></div>
            <div className="ws-meter" role="progressbar" aria-label="Shift progress" aria-valuemin={0} aria-valuemax={METER} aria-valuenow={lit}>
              {Array.from({ length: METER }, (_, i) => <i key={i} data-on={i < lit || undefined} />)}
            </div>
            {/* On https with a self-signed certificate, the browser must accept the game server's address once too. */}
            {connecting && waited > 4000 && typeof window !== 'undefined' && window.location.protocol === 'https:' && (
              <div className="ws-reply-note">
                Still connecting? Open <a href={`${BACKEND}/health`} target="_blank" rel="noreferrer">{BACKEND}</a> once, choose Advanced, then Proceed, and come back.
              </div>
            )}
          </Reply>
        )}
      </div>
      {failed && s.isHost && <PromptBar onStarted={go} />}
    </Screen>
  );
}

export default function ShiftApp() {
  const ready = useShift((s) => !!(s.blueprint && s.state && s.you));
  const roomId = useShift((s) => s.roomId);
  useDebugHook();
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const room = q.get('room');
    const isHost = q.get('host') === '1';
    useShift.getState().set({ roomId: room, isHost, occupation: q.get('job') ?? '', generatingSince: performance.now() });
    if (!room) return;
    return connect(room, playerName(isHost));
  }, []);
  if (typeof window !== 'undefined' && !roomId && !new URLSearchParams(window.location.search).get('room')) {
    return (
      <Screen>
        <Reply><div className="ws-reply-title">That link has no shift in it.</div><div className="ws-reply-note">Tell me a job to try instead.</div></Reply>
        <PromptBar onStarted={(url) => { window.location.href = url; }} />
      </Screen>
    );
  }
  return ready ? <Game /> : <Lobby />;
}
