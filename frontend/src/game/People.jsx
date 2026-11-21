'use client';
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { M } from './materials';
import { B, C, S } from './parts';
import { Hardhat } from './Rig';
import { A, registerInteractable } from './world';
import { useGame } from './store';
import { talkRhodes } from './flow';
import { solveElbow } from './handPose';

const DOWN = new THREE.Vector3(0, -1, 0);
const limb = () => ({
  shoulder: new THREE.Vector3(), wrist: new THREE.Vector3(), target: new THREE.Vector3(),
  elbow: new THREE.Vector3(), bend: new THREE.Vector3(),
  axis: new THREE.Vector3(), pole: new THREE.Vector3(), direction: new THREE.Vector3(),
});

// The shoulder and elbow follow a fixed-length arm. Work motions can supply a target
// in body space, so the same animation reaches the equipment in different venues.
export function Humanoid({ outfit = M.coverallOrange, hat = M.hatYellow, motion, vest = true, hair = null, hands = M.glove, pants = null, skin = M.skin, boxing = null, grips }) {
  const thighs = useRef([]), knees = useRef([]), shoulders = useRef([]), forearms = useRef([]), wrists = useRef([]);
  const torso = useRef(), head = useRef(), eyes = useRef(), mouth = useRef();
  const pose = useMemo(() => ({ arms: [limb(), limb()], torsoInv: new THREE.Matrix4(), stride: 0, seed: null, speed: 0 }), []);
  useFrame(({ clock }, delta) => {
    const dt = Math.min(delta, 0.05);
    const m = motion?.current ?? {};
    const damp = (a, b, rate = 11) => THREE.MathUtils.damp(a, b, rate, dt);
    if (pose.seed == null) pose.seed = m.seed ?? (torso.current.id % 13) * 0.64;
    const t = clock.elapsedTime + pose.seed;
    const sp = pose.speed = damp(pose.speed, m.speed ?? 0, 7);
    pose.stride += dt * (3.3 + sp * 3.2);
    const swing = Math.min(sp, 1.5) * 0.47;
    const step = Math.sin(pose.stride);
    for (let i = 0; i < 2; i++) {
      const legStep = i === 0 ? step : -step;
      thighs.current[i].rotation.x = -legStep * swing;
      knees.current[i].rotation.x = Math.max(0, -legStep) * swing * 1.50 + swing * 0.09;
    }
    const twist = m.work ? -0.12 : step * swing * 0.23;
    torso.current.position.set(step * swing * 0.06, 1.00 + Math.abs(step) * swing * 0.035 + Math.sin(t * 1.6) * 0.006, 0);
    torso.current.rotation.x = damp(torso.current.rotation.x, m.work ? 0.10 : sp * 0.065);
    torso.current.rotation.y = damp(torso.current.rotation.y, twist);
    torso.current.rotation.z = damp(torso.current.rotation.z, -step * swing * 0.12);
    torso.current.updateMatrix();
    pose.torsoInv.copy(torso.current.matrix).invert();

    for (let i = 0; i < 2; i++) {
      const sign = i ? 1 : -1;
      const { shoulder, wrist, target, elbow, bend, axis, pole, direction } = pose.arms[i];
      shoulder.set(sign * 0.215, 0.52, 0);
      bend.set(sign * 0.74, -1, -0.15);
      target.set(sign * (0.24 + Math.sin(t * 1.8 + i) * 0.012), -0.055 + swing * 0.12, sign * step * swing * 0.47);
      if (m.sparring) {
        const covering = m.sparring === 'cover';
        target.set(sign * (covering ? 0.14 : 0.27), covering ? 0.60 : 0.42, covering ? 0.29 : 0.30);
        if (i === 1 && m.sparring === 'windup') target.set(0.30, 0.40, -0.15);
        if (i === 1 && m.sparring === 'strike') target.set(0.11, 0.55, 0.56);
      } else if (m.carry && (m.carrySide ?? 'right') === (i ? 'left' : 'right')) {
        target.set(sign * 0.17, 0.18, 0.38);
      } else if (m.work) {
        // A work cycle alternates effort and recovery. Each hand has different timing.
        const beat = t * (m.work === 'stock' ? 3.8 : m.work === 'inspect' ? 2.7 : 5.2) + i * 0.84;
        const effort = Math.pow(0.5 + 0.5 * Math.sin(beat), 2);
        if (m.workPoint) {
          target.copy(m.workPoint).applyMatrix4(pose.torsoInv);
          target.x += sign * (i ? 0.015 : 0.14) + 0.025 * Math.sin(beat * 0.5);
          target.y += (1 - effort) * 0.078 + (m.work === 'stock' ? 0.08 * effort : 0.014);
          target.z -= (1 - effort) * (i ? 0.18 : 0.25);
        } else {
          target.set(sign * 0.21, 0.17 + effort * 0.12, 0.26 + effort * 0.18);
        }
      } else if (m.talk && i === 1) {
        const gesture = Math.pow(0.5 + 0.5 * Math.sin(t * 3.1), 3);
        target.set(0.24 + 0.065 * gesture, 0.16 + 0.18 * gesture, 0.18 + 0.16 * gesture);
      } else if (m.point && i === 1) target.set(0.18, 0.47, 0.56);
      if (wrist.lengthSq() === 0) wrist.copy(target);
      wrist.lerp(target, 1 - Math.exp(-(m.sparring === 'strike' ? 24 : 11) * dt));
      solveElbow(shoulder, wrist, elbow, bend, 0.30, 0.29, axis, pole);
      shoulders.current[i].quaternion.setFromUnitVectors(DOWN, direction.copy(elbow).sub(shoulder).normalize());
      forearms.current[i].position.copy(elbow);
      forearms.current[i].quaternion.setFromUnitVectors(DOWN, direction.copy(wrist).sub(elbow).normalize());
      wrists.current[i].position.copy(wrist);
      wrists.current[i].rotation.x = damp(wrists.current[i].rotation.x, m.sparring ? -0.18 : m.work || m.carry ? 0.16 : 0.72);
      wrists.current[i].rotation.z = -sign * 0.08;
    }
    head.current.rotation.x = damp(head.current.rotation.x, m.work ? 0.21 : m.talk ? Math.sin(t * 3.2) * 0.05 : 0.01);
    head.current.rotation.y = damp(head.current.rotation.y, m.talk ? Math.sin(t * 1.15) * 0.09 : -torso.current.rotation.y * 0.50);
    const blink = Math.max(0, 1 - Math.abs(t % 4.6 - 3.9) * 19);
    eyes.current.scale.y = 1 - blink * 0.90;
    mouth.current.scale.y = m.talk ? 0.45 + Math.abs(Math.sin(t * 11.8)) * 1.3 : 0.45;
  }, -2);
  return (
    <group>
      {[-0.104, 0.104].map((x, i) => (
        <group key={i} ref={node => { thighs.current[i] = node; }} position={[x, 0.874, 0]}>
          <C rt={0.084} rb={0.066} h={0.404} p={[0, -0.20, 0]} m={pants ?? outfit} seg={12} />
          <group ref={node => { knees.current[i] = node; }} position={[0, -0.413, 0]}>
            <S rad={0.067} m={pants ?? outfit} seg={12} />
            <C rt={0.066} rb={0.047} h={0.397} p={[0, -0.193, 0]} m={pants ?? outfit} seg={12} />
            <B s={[0.131, 0.09, 0.242]} p={[0, -0.419, 0.045]} m={M.black} round={0.028} />
            <B s={[0.138, 0.022, 0.248]} p={[0, -0.445, 0.046]} m={M.rubber} round={0.009} />
          </group>
        </group>
      ))}
      <group ref={torso} position={[0, 1.00, 0]}>
        <B s={[0.338, 0.54, 0.223]} p={[0, 0.245, 0]} m={outfit} round={0.083} />
        <S rad={0.19} p={[0, 0.43, 0]} scale={[1.12, 0.43, 0.61]} m={outfit} seg={16} />
        <B s={[0.309, 0.145, 0.223]} p={[0, -0.048, 0]} m={pants ?? outfit} round={0.046} />
        {vest && <B s={[0.371, 0.39, 0.245]} p={[0, 0.29, 0]} m={M.hivis} round={0.065} />}
        {vest && <B s={[0.384, 0.041, 0.246]} p={[0, 0.205, 0]} m={M.chrome} />}
        {['right', 'left'].map((side, i) => (
          <group key={side}>
            <group ref={node => { shoulders.current[i] = node; }} position={[i ? 0.215 : -0.215, 0.52, 0]}>
              <S rad={0.06} m={outfit} seg={12} />
              <C rt={0.062} rb={0.047} h={0.299} p={[0, -0.15, 0]} m={outfit} seg={12} />
            </group>
            <group ref={node => { forearms.current[i] = node; }}>
              <S rad={0.048} m={outfit} seg={12} />
              <C rt={0.049} rb={0.034} h={0.288} p={[0, -0.145, 0]} m={outfit} seg={12} />
            </group>
            <group ref={node => { wrists.current[i] = node; }}>
              <group ref={grips?.[side]} position={[0, 0, 0.048]} />
              <B s={boxing ? [0.125, 0.12, 0.16] : [0.064, 0.044, 0.096]} p={[0, 0, 0.033]} m={boxing ?? hands} round={boxing ? 0.05 : 0.02} />
              {!boxing && <S rad={0.016} p={[(i ? -1 : 1) * 0.033, -0.008, 0.040]} scale={[0.7, 0.83, 1.55]} m={hands} seg={10} />}
            </group>
          </group>
        ))}
        <group ref={head} position={[0, 0.641, 0]}>
          <C rt={0.048} rb={0.055} h={0.13} p={[0, -0.06, 0]} m={skin} seg={12} />
          <S rad={0.115} p={[0, 0.067, 0.006]} m={skin} seg={20} scale={[0.89, 1.1, 0.92]} />
          {[-1, 1].map(side => <S key={side} rad={0.024} p={[side * 0.097, 0.067, 0]} m={skin} seg={12} scale={[0.59, 1.13, 0.71]} />)}
          <S rad={0.021} p={[0, 0.059, 0.104]} m={skin} seg={12} scale={[0.76, 1.06, 1.19]} />
          <group ref={eyes} position-y={0.093}>
            {[-1, 1].map(side => (
              <group key={side} position={[side * 0.037, 0, 0.102]}>
                <S rad={0.013} m={M.labCoat} seg={10} scale={[1.05, 0.57, 0.44]} />
                <S rad={0.0068} p={[0, 0, 0.006]} m={M.black} seg={8} scale={[1, 0.88, 0.51]} />
              </group>
            ))}
          </group>
          <group ref={mouth} position={[0, 0.025, 0.103]}><S rad={0.015} m={M.fabricRed} seg={12} scale={[1.32, 0.41, 0.33]} /></group>
          {hat && <Hardhat p={[0, 0.136, 0.007]} m={hat} s={0.92} />}
          {!hat && hair && <S rad={0.107} p={[0, 0.115, -0.014]} m={hair} seg={18} scale={[1.01, 0.76, 1.03]} />}
        </group>
      </group>
    </group>
  );
}

