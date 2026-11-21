// MediaPipe hand + face tracking loop. Feeds the gesture engine.
import { cam, createGestureEngine } from './gestures';

const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task';

export const engine = createGestureEngine();
if (typeof window !== 'undefined') window.__wc = { cam, engine };

// MediaPipe's wasm logs routine INFO lines through console.error, which trips the Next.js dev overlay.
if (typeof window !== 'undefined' && !window.__mpLogPatched) {
  window.__mpLogPatched = true;
  const orig = console.error.bind(console);
  console.error = (...args) => {
    if (typeof args[0] === 'string' && /^(INFO|W0000|I0000):?/.test(args[0])) return console.info(...args);
    orig(...args);
  };
}
let video, hands, face, raf, stream, lastTime = -1;

export async function startTracking() {
  if (cam.enabled) return video;
  cam.status = 'loading';
  cam.error = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
    video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();

    const { FilesetResolver, HandLandmarker, FaceLandmarker } = await import('@mediapipe/tasks-vision');
    const fileset = await FilesetResolver.forVisionTasks('/mediapipe');
    [hands, face] = await Promise.all([
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
  const h = hands.detectForVideo(video, t);
  const f = face.detectForVideo(video, t);
  const faceLm = f.faceLandmarks?.[0] ?? null;
  const handLm = h.landmarks ?? [];
  cam.frame = { face: faceLm, hands: handLm };
  engine.update(faceLm, handLm);
}

export function stopTracking() {
  cancelAnimationFrame(raf);
  stream?.getTracks().forEach((t) => t.stop());
  hands?.close?.(); face?.close?.();
  hands = face = video = stream = null;
  cam.enabled = false;
  cam.calibrated = false;
  cam.forward = 0; cam.turn = 0; cam.palmPush = false;
  if (cam.status !== 'error') cam.status = 'off';
}

export function getVideo() { return video; }
