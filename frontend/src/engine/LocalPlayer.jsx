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
import { staticInteractables, matchesObjective, gesturesFor, anchorFrame, BOUNDS, myObjective } from './world';
import TrackedHands from './TrackedHands';
import { carryingNeeded, mayRelease } from './carry';
import { footstep } from '../game/audio';
import { cam, onGesture, webcamPace } from '../game/webcam/gestures';
import { clampToArena } from '../shared/gameRules';
import { talkLock, updateTalkLock, yawToFace } from './talkLock';
import { updateWorkView, isMachineWork, WORK_FOV } from './workView';

export const EYE = 1.62;
const RADIUS = 0.3;
const REACH = 2.4;
const BODY_REACH = 4.2; // full-body webcam: aim by body heading, so reach further
const BODY_SPEED = 1.8; // full-body webcam: m/s at full arm-swing cadence (cam.forward = 1)
const tmpV = new THREE.Vector3(), fwdV = new THREE.Vector3(), tmpEye = new THREE.Vector3();

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
  const step = st.objectives[st.players[s.you]?.step ?? st.cur]?.id; // a use step's spot appears with its step
  return `${st.phase}#${st.players[s.you]?.held}#${st.closed.join(',')}#${step}#${st.objectives.length}#${items}`;
}

export default function LocalPlayer({ colliders }) {
  const { camera } = useThree();
  const yaw = useRef(0), pitch = useRef(0);
  const pos = useRef(new THREE.Vector3());
  const vel = useRef(new THREE.Vector3());
  const stepAcc = useRef(0);
  const strike = useRef({ time: -Infinity, side: 'right' });
  const assist = useRef(null); // full-body webcam aim-assist target [x, y, z]
  const zoom = useRef({ blend: 0, target: null, fov: null }); // machine close-up (workView.js)
  const camPos = useMemo(() => new THREE.Vector3(), []);
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

  useEffect(() => onGesture((name, side) => {
    const s = useShift.getState();
    if (!s.started || s.state?.phase !== 'play' || s.skill) return;
    if (s.state.game?.kind === 'sparring') {
      const now = performance.now();
      if ((name === 'strike' || name === 'fist') && now - strike.current.time >= 550) {
        strike.current = { time: now, side: side ?? 'right' };
        send({ t: 'strike' });
      }
      return;
    }
    const f = s.focus;
    // Full-body mode: a raised hand or reach ('fist') uses whatever is highlighted, whatever its kind.
    const universal = cam.mode === 'body' && name === 'fist';
    if (!f || !(universal || gesturesFor(f).includes(name))) return;
    // Opening the hand immediately after a grab finishes that gesture.
    if ((name === 'release' || name === 'unpinch') && performance.now() - lastGrabAt < 450) return;
    const releasing = f.kind === 'place' || f.kind === 'handoff';
    const now = performance.now();
    const moving = cam.enabled && (webcamPace(now) > 0 || cam.forward > 0.05 || Math.abs(cam.turn) > 0.2);
    if (releasing && !mayRelease({ it: f, matches: matchesObjective(myObjective(s.state, s.you), f), state: s.state, you: s.you, now, grabAt: lastGrabAt, moving })) return;
    use(f, releasing ? s.state.players[s.you]?.holdHand ?? 'right' : side);
  }), []);

  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    const s = useShift.getState();
    // server-side position (first welcome, or a large correction)
    if (reconcile.pos) {
      pos.current.set(reconcile.pos[0], 0, reconcile.pos[2]);
      vel.current.set(0, 0, 0);
      reconcile.pos = null;
    }
    if (reconcile.yaw !== undefined && reconcile.yaw !== null) {
      yaw.current = reconcile.yaw; pitch.current = reconcile.pitch ?? 0;
      reconcile.yaw = null; reconcile.pitch = null;
    }
    const frozen = !s.started || s.state?.phase !== 'play' || !!s.skill;
    // In a conversation the view turns to face the NPC and walking pauses.
    let facing = null;
    if (talkLock.npc) {
      const person = s.state?.people?.[talkLock.npc];
      const p = person && (sampleNpc(talkLock.npc) ?? person);
      const speaking = Boolean(person) && (s.subtitle?.who === person.name || (s.heard?.pending && s.heard.npc === talkLock.npc));
      const distance = p ? Math.hypot(p.pos[0] - pos.current.x, p.pos[2] - pos.current.z) : null;
      if (updateTalkLock({ speaking, distance }) && !frozen) facing = p.pos;
    }
    const guard = Boolean(arena && cam.enabled && cam.guard);
    const held = s.state?.players?.[s.you]?.held ?? null;
    const camOn = cam.enabled && cam.calibrated;
    const bodyMode = camOn && cam.mode === 'body';
    const wantPace = frozen ? 0 : webcamPace();
    // Working a machine: lean in to the part the step needs. Trying to walk steps back out.
    let work = null;
    if (!frozen && !facing && !arena) {
      const obj = myObjective(s.state, s.you);
      const need = obj ? staticsRef.current.find((it) => isMachineWork(it) && matchesObjective(obj, it)) : null;
      const st = need && getIndex()?.stations[need.station];
      work = updateWorkView({
        it: need, stepId: obj?.id, frame: st?.frame, depth: st?.recipe?.size?.[2],
        distance: need ? Math.hypot(need.pos[0] - pos.current.x, need.pos[2] - pos.current.z) : null,
        walking: wantPace > 0 || (bodyMode && cam.forward > 0.3),
      });
    } else updateWorkView({ it: null });
    const pace = guard || facing || work ? 0 : wantPace;
    if (facing) {
      const dx = facing[0] - pos.current.x, dz = facing[2] - pos.current.z;
      let d = yawToFace([pos.current.x, 0, pos.current.z], facing) - yaw.current;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      yaw.current += d * Math.min(1, dt * 6);
      pitch.current = THREE.MathUtils.damp(pitch.current, Math.atan2(1.55 - EYE, Math.max(0.3, Math.hypot(dx, dz))), 6, dt);
    } else if (work) {
      // Aim from where the camera is now (it glides in), so the part stays centred the whole way.
      const from = camPos.set(pos.current.x, EYE, pos.current.z).lerp(tmpEye.fromArray(work.eye), zoom.current.blend);
      let d = yawToFace([from.x, 0, from.z], work.look) - yaw.current;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      yaw.current += d * Math.min(1, dt * 7);
      const hd = Math.max(0.15, Math.hypot(work.look[0] - from.x, work.look[2] - from.z));
      pitch.current = THREE.MathUtils.damp(pitch.current, Math.atan2(work.look[1] - from.y, hd), 7, dt);
    } else if (!frozen && camOn) {
      yaw.current += cam.turn * dt;
      // Full-body aim assist: there is no head pitch, so tilt the view toward the focused thing. When the player
      // stands still and is not turning, ease the heading onto it so a rough torso turn is enough.
      const tgt = bodyMode ? assist.current : null;
      if (tgt) {
        const dx = tgt[0] - pos.current.x, dz = tgt[2] - pos.current.z;
        const hd = Math.max(0.3, Math.hypot(dx, dz));
        pitch.current = THREE.MathUtils.damp(pitch.current, THREE.MathUtils.clamp(Math.atan2(tgt[1] - EYE, hd), -0.9, 0.5), 4, dt);
        if (Math.abs(cam.turn) < 0.05 && Math.abs(cam.forward) < 0.05) {
          let d = Math.atan2(-dx, -dz) - yaw.current;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          yaw.current += THREE.MathUtils.clamp(d * Math.min(1, dt * 2.5), -0.9 * dt, 0.9 * dt);
        }
      } else pitch.current = THREE.MathUtils.damp(pitch.current, cam.pitch, 5, dt);
    }
    const speedTarget = bodyMode ? (frozen || guard || facing || work ? 0 : cam.forward * BODY_SPEED) : pace === 2 ? 3.85 : pace === 1 ? 1.75 : 0;
    const f = tmpV.set(-Math.sin(yaw.current), 0, -Math.cos(yaw.current));
    vel.current.x = THREE.MathUtils.damp(vel.current.x, f.x * speedTarget, pace ? 9 : 17, dt);
    vel.current.z = THREE.MathUtils.damp(vel.current.z, f.z * speedTarget, pace ? 9 : 17, dt);
    const xBefore = pos.current.x, zBefore = pos.current.z;
    pos.current.addScaledVector(vel.current, dt);
    collide(pos.current, colliders);
    if (arena) pos.current.set(...clampToArena(pos.current.toArray(), arena));

    stepAcc.current += Math.hypot(pos.current.x - xBefore, pos.current.z - zBefore);
    const stride = pace === 2 ? 1.10 : 0.73;
    if (stepAcc.current >= stride) { stepAcc.current -= stride; footstep(); }
    const z = zoom.current;
    if (work) z.target = work;
    z.blend = THREE.MathUtils.damp(z.blend, work ? 1 : 0, work ? 4.5 : 6, dt);
    if (z.blend < 0.002) { z.blend = 0; z.target = null; }
    camera.position.set(pos.current.x, EYE, pos.current.z);
    if (z.target) camera.position.lerp(tmpEye.fromArray(z.target.eye), z.blend);
    camera.rotation.set(pitch.current, yaw.current, 0);
    z.fov ??= camera.fov;
    const fov = THREE.MathUtils.lerp(z.fov, WORK_FOV, z.blend);
    if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }

    localPose.pos[0] = pos.current.x; localPose.pos[1] = 0; localPose.pos[2] = pos.current.z;
    localPose.yaw = yaw.current; localPose.pitch = pitch.current;
    localPose.guard = guard && !frozen;
    localPose.ready = !!s.you;

    // focus picking
    let best = null, bestScore = -Infinity;
    if (!frozen && !arena) {
      camera.getWorldDirection(fwdV);
      const obj = myObjective(s.state, s.you);
      const hfx = -Math.sin(yaw.current), hfz = -Math.cos(yaw.current);
      const needed = carryingNeeded(s.state, s.you);
      const consider = (it) => {
        // Carrying what the plan needs: only its destination can take it, so no other spot lights up.
        if (needed && it.kind === 'place' && !matchesObjective(obj, it)) return;
        const dx = it.pos[0] - camera.position.x, dy = it.pos[1] - camera.position.y, dz = it.pos[2] - camera.position.z;
        const required = matchesObjective(obj, it);
        let score;
        if (bodyMode) {
          // Full body: aim by body heading only, in a wide cone, with longer reach, strongly preferring the
          // thing the current step needs.
          const hd = Math.hypot(dx, dz);
          if (hd > BODY_REACH + it.r) return;
          const dot = (dx * hfx + dz * hfz) / Math.max(hd, 1e-3);
          if (dot < Math.cos(required ? 0.9 : 0.55)) return;
          score = dot * 2 - hd * 0.15 + (required ? 1.5 : 0);
        } else {
          const dist = Math.hypot(dx, dy, dz);
          if (dist > REACH + it.r) return;
          const dot = (dx * fwdV.x + dy * fwdV.y + dz * fwdV.z) / Math.max(dist, 1e-3);
          const need = Math.cos(Math.min(0.62, Math.atan2(it.r + 0.22, dist) + (required ? 0.10 : 0)));
          if (dot < need) return;
          score = dot * 2 - dist * 0.08 + (required ? 0.28 : 0);
        }
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
    assist.current = bodyMode && best ? best.pos : null;
  }, -3);

  return <TrackedHands boxing={Boolean(arena)} strike={strike} />;
}
