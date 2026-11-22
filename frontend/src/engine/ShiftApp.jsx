'use client';
// /shift?room=ID[&host=1][&job=Barista]: joins the room, shows the generating lobby with the invite QR (F5),
// offers labeled demo shifts on failure or after 8 s (F7), then builds and runs the generated shift.
import { Suspense, useEffect, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { useShift } from './store';
import { connect, chooseDemo, fetchRoom, fetchDemos, localPose, reconcile, samplePlayer } from './net';
import { act, use, getIndex } from './actions';
import { staticInteractables, RECIPES } from './world';
import { recipeColliders, shellColliders, ShellLighting } from './scene';
import World from './World.jsx';
import { LabelLayer, LabelProjector } from './Labels';
import LocalPlayer from './LocalPlayer';
import Hud, { ui, KEYFRAMES } from './Hud';
import { BACKEND } from './config';
import { PostFX } from '../game/Look';

// Fallback labels when the server's demo list cannot be fetched.
const DEMOS = [
  { occupation: 'Barista', title: 'Pull an espresso shot and serve it' },
  { occupation: 'Warehouse picker', title: 'Pick an order and sort it into bins' },
  { occupation: 'Florist', title: 'Assemble and wrap a bouquet' },
];
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

export function CopyLink({ url }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
      {/* The whole link stays readable so it can also be typed on the other laptop. */}
      <div style={{ padding: '9px 10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.05)', color: '#eee', fontSize: 13, lineHeight: 1.45, fontFamily: 'ui-monospace, Consolas, monospace', wordBreak: 'break-all', userSelect: 'all' }}>{url}</div>
      <button
        onClick={async () => { try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch {} }}
        style={{ padding: '10px 14px', borderRadius: 8, border: 0, background: copied ? '#3cff8a' : ui.accent, color: '#111', fontWeight: 800, cursor: 'pointer', fontSize: 14 }}>
        {copied ? 'Copied' : 'Copy invite link'}
      </button>
    </div>
  );
}

