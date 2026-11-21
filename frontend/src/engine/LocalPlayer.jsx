'use client';
// First-person local player for generated shifts: WASD / mouse or webcam lean + head turn, collisions against the
// shell and placed recipes, visible hands (tracked by the webcam when on), the held prop in view, and crosshair
// focus picking over the interactables derived from blueprint + authoritative state.
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useShift } from './store';
import { localPose, reconcile, samplePlayer } from './net';
import { use, getIndex, lastGrabAt } from './actions';
import { staticInteractables, matchesObjective, KIND_GESTURES, anchorFrame, recipeOf, BOUNDS } from './world';
import { Prop } from './scene';
import { M } from '../game/materials';
import { B } from '../game/parts';
import { footstep } from '../game/audio';
import { cam, onGesture } from '../game/webcam/gestures';

export const EYE = 1.62;
const RADIUS = 0.3;
const REACH = 2.4;
const keys = {};
const tmpV = new THREE.Vector3(), fwdV = new THREE.Vector3();

export function collide(p, colliders) {
  p.x = THREE.MathUtils.clamp(p.x, BOUNDS.minX + RADIUS, BOUNDS.maxX - RADIUS);
  p.z = THREE.MathUtils.clamp(p.z, BOUNDS.minZ + RADIUS, BOUNDS.maxZ - RADIUS);
  for (let pass = 0; pass < 2; pass++) {
    for (const b of colliders) {
      const cx = THREE.MathUtils.clamp(p.x, b.minX, b.maxX);
      const cz = THREE.MathUtils.clamp(p.z, b.minZ, b.maxZ);
      const dx = p.x - cx, dz = p.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= RADIUS * RADIUS) continue;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        p.x = cx + (dx / d) * RADIUS; p.z = cz + (dz / d) * RADIUS;
      } else {
        const opts = [[b.minX - RADIUS - p.x, 0], [b.maxX + RADIUS - p.x, 0], [0, b.minZ - RADIUS - p.z], [0, b.maxZ + RADIUS - p.z]];
        opts.sort((a, c) => Math.abs(a[0] + a[1]) - Math.abs(c[0] + c[1]));
        p.x += opts[0][0]; p.z += opts[0][1];
      }
    }
  }
}

// Interactables are recomputed only when the parts of the state they depend on change.
function interactKey(s) {
  const st = s.state;
  if (!st) return '';
  const items = Object.entries(st.items).map(([id, it]) => `${id}:${it.at}:${it.holder}`).join('|');
  return `${st.phase}#${st.players[s.you]?.held}#${st.closed.join(',')}#${items}`;
}

