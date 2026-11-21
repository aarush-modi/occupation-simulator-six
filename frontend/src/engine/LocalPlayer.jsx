'use client';
// First-person local player for generated shifts: webcam steps and head turns, collisions against the
// shell and placed recipes, visible hands (tracked by the webcam when on), the held prop in view, and crosshair
// focus picking over the interactables derived from blueprint + authoritative state.
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useShift } from './store';
import { localPose, reconcile, samplePlayer, sampleNpc, send } from './net';
import { use, getIndex, lastGrabAt } from './actions';
import { staticInteractables, matchesObjective, KIND_GESTURES, anchorFrame, recipeOf, BOUNDS } from './world';
import { Prop } from './scene';
import { M } from '../game/materials';
import { B } from '../game/parts';
import { footstep } from '../game/audio';
import { cam, onGesture, webcamPace } from '../game/webcam/gestures';
import { clampToArena } from '../shared/gameRules';

export const EYE = 1.62;
const RADIUS = 0.3;
const REACH = 2.4;
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
  const { camera } = useThree();
  const yaw = useRef(0), pitch = useRef(0);
  const pos = useRef(new THREE.Vector3());
  const vel = useRef(new THREE.Vector3());
  const bob = useRef(0), stepAcc = useRef(0);
  const hands = useRef();
  const spawned = useRef(false);
  const strikeAt = useRef(-Infinity);
  const arena = useShift((s) => s.blueprint?.game?.arena);

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

  useEffect(() => onGesture((name) => {
    const s = useShift.getState();
    if (!s.started || s.state?.phase !== 'play' || s.skill) return;
    if (s.state.game?.kind === 'sparring') {
      const now = performance.now();
      if ((name === 'strike' || name === 'fist') && now - strikeAt.current >= 550) {
        strikeAt.current = now;
        send({ t: 'strike' });
      }
      return;
    }
    const f = s.focus;
    if (!f || !(KIND_GESTURES[f.kind] ?? []).includes(name)) return;
    // Opening the hand immediately after a grab finishes that gesture.
    if ((name === 'release' || name === 'unpinch') && performance.now() - lastGrabAt < 450) return;
    use(f);
  }), []);

  useFrame((_, dtRaw) => {
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
    const guard = Boolean(arena && cam.enabled && cam.guard);
    const pace = frozen || guard ? 0 : webcamPace();
    const held = s.state?.players?.[s.you]?.held ?? null;
    const camOn = cam.enabled && cam.calibrated;
    if (!frozen && camOn) {
      yaw.current += cam.turn * dt;
      pitch.current = THREE.MathUtils.damp(pitch.current, cam.pitch, 5, dt);
    }
    const speedTarget = pace === 2 ? 4.4 : pace === 1 ? 2.25 : 0;
    const f = tmpV.set(-Math.sin(yaw.current), 0, -Math.cos(yaw.current));
    vel.current.x = THREE.MathUtils.damp(vel.current.x, f.x * speedTarget, pace ? 14 : 21, dt);
    vel.current.z = THREE.MathUtils.damp(vel.current.z, f.z * speedTarget, pace ? 14 : 21, dt);
    pos.current.addScaledVector(vel.current, dt);
    collide(pos.current, colliders);
    if (arena) pos.current.set(...clampToArena(pos.current.toArray(), arena));

    const speed = Math.hypot(vel.current.x, vel.current.z);
    bob.current += speed * dt * 2.1;
    stepAcc.current += speed * dt;
    if (stepAcc.current > 0.75) { stepAcc.current = 0; footstep(); }
    camera.position.set(pos.current.x, EYE, pos.current.z);
    camera.rotation.set(pitch.current, yaw.current, 0);

    localPose.pos[0] = pos.current.x; localPose.pos[1] = 0; localPose.pos[2] = pos.current.z;
    localPose.yaw = yaw.current; localPose.pitch = pitch.current;
    localPose.guard = guard && !frozen;
    localPose.ready = !!s.you;

    // first-person hands
    if (hands.current) {
      hands.current.position.copy(camera.position);
      hands.current.quaternion.copy(camera.quaternion);
      const sway = Math.sin(bob.current) * 0.01 * Math.min(speed / 3, 1);
      const rig = hands.current.children[0];
      rig.position.set(sway, -0.02 + Math.abs(sway) * 0.5, 0);
      const hs = camOn ? cam.frame?.hands ?? [] : [];
      const gestureAge = performance.now() - strikeAt.current;
      const extension = gestureAge < 220 ? Math.sin(Math.PI * gestureAge / 220) * 0.37 : 0;
      for (let i = 0; i < 2; i++) {
        const h = rig.children[i];
        if (!h) continue;
        const tracked = hs.find((lm) => (i === 0 ? lm[0].x > 0.5 : lm[0].x <= 0.5));
        const carry = held ? 0.13 : 0;
        const tx = tracked ? (0.5 - tracked[9].x) * 0.9 : (i === 0 ? -0.24 + carry : 0.24 - carry);
        const ty = tracked ? (0.5 - tracked[9].y) * 0.7 - 0.12 : held ? -0.27 : -0.34;
        h.position.x = THREE.MathUtils.damp(h.position.x, tx, 14, dt);
        h.position.y = THREE.MathUtils.damp(h.position.y, ty, 14, dt);
        h.position.z = -0.5 - (i === 1 ? extension : 0);
      }
    }

    // focus picking
    let best = null, bestScore = -Infinity;
    if (!frozen && !arena) {
      camera.getWorldDirection(fwdV);
      const obj = s.state?.objectives?.[s.state.cur];
      const consider = (it) => {
        const dx = it.pos[0] - camera.position.x, dy = it.pos[1] - camera.position.y, dz = it.pos[2] - camera.position.z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist > REACH + it.r) return;
        const dot = (dx * fwdV.x + dy * fwdV.y + dz * fwdV.z) / Math.max(dist, 1e-3);
        const required = matchesObjective(obj, it);
        const need = Math.cos(Math.min(0.62, Math.atan2(it.r + 0.22, dist) + (required ? 0.10 : 0)));
        if (dot < need) return;
        const score = dot * 2 - dist * 0.08 + (required ? 0.28 : 0);
        if (score > bestScore) { bestScore = score; best = it; }
      };
      for (const it of staticsRef.current) consider(it);
      for (const person of Object.values(s.state?.people ?? {})) {
        const p = sampleNpc(person.id) ?? person;
        consider({ id: `talk:${person.id}`, kind: 'talk', pos: [p.pos[0], 1.5, p.pos[2]], r: 0.52,
          label: `Talk to ${person.name}`, intent: { t: 'talk', npc: person.id } });
      }
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
  const plated = useShift((s) => s.state?.items?.[heldId]?.tags?.includes('plated') ?? false);
  const recipe = heldProp ? recipeOf(heldProp, 'item') : null;
  const fit = recipe ? Math.min(1, 0.3 / Math.max(...recipe.size)) : 1;
  return (
    <group ref={hands}>
      <group>
        {[[-0.24, 0], [0.24, 1]].map(([x, i]) => (
          <group key={i} position={[x, -0.34, -0.5]} rotation={[0.3, x > 0 ? -0.25 : 0.25, 0]}>
            <B s={arena ? [0.15, 0.14, 0.18] : [0.075, 0.045, 0.13]} m={arena ? M.fabricBlue : M.skin} round={arena ? 0.06 : 0.022} />
            {!arena && <B s={[0.03, 0.028, 0.07]} p={[x > 0 ? -0.05 : 0.05, 0.01, -0.045]} r={[0, x > 0 ? 0.6 : -0.6, 0]} m={M.skin} round={0.012} />}
            <B s={[0.095, 0.075, 0.18]} p={[0, -0.005, 0.15]} m={M.fabricBlue} round={0.03} />
          </group>
        ))}
        {recipe && (
          <group position={[0, -0.3 - recipe.size[1] * fit * 0.35, -0.55]} rotation={[0.12, 0, 0]} scale={fit}>
            <Prop recipe={recipe} plated={plated} />
          </group>
        )}
      </group>
    </group>
  );
}
