'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import { roomRequest, useRoom } from '../lib/connection';
import { preloadTracking, useMotion } from '../lib/useMotion';

const World = dynamic(() => import('./World'), { ssr: false, loading: () => <div className="loading-view">Loading 3D view…</div> });

const roles = [
  { id: 'barista', title: 'Barista', text: 'Prep, brew, and serve an espresso order.', prompt: 'Barista working the opening shift in a neighborhood café', tint: 'peach' },
  { id: 'warehouse', title: 'Warehouse picker', text: 'Scan parcels and get two orders out the door.', prompt: 'Warehouse picker sorting two orders before dispatch', tint: 'blue' },
  { id: 'florist', title: 'Florist', text: 'Assemble an arrangement to a customer brief.', prompt: 'Florist putting together a spring arrangement for a customer', tint: 'pink' },
];

const preview = {
  title: 'The opening order', theme: 'cafe',
  stations: [
    { id: 'cup-shelf', x: -3.4, y: 0.9, z: 1.1, width: 1.1, depth: 1.8, inward: { x: 1, z: 0 }, control: {}, kind: 'shelf', label: 'Cup shelf' },
    { id: 'brewer', x: -3.4, y: 0.9, z: -1.5, width: 1.1, depth: 1.8, inward: { x: 1, z: 0 }, control: { x: -2.82, y: 1.33, z: -1.5 }, kind: 'machine', label: 'Espresso machine' },
    { id: 'pickup', x: 1.35, y: 0.9, z: -4.0, width: 1.8, depth: 1.15, inward: { x: 0, z: 1 }, control: {}, kind: 'dropoff', label: 'Pickup counter' },
  ],
  props: [
    { id: 'cup', shape: 'cup', color: 'gold', size: [0.24, 0.28, 0.24], spawn: { x: -3.4, y: 1.04, z: 1.35 } },
    { id: 'milk', shape: 'bottle', color: 'mint', size: [0.22, 0.38, 0.22], spawn: { x: -3.4, y: 1.09, z: 0.78 } },
  ],
};
const previewPlayers = { players: [], stations: [], props: [], npcs: [], objective: { station: 'brewer' } };
const noHands = { current: null };

function Logo() {
  return <a className="brand" href="/" aria-label="Workshift home"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>workshift<span className="brand-period">.</span></a>;
}

function useRecorder(onRecording) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const recording = useRef(null);
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (recording.current?.recorder.state === 'recording') recording.current.recorder.stop();
    };
  }, []);

  async function toggle() {
    if (recording.current?.recorder.state === 'recording') {
      recording.current.recorder.stop();
      return;
    }
    if (pending.current) return;
    pending.current = true;
    setError('');
    let stream;
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('Voice input needs a supported browser on HTTPS or localhost.');
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!alive.current) { stream.getTracks().forEach(track => track.stop()); return; }
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('This browser cannot record a supported audio format.');
      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 48_000 });
      const parts = [];
      const timer = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 12000);
      recorder.ondataavailable = event => { if (event.data.size) parts.push(event.data); };
      recorder.onstop = () => {
        clearTimeout(timer);
        stream.getTracks().forEach(track => track.stop());
        recording.current = null;
        if (!alive.current) return;
        setBusy(false);
        if (!parts.length) { setError('No audio was captured. Try recording again.'); return; }
        const mime = mimeType.split(';')[0];
        const reader = new FileReader();
        reader.onload = () => { if (alive.current) onRecording({ mime, data: String(reader.result).split(',')[1] }); };
        reader.onerror = () => { if (alive.current) setError('Could not read the recording.'); };
        reader.readAsDataURL(new Blob(parts, { type: mime }));
      };
      recording.current = { recorder };
      recorder.start();
      setBusy(true);
    } catch (failure) {
      stream?.getTracks().forEach(track => track.stop());
      setError(failure.name === 'NotAllowedError' ? 'Microphone permission was denied.' : failure.message);
    } finally {
      pending.current = false;
    }
  }
  return { busy, error, toggle };
}

