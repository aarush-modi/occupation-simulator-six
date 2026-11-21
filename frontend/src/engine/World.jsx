'use client';
// The generated workplace: shell + stations/decor at anchors, items at rest or carried, routed NPCs, remote
// players as interpolated avatars, closed-station dressing, and markers for the current objective and focus.
import * as THREE from 'three';
import { memo, useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useLabel } from './Labels';
import { useShift } from './store';
import { localPose, samplePlayer, sampleNpc } from './net';
import { getIndex } from './actions';
import { restFrame, objectiveMarker, toWorld, RECIPES } from './world';
import { handGrips } from './handGrips';
import { Prop, placeAt, Shell } from './scene';
import { Humanoid } from '../game/People';
import { M } from '../game/materials';
import { B } from '../game/parts';
import { arenaPoints } from '../shared/gameRules';

const std = (color, rough = 0.85) => new THREE.MeshStandardMaterial({ color, roughness: rough });
const LOCAL_M = {
  apron: std('#3a2a22', 0.8),
  denim: std('#2f3f5c', 0.9),
  suit: std('#23293a', 0.6),
  shirt: std('#d9d4ca', 0.9),
  sweater: std('#7a4a3a', 0.95),
  shoes: std('#1a1a1a', 0.6),
};
const HAIR = ['#1d1510', '#3b2616', '#6b4a2b', '#b08850', '#2a2a2a', '#7a3020'].map((c) => std(c, 0.7));
const SKIN = ['#e0b49a', '#c08a68', '#a07458', '#7a5238', '#5a3a28'].map((c) => std(c, 0.7));
const PLAYER_COLORS = ['#2e64b8', '#c8302a', '#3c9a4e', '#8a4fc0'];

const hash = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };

function outfitProps(outfit, seed) {
  const hair = HAIR[seed % HAIR.length], skin = SKIN[(seed >> 3) % SKIN.length];
  const common = { hair, skin, hands: skin, hat: null, vest: false };
  switch (outfit) {
    case 'scrubs': return { ...common, outfit: M.scrubs, pants: M.scrubs };
    case 'labCoat': return { ...common, outfit: M.labCoat, pants: LOCAL_M.denim };
    case 'apron': return { ...common, outfit: LOCAL_M.shirt, pants: LOCAL_M.denim, extra: 'apron' };
    case 'coverall': return { ...common, outfit: M.coverallBlue, hands: M.glove };
    case 'suit': return { ...common, outfit: LOCAL_M.suit, extra: 'tie' };
    case 'hivis': return { ...common, outfit: M.fabricGrey, pants: LOCAL_M.denim, vest: true, hat: M.hatYellow, hands: M.glove };
    default: return { ...common, outfit: LOCAL_M.sweater, pants: LOCAL_M.denim };
  }
}

function Outfit({ look }) {
  if (look.extra === 'apron') return <mesh position={[0, 1.08, 0.125]} material={LOCAL_M.apron}><boxGeometry args={[0.36, 0.62, 0.02]} /></mesh>;
  if (look.extra === 'tie') return <mesh position={[0, 1.5, 0.125]} material={M.fabricRed}><boxGeometry args={[0.05, 0.3, 0.015]} /></mesh>;
  return null;
}

