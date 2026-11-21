// MediaPipe hand, face, and body tracking loop. Feeds the gesture engine.
import { cam, createGestureEngine } from './gestures';

const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
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
let video, hands, face, pose, raf, stream, lastTime = -1, lastPoseTime = -Infinity, body = null;

let pending;
let session = 0;

export function startTracking() {
  if (cam.enabled) return Promise.resolve(video);
  if (pending) return pending;
  const activeSession = ++session;
  pending = openCamera(activeSession).finally(() => {
    if (activeSession === session) pending = null;
  });
  return pending;
}

async function openCamera(activeSession) {
  cam.status = 'loading';
  cam.error = null;
  let input;
  const models = [];
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Open this shift over HTTPS or localhost to use the camera.');
    input = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
    if (activeSession !== session) return;
    const view = document.createElement('video');
    view.srcObject = input;
    view.muted = true;
    view.playsInline = true;
    await view.play();

    const { FilesetResolver, HandLandmarker, FaceLandmarker, PoseLandmarker } = await import('@mediapipe/tasks-vision');
    const fileset = await FilesetResolver.forVisionTasks('/mediapipe');
    if (activeSession !== session) return;
    const results = await Promise.allSettled([
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
      PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numPoses: 1,
      }),
    ]);
    models.push(...results.filter(result => result.status === 'fulfilled').map(result => result.value));
    if (activeSession !== session) return;
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    [hands, face, pose] = models.splice(0);
    video = view;
    stream = input;
    input = null;
    cam.enabled = true;
    lastTime = -1;
    lastPoseTime = -Infinity;
    engine.calibrate();
    loop();
    return video;
  } catch (error) {
    if (activeSession !== session) return;
    stopTracking();
    cam.status = 'error';
    cam.error = error.name === 'NotAllowedError'
      ? 'Allow camera access in your browser, then retry.'
      : (error.message ?? String(error));
    throw error;
  } finally {
    input?.getTracks().forEach(track => track.stop());
    models.forEach(model => model.close());
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
  let poseFrame;
  if (pose && t - lastPoseTime >= 48) {
    lastPoseTime = t;
    try {
      const p = pose.detectForVideo(video, t);
      poseFrame = p.landmarks[0] ?? null;
    } catch (error) {
      stopTracking();
      cam.status = 'error';
      cam.error = 'Body tracking stopped. Retry the camera.';
      console.warn('[webcam] Pose tracking paused', error);
      return;
    }
    body = poseFrame;
  }
  cam.frame = { face: faceLm, hands: handLm, body };
  engine.update(faceLm, handLm, poseFrame);
}

export function stopTracking() {
  session++;
  pending = null;
  cancelAnimationFrame(raf);
  stream?.getTracks().forEach((t) => t.stop());
  hands?.close?.(); face?.close?.(); pose?.close?.();
  hands = face = pose = video = stream = body = null;
  cam.frame = null;
  cam.enabled = false;
  cam.calibrated = false;
  cam.movement = 'frame';
  cam.moveUntil = 0; cam.runUntil = 0; cam.turn = 0; cam.palmPush = false; cam.wheel = 0;
  cam.guard = false;
  cam.status = 'off';
}

export function getVideo() { return video; }
