'use client';
// The generated workplace: shell + stations/decor at anchors, items at rest or carried, NPCs at spots, remote
// players as interpolated avatars, closed-station dressing, and markers for the current objective and focus.
import * as THREE from 'three';
import { memo, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useLabel } from './Labels';
import { useShift } from './store';
import { samplePlayer } from './net';
import { getIndex } from './actions';
import { restFrame, objectiveMarker, recipeOf, RECIPES } from './world';
import { Prop, placeAt, Shell } from './scene';
import { Humanoid } from '../game/People';
import { M } from '../game/materials';

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
  const motion = useRef({ speed: 0, talk: false });
  const look = useMemo(() => outfitProps(npc.outfit, hash(npc.id)), [npc]);
  const { position, rotationY } = useMemo(() => placeAt(npc.anchor), [npc.anchor]);
  useLabel(`npc:${npc.id}`, { pos: () => [position[0], 2.12, position[2]], title: npc.name, sub: npc.role });
  useFrame((state, dt) => {
    if (!g.current) return;
    const c = state.camera.position;
    const dx = c.x - position[0], dz = c.z - position[2];
    const target = Math.hypot(dx, dz) < 5 ? Math.atan2(dx, dz) : rotationY;
    let d = target - g.current.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    g.current.rotation.y += d * Math.min(1, dt * 3);
    motion.current.talk = useShift.getState().subtitle?.who === npc.name;
  });
  return (
    <group position={position}>
      <group ref={g} rotation-y={rotationY}>
        <Humanoid {...look} motion={motion} />
        <Outfit look={look} />
      </group>
    </group>
  );
}

function RemotePlayer({ id, index }) {
  const g = useRef(), body = useRef();
  const motion = useRef({ speed: 0, carry: false });
  const last = useRef(null);
  const name = useShift((s) => s.state?.players?.[id]?.name ?? 'Player');
  const heldProp = useShift((s) => {
    const h = s.state?.players?.[id]?.held;
    return h ? s.blueprint?.items?.find((i) => i.id === h)?.prop ?? null : null;
  });
  const plated = useShift((s) => {
    const held = s.state?.players?.[id]?.held;
    return s.state?.items?.[held]?.tags?.includes('plated') ?? false;
  });
  const recipe = heldProp ? recipeOf(heldProp, 'item') : null;
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
    motion.current.carry = !!recipe;
    last.current = p.pos;
  });
  const fit = recipe ? Math.min(1, 0.45 / Math.max(...recipe.size)) : 1;
  return (
    <group ref={g}>
      <group ref={body}>
        <Humanoid {...look} motion={motion} />
        {recipe && <group position={[0, 1.0, 0.42]} scale={fit}><Prop recipe={recipe} plated={plated} /></group>}
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
  useFrame((_, dt) => {
    const s = useShift.getState();
    const it = s.state?.items?.[id];
    if (!g.current || !it) return;
    let target = null, rotY = 0;
    if (it.holder) {
      // local holder: shown in first-person hands; remote holder: drawn by the avatar
      g.current.visible = false;
      return;
    }
    const f = restFrame(idx, it.at);
    if (f) { target = f.pos; rotY = f.rotY; }
    if (!target) { g.current.visible = false; return; }
    const p = g.current.position;
    const far = Math.hypot(p.x - target[0], p.y - target[1], p.z - target[2]) > 4 || !g.current.visible;
    g.current.visible = true;
    if (far) p.set(...target);
    else {
      p.x = THREE.MathUtils.damp(p.x, target[0], 12, dt);
      p.y = THREE.MathUtils.damp(p.y, target[1], 12, dt);
      p.z = THREE.MathUtils.damp(p.z, target[2], 12, dt);
    }
    g.current.rotation.y = rotY;
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

const Static = memo(function Static({ bp }) {
  const idx = getIndex();
  return (
    <>
      <Shell id={bp.shell} venue={bp.venue} />
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
      {bp.npcs.map((n) => <Npc key={n.id} npc={n} />)}
    </>
  );
});

export default function World() {
  const bp = useShift((s) => s.blueprint);
  const closedKey = useShift((s) => s.state?.closed?.join(',') ?? '');
  const others = useShift((s) => (s.state ? Object.keys(s.state.players).filter((id) => id !== s.you).sort().join(',') : ''));
  const idx = getIndex();
  if (!bp || !idx) return null;
  const closed = new Set(closedKey ? closedKey.split(',') : []);
  const ids = others ? others.split(',') : [];
  return (
    <group>
      <Static bp={bp} />
      {Object.values(idx.stations).map((st) => (
        <group key={st.id}>
          <StationLabel st={st} closed={closed.has(st.id)} />
          {closed.has(st.id) && <ClosedDressing st={st} />}
        </group>
      ))}
      {bp.items.map((it) => <Item key={it.id} id={it.id} />)}
      {ids.map((id, i) => <RemotePlayer key={id} id={id} index={i + 1} />)}
      <Markers />
    </group>
  );
}