export default function LocalPlayer({ colliders }) {
  const { camera, gl } = useThree();
  const yaw = useRef(0), pitch = useRef(0);
  const pos = useRef(new THREE.Vector3());
  const vel = useRef(new THREE.Vector3());
  const bob = useRef(0), stepAcc = useRef(0);
  const hands = useRef();
  const spawned = useRef(false);

  const key = useShift(interactKey);
  const statics = useMemo(() => {
    const s = useShift.getState();
    const idx = getIndex();
    return idx ? staticInteractables(idx, s.state, s.you) : [];
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const staticsRef = useRef(statics);
  staticsRef.current = statics;

  // spawn
  useEffect(() => {
    camera.rotation.order = 'YXZ';
    const f = anchorFrame('SPAWN');
    pos.current.set(f.pos[0], 0, f.pos[2]);
    yaw.current = f.rotY;
  }, [camera]);

  useEffect(() => {
    const canPlay = () => { const s = useShift.getState(); return s.started && s.state?.phase === 'play' && !s.skill; };
    const relock = () => { if (canPlay() && !cam.enabled) gl.domElement.requestPointerLock?.()?.catch?.(() => {}); };
    window.__relock = relock;
    const onMove = (e) => {
      if (document.pointerLockElement !== gl.domElement || useShift.getState().skill) return;
      yaw.current -= e.movementX * 0.0022;
      pitch.current = THREE.MathUtils.clamp(pitch.current - e.movementY * 0.0022, -1.35, 1.35);
    };
    const down = (e) => {
      if (e.target?.tagName === 'INPUT') return;
      keys[e.code] = true;
      if (e.code === 'KeyE' && !e.repeat && canPlay()) {
        const f = useShift.getState().focus;
        if (f) use(f);
      }
    };
    const up = (e) => { keys[e.code] = false; };
    const blur = () => { for (const k in keys) keys[k] = false; };
    const click = () => relock();
    const offG = onGesture((name) => {
      if (!canPlay()) return;
      const f = useShift.getState().focus;
      if (!f || !(KIND_GESTURES[f.kind] ?? []).includes(name)) return;
      // Opening the hand right after a grab is the grab finishing, not a request to put it down.
      if (name === 'release' && performance.now() - lastGrabAt < 1200) return;
      use(f);
    });
    document.addEventListener('mousemove', onMove);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    gl.domElement.addEventListener('click', click);
    return () => {
      document.removeEventListener('mousemove', onMove);
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      gl.domElement.removeEventListener('click', click);
      offG();
    };
  }, [gl]);

  useFrame((state, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    const s = useShift.getState();
    // server-side position (first welcome, or a large correction)
    if (reconcile.pos) {
      pos.current.set(reconcile.pos[0], 0, reconcile.pos[2]);
      vel.current.set(0, 0, 0);
      reconcile.pos = null;
      spawned.current = true;
    }
    if (reconcile.yaw !== undefined && reconcile.yaw !== null) {
      yaw.current = reconcile.yaw; pitch.current = reconcile.pitch ?? 0;
      reconcile.yaw = null; reconcile.pitch = null;
    }
    const frozen = !s.started || s.state?.phase !== 'play' || !!s.skill;
    const sprint = keys.ShiftLeft || keys.ShiftRight;
    const held = s.state?.players?.[s.you]?.held ?? null;
    const maxSpeed = sprint ? 4.6 : 3.0;
    const f = tmpV.set(-Math.sin(yaw.current), 0, -Math.cos(yaw.current));
    const rx = -f.z, rz = f.x;
    let wx = 0, wz = 0;
    if (!frozen) {
      if (keys.KeyW || keys.ArrowUp) { wx += f.x; wz += f.z; }
      if (keys.KeyS || keys.ArrowDown) { wx -= f.x; wz -= f.z; }
      if (keys.KeyD || keys.ArrowRight) { wx += rx; wz += rz; }
      if (keys.KeyA || keys.ArrowLeft) { wx -= rx; wz -= rz; }
    }
    const camOn = cam.enabled && cam.calibrated;
    if (!frozen && camOn) {
      if (Math.abs(cam.forward) > 0.01) { wx += f.x * cam.forward; wz += f.z * cam.forward; }
      yaw.current += cam.turn * dt;
      pitch.current = THREE.MathUtils.damp(pitch.current, cam.pitch, 5, dt);
    }
    const wl = Math.hypot(wx, wz);
    if (wl > 1) { wx /= wl; wz /= wl; }
    vel.current.x = THREE.MathUtils.damp(vel.current.x, wx * maxSpeed, 10, dt);
    vel.current.z = THREE.MathUtils.damp(vel.current.z, wz * maxSpeed, 10, dt);
    pos.current.addScaledVector(vel.current, dt);
    collide(pos.current, colliders);

    const speed = Math.hypot(vel.current.x, vel.current.z);
    bob.current += speed * dt * 2.1;
    stepAcc.current += speed * dt;
    if (stepAcc.current > 0.75) { stepAcc.current = 0; footstep(); }
    // N7: no forced camera bob from webcam movement; a light bob for keyboard walking only
    const bobY = camOn ? 0 : Math.sin(bob.current * 2) * 0.018 * Math.min(speed / 3, 1);
    camera.position.set(pos.current.x, EYE + bobY, pos.current.z);
    camera.rotation.set(pitch.current, yaw.current, 0);

    localPose.pos[0] = pos.current.x; localPose.pos[1] = 0; localPose.pos[2] = pos.current.z;
    localPose.yaw = yaw.current; localPose.pitch = pitch.current;
    localPose.ready = !!s.you;

    // first-person hands
    if (hands.current) {
      hands.current.position.copy(camera.position);
      hands.current.quaternion.copy(camera.quaternion);
      const sway = Math.sin(bob.current) * 0.01 * Math.min(speed / 3, 1);
      const rig = hands.current.children[0];
      rig.position.set(sway, -0.02 + Math.abs(sway) * 0.5, 0);
      const hs = camOn ? cam.frame?.hands ?? [] : [];
      for (let i = 0; i < 2; i++) {
        const h = rig.children[i];
        if (!h) continue;
        const tracked = hs.find((lm) => (i === 0 ? lm[0].x > 0.5 : lm[0].x <= 0.5));
        const carry = held ? 0.13 : 0;
        const tx = tracked ? (0.5 - tracked[9].x) * 0.9 : (i === 0 ? -0.24 + carry : 0.24 - carry);
        const ty = tracked ? (0.5 - tracked[9].y) * 0.7 - 0.12 : held ? -0.27 : -0.34;
        h.position.x = THREE.MathUtils.damp(h.position.x, tx, 14, dt);
        h.position.y = THREE.MathUtils.damp(h.position.y, ty, 14, dt);
      }
    }

    // focus picking
    let best = null, bestScore = -Infinity;
    if (!frozen) {
      camera.getWorldDirection(fwdV);
      const obj = s.state?.objectives?.[s.state.cur];
      const consider = (it) => {
        const dx = it.pos[0] - camera.position.x, dy = it.pos[1] - camera.position.y, dz = it.pos[2] - camera.position.z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist > REACH + it.r) return;
        const dot = (dx * fwdV.x + dy * fwdV.y + dz * fwdV.z) / Math.max(dist, 1e-3);
        const need = Math.cos(Math.min(0.55, Math.atan2(it.r + 0.12, dist)));
        if (dot < need) return;
        const score = dot * 2 - dist * 0.08 + (matchesObjective(obj, it) ? 0.25 : 0);
        if (score > bestScore) { bestScore = score; best = it; }
      };
      for (const it of staticsRef.current) consider(it);
      // teammates for a handoff
      if (held && s.state) {
        const label = getIndex()?.items[held]?.label ?? held;
        for (const [id, p] of Object.entries(s.state.players)) {
          if (id === s.you || p.held) continue;
          const sp = samplePlayer(id);
          if (!sp) continue;
          consider({ id: `handoff:${id}`, kind: 'handoff', pos: [sp.pos[0], 1.2, sp.pos[2]], r: 0.55, label: `Hand ${label} to ${p.name}`, intent: { t: 'handoff', to: id } });
        }
      }
    }
    s.setFocus(best);
  });

  const heldId = useShift((s) => s.state?.players?.[s.you]?.held ?? null);
  const heldProp = useShift((s) => (heldId ? s.blueprint?.items?.find((i) => i.id === heldId)?.prop : null));
  const recipe = heldProp ? recipeOf(heldProp, 'item') : null;
  const fit = recipe ? Math.min(1, 0.3 / Math.max(...recipe.size)) : 1;
  return (
    <group ref={hands}>
      <group>
        {[[-0.24, 0], [0.24, 1]].map(([x, i]) => (
          <group key={i} position={[x, -0.34, -0.5]} rotation={[0.3, x > 0 ? -0.25 : 0.25, 0]}>
            <B s={[0.075, 0.045, 0.13]} m={M.skin} round={0.022} />
            <B s={[0.03, 0.028, 0.07]} p={[x > 0 ? -0.05 : 0.05, 0.01, -0.045]} r={[0, x > 0 ? 0.6 : -0.6, 0]} m={M.skin} round={0.012} />
            <B s={[0.095, 0.075, 0.18]} p={[0, -0.005, 0.15]} m={M.fabricBlue} round={0.03} />
          </group>
        ))}
        {recipe && (
          <group position={[0, -0.3 - recipe.size[1] * fit * 0.35, -0.55]} rotation={[0.12, 0, 0]} scale={fit}>
            <Prop recipe={recipe} />
          </group>
        )}
      </group>
    </group>
  );
}
