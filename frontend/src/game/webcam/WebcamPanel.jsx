'use client';
import { useEffect, useRef, useState } from 'react';
import { cam, GESTURE_HINT, webcamPace } from './gestures';
import { startTracking, stopTracking, getVideo, engine } from './tracker';

const HAND_EDGES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
const LEG_EDGES = [[23, 25], [25, 27], [24, 26], [26, 28]];
const FACE_PTS = [10, 152, 234, 454, 1, 33, 263];

export default function WebcamPanel() {
  const canvas = useRef();
  const [, tick] = useState(0);

  useEffect(() => {
    let raf;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = canvas.current, v = getVideo();
      if (!c) return;
      const ctx = c.getContext('2d');
      const W = c.width, H = c.height;
      ctx.save();
      ctx.clearRect(0, 0, W, H);
      ctx.translate(W, 0); ctx.scale(-1, 1); // mirror like a selfie
      if (v && v.readyState >= 2) ctx.drawImage(v, 0, 0, W, H);
      const fr = cam.frame;
      if (fr) {
        ctx.lineWidth = 2;
        for (const hand of fr.hands) {
          ctx.strokeStyle = '#f2b233';
          for (const [a, b] of HAND_EDGES) { ctx.beginPath(); ctx.moveTo(hand[a].x * W, hand[a].y * H); ctx.lineTo(hand[b].x * W, hand[b].y * H); ctx.stroke(); }
        }
        if (fr.body) {
          ctx.strokeStyle = '#64c8ff';
          for (const [a, b] of LEG_EDGES) {
            const from = fr.body[a], to = fr.body[b];
            if (from?.visibility < 0.45 || to?.visibility < 0.45 || !from || !to) continue;
            ctx.beginPath();
            ctx.moveTo(from.x * W, from.y * H);
            ctx.lineTo(to.x * W, to.y * H);
            ctx.stroke();
          }
        }
        if (fr.face) {
          ctx.fillStyle = '#3cff8a';
          for (const i of FACE_PTS) { ctx.beginPath(); ctx.arc(fr.face[i].x * W, fr.face[i].y * H, 3, 0, 7); ctx.fill(); }
        }
      }
      ctx.restore();
    };
    draw();
    const iv = setInterval(() => tick((x) => x + 1), 150);
    return () => { cancelAnimationFrame(raf); clearInterval(iv); };
  }, []);

  const requestCamera = () => { startTracking().catch(() => {}); };
  useEffect(() => {
    const request = setTimeout(requestCamera, 0);
    return () => { clearTimeout(request); stopTracking(); };
  }, []);

  const g = cam.lastGesture && performance.now() - cam.lastGesture.t < 1500 ? cam.lastGesture.name : null;
  const statusColor = { tracking: '#3cff8a', calibrating: '#f2b233', loading: '#f2b233', lost: '#ff6a5c', error: '#ff6a5c', off: '#888' }[cam.status];
  const pace = webcamPace();
  const calibrating = cam.status === 'calibrating';

  return (
    <>
      {calibrating && (
        <div style={{ position: 'absolute', left: '50%', top: '30%', transform: 'translateX(-50%)', padding: '16px 22px', background: 'rgba(12,12,14,0.85)', borderRadius: 10, color: '#fff', textAlign: 'center', border: '1px solid rgba(255,255,255,0.1)' }}>
          <div style={{ fontSize: 12, letterSpacing: 3, color: '#f2b233' }}>CALIBRATING</div>
          <div style={{ fontSize: 18, fontWeight: 700, marginTop: 6 }}>Face the screen with both feet flat</div>
          <div style={{ fontSize: 13, color: '#bbb', marginTop: 6 }}>Step back until both knees and ankles are in frame.</div>
        </div>
      )}
      <div style={{ position: 'absolute', right: 20, bottom: 20, width: 260, padding: 10, background: 'rgba(12,12,14,0.78)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, color: '#fff', pointerEvents: 'auto', fontSize: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: 8, background: statusColor }} />
            Webcam {cam.status === 'off' ? 'off' : cam.status}
          </span>
          <span style={{ display: 'flex', gap: 6 }}>
            {cam.enabled && <button onClick={() => engine.calibrate()} style={btn}>Recalibrate</button>}
            {cam.status === 'error' && <button onClick={requestCamera} style={btn}>Retry camera</button>}
          </span>
        </div>
        <canvas ref={canvas} width={240} height={180} style={{ width: 240, height: 180, borderRadius: 6, background: '#000', display: cam.enabled ? 'block' : 'none' }} />
        {cam.enabled && (
          <div style={{ marginTop: 6, display: 'flex', justifyContent: 'space-between', color: '#bbb' }}>
            <span>Face {cam.face ? '✓' : '✗'} · Hands {cam.hands}{cam.debug?.onHead ? ` · on head ${cam.debug.onHead}` : ''}</span>
            <span>{pace === 2 ? 'Running' : pace === 1 ? 'Walking' : ''}{Math.abs(cam.turn) > 0.05 ? (cam.turn > 0 ? ' ← ' : ' → ') : ''}</span>
          </div>
        )}
        {cam.enabled && !calibrating && <div style={{ marginTop: 6, color: '#bbb' }}>Keep both feet in frame. Lift each foot a little to walk in place. Step faster to run. Turn your head to steer.</div>}
        {g && <div style={{ marginTop: 6, color: '#f2b233', fontWeight: 700 }}>Gesture: {GESTURE_HINT[g] ?? g}</div>}
        {cam.error && <div style={{ marginTop: 6, color: '#ff8a7a' }}>{cam.error}</div>}
      </div>
    </>
  );
}

const btn = { border: 0, borderRadius: 6, padding: '4px 10px', fontWeight: 700, cursor: 'pointer', fontSize: 12 };