function useNpcTalk(id, pos, label, use) {
  useEffect(() => registerInteractable({ id, pos, r: 0.8, label, use, gesture: ['wave'] }), []); // eslint-disable-line react-hooks/exhaustive-deps
}

// NPC that walks between waypoints or holds position, always faces where it goes / the player.
function Npc({ start, path, speed = 1.2, outfit, hat, face, talkWhen, id, label, use, override }) {
  const g = useRef();
  const motion = useRef({ speed: 0 });
  const st = useRef({ i: 0, pos: new THREE.Vector3(...start), wait: 0 });
  const live = useRef({ pos: [...start, 0] });
  useNpcTalk(id, live.current.pos, label, use);
  useFrame((state, dt) => {
    const s = st.current;
    const route = override?.() ?? path;
    let target = null;
    if (route && route.length) target = new THREE.Vector3(...route[s.i % route.length]);
    let moving = false;
    if (target) {
      const d = target.clone().sub(s.pos); d.y = 0;
      if (d.length() > 0.15) {
        if (s.wait > 0) { s.wait -= dt; }
        else {
          const sp = override?.() ? speed * 2.2 : speed;
          s.pos.add(d.normalize().multiplyScalar(Math.min(sp * dt, d.length())));
          moving = true;
          g.current.rotation.y = THREE.MathUtils.damp(g.current.rotation.y, Math.atan2(d.x, d.z), 8, dt);
          motion.current.speed = override?.() ? 1.6 : 1;
        }
      } else if (route.length > 1) { s.i++; s.wait = 2 + Math.random() * 2; }
    }
    if (!moving) {
      motion.current.speed = THREE.MathUtils.damp(motion.current.speed, 0, 6, dt);
      const cam = state.camera.position;
      const look = face ?? [cam.x, cam.z];
      const dist = Math.hypot(cam.x - s.pos.x, cam.z - s.pos.z);
      const yaw = dist < 6 ? Math.atan2(cam.x - s.pos.x, cam.z - s.pos.z) : Math.atan2(look[0] - s.pos.x, look[1] - s.pos.z);
      g.current.rotation.y = THREE.MathUtils.damp(g.current.rotation.y, yaw, 4, dt);
    }
    motion.current.talk = talkWhen?.() ?? false;
    g.current.position.copy(s.pos);
    live.current.pos[0] = s.pos.x; live.current.pos[1] = 1.4; live.current.pos[2] = s.pos.z;
  });
  return (
    <group ref={g}>
      <Humanoid outfit={outfit} hat={hat} motion={motion} />
    </group>
  );
}

