'use client';
import * as THREE from 'three';
import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { colliders, DECK, A, interactables } from './world';
import { useGame, live } from './store';
import { M } from './materials';
import { B, C } from './parts';
import { footstep } from './audio';
import { cam, onGesture, webcamPace } from './webcam/gestures';

export function gestureList(it) {
  const g = typeof it.gesture === 'function' ? it.gesture() : it.gesture;
  return g ?? [];
}

const EYE = 1.65, RADIUS = 0.32;

function collide(p) {
  p.x = THREE.MathUtils.clamp(p.x, DECK.minX + 0.5, DECK.maxX - 0.5);
  p.z = THREE.MathUtils.clamp(p.z, DECK.minZ + 0.5, DECK.maxZ - 0.5);
  for (const b of colliders) {
    const cx = THREE.MathUtils.clamp(p.x, b.minX, b.maxX);
    const cz = THREE.MathUtils.clamp(p.z, b.minZ, b.maxZ);
    const dx = p.x - cx, dz = p.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 < RADIUS * RADIUS) {
      if (d2 > 1e-6) {
        const d = Math.sqrt(d2);
        p.x = cx + (dx / d) * RADIUS; p.z = cz + (dz / d) * RADIUS;
      } else {
        // inside the box: push out along shallowest axis
        const opts = [[b.minX - RADIUS - p.x, 0], [b.maxX + RADIUS - p.x, 0], [0, b.minZ - RADIUS - p.z], [0, b.maxZ + RADIUS - p.z]];
        opts.sort((a, c) => Math.abs(a[0] + a[1]) - Math.abs(c[0] + c[1]));
        p.x += opts[0][0]; p.z += opts[0][1];
      }
    }
  }
}

export default function Player() {
  const { camera } = useThree();
  const yaw = useRef(0), pitch = useRef(0);
  const pos = useRef(new THREE.Vector3(A.spawn[0], 0, A.spawn[2]));
  const vel = useRef(new THREE.Vector3());
  const bob = useRef(0);
  const hands = useRef();
  const stepAcc = useRef(0);

  useEffect(() => {
    camera.rotation.order = 'YXZ';
    return onGesture((name) => {
      const s = useGame.getState();
      if (s.skill || s.phase !== 'play') return;
      const it = s.focus && interactables.get(s.focus);
      if (it && it.label() && gestureList(it).includes(name)) it.use();
    });
  }, [camera]);

  useFrame((state, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    const s = useGame.getState();
    const frozen = s.phase !== 'play' || !!s.skill;
    const carrying = s.held === 'pipe';
    const pace = frozen ? 0 : webcamPace();
    const camOn = cam.enabled && cam.calibrated;
    if (!frozen && camOn) {
      yaw.current += cam.turn * dt;
      pitch.current = THREE.MathUtils.damp(pitch.current, cam.pitch, 5, dt);
    }
    const speedTarget = !pace ? 0 : carrying ? 2.0 : pace === 2 ? 4.9 : 2.45;
    vel.current.x = THREE.MathUtils.damp(vel.current.x, -Math.sin(yaw.current) * speedTarget, pace ? 14 : 21, dt);
    vel.current.z = THREE.MathUtils.damp(vel.current.z, -Math.cos(yaw.current) * speedTarget, pace ? 14 : 21, dt);
    pos.current.addScaledVector(vel.current, dt);
    collide(pos.current);

    const speed = Math.hypot(vel.current.x, vel.current.z);
    bob.current += speed * dt * 2.1;
    stepAcc.current += speed * dt;
    if (stepAcc.current > (carrying ? 0.6 : 0.8)) { stepAcc.current = 0; footstep(); }

    // alarm shake, capped for comfort
    const shake = s.alarm ? 0.004 : 0;
    const t = state.clock.elapsedTime;
    camera.position.set(pos.current.x, EYE + Math.sin(t * 31) * shake, pos.current.z);
    camera.rotation.set(pitch.current + Math.sin(t * 27) * shake, yaw.current, 0);

    // hands follow camera
    if (hands.current) {
      hands.current.position.copy(camera.position);
      hands.current.quaternion.copy(camera.quaternion);
      const sway = Math.sin(bob.current) * 0.012 * Math.min(speed / 3, 1);
      hands.current.children[0].position.set(sway, -0.02 + Math.abs(sway) * 0.5, 0);
      // tracked hands drive the first-person hands (mirrored)
      const hs = camOn ? cam.frame?.hands ?? [] : [];
      const fp = hands.current.children[0].children;
      for (let i = 0; i < 2; i++) {
        const h = fp[i];
        if (!h) continue;
        const tracked = hs.find((lm) => (i === 0 ? lm[0].x > 0.5 : lm[0].x <= 0.5)); // image right = user's left hand
        const tx = tracked ? (0.5 - tracked[9].x) * 0.9 : (i === 0 ? -0.28 : 0.28) * 0.85;
        const ty = tracked ? (0.5 - tracked[9].y) * 0.7 - 0.12 : -0.34;
        h.position.x = THREE.MathUtils.damp(h.position.x, tx, 14, dt);
        h.position.y = THREE.MathUtils.damp(h.position.y, ty, 14, dt);
      }
    }

    // focus: best interactable in front within reach
    let best = null, bestScore = -1;
    const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd);
    if (!frozen) {
      for (const it of interactables.values()) {
        if (!it.label()) continue;
        const to = new THREE.Vector3(it.pos[0] - camera.position.x, it.pos[1] - camera.position.y, it.pos[2] - camera.position.z);
        const dist = to.length();
        if (dist > 2.6 + (it.r ?? 0.5)) continue;
        const dot = to.normalize().dot(fwd);
        const need = Math.cos(Math.min(0.7, Math.atan2((it.r ?? 0.5) + 0.25, dist)));
        if (dot < need) continue;
        const score = dot - dist * 0.05;
        if (score > bestScore) { bestScore = score; best = it.id; }
      }
    }
    s.setFocus(best);
  });

  const held = useGame((s) => s.held);
  const ppe = useGame((s) => s.ppe);
  return (
    <group ref={hands}>
      <group>
        {/* gloved hands, visible in lower view */}
        {[[-0.28, 0], [0.28, 1]].map(([x, i]) => (
          <group key={i} position={[x * 0.85, -0.34, -0.5]} rotation={[0.3, x > 0 ? -0.25 : 0.25, 0]}>
            <B s={[0.07, 0.045, 0.14]} m={ppe ? M.glove : M.skin} round={0.025} />
            <B s={[0.1, 0.07, 0.16]} p={[0, -0.005, 0.15]} m={M.coverallOrange} round={0.03} />
            <B s={[0.03, 0.03, 0.07]} p={[x > 0 ? -0.05 : 0.05, 0.01, -0.05]} r={[0, x > 0 ? 0.6 : -0.6, 0]} m={ppe ? M.glove : M.skin} round={0.012} />
          </group>
        ))}
        {held === 'pipe' && (
          <group position={[0.05, -0.32, -0.6]} rotation={[0, 0.25, 0]}>
            <C rt={0.11} h={8} r={[Math.PI / 2, 0, 0.05]} p={[0, 0, -2.6]} m={M.pipe} seg={16} />
            <C rt={0.14} h={0.4} r={[Math.PI / 2, 0, 0.05]} p={[0, 0, -6.4]} m={M.pipe} seg={16} />
          </group>
        )}
      </group>
    </group>
  );
}

export { live };