function Npc({ npc }) {
  const g = useRef();
  const seed = hash(npc.id);
  const motion = useRef({ speed: 0, talk: false, work: false, seed: (seed % 700) / 100 });
  const workPoint = useMemo(() => new THREE.Vector3(), []);
  const look = useMemo(() => outfitProps(npc.outfit, seed), [npc.outfit, seed]);
  const station = getIndex()?.stations[npc.station];
  const contact = useMemo(() => {
    if (!station) return null;
    const { frame, recipe } = station;
    const feature = npc.action === 'inspect' ? recipe.controls?.[0]?.pos : recipe.slots?.[0]?.pos ?? recipe.controls?.[0]?.pos;
    const [x, y, z] = feature ?? [0, recipe.size[1] * 0.85, 0];
    return toWorld(frame, [x, THREE.MathUtils.clamp(y, 0.88, 1.52), Math.max(z, recipe.size[2] * 0.5 - 0.06)]);
  }, [station, npc.action]);
  useLabel(`npc:${npc.id}`, {
    pos: () => g.current ? [g.current.position.x, 2.05, g.current.position.z] : null,
    title: npc.side ? `${npc.name} · ${npc.side === 'ally' ? 'Ally' : 'Rival'}` : npc.name,
    sub: npc.activity || npc.role,
    color: npc.side === 'ally' ? '#85bfff' : npc.side === 'rival' || npc.mode === 'sparring' ? '#ff9e91' : undefined,
  });
  useFrame((_, dt) => {
    if (!g.current) return;
    const state = sampleNpc(npc.id) ?? npc;
    g.current.position.set(...state.pos);
    const diff = state.yaw - g.current.rotation.y;
    g.current.rotation.y += Math.atan2(Math.sin(diff), Math.cos(diff)) * Math.min(1, dt * 12);
    motion.current.speed = THREE.MathUtils.damp(motion.current.speed, state.speed, 10, dt);
    motion.current.work = state.mode === 'work' ? state.action : null;
    motion.current.workPoint = null;
    if (motion.current.work && contact && state.station === npc.station) {
      workPoint.fromArray(contact);
      motion.current.workPoint = g.current.worldToLocal(workPoint);
    }
    motion.current.sparring = state.mode === 'sparring' ? state.action : null;
    motion.current.talk = state.mode === 'talk' || useShift.getState().subtitle?.who === npc.name;
  }, -3);
  return (
    <group ref={g}>
      <Humanoid {...look} motion={motion} boxing={npc.mode === 'sparring' ? M.coverallRed : null} />
      <Outfit look={look} />
    </group>
  );
}

function RemotePlayer({ id, index }) {
  const g = useRef(), body = useRef();
  const left = useRef(), right = useRef();
  const motion = useRef({ speed: 0, carry: false });
  const last = useRef(null);
  const name = useShift((s) => s.state?.players?.[id]?.name ?? 'Player');
  const boxing = useShift((s) => s.state?.game?.kind === 'sparring');
  useEffect(() => {
    const anchors = { left: left.current, right: right.current };
    handGrips.set(id, anchors);
    return () => { if (handGrips.get(id) === anchors) handGrips.delete(id); };
  }, [id]);
  useLabel(`player:${id}`, { pos: () => { const p = samplePlayer(id); return p ? [p.pos[0], 2.16, p.pos[2]] : null; }, title: name, sub: 'Teammate', color: PLAYER_COLORS[index % PLAYER_COLORS.length] });
  const look = useMemo(() => {
    const seed = hash(id);
    return { ...outfitProps('casual', seed), outfit: std(PLAYER_COLORS[index % PLAYER_COLORS.length], 0.85) };
  }, [id, index]);
  useFrame((_, dt) => {
    const p = samplePlayer(id);
    if (!p || !g.current) return;
    g.current.position.set(p.pos[0], 0, p.pos[2]);
    body.current.rotation.y = p.yaw + Math.PI;
    const prev = last.current;
    const sp = prev && dt > 0 ? Math.hypot(p.pos[0] - prev[0], p.pos[2] - prev[2]) / dt : 0;
    motion.current.speed = THREE.MathUtils.damp(motion.current.speed, Math.min(sp / 2.2, 1.6), 8, dt);
    motion.current.carry = !!p.held;
    motion.current.carrySide = p.holdHand;
    const game = useShift.getState().state?.game;
    motion.current.sparring = boxing ? (p.guard ? 'cover' : game.clock - (p.strikeAt ?? -Infinity) < 230 ? 'strike' : 'ready') : null;
    last.current = p.pos;
  }, -3);
  return (
    <group ref={g}>
      <group ref={body}>
        <Humanoid {...look} motion={motion} grips={{ left, right }} boxing={boxing ? M.fabricBlue : null} />
      </group>
    </group>
  );
}