function Home({ onRoom }) {
  const [prompt, setPrompt] = useState('');
  const [audio, setAudio] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const recorder = useRecorder(setAudio);
  const submitting = useRef(false);

  async function create(input) {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError('');
    try {
      const room = await roomRequest('/api/rooms', input);
      onRoom(room.roomId);
    } catch (failure) {
      setError(failure.message);
      setPending(false);
      submitting.current = false;
    }
  }

  return <div className="site">
    <header className="site-header"><Logo /><span className="header-note">First-person career simulator</span></header>
    <main className="home">
      <section className="hero">
        <div className="intro">
          <p className="eyebrow"><span /> YOUR NEXT SHIFT</p>
          <h1>Try a job.<br /><em>Do the work.</em></h1>
          <p className="summary">Name an occupation and step into a short, first-person shift. Use your webcam to work solo or invite a friend.</p>
          <form className="prompt-form" onSubmit={event => { event.preventDefault(); create(audio ? { audio } : { prompt: prompt.trim() }); }}>
            <label htmlFor="occupation">What job would you like to try?</label>
            <div className="prompt-row">
              <input id="occupation" value={prompt} maxLength={1200} placeholder="e.g. A stagehand preparing for opening night"
                disabled={Boolean(audio) || recorder.busy || pending} onChange={event => setPrompt(event.target.value)} />
              <button type="button" className={`mic ${recorder.busy ? 'recording' : ''}`} aria-pressed={recorder.busy}
                disabled={pending} onClick={() => { setAudio(null); recorder.toggle(); }}>{recorder.busy ? 'Stop' : 'Record'}</button>
            </div>
            {recorder.busy && <p className="inline-note" role="status">Recording a voice prompt for up to 12 seconds.</p>}
            {audio && <p className="inline-note">Voice prompt ready <button type="button" className="text-button" onClick={() => setAudio(null)}>Remove</button></p>}
            {(error || recorder.error) && <p className="notice error" role="alert">{error || recorder.error}</p>}
            <button className="primary" disabled={pending || recorder.busy || (!audio && prompt.trim().length < 2)}>{pending ? 'Opening lobby…' : 'Create my shift'} <span aria-hidden="true">↗</span></button>
          </form>
        </div>
        <div className="hero-world">
          <div className="world-preview"><World blueprint={preview} snapshot={previewPlayers} local={noHands} /></div>
          <div className="preview-label"><span className="live-dot" /> WORKPLACE PREVIEW <strong>ESPRESSO BAR</strong></div>
        </div>
      </section>
      <section className="occupation-examples" aria-labelledby="examples-heading">
        <div className="section-heading"><h2 id="examples-heading">Explore an occupation</h2><p>Choose a prompt to start from.</p></div>
        <div className="cards">
          {roles.map(role => <button key={role.id} className="role-card" disabled={pending || recorder.busy} onClick={() => { setAudio(null); setPrompt(role.prompt); document.getElementById('occupation')?.focus(); }}>
            <span className={`role-number ${role.tint}`}>{role.title.slice(0, 1)}</span>
            <span><strong>{role.title}</strong><small>{role.text}</small></span>
            <span className="card-arrow" aria-hidden="true">↗</span>
          </button>)}
        </div>
      </section>
    </main>
    <footer><span>Workshift</span><span>Webcam controls · Solo or multiplayer</span></footer>
  </div>;
}

function Invite({ roomId }) {
  const [qr, setQr] = useState('');
  const [copied, setCopied] = useState(false);
  const [url, setUrl] = useState('');
  useEffect(() => {
    let live = true;
    const link = new URL(window.location.pathname, window.location.origin);
    link.searchParams.set('room', roomId);
    setUrl(link.href);
    import('qrcode').then(module => (module.default ?? module).toDataURL(link.href, {
      width: 248, margin: 2, color: { dark: '#142e27', light: '#f4f6ed' },
    })).then(image => { if (live) setQr(image); }).catch(() => {});
    return () => { live = false; };
  }, [roomId]);
  return <details className="invite">
    <summary>Invite players <span aria-hidden="true">↗</span></summary>
    <div className="invite-pop">
      {qr && <img src={qr} alt="QR code to join this shift" width="124" height="124" />}
      <div><strong>Join this shift</strong><p>Scan the code or share the link.</p>
        <input aria-label="Room invite link" value={url} readOnly onFocus={event => event.currentTarget.select()} />
        <button className="quiet" onClick={() => navigator.clipboard?.writeText(url).then(() => setCopied(true)).catch(() => {})}>{copied ? 'Copied' : 'Copy link'}</button>
      </div>
    </div>
  </details>;
}