const speaking = (who) => () => useGame.getState().subtitle?.who === who;

export default function People() {
  return (
    <group>
      <Npc id="rhodes" start={A.rhodes} outfit={M.coverallBlue} hat={M.hatWhite} talkWhen={speaking('Rhodes')}
        label={() => 'Talk to Rhodes (Toolpusher)'} use={talkRhodes} />
      <Npc id="okafor" start={A.okafor} outfit={M.coverallRed} hat={M.hatWhite} face={[0, 6]} talkWhen={speaking('Okafor')}
        label={() => 'Talk to Okafor (Driller)'} use={() => useGame.getState().say('Okafor', useGame.getState().alarm ? 'NOT NOW! BOP panel!' : 'Keep that floor clean and your hands clear of the rotary.', 3200)} />
      <Npc id="dez" start={[4, 0, 4]} path={[[4, 0, 4], [6.5, 0, 4.5], [1.5, 0, 1.8], [-1, 0, 4.5]]} outfit={M.coverallOrange} hat={M.hatYellow}
        talkWhen={speaking('Dez')} label={() => 'Talk to Dez (Floorhand)'}
        override={() => (useGame.getState().alarm ? [[4.8, 0, -8.4]] : null)}
        use={() => useGame.getState().say('Dez', 'Two weeks on, two weeks off. You get used to the noise. Mostly.', 3500)} />
      <group position={[A.rotary[0], 20.06, A.rotary[2] + 2.0]}>
        <Npc id="mia" start={[0, 0, 0]} outfit={M.coverallOrange} hat={M.hatYellow} face={[0, 10]} label={() => null} use={() => {}} />
      </group>
    </group>
  );
}