// Item: eases toward wherever the authoritative state says it is (rest spot or a teammate's hands).
function Item({ id }) {
  const g = useRef();
  const plated = useShift((s) => s.state?.items?.[id]?.tags?.includes('plated') ?? false);
  const idx = getIndex();
  const recipe = idx?.items[id]?.recipe;
  const init = useMemo(() => restFrame(idx, useShift.getState().state?.items?.[id]?.at) ?? { pos: [0, -10, 0], rotY: 0 }, [idx, id]);
  const move = useMemo(() => ({ key: null, elapsed: 0, from: new THREE.Vector3(), target: new THREE.Vector3(), pickupDelay: 0 }), []);
  useFrame((_, dt) => {
    const s = useShift.getState();
    const it = s.state?.items?.[id];
    if (!g.current || !it) return;
    const { target, from } = move;
    const key = it.holder ? `hand:${it.holder}` : it.at;
    let rotY;
    if (it.holder) {
      const player = s.state.players[it.holder];
      if (!player) { g.current.visible = false; return; }
      const pose = it.holder === s.you && localPose.ready ? localPose : samplePlayer(it.holder) ?? player;
      const side = player.holdHand ?? 'right';
      const grip = handGrips.get(it.holder)?.[side];
      rotY = pose.yaw;
      const sin = Math.sin(rotY), cos = Math.cos(rotY);
      if (grip) grip.getWorldPosition(target);
      else target.set(pose.pos[0] - sin * 0.43, 1.22, pose.pos[2] - cos * 0.43);
      const forward = Math.min(0.17, recipe.size[2] * 0.42 + 0.016);
      const inward = side === 'right' ? -0.040 : 0.040;
      target.x += -sin * forward + cos * inward;
      target.y -= recipe.size[1] * 0.46;
      target.z += -cos * forward - sin * inward;
    } else {
      const f = restFrame(idx, it.at);
      if (!f) { g.current.visible = false; return; }
      target.fromArray(f.pos);
      rotY = f.rotY;
    }
    const model = g.current;
    if (!model.visible || move.key === null || model.position.distanceToSquared(target) > 16) {
      model.position.copy(target);
      move.elapsed = 1;
    } else if (move.key !== key) {
      from.copy(model.position);
      move.elapsed = 0;
      move.pickupDelay = it.holder && !move.key.startsWith('hand:') ? 0.06 : 0;
    }
    model.visible = true;
    move.key = key;
    move.elapsed += Math.min(dt, 0.05);
    const duration = it.holder ? 0.30 : 0.24;
    const travel = move.elapsed - move.pickupDelay;
    if (travel < duration) {
      const progress = Math.max(0, travel) / duration;
      model.position.lerpVectors(from, target, THREE.MathUtils.smoothstep(progress, 0, 1));
      if (it.holder) model.position.y += Math.sin(progress * Math.PI) * 0.055;
    } else {
      model.position.lerp(target, 1 - Math.exp(-26 * dt));
    }
    const delta = rotY - model.rotation.y;
    model.rotation.y += Math.atan2(Math.sin(delta), Math.cos(delta)) * (1 - Math.exp(-18 * dt));
  });
  if (!recipe) return null;
  return <group ref={g} position={init.pos} rotation-y={init.rotY}><Prop recipe={recipe} plated={plated} /></group>;
}

const TAPE_R = new THREE.MeshStandardMaterial({ color: '#d4241a', roughness: 0.5, emissive: '#3a0500' });
const TAPE_W = new THREE.MeshStandardMaterial({ color: '#f0ece4', roughness: 0.5 });
const DIM = new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0.38, depthWrite: false });

