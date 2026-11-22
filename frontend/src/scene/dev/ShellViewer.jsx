'use client';
// Dev viewer for a room shell with catalog props on every anchor kind:
// /dev/shells?id=cafe            orbit camera inside the room
// /dev/shells?id=cafe&view=player  first-person framing from SPAWN
// /dev/shells?id=cafe&cut=1      ceiling and front wall removed, overview from above
// /dev/shells?id=cafe&colliders=1  draw shell + prop colliders
import { Suspense, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import Shell, { ShellLighting, shellColliders } from '../Shell';
import Prop, { placeAt, recipeColliders } from '../Prop';
import { PostFX } from '../../game/Look';
import { M } from '../../game/materials';
import { B, C, S } from '../../game/parts';
import { CATALOG } from '../../shared/catalog/catalog.generated.js';
import { ANCHORS, SHELL_IDS, anchorIds } from '../../shared/layout.js';

function params() {
  if (typeof window === 'undefined') return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

// Simple stand-in for an NPC so spots are visible.
function Mannequin({ position, rotationY }) {
  return (
    <group position={position} rotation-y={rotationY}>
      <C rt={0.13} rb={0.11} h={0.85} p={[0, 0.43, 0]} m={M.fabricBlue} seg={20} />
      <B s={[0.42, 0.6, 0.24]} p={[0, 1.18, 0]} m={M.scrubs} round={0.09} />
      <S rad={0.12} p={[0, 1.65, 0]} m={M.skin} />
      <B s={[0.16, 0.03, 0.02]} p={[0, 1.67, 0.11]} m={M.black} round={0.008} />
    </group>
  );
}

function pickFor(shell) {
  const inShell = (r) => r.shells.includes(shell);
  const big = CATALOG.filter((r) => r.kind !== 'item');
  const items = CATALOG.filter((r) => r.kind === 'item');
  const pref = (list) => {
    const a = list.filter(inShell);
    return a.length ? a : list;
  };
  return { big: pref(big), items: pref(items) };
}

function Colliders({ boxes }) {
  return boxes.map((b, i) => (
    <mesh key={i} position={[(b.minX + b.maxX) / 2, 0.02, (b.minZ + b.maxZ) / 2]}>
      <boxGeometry args={[b.maxX - b.minX, 0.04, b.maxZ - b.minZ]} />
      <meshBasicMaterial color="#ff3b8d" transparent opacity={0.45} depthWrite={false} toneMapped={false} />
    </mesh>
  ));
}

export default function ShellViewer() {
  const [q] = useState(params);
  const id = SHELL_IDS.includes(q.get('id')) ? q.get('id') : 'cafe';
  const view = q.get('view');
  const cut = q.get('cut') === '1';
  const showColl = q.get('colliders') === '1';
  const empty = q.get('empty') === '1';
  const quality = q.get('quality') ?? 'high';

  const placed = useMemo(() => {
    if (empty) return [];
    const { big, items } = pickFor(id);
    const out = [];
    const bigAnchors = [...anchorIds('wall'), ...anchorIds('island')];
    bigAnchors.forEach((a, i) => { if (big.length) out.push({ a, r: big[i % big.length] }); });
    anchorIds('surface').forEach((a, i) => { if (items.length) out.push({ a, r: items[i % items.length] }); });
    return out;
  }, [id, empty]);

  const vec = (k) => (q.get(k) ? q.get(k).split(',').map(Number) : null);
  const camera = vec('cam') ? { position: vec('cam'), fov: 70 } : view === 'player'
    ? { position: [ANCHORS.SPAWN.pos[0], 1.65, ANCHORS.SPAWN.pos[2]], fov: 72 }
    : cut ? { position: [0, 13, 12], fov: 45 } : { position: [0.4, 1.9, 4.9], fov: 70 };
  const target = vec('look') ?? (view === 'player' ? [0, 1.45, 0] : cut ? [0, 0, 0] : [0, 1.2, -1]);

  const boxes = useMemo(() => (showColl ? [...shellColliders, ...placed.map(({ a, r }) => recipeColliders(r, a))] : []), [showColl, placed]);

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000' }}>
      <Canvas shadows="soft" flat dpr={[1, 2]} camera={{ ...camera, near: 0.05, far: 200 }} gl={{ antialias: false, powerPreference: 'high-performance' }}>
        <Suspense fallback={null}>
          <ShellLighting id={id} />
          <Shell id={id} cutaway={cut} />
          {placed.map(({ a, r }) => {
            const { position, rotationY } = placeAt(a);
            return <Prop key={a} recipe={r} position={position} rotation-y={rotationY} />;
          })}
          {anchorIds('spot').map((a) => {
            const { position, rotationY } = placeAt(a);
            return <Mannequin key={a} position={position} rotationY={rotationY} />;
          })}
          {showColl && <Colliders boxes={boxes} />}
          <OrbitControls makeDefault target={target} />
          <PostFX quality={quality} />
        </Suspense>
      </Canvas>
      <div style={{ position: 'fixed', top: 12, left: 12, padding: '10px 14px', borderRadius: 10, background: 'rgba(17,17,17,0.8)', color: '#eee', font: '500 13px "Segoe UI",system-ui,sans-serif' }}>
        <div style={{ fontWeight: 800, letterSpacing: 2, color: '#f2b233', fontSize: 11 }}>SHELL · {id.toUpperCase()}</div>
        <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6, maxWidth: 520 }}>
          {SHELL_IDS.map((s) => (
            <a key={s} href={`?id=${s}${view ? `&view=${view}` : ''}${cut ? '&cut=1' : ''}`} style={{ color: s === id ? '#111' : '#ddd', background: s === id ? '#f2b233' : 'rgba(255,255,255,0.1)', padding: '2px 8px', borderRadius: 6, textDecoration: 'none' }}>{s}</a>
          ))}
        </div>
      </div>
    </div>
  );
}