function Room({ roomId }) {
  const room = useRoom(roomId);
  const [camera, setCamera] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const video = useRef(null);
  const { status: tracking, local, recalibrate } = useMotion(camera, video, room.current, room.send);
  useEffect(() => {
    const timeout = setTimeout(() => setWaiting(true), 8000);
    preloadTracking().catch(() => {});
    return () => clearTimeout(timeout);
  }, [roomId]);

  const blueprint = room.world?.blueprint;
  const snapshot = room.snapshot;
  const player = snapshot?.players.find(item => item.id === room.playerId);
  const current = snapshot?.objective;
  const held = blueprint?.props.find(item => item.id === player?.held);
  const target = blueprint?.props.find(item => item.id === player?.hint);
  const objectiveStation = blueprint?.stations.find(item => item.id === current?.station);
  const finished = snapshot?.total > 0 && snapshot.completed === snapshot.total;
  const disconnected = !['connected', 'connecting', 'reconnecting'].includes(room.status);
  const generationFailed = room.lobby?.status === 'error';
  const connection = room.status === 'connected' ? 'Connected' : room.status === 'connecting' ? 'Connecting' : room.status === 'reconnecting' ? 'Reconnecting…' : room.status;

  return <div className="site room-page">
    <header className="site-header"><Logo /><div className="room-actions"><span className="header-note">{room.lobby?.players || 0} / {room.lobby?.limit || 4} players</span><Invite roomId={roomId} /></div></header>
    <main className="room-main">
      <div className="room-heading">
        <div><p className="eyebrow"><span /> {blueprint?.occupation || 'SHIFT LOBBY'}</p><h1>{blueprint?.title || 'Preparing your workplace'}</h1></div>
        <div className="status-pill"><span className={room.status === 'connected' ? 'live-dot' : 'offline-dot'} />{connection}</div>
      </div>
      <div className="room-grid">
        <section className="room-canvas" aria-label="First-person workplace">
          {blueprint ? <World key={room.world.version} blueprint={blueprint} snapshot={snapshot} playerId={room.playerId} local={local} />
            : <div className="waiting-view">
              <div className="waiting-shape" aria-hidden="true"><i /><i /><i /></div>
              <h2>{generationFailed ? 'Generation failed' : disconnected ? 'Room unavailable' : 'Building your shift'}</h2>
              <p>{room.lobby?.error || (disconnected ? room.status : '') || 'You can invite a friend and calibrate your camera while the workplace is prepared.'}</p>
              {(generationFailed || disconnected)
                ? <a href="/" className="quiet">Try a new prompt</a>
                : waiting && <p className="inline-note" role="status">Gemini is still designing this shift.</p>}
            </div>}
          {blueprint && <div className="world-hud"><span className="crosshair" /><span className="hint">
            {held ? `Holding ${held.label} · lower your hand to place` : target ? `Lift to pick up ${target.label}` : 'Reach toward an object to interact'}
          </span></div>}
          {finished && <div className="result"><p className="eyebrow"><span /> SHIFT COMPLETE</p><h2>You finished the shift.</h2><p>{blueprint.takeaway}</p><a className="primary" href="/">Try another occupation ↗</a></div>}
        </section>
        <aside className="room-panel" aria-label="Shift controls and progress">
          <div className="panel-section">
            <h2>Current task</h2>
            <p className="task">{finished ? 'All tasks complete' : current?.instruction || blueprint?.briefing || 'Your task will appear when the room is ready.'}</p>
            {current && objectiveStation && <p className="inline-note">Station · {objectiveStation.label}</p>}
            {snapshot && <div className="progress"><progress aria-label="Shift progress" value={snapshot.completed} max={snapshot.total} /><span>{snapshot.completed}/{snapshot.total}</span></div>}
          </div>
          {snapshot?.npcs.map(npc => <div key={npc.id} className="panel-section dialogue">
            <h2>{npc.name} <span>· {npc.role}</span></h2><p>“{npc.line}”</p>
          </div>)}
          <div className="panel-section camera">
            <h2>Body tracking</h2>
            <video ref={video} muted playsInline autoPlay hidden={!camera} aria-label="Local calibration preview" />
            <p className="inline-note"><span className={tracking.tracked ? 'live-dot' : 'offline-dot'} />{tracking.text}</p>
            <div className="camera-actions"><button className="quiet" onClick={() => setCamera(value => !value)}>{camera ? 'Turn off camera' : 'Enable camera'}</button>
              {camera && <button className="text-button" onClick={recalibrate}>Recalibrate</button>}
            </div>
            <p className="motion-guide">Step in place to move. Turn your shoulders to steer. Reach and lift to grab. Lower and pause to place or hand an item to a reaching player.</p>
          </div>
          {snapshot?.feed.length > 0 && <div className="panel-section activity"><h2>Shift activity</h2>
            <ul>{snapshot.feed.slice(-4).reverse().map(event => <li key={event.id} className={event.type}>{event.text}</li>)}</ul>
          </div>}
        </aside>
      </div>
    </main>
  </div>;
}

export default function App() {
  const [roomId, setRoomId] = useState('');
  useEffect(() => {
    function syncRoom() { setRoomId(new URLSearchParams(window.location.search).get('room') || ''); }
    syncRoom();
    window.addEventListener('popstate', syncRoom);
    return () => window.removeEventListener('popstate', syncRoom);
  }, []);
  return roomId ? <Room key={roomId} roomId={roomId} /> : <Home onRoom={id => {
    const url = new URL(window.location.href);
    url.searchParams.set('room', id);
    window.history.pushState(null, '', url);
    setRoomId(id);
  }} />;
}