// Closed station: X of hazard tape across the front, a blinking warning light, dimmed with a dark shroud.
function ClosedDressing({ st }) {
  const light = useRef(), lamp = useRef();
  const [w, h, d] = st.recipe.size;
  useFrame((state) => {
    const on = Math.sin(state.clock.elapsedTime * 7) > 0;
    if (light.current) light.current.intensity = on ? 6 : 0.4;
    if (lamp.current) lamp.current.material = on ? M.red_glow : M.rubber;
  });
  useLabel(`closed:${st.id}`, { pos: () => [st.frame.pos[0], h + 0.5, st.frame.pos[2]], title: 'CLOSED', variant: 'closed' });
  const len = Math.hypot(w, h * 0.9);
  const ang = Math.atan2(h * 0.9, w);
  const n = 14;
  return (
    <group position={st.frame.pos} rotation-y={st.frame.rotY}>
      <mesh position={[0, h / 2 + 0.01, 0]} material={DIM} renderOrder={2}><boxGeometry args={[w + 0.06, h + 0.04, d + 0.06]} /></mesh>
      {[ang, -ang].map((a, k) => (
        <group key={k} position={[0, h * 0.5, d / 2 + 0.05 + k * 0.01]} rotation-z={a}>
          {Array.from({ length: n }, (_, i) => (
            <mesh key={i} position={[-len / 2 + (len / n) * (i + 0.5), 0, 0]} material={i % 2 ? TAPE_W : TAPE_R}><boxGeometry args={[len / n, 0.09, 0.006]} /></mesh>
          ))}
        </group>
      ))}
      <group position={[w / 2 - 0.12, h + 0.02, 0]}>
        <mesh material={M.darkSteel} position={[0, 0.03, 0]}><cylinderGeometry args={[0.07, 0.08, 0.06, 20]} /></mesh>
        <mesh ref={lamp} material={M.red_glow} position={[0, 0.12, 0]}><sphereGeometry args={[0.07, 20, 12]} /></mesh>
        <pointLight ref={light} color="#ff2a1a" distance={4} intensity={5} position={[0, 0.25, 0.1]} />
      </group>
    </group>
  );
}

function StationLabel({ st, closed }) {
  useLabel(`station:${st.id}`, closed ? null : { pos: () => [st.frame.pos[0], Math.max(st.recipe.size[1], 1.2) + 0.3, st.frame.pos[2]], title: st.label, color: '#8fd3ff', variant: 'sign' });
  return null;
}

// Floating chevron above the current objective's target, and a soft ring on the thing under the crosshair.
function Markers() {
  const chev = useRef(), ring = useRef(), focusRing = useRef();
  useFrame((state, dt) => {
    const s = useShift.getState();
    const idx = getIndex();
    const t = state.clock.elapsedTime;
    const p = idx && s.state ? objectiveMarker(idx, s.state, s.you, (id) => {
      const holder = s.state.items[id]?.holder;
      const sp = holder ? samplePlayer(holder) : null;
      return sp ? [sp.pos[0], 1.5, sp.pos[2]] : null;
    }) : null;
    if (chev.current) {
      chev.current.visible = !!p;
      if (p) {
        chev.current.position.set(p[0], p[1] + 0.42 + Math.sin(t * 3) * 0.06, p[2]);
        chev.current.rotation.y += dt * 1.6;
        ring.current.position.set(p[0], p[1] + 0.02, p[2]);
        ring.current.scale.setScalar(1 + (Math.sin(t * 3) * 0.5 + 0.5) * 0.25);
      }
      ring.current.visible = !!p;
    }
    const f = s.focus;
    if (focusRing.current) {
      focusRing.current.visible = !!f;
      if (f) {
        focusRing.current.position.set(...f.pos);
        focusRing.current.lookAt(state.camera.position);
        focusRing.current.scale.setScalar(Math.max(0.18, f.r * 0.7));
      }
    }
  });
  return (
    <>
      <group ref={chev}>
        <mesh rotation-x={Math.PI} material={M.amber_glow}><coneGeometry args={[0.09, 0.2, 4]} /></mesh>
        <mesh position={[0, 0.17, 0]} material={M.amber_glow}><boxGeometry args={[0.05, 0.12, 0.05]} /></mesh>
      </group>
      <mesh ref={ring} rotation-x={-Math.PI / 2} material={M.amber_glow}><torusGeometry args={[0.16, 0.008, 8, 40]} /></mesh>
      <mesh ref={focusRing}><torusGeometry args={[1, 0.035, 8, 48]} /><meshBasicMaterial color="#ffffff" transparent opacity={0.55} depthTest={false} toneMapped={false} /></mesh>
    </>
  );
}

