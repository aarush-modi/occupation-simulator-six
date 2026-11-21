'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { backendUrl } from '../src/engine/config';

const JOBS = [
  'barista', 'line cook', 'baker', 'bartender', 'sushi chef', 'barber', 'hairstylist', 'nail technician',
  'warehouse picker', 'mail sorter', 'shipping clerk', 'car mechanic', 'carpenter', 'electrician', 'bike mechanic',
  'florist', 'pharmacist', 'cashier', 'bookseller', 'software engineer', 'journalist', 'architect', 'accountant',
  'nurse', 'veterinarian', 'dentist', 'paramedic', 'lab technician', 'chemist', 'forensic analyst',
];

const font = "'Inter','Segoe UI',system-ui,sans-serif";
const MAX_RECORD_MS = 6000;

// Containers Gemini is happy with first; Chrome usually only offers webm (we convert to WAV anyway when we can).
const RECORDER_TYPES = ['audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];

/** Re-encode a recorded clip as 16 kHz mono 16-bit WAV, a format Gemini always accepts. Returns null if decoding fails. */
async function toWav(blob) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    ctx.close?.();
    const rate = 16000;
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const pcm = (await off.startRendering()).getChannelData(0);
    const buf = new ArrayBuffer(44 + pcm.length * 2);
    const v = new DataView(buf);
    const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
    return new Blob([buf], { type: 'audio/wav' });
  } catch {
    return null;
  }
}

const toBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

function MicIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}
const accent = '#f2b233';

