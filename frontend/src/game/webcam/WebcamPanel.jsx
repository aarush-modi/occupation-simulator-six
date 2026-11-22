'use client';
import { useEffect, useRef, useState } from 'react';
import { cam, GESTURE_HINT, webcamPace } from './gestures';
import { BODY_GESTURE_HINT } from './pose';
import { startTracking, stopTracking, getVideo, engine, setMode, loadSavedMode } from './tracker';

const HAND_EDGES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
const POSTURE_EDGES = [[11, 12], [2, 11], [5, 12]];
const FACE_PTS = [10, 152, 234, 454, 1, 33, 263];
// MediaPipe pose skeleton (torso, arms, hands, legs)
const POSE_EDGES = [[11, 12], [11, 23], [12, 24], [23, 24], [11, 13], [13, 15], [12, 14], [14, 16], [15, 19], [15, 17], [16, 20], [16, 18], [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32]];
const POSE_VIS = 0.5;

export default function WebcamPanel() {
  const canvas = useRef();
  const [, tick] = useState(0);
  const [busy, setBusy] = useState(false);

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
      if (fr?.pose) {
        // full-body mode: skeleton over the video (the synthesised hands live in view space, not image space)
        const lm = fr.pose;
        const ok = (i) => lm[i] && (lm[i].visibility == null || lm[i].visibility >= POSE_VIS);
        ctx.lineWidth = 3;
        ctx.strokeStyle = cam.status === 'lost' ? '#ff6a5c' : '#3cff8a';
        for (const [a, b] of POSE_EDGES) {
          if (!ok(a) || !ok(b)) continue;
          ctx.beginPath(); ctx.moveTo(lm[a].x * W, lm[a].y * H); ctx.lineTo(lm[b].x * W, lm[b].y * H); ctx.stroke();
        }
        ctx.fillStyle = '#f2b233';
        for (const i of [0, 15, 16, 25, 26]) if (ok(i)) { ctx.beginPath(); ctx.arc(lm[i].x * W, lm[i].y * H, 3.5, 0, 7); ctx.fill(); }
      } else if (fr) {
        ctx.lineWidth = 2;
        for (const hand of fr.hands) {
          ctx.strokeStyle = '#f2b233';
          for (const [a, b] of HAND_EDGES) { ctx.beginPath(); ctx.moveTo(hand[a].x * W, hand[a].y * H); ctx.lineTo(hand[b].x * W, hand[b].y * H); ctx.stroke(); }
        }
        if (fr.body) {
          ctx.strokeStyle = '#64c8ff';
          for (const [a, b] of POSTURE_EDGES) {
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
    loadSavedMode();
    const request = setTimeout(requestCamera, 0);
    return () => { clearTimeout(request); stopTracking(); };
  }, []);

  const g = cam.lastGesture && performance.now() - cam.lastGesture.t < 1500 ? cam.lastGesture.name : null;
  const statusColor = { tracking: '#3cff8a', calibrating: '#f2b233', loading: '#f2b233', lost: '#ff6a5c', error: '#ff6a5c', off: '#888' }[cam.status];
  const pace = webcamPace();
  const calibrating = cam.status === 'calibrating';
  const body = cam.mode === 'body';
  const b = cam.body;
  const pickMode = async (m) => {
    if (m === cam.mode || busy) return;
    setBusy(true);
    try { await setMode(m); } catch {}
    setBusy(false);
  };

  return (
    <>
      {calibrating && (
        <div style={{ position: 'absolute', left: '50%', top: '30%', transform: 'translateX(-50%)', padding: '16px 22px', background: 'rgba(12,12,14,0.85)', borderRadius: 0, color: '#fff', textAlign: 'center', border: '1px solid rgba(255,255,255,0.1)' }}>
          <div style={{ fontSize: 12, letterSpacing: 3, color: '#f2b233' }}>CALIBRATING</div>
          {body ? (
            <>
              <div style={{ fontSize: 18, fontWeight: 700, marginTop: 6 }}>Stand still, facing the screen, arms at your sides</div>
              <div style={{ fontSize: 13, color: '#bbb', marginTop: 6 }}>Stand back so your shoulders, arms and hips are in the preview. Legs are optional.</div>
              {cam.calibHint && <div style={{ fontSize: 13, color: '#ff8a7a', marginTop: 6 }}>{cam.calibHint}</div>}
              <div style={{ height: 4, background: 'rgba(255,255,255,0.12)', borderRadius: 0, marginTop: 10, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.round((cam.calibProgress ?? 0) * 100)}%`, background: '#f2b233' }} />
              </div>
              <div style={{ fontSize: 12, color: '#999', marginTop: 10, lineHeight: 1.6 }}>
                Swing your arms (or run in place) to walk · twist your shoulders to turn · raise a hand to use what is highlighted<br />
                lower both hands to put down · push a hand forward and hold to press · wave to talk
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 18, fontWeight: 700, marginTop: 6 }}>Face the screen and relax your shoulders</div>
              <div style={{ fontSize: 13, color: '#bbb', marginTop: 6 }}>Keep your face and both shoulders in frame.</div>
            </>
          )}
        </div>
      )}
      <div style={{ position: 'absolute', right: 20, bottom: 20, width: 260, padding: 10, background: 'rgba(34,26,20,0.94)', boxShadow: '0 0 0 2px #120e0b, 0 0 0 4px #4a3a2c, 0 4px 0 4px rgba(18,14,11,0.9)', borderRadius: 0, color: '#fff', pointerEvents: 'auto', fontSize: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: 0, background: statusColor }} />
            Webcam {cam.status === 'off' ? 'off' : cam.status}
          </span>
          <span style={{ display: 'flex', gap: 6 }}>
            {cam.enabled && <button onClick={() => engine.calibrate()} style={btn}>Recalibrate</button>}
            {cam.status === 'error' && <button onClick={requestCamera} style={btn}>Retry camera</button>}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
          {[['body', 'Full body'], ['seated', 'Seated']].map(([m, label]) => (
            <button key={m} onClick={() => pickMode(m)} disabled={busy} style={{ ...btn, flex: 1, fontWeight: 600, background: cam.mode === m ? 'rgba(242,178,51,0.9)' : 'rgba(255,255,255,0.08)', color: cam.mode === m ? '#111' : '#ccc' }}>
              {label}
            </button>
          ))}
        </div>
        <canvas ref={canvas} width={240} height={180} style={{ width: 240, height: 180, borderRadius: 0, background: '#000', display: cam.enabled ? 'block' : 'none' }} />
        {cam.enabled && (
          <div style={{ marginTop: 6, display: 'flex', justifyContent: 'space-between', color: '#bbb' }}>
            {body ? (
              <span>{cam.status === 'lost' ? 'Body lost: step into view' : b?.visible ? `Body ✓${b.squat ? ' · Squat' : ''} · Hand ${b.raise === 'up' ? 'UP ✋' : b.raise === 'blocked: walking' ? 'up (stop walking first)' : 'down'}` : 'Body ✗'}</span>
            ) : (
              <span>Face {cam.face ? '✓' : '✗'} · Hands {cam.hands} · {cam.movement === 'frame' ? 'Show shoulders' : cam.movement === 'calibrating' ? 'Hold still' : 'Shoulders tracked'}{cam.debug?.onHead ? ` · on head ${cam.debug.onHead}` : ''}</span>
            )}
            <span>{pace === 2 ? 'Running' : pace === 1 ? 'Walking' : ''}{Math.abs(cam.turn) > 0.05 ? (cam.turn > 0 ? ' ← ' : ' → ') : ''}</span>
          </div>
        )}
        {cam.enabled && !calibrating && <div style={{ marginTop: 6, color: '#bbb' }}>{body ? 'Swing your arms to walk. Stop to stand still. Twist your shoulders to turn.' : 'Raise both shoulders to move forward. Relax to stop. Turn your head to steer.'}</div>}
        {g && <div style={{ marginTop: 6, color: '#f2b233', fontWeight: 700 }}>Gesture: {(body ? BODY_GESTURE_HINT[g] : null) ?? GESTURE_HINT[g] ?? g}</div>}
        {cam.error && <div style={{ marginTop: 6, color: '#ff8a7a' }}>{cam.error}</div>}
      </div>
    </>
  );
}

const btn = { border: 0, borderRadius: 0, padding: '4px 10px', fontWeight: 700, cursor: 'pointer', fontSize: 12 };
