'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { backendUrl } from '../src/engine/config';

const JOBS = [
  'barista', 'line cook', 'baker', 'bartender', 'sushi chef', 'barber', 'hairstylist', 'nail technician',
  'warehouse picker', 'mail sorter', 'shipping clerk', 'car mechanic', 'carpenter', 'electrician', 'bike mechanic',
  'florist', 'pharmacist', 'cashier', 'bookseller', 'software engineer', 'journalist', 'architect', 'accountant',
  'nurse', 'veterinarian', 'dentist', 'paramedic', 'lab technician', 'chemist', 'forensic analyst', 'boxer',
];

const font = "'Inter','Segoe UI',system-ui,sans-serif";
const accent = '#f2b233';

export default function HomePage() {
  const [occupation, setOccupation] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const router = useRouter();

  const play = async (job) => {
    const occ = (job ?? occupation).trim();
    if (!occ || busy) return;
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
          <label htmlFor="job" style={{ alignSelf: 'center', paddingLeft: 12, color: '#a9a097', fontSize: 17, whiteSpace: 'nowrap' }}>Play as</label>
          <input
            id="job"
            autoFocus
            value={occupation}
            placeholder="A boxer in a rooftop arena"
            onChange={(e) => setOccupation(e.target.value)}
            maxLength={320}
            style={{ flex: 1, minWidth: 0, fontSize: 20, fontWeight: 700, padding: '12px 10px', background: 'transparent', border: 0, outline: 'none', color: '#fff' }}
          />
          <button type="submit" disabled={!occupation.trim() || !!busy} style={{ padding: '12px 30px', fontSize: 18, fontWeight: 800, borderRadius: 10, border: 0, background: accent, color: '#111', cursor: occupation.trim() && !busy ? 'pointer' : 'default', opacity: occupation.trim() ? 1 : 0.55 }}>
            {busy && busy === occupation.trim() ? 'Starting...' : 'Play'}
          </button>
        </form>
        {error && <div style={{ marginTop: 12, color: '#ff8a7a', fontSize: 14 }}>{error}</div>}

        <div style={{ marginTop: 26, fontSize: 12, letterSpacing: 2, color: '#8c847a', textTransform: 'uppercase' }}>Or pick one</div>
        <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 8 }}>
          {JOBS.map((j) => (
            <button
              key={j}
              onClick={() => { setOccupation(j); play(j); }}
              disabled={!!busy}
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
input::placeholder{ color: rgba(255,255,255,0.28) }`}</style>
    </main>
  );
}