function Lobby() {
  const s = useShift();
  const [now, setNow] = useState(performance.now());
  const [picking, setPicking] = useState(null);
  const [err, setErr] = useState(null);
  const [demos, setDemos] = useState(DEMOS);
  const [serverInvite, setServerInvite] = useState(null);
  useEffect(() => { const i = setInterval(() => setNow(performance.now()), 250); return () => clearInterval(i); }, []);
  useEffect(() => {
    if (!s.roomId) return;
    fetchRoom(s.roomId).then((r) => {
      // The server's invite URL uses the LAN address, so the link works from another laptop on the same network.
      if (r.inviteUrl) setServerInvite(r.inviteUrl);
      if (r.occupation && !useShift.getState().occupation) useShift.getState().set({ occupation: r.occupation });
      if (r.demos?.length) setDemos(r.demos);
    }).catch((e) => { if (e.gone) useShift.getState().set({ status: 'gone' }); });
    fetchDemos().then((d) => { if (d.length) setDemos(d); }).catch(() => {});
  }, [s.roomId]);
  const local = typeof window !== 'undefined' ? `${window.location.origin}/shift?room=${encodeURIComponent(s.roomId)}` : '';
  const base = serverInvite && !/localhost|127\.0\.0\.1/.test(window.location.hostname) ? local : serverInvite ?? local;
  const invite = base ? `${base}${s.occupation ? `&job=${encodeURIComponent(s.occupation)}` : ''}` : '';
  useEffect(() => { if (invite && useShift.getState().invite !== invite) useShift.getState().set({ invite }); }, [invite]);
  const waited = s.generatingSince ? now - s.generatingSince : 0;
  const failed = s.status === 'failed';
  const offerDemo = s.isHost && (failed || waited > 8000 || (s.status === 'ready' && !s.blueprint));
  const pick = async (occupation) => {
    setPicking(occupation); setErr(null);
    try { await chooseDemo(s.roomId, occupation); } catch (e) { setErr(e.message); setPicking(null); }
  };
  if (s.status === 'gone') {
    return (
      <main style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', background: 'radial-gradient(ellipse at 30% 20%, #3a2414, #0c0b0a 70%)', color: '#fff', fontFamily: ui.font }}>
        <div style={{ textAlign: 'center', maxWidth: 460, padding: 24 }}>
          <div style={{ fontSize: 13, letterSpacing: 8, color: ui.accent }}>WORKSHIFT</div>
          <div style={{ fontSize: 30, fontWeight: 900, marginTop: 14 }}>This shift has ended</div>
          <div style={{ color: '#cfc6b8', marginTop: 8, lineHeight: 1.5 }}>The room is no longer on the server. It may have expired or the server restarted.</div>
          <a href="/" style={{ display: 'inline-block', marginTop: 22, padding: '12px 26px', borderRadius: 10, background: ui.accent, color: '#111', fontWeight: 800, textDecoration: 'none' }}>Start a new shift</a>
        </div>
      </main>
    );
  }
  const loading = s.status === 'connecting' || s.status === 'generating' || (s.status === 'ready' && !s.state);
  return (
    <main style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', background: 'radial-gradient(ellipse at 30% 20%, #3a2414, #0c0b0a 70%)', color: '#fff', fontFamily: ui.font, overflow: 'auto' }}>
      <style>{KEYFRAMES}</style>
      <div style={{ width: 'min(820px, 94vw)', display: 'grid', gridTemplateColumns: '1fr 280px', gap: 28, alignItems: 'start', padding: 24 }}>
        <div>
          <a href="/" style={{ fontSize: 13, letterSpacing: 8, color: ui.accent, textDecoration: 'none' }}>WORKSHIFT</a>
          <div style={{ fontSize: 15, color: '#a9a097', marginTop: 22 }}>{s.isHost ? 'Your shift' : 'You were invited to a shift'}{s.occupation ? ' as a' : ''}</div>
          {s.occupation && <div style={{ fontSize: 44, fontWeight: 900, letterSpacing: -1, lineHeight: 1.05, marginTop: 4, textTransform: 'capitalize' }}>{s.occupation}</div>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 22, fontSize: 18, fontWeight: 600, color: failed ? '#ff8a7a' : '#eee' }}>
            {loading && !failed && <span style={{ width: 18, height: 18, borderRadius: 18, border: '3px solid rgba(255,255,255,0.15)', borderTopColor: ui.accent, animation: 'ws-spin 0.8s linear infinite' }} />}
            {s.conn !== 'open' && s.status === 'connecting' ? 'Connecting to the room...' : failed ? 'We could not build that shift.' : s.status === 'ready' ? 'Shift ready, joining...' : 'Generating your shift...'}
          </div>
          {/* On https with a self-signed certificate, the browser must accept the game server's address once too. */}
          {s.conn !== 'open' && s.status === 'connecting' && waited > 4000 && typeof window !== 'undefined' && window.location.protocol === 'https:' && (
            <div style={{ marginTop: 12, maxWidth: 460, padding: '10px 14px', borderRadius: 10, background: 'rgba(242,178,51,0.1)', border: '1px solid rgba(242,178,51,0.35)', color: '#e8dfd2', fontSize: 14, lineHeight: 1.5 }}>
              Still connecting? This laptop's browser has to trust the game server once. Open <a href={`${BACKEND}/health`} target="_blank" rel="noreferrer" style={{ color: ui.accent, fontWeight: 700 }}>{BACKEND}</a>, choose Advanced, then Proceed, and come back to this tab.
            </div>
          )}
          {failed && s.error && <div style={{ color: '#a9a097', fontSize: 13, marginTop: 6 }}>{String(s.error).slice(0, 160)}</div>}
          {!failed && s.status === 'generating' && <div style={{ color: '#a9a097', fontSize: 14, marginTop: 8 }}>Building the workplace, the crew and the task. Usually a few seconds.</div>}
          {offerDemo && (
            <div style={{ marginTop: 26 }}>
              <div style={{ fontSize: 13, letterSpacing: 2, color: '#a9a097', textTransform: 'uppercase', marginBottom: 10 }}>{failed ? 'Play a ready-made shift instead' : 'Taking a while? Play a ready-made shift'}</div>
              <div style={{ display: 'grid', gap: 8 }}>
                {demos.map((d) => (
                  <button key={d.occupation} onClick={() => pick(d.occupation)} disabled={!!picking}
                    style={{ textAlign: 'left', padding: '12px 14px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.12)', background: picking === d.occupation ? 'rgba(242,178,51,0.18)' : 'rgba(255,255,255,0.05)', color: '#fff', cursor: picking ? 'default' : 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                    <span><b style={{ fontSize: 16, textTransform: 'capitalize' }}>Demo shift: {d.occupation}</b><div style={{ fontSize: 13, color: '#a9a097', marginTop: 2 }}>{d.title}</div></span>
                    <span style={{ color: ui.accent, fontWeight: 800 }}>{picking === d.occupation ? 'Loading...' : 'Play →'}</span>
                  </button>
                ))}
              </div>
              {err && <div style={{ color: '#ff8a7a', fontSize: 13, marginTop: 8 }}>{err}</div>}
            </div>
          )}
          {!s.isHost && failed && <div style={{ marginTop: 18, color: '#cfc6b8' }}>Waiting for the host to pick a demo shift...</div>}
        </div>
        <div style={{ padding: 18, borderRadius: 14, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}>
          <div style={{ fontSize: 12, letterSpacing: 2, color: '#a9a097', textTransform: 'uppercase' }}>Invite a teammate</div>
          <div style={{ fontSize: 14, color: '#cfc6b8', marginTop: 10, lineHeight: 1.5 }}>Send this link to a teammate on another laptop on the same Wi-Fi. They can join now, while the shift builds, and take the other role.</div>
          {invite && <CopyLink url={invite} />}
        </div>
      </div>
    </main>
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
    return <main style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', background: '#0c0b0a', color: '#fff', fontFamily: ui.font }}><div>No room in the link. <a href="/" style={{ color: ui.accent }}>Back to the lobby</a></div></main>;
  }
  return ready ? <Game /> : <Lobby />;
}