const MATS = { blue: '#254c86', red: '#8c3943', charcoal: '#343944', sand: '#8e725c' };
const ROPES = [M.coverallRed, M.chrome, M.fabricBlue];

function SparringArena({ arena }) {
  const { shape, points } = useMemo(() => {
    const points = arenaPoints(arena);
    const shape = new THREE.Shape(points.map(([x, , z]) => new THREE.Vector2(x, -z)));
    return { shape, points };
  }, [arena]);
  return (
    <group>
      <mesh position-y={0.025} rotation-x={-Math.PI / 2} receiveShadow>
        <shapeGeometry args={[shape]} />
        <meshStandardMaterial color={MATS[arena.mat]} roughness={0.91} />
      </mesh>
      <mesh position-y={0.03} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[0.98, 1.035, 32]} />
        <meshBasicMaterial color="#e8deca" />
      </mesh>
      {points.map(([x, , z], i) => {
        const [nx, , nz] = points[(i + 1) % points.length];
        const length = Math.hypot(nx - x, nz - z);
        const yaw = -Math.atan2(nz - z, nx - x);
        const mx = (x + nx) / 2, mz = (z + nz) / 2;
        return (
          <group key={i}>
            <B s={[0.23, 1.4, 0.23]} p={[x, 0.7, z]} m={i % 2 ? M.coverallRed : M.fabricBlue} round={0.04} />
            <B s={[length, 0.13, 0.13]} p={[mx, 0.035, mz]} r={[0, yaw, 0]} m={M.black} />
            {ROPES.map((material, j) =>
              <B key={j} s={[length, 0.037, 0.037]} p={[mx, 0.44 + j * 0.29, mz]} r={[0, yaw, 0]} m={material} />)}
          </group>
        );
      })}
      {[-1, 1].map((side) => <B key={side} s={[0.5, 0.28, 2.0]} p={[side * (arena.radius + 1), .29, 0]} m={M.black} round={0.05} />)}
    </group>
  );
}

const Static = memo(function Static({ bp }) {
  const idx = getIndex();
  return (
    <>
      <Shell id={bp.shell} venue={bp.venue} arena={bp.game?.kind === 'sparring'} />
      {bp.game?.kind === 'sparring' && <SparringArena arena={bp.game.arena} />}
      {Object.values(idx.stations).map((st) => {
        const { position, rotationY } = placeAt(st.anchor);
        return <Prop key={st.id} recipe={st.recipe} position={position} rotation-y={rotationY} />;
      })}
      {(bp.decor ?? []).map((d, i) => {
        const recipe = RECIPES[d.prop];
        if (!recipe) return null;
        const { position, rotationY } = placeAt(d.anchor);
        return <Prop key={`decor${i}`} recipe={recipe} position={position} rotation-y={rotationY} />;
      })}
    </>
  );
});

export default function World() {
  const bp = useShift((s) => s.blueprint);
  const people = useShift(s => s.state?.people);
  const closedKey = useShift((s) => s.state?.closed?.join(',') ?? '');
  const others = useShift((s) => (s.state ? Object.keys(s.state.players).filter((id) => id !== s.you).sort().join(',') : ''));
  const idx = getIndex();
  if (!bp || !idx) return null;
  const closed = new Set(closedKey ? closedKey.split(',') : []);
  const ids = others ? others.split(',') : [];
  return (
    <group>
      <Static bp={bp} />
      {Object.values(people ?? {}).map(npc => <Npc key={npc.id} npc={npc} />)}
      {Object.values(idx.stations).map((st) => (
        <group key={st.id}>
          <StationLabel st={st} closed={closed.has(st.id)} />
          {closed.has(st.id) && <ClosedDressing st={st} />}
        </group>
      ))}
      {bp.items.map((it) => <Item key={it.id} id={it.id} />)}
      {ids.map((id, i) => <RemotePlayer key={id} id={id} index={i + 1} />)}
      {bp.game?.kind !== 'sparring' && <Markers />}
    </group>
  );
}
