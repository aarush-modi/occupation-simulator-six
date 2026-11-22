'use client';

import { useEffect, useRef, useState } from 'react';
import { GestureTracker, neutral } from './gesture';

const VERSION = '0.10.22-rc.20250304';
const WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/wasm`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
let preloaded;

export function preloadTracking() {
  if (!preloaded) {
    preloaded = import('@mediapipe/tasks-vision').then(async ({ FilesetResolver, PoseLandmarker }) => ({
      files: await FilesetResolver.forVisionTasks(WASM), PoseLandmarker,
    }));
    preloaded.catch(() => { preloaded = null; });
  }
  return preloaded;
}

export function useMotion(enabled, video, scene, send) {
  const [status, setStatus] = useState({ text: 'Camera off', tracked: false });
  const [recalibration, setRecalibration] = useState(0);
  const local = useRef(null);
  const callbacks = useRef({ scene, send });
  useEffect(() => { callbacks.current = { scene, send }; }, [scene, send]);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let stream;
    let landmarker;
    let raf;
    let previousTimestamp = -1;
    let previousSample = -Infinity;
    let previousStatus = '';
    let lastActive = false;
    const gestures = new GestureTracker();
    const report = (text, tracked = false) => {
      if (stopped || (text === previousStatus && tracked === lastActive)) return;
      previousStatus = text;
      lastActive = tracked;
      setStatus({ text, tracked });
    };
    function loop(now) {
      if (stopped) return;
      raf = requestAnimationFrame(loop);
      const element = video.current;
      if (!element || element.readyState < 2 || element.currentTime === previousTimestamp || now - previousSample < 34) return;
      previousTimestamp = element.currentTime;
      previousSample = now;
      try {
        const detection = landmarker.detectForVideo(element, now);
        const context = callbacks.current.scene.current;
        const result = gestures.update(detection.landmarks[0], detection.worldLandmarks[0], now, context);
        local.current = result;
        report(result.stage, result.tracked);
        callbacks.current.send({
          type: 'motion', seq: Math.floor((performance.timeOrigin + now) * 1000), tracked: result.tracked,
          move: result.move ?? 0, turn: result.turn ?? 0, look: result.look ?? 0,
          right: result.right ?? neutral, left: result.left ?? { ...neutral, x: -neutral.x },
          action: result.action, side: result.side,
        });
      } catch {
        local.current = null;
        report('Tracking paused. Turn the camera off and back on to retry.');
        cancelAnimationFrame(raf);
      }
    }
    async function start() {
      report('Starting camera and pose tracking…');
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access requires HTTPS or localhost.');
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false, video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      });
      if (stopped) { stream.getTracks().forEach(track => track.stop()); return; }
      video.current.srcObject = stream;
      await video.current.play();
      report('Loading pose tracking…');
      const { files, PoseLandmarker } = await preloadTracking();
      if (stopped) return;
      landmarker = await PoseLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: MODEL, delegate: 'CPU' },
        runningMode: 'VIDEO', numPoses: 1, minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
      });
      if (stopped) { landmarker.close(); return; }
      raf = requestAnimationFrame(loop);
    }
    start().catch(error => {
      stream?.getTracks().forEach(track => track.stop());
      report(error.name === 'NotAllowedError' ? 'Camera permission was denied.' : (error.message || 'Could not start motion tracking.'));
    });
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      landmarker?.close();
      stream?.getTracks().forEach(track => track.stop());
      local.current = null;
    };
  }, [enabled, video, recalibration]);

  return { status: enabled ? status : { text: 'Camera off', tracked: false }, local, recalibrate: () => setRecalibration(count => count + 1) };
}