export default function HomePage() {
  const [occupation, setOccupation] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [rec, setRec] = useState(null); // null | { startedAt } while recording
  const [recNow, setRecNow] = useState(0);
  const recorder = useRef(null);
  const router = useRouter();

  useEffect(() => {
    if (!rec) return;
    const i = setInterval(() => setRecNow(Date.now()), 100);
    return () => clearInterval(i);
  }, [rec]);
  // Release the microphone if the page unmounts mid-recording.
  useEffect(() => () => { recorder.current?.cancel(); }, []);

  const startRecording = async () => {
    if (busy || rec) return;
    setError(null);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError(window.isSecureContext ? 'This browser cannot record audio. Type the job instead.' : 'The microphone needs HTTPS. Open the lobby over https (npm run dev:frontend:https) or on localhost, or type the job instead.');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      const denied = ['NotAllowedError', 'SecurityError', 'PermissionDeniedError', 'NotSupportedError'].includes(e?.name);
      setError(
        denied ? 'Microphone access was blocked. Allow it in the address bar (site settings), or type the job instead.'
          : e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError' ? 'No microphone found. Type the job instead.'
          : `Could not start the microphone. ${e?.message ?? ''}`.trim(),
      );
      return;
    }
    const mimeType = RECORDER_TYPES.find((t) => MediaRecorder.isTypeSupported?.(t));
    let mr;
    try {
      mr = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 64000 } : undefined);
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      setError(`Could not record audio. ${e?.message ?? ''}`.trim());
      return;
    }
    const chunks = [];
    let cancelled = false;
    const stopTracks = () => stream.getTracks().forEach((t) => t.stop());
    const timer = setTimeout(() => mr.state === 'recording' && mr.stop(), MAX_RECORD_MS);
    mr.ondataavailable = (ev) => { if (ev.data?.size) chunks.push(ev.data); };
    mr.onstop = () => {
      clearTimeout(timer);
      stopTracks();
      recorder.current = null;
      setRec(null);
      if (cancelled) return;
      sendClip(new Blob(chunks, { type: mr.mimeType || mimeType || 'audio/webm' }));
    };
    recorder.current = {
      stop: () => mr.state === 'recording' && mr.stop(),
      cancel: () => { cancelled = true; if (mr.state === 'recording') mr.stop(); else stopTracks(); },
    };
    mr.start();
    const now = Date.now();
    setRec({ startedAt: now });
    setRecNow(now);
  };

  const sendClip = async (blob) => {
    if (blob.size < 1000) { setError('That recording was empty. Try again, or type the job.'); return; }
    setBusy('voice'); setError(null);
    try {
      const clip = (await toWav(blob)) ?? blob;
      const data = await toBase64(clip);
      const r = await fetch(`${backendUrl()}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ audio: { mimeType: clip.type || 'audio/webm', data } }) });
      if (!r.ok) {
        const msg = await r.json().then((j) => j.error).catch(() => null);
        throw new Error(msg ?? `The server said ${r.status}`);
      }
      const { roomId } = await r.json();
      // No job in the URL: the room's occupation arrives with the status message once Gemini has heard the clip.
      router.push(`/shift?room=${encodeURIComponent(roomId)}&host=1`);
    } catch (e) {
      setError(`Could not send the recording. ${e.message ?? ''}`.trim());
      setBusy(null);
    }
  };

  const recLeft = rec ? Math.max(0, Math.ceil((MAX_RECORD_MS - (recNow - rec.startedAt)) / 1000)) : 0;

  const play = async (job) => {
    const occ = (job ?? occupation).trim();
    if (!occ || busy || rec) return;
    setBusy(occ); setError(null);
    try {
      const r = await fetch(`${backendUrl()}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ occupation: occ }) });
      if (!r.ok) throw new Error(`The server said ${r.status}`);
      const { roomId } = await r.json();
      router.push(`/shift?room=${encodeURIComponent(roomId)}&host=1&job=${encodeURIComponent(occ)}`);
    } catch (e) {
      setError(`Could not reach the shift server. ${e.message ?? ''}`.trim());
      setBusy(null);
    }
  };

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'radial-gradient(ellipse at 30% 20%, #3a2414, #0c0b0a 70%)', color: '#fff', fontFamily: font, padding: '48px 20px' }}>
      <div style={{ width: 'min(760px, 100%)', textAlign: 'center' }}>
        <div style={{ fontSize: 13, letterSpacing: 8, color: accent }}>WORKSHIFT</div>
        <h1 style={{ fontSize: 56, margin: '10px 0 6px', fontWeight: 900, letterSpacing: -1.5, lineHeight: 1.05 }}>Live a shift of any job.</h1>
        <p style={{ color: '#cfc6b8', fontSize: 18, margin: 0 }}>Tell us what you want to be. We build the workplace, the crew, and the day.</p>

        <form
          onSubmit={(e) => { e.preventDefault(); play(); }}
          style={{ marginTop: 34, display: 'flex', gap: 10, padding: 8, borderRadius: 14, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)' }}
        >
          <label htmlFor="job" style={{ alignSelf: 'center', paddingLeft: 12, color: '#a9a097', fontSize: 17, whiteSpace: 'nowrap' }}>I want to be a</label>
          <input
            id="job"
            autoFocus
            value={occupation}
            placeholder="barista"
            onChange={(e) => setOccupation(e.target.value)}
            maxLength={60}
            style={{ flex: 1, minWidth: 0, fontSize: 20, fontWeight: 700, padding: '12px 10px', background: 'transparent', border: 0, outline: 'none', color: '#fff' }}
          />
          <button
            type="button"
            onClick={rec ? () => recorder.current?.stop() : startRecording}
            disabled={!!busy}
            aria-label={rec ? 'Stop recording' : 'Say the job out loud'}
            title={rec ? 'Stop recording' : 'Say the job out loud (up to 6 seconds)'}
            className={rec ? 'ws-mic ws-rec' : 'ws-mic'}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: rec ? '0 16px' : '0 14px', fontSize: 15, fontWeight: 800, borderRadius: 10, border: `1px solid ${rec ? '#ff6b5a' : 'rgba(255,255,255,0.16)'}`, background: rec ? 'rgba(255,90,70,0.2)' : busy === 'voice' ? 'rgba(242,178,51,0.22)' : 'rgba(255,255,255,0.05)', color: rec ? '#ffb3a8' : busy === 'voice' ? accent : '#e6ddd0', cursor: busy ? 'default' : 'pointer', fontFamily: font, whiteSpace: 'nowrap' }}
          >
            {rec ? <><span className="ws-dot" /> Stop {recLeft}s</> : busy === 'voice' ? <><MicIcon size={18} /> Sending...</> : <MicIcon />}
          </button>
          <button type="submit" disabled={!occupation.trim() || !!busy || !!rec} style={{ padding: '12px 30px', fontSize: 18, fontWeight: 800, borderRadius: 10, border: 0, background: accent, color: '#111', cursor: occupation.trim() && !busy ? 'pointer' : 'default', opacity: occupation.trim() ? 1 : 0.55 }}>
            {busy && busy === occupation.trim() ? 'Starting...' : 'Play'}
          </button>
        </form>
        {rec && <div role="status" style={{ marginTop: 12, color: '#ffb3a8', fontSize: 14 }}>Listening... say the job you want to try, e.g. "I want to be a beekeeper". Press Stop when you are done.</div>}
        {error && <div role="alert" style={{ marginTop: 12, color: '#ff8a7a', fontSize: 14 }}>{error}</div>}

        <div style={{ marginTop: 26, fontSize: 12, letterSpacing: 2, color: '#8c847a', textTransform: 'uppercase' }}>Or pick one</div>
        <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 8 }}>
          {JOBS.map((j) => (
            <button
              key={j}
              onClick={() => { setOccupation(j); play(j); }}
              disabled={!!busy || !!rec}
              className="ws-chip"
              style={{ padding: '7px 14px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.14)', background: busy === j ? 'rgba(242,178,51,0.22)' : 'rgba(255,255,255,0.04)', color: busy === j ? accent : '#e6ddd0', fontSize: 14, cursor: busy ? 'default' : 'pointer', fontFamily: font, textTransform: 'capitalize' }}
            >
              {busy === j ? 'Starting...' : j}
            </button>
          ))}
        </div>

        <a href="/play" className="ws-feature" style={{ display: 'flex', alignItems: 'center', gap: 18, marginTop: 36, padding: 18, borderRadius: 16, textAlign: 'left', textDecoration: 'none', color: '#fff', background: 'linear-gradient(110deg, rgba(233,165,18,0.16), rgba(201,86,30,0.12) 55%, rgba(255,255,255,0.03))', border: '1px solid rgba(242,178,51,0.3)' }}>
          <div style={{ width: 64, height: 64, flex: '0 0 64px', borderRadius: 12, background: 'linear-gradient(180deg, #e9b07a, #c9561e 60%, #0b2a3a 61%)', display: 'grid', placeItems: 'end center', overflow: 'hidden' }}>
            <svg width="40" height="44" viewBox="0 0 40 44" aria-hidden="true"><path d="M20 2 L30 34 H10 Z M14 22 H26 M12 28 H28" stroke="#1a1410" strokeWidth="2.5" fill="none" /><rect x="4" y="34" width="32" height="5" fill="#1a1410" /></svg>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, letterSpacing: 3, color: accent }}>FEATURED SHIFT</div>
            <div style={{ fontSize: 20, fontWeight: 800, marginTop: 2 }}>Offshore drilling rig floorhand</div>
            <div style={{ fontSize: 14, color: '#cfc6b8', marginTop: 2 }}>A hand-built twelve hour tour: make up pipe, read the pumps, and handle a well kick.</div>
          </div>
          <div style={{ color: accent, fontWeight: 800, fontSize: 16, whiteSpace: 'nowrap' }}>Play →</div>
        </a>
      </div>
      <style>{`.ws-chip:hover:not(:disabled){ background: rgba(242,178,51,0.14) !important; border-color: rgba(242,178,51,0.5) !important; color: #fff !important }
.ws-feature:hover{ border-color: rgba(242,178,51,0.6) !important }
input::placeholder{ color: rgba(255,255,255,0.28) }
.ws-mic:hover:not(:disabled){ border-color: rgba(242,178,51,0.6) !important; color: #fff !important }
.ws-dot{ width: 10px; height: 10px; border-radius: 50%; background: #ff5a46; animation: ws-pulse 1s ease-in-out infinite }
@keyframes ws-pulse{ 50%{ opacity: 0.25; transform: scale(0.8) } }`}</style>
    </main>
  );
}
