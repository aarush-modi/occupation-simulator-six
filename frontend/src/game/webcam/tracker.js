// MediaPipe tracking loop. Two modes (cam.mode):
//   body   (default) PoseLandmarker -> pose.js: arm swing or running in place, torso turns, reach / lower / press / wave (F3)
//   seated HandLandmarker + FaceLandmarker -> gestures.js: lean, head turn, hand gestures
import { cam, createGestureEngine } from './gestures';
import { createPoseEngine } from './pose';

const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';
const MODE_KEY = 'workshift.webcamMode';

const engines = { seated: createGestureEngine(), body: createPoseEngine() };
// `engine` always forwards to the engine for the current mode (the panel calls engine.calibrate()).
export const engine = {
  calibrate: (ms) => engines[cam.mode].calibrate(ms),
  get calibrating() { return engines[cam.mode].calibrating; },
  get base() { return engines[cam.mode].base; },
};
if (typeof window !== 'undefined') window.__wc = { cam, engine, engines };

/** Restore the saved mode (call after mount so server and client render the same default). */
export function loadSavedMode() {
  if (cam.enabled || stream) return cam.mode;
  try { const m = localStorage.getItem(MODE_KEY); if (m === 'seated' || m === 'body') cam.mode = m; } catch {}
  return cam.mode;
}

// MediaPipe's wasm logs routine INFO lines through console.error, which trips the Next.js dev overlay.
if (typeof window !== 'undefined' && !window.__mpLogPatched) {
  window.__mpLogPatched = true;
  const orig = console.error.bind(console);
  console.error = (...args) => {
    if (typeof args[0] === 'string' && /^(INFO|W0000|I0000):?/.test(args[0])) return console.info(...args);
    orig(...args);
  };
}
let video, hands, face, pose, raf, stream, lastTime = -1, runMode = null, gen = 0;

export async function startTracking() {
  if (cam.enabled) return video;
  const my = ++gen;
  cam.status = 'loading';
  cam.error = null;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
    if (my !== gen) { s.getTracks().forEach((tr) => tr.stop()); return null; }
    stream = s;
    video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();

    const { FilesetResolver, HandLandmarker, FaceLandmarker, PoseLandmarker } = await import('@mediapipe/tasks-vision');
    const fileset = await FilesetResolver.forVisionTasks('/mediapipe');
    const mode = cam.mode;
    let p = null, hl = null, fl = null;
    if (mode === 'body') {
      p = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    } else [hl, fl] = await Promise.all([
      HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      }),
      FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numFaces: 1,
      }),
    ]);
    if (my !== gen) { p?.close?.(); hl?.close?.(); fl?.close?.(); return null; } // stopped / switched while loading
    pose = p; hands = hl; face = fl; runMode = mode;
    cam.enabled = true;
    engine.calibrate();
    loop();
    return video;
  } catch (e) {
    console.error('[webcam]', e);
    cam.status = 'error';
    cam.error = e?.message ?? String(e);
    stopTracking();
    throw e;
  }
}

function loop() {
  raf = requestAnimationFrame(loop);
  if (!video || video.readyState < 2 || video.currentTime === lastTime) return;
  lastTime = video.currentTime;
  const t = performance.now();
  if (runMode === 'body') {
    const r = pose.detectForVideo(video, t);
    engines.body.update(r.landmarks?.[0] ?? null, r.worldLandmarks?.[0] ?? null); // also fills cam.frame
    return;
  }
  const h = hands.detectForVideo(video, t);
  const f = face.detectForVideo(video, t);
  const faceLm = f.faceLandmarks?.[0] ?? null;
  const handLm = h.landmarks ?? [];
  cam.frame = { face: faceLm, hands: handLm };
  engines.seated.update(faceLm, handLm);
}

export function stopTracking() {
  gen++;
  cancelAnimationFrame(raf);
  stream?.getTracks().forEach((t) => t.stop());
  hands?.close?.(); face?.close?.(); pose?.close?.();
  hands = face = pose = video = stream = null;
  runMode = null;
  lastTime = -1;
  cam.enabled = false;
  cam.calibrated = false;
  cam.forward = 0; cam.turn = 0; cam.pitch = 0; cam.palmPush = false;
  cam.frame = null;
  if (cam.status !== 'error') cam.status = 'off';
}

export function getVideo() { return video; }

/** Switch between 'body' and 'seated'. Restarts tracking (and calibration) if the webcam is on. */
export async function setMode(mode) {
  if (mode !== 'body' && mode !== 'seated') return;
  try { localStorage.setItem(MODE_KEY, mode); } catch {}
  if (mode === cam.mode && (!cam.enabled || runMode === mode)) return;
  const wasOn = cam.enabled || !!stream;
  if (wasOn) stopTracking();
  cam.mode = mode;
  if (wasOn) await startTracking();
}
