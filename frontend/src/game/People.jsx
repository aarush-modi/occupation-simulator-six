'use client';
import * as THREE from 'three';
import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { M } from './materials';
import { B, C, S } from './parts';
import { Hardhat } from './Rig';
import { A, registerInteractable } from './world';
import { useGame } from './store';
import { talkRhodes } from './flow';

// Procedural humanoid. motion.current = { speed, talk, point }
// hat: material or null (no hard hat). hair: material for a hair cap when there is no hat. hands: glove/skin material.
// pants: leg material (defaults to the outfit). Arms read motion.current.carry (both forearms forward).
export function Humanoid({ outfit = M.coverallOrange, hat = M.hatYellow, motion, vest = true, hair = null, hands = M.glove, pants = null, skin = M.skin, boxing = null }) {
  const lLeg = useRef(), rLeg = useRef(), lArm = useRef(), rArm = useRef(), torso = useRef(), head = useRef();
  useFrame((st) => {
    const t = st.clock.elapsedTime;
    const m = motion?.current ?? {};
    const sp = m.speed ?? 0;
    const ph = t * (4 + sp * 2.5);
    const sw = Math.min(sp, 1.5) * 0.55;
    if (lLeg.current) lLeg.current.rotation.x = Math.sin(ph) * sw;
    if (rLeg.current) rLeg.current.rotation.x = -Math.sin(ph) * sw;
    const reach = m.work === 'stock' ? -1.1 : m.work === 'inspect' ? -0.62 : -0.91;
    const handMotion = m.work === 'prepare' ? 0.25 : m.work === 'inspect' ? 0.1 : 0.17;
    if (lArm.current) lArm.current.rotation.x = m.carry ? -1.1 : m.work ? reach + Math.sin(t * 4.6) * handMotion : -Math.sin(ph) * sw * 0.8 + (m.talk ? Math.sin(t * 3) * 0.15 - 0.3 : 0);
    if (rArm.current) rArm.current.rotation.x = m.carry ? -1.1 : m.work ? reach - 0.15 + Math.sin(t * 4.6 + Math.PI) * handMotion : m.point ? -1.5 : Math.sin(ph) * sw * 0.8 + (m.talk ? Math.sin(t * 2.3 + 1) * 0.2 - 0.4 : 0);
    if (m.sparring && lArm.current && rArm.current) {
      lArm.current.rotation.x = m.sparring === 'cover' ? -1.92 : -1.06 + Math.sin(t * 5) * 0.08;
      rArm.current.rotation.x = m.sparring === 'strike' ? -1.68 : m.sparring === 'windup' ? 0.39 : m.sparring === 'cover' ? -1.92 : -0.89;
      lArm.current.rotation.z = -0.24;
      rArm.current.rotation.z = 0.24;
    }
    if (torso.current) torso.current.position.y = 1.02 + Math.sin(t * 1.6) * 0.008 + Math.abs(Math.sin(ph)) * sw * 0.04;
    if (head.current) head.current.rotation.y = m.talk ? Math.sin(t * 1.3) * 0.15 : 0;
  });
  return (
    <group>
      {[[-0.11, lLeg], [0.11, rLeg]].map(([x, ref], i) => (
        <group key={i} ref={ref} position={[x, 0.92, 0]}>
          <C rt={0.08} rb={0.07} h={0.82} p={[0, -0.42, 0]} m={pants ?? outfit} seg={12} />
          <B s={[0.13, 0.11, 0.28]} p={[0, -0.86, 0.04]} m={M.black} round={0.03} />
        </group>
      ))}
      <group ref={torso} position={[0, 1.02, 0]}>
        <B s={[0.4, 0.62, 0.24]} p={[0, 0.3, 0]} m={outfit} round={0.09} />
        {vest && <B s={[0.42, 0.42, 0.26]} p={[0, 0.36, 0]} m={M.hivis} round={0.08} />}
        {vest && <B s={[0.43, 0.04, 0.27]} p={[0, 0.28, 0]} m={M.chrome} />}
        {[[-0.25, lArm], [0.25, rArm]].map(([x, ref], i) => (
          <group key={i} ref={ref} position={[x, 0.56, 0]}>
            <C rt={0.065} rb={0.055} h={0.62} p={[0, -0.31, 0]} m={outfit} seg={12} />
            <B s={boxing ? [0.15, 0.18, 0.16] : [0.09, 0.12, 0.08]} p={[0, -0.66, 0]} m={boxing ?? hands} round={boxing ? 0.057 : 0.03} />
          </group>
        ))}
        <group ref={head} position={[0, 0.72, 0]}>
          <C rt={0.05} h={0.1} p={[0, -0.05, 0]} m={skin} seg={10} />
          <S rad={0.12} p={[0, 0.08, 0]} m={skin} seg={20} />
          <B s={[0.16, 0.04, 0.02]} p={[0, 0.1, 0.11]} m={M.black} round={0.01} />
          {hat && <Hardhat p={[0, 0.13, 0]} m={hat} s={0.95} />}
          {!hat && hair && <S rad={0.127} p={[0, 0.1, -0.012]} m={hair} seg={20} scale={[1, 0.92, 1.02]} />}
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
