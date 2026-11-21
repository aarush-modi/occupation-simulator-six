// MediaPipe tracking loop. Two modes (cam.mode):
//   body   (default) PoseLandmarker only -> pose.js: arm swing or running in place, torso turns, reach / lower / press / wave
//   seated HandLandmarker + FaceLandmarker + PoseLandmarker -> gestures.js: shoulder lift, head turn, hand gestures
import { cam, createGestureEngine } from './gestures';
import { createPoseEngine } from './pose';

const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task';

const MODE_KEY = 'workshift.webcamMode';

const engines = { seated: createGestureEngine(), body: createPoseEngine() };
// `engine` forwards to the engine for the current mode (the panel calls engine.calibrate()).
export const engine = {
  calibrate: (ms) => engines[cam.mode].calibrate(ms),
  get calibrating() { return engines[cam.mode].calibrating; },
  get base() { return engines[cam.mode].base; },
};
if (typeof window !== 'undefined') window.__wc = { cam, engine, engines };

/** Restore the saved mode. Call after mount so server and client render the same default. */
export function loadSavedMode() {
  if (cam.enabled || pending) return cam.mode;
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
let video, hands, face, pose, raf, stream, lastTime = -1, lastPoseTime = -Infinity, body = null, runMode = null;

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
    const mode = cam.mode;
    const poseOptions = (delegate) => ({
      baseOptions: { modelAssetPath: POSE_MODEL, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    const results = await Promise.allSettled(mode === 'body' ? [PoseLandmarker.createFromOptions(fileset, poseOptions('GPU'))] : [
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
      PoseLandmarker.createFromOptions(fileset, poseOptions('CPU')),
    ]);
    models.push(...results.filter(result => result.status === 'fulfilled').map(result => result.value));
    if (activeSession !== session) return;
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    if (mode === 'body') [pose] = models.splice(0);
    else [hands, face, pose] = models.splice(0);
    runMode = mode;
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
  if (runMode === 'body') {
    try {
      const r = pose.detectForVideo(video, t);
      engines.body.update(r.landmarks?.[0] ?? null, r.worldLandmarks?.[0] ?? null); // also fills cam.frame
    } catch (error) {
      stopTracking();
      cam.status = 'error';
      cam.error = 'Body tracking stopped. Retry the camera.';
      console.warn('[webcam] Pose tracking paused', error);
    }
    return;
  }
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
  const handSides = handLm.map((points, i) => {
    const name = h.handedness?.[i]?.[0]?.categoryName?.toLowerCase();
    return name === 'left' || name === 'right' ? name : points[0].x > 0.5 ? 'left' : 'right';
  });
  cam.frame = { face: faceLm, hands: handLm, handSides, handWorld: h.worldLandmarks, aspect: video.videoWidth / video.videoHeight, body };
  engines.seated.update(faceLm, handLm, poseFrame, handSides);
}

export function stopTracking() {
  session++;
  pending = null;
  cancelAnimationFrame(raf);
  stream?.getTracks().forEach((t) => t.stop());
  hands?.close?.(); face?.close?.(); pose?.close?.();
  hands = face = pose = video = stream = body = runMode = null;
  cam.frame = null;
  cam.enabled = false;
  cam.calibrated = false;
  cam.movement = 'frame';
  cam.moveUntil = 0; cam.runUntil = 0; cam.forward = 0; cam.turn = 0; cam.pitch = 0; cam.palmPush = false; cam.wheel = 0;
  cam.guard = false;
  cam.status = 'off';
}

export function getVideo() { return video; }

/** Switch between 'body' and 'seated'. Restarts tracking (and calibration) if the webcam is on. */
export async function setMode(mode) {
  if (mode !== 'body' && mode !== 'seated') return;
  try { localStorage.setItem(MODE_KEY, mode); } catch {}
  if (mode === cam.mode && (!cam.enabled || runMode === mode)) return;
  const wasOn = cam.enabled || !!pending;
  if (wasOn) stopTracking();
  cam.mode = mode;
  if (wasOn) await startTracking();
}
