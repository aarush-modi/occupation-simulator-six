'use client';
// Dev gallery of every catalog recipe: /dev/props?shell=cafe&id=espresso_machine&bounds=1&quality=lite
import * as THREE from 'three';
import { Suspense, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Html, Environment, Lightformer } from '@react-three/drei';
import Prop from '../Prop';
import { PostFX } from '../../game/Look';
import { CATALOG } from '../../shared/catalog/catalog.generated.js';
import { SHELL_IDS } from '../../shared/layout.js';

const KIND_COLOR = { station: '#f2b233', item: '#7fc4ff', furniture: '#b3e08a', decor: '#e9a0d0' };

function params() {
  if (typeof window === 'undefined') return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

function Bounds({ size }) {
  const geo = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(...size)), [size]);
  return (
    <lineSegments geometry={geo} position={[0, size[1] / 2, 0]}>
      <lineBasicMaterial color="#ff3b8d" />
    </lineSegments>
  );
}

function Markers({ recipe }) {
  return (
    <group>
      {recipe.slots.map((s) => (
        <mesh key={'s' + s.id} position={s.pos}>
          <ringGeometry args={[0.04, 0.055, 24]} />
          <meshBasicMaterial color="#29ff6a" side={THREE.DoubleSide} toneMapped={false} />
        </mesh>
      ))}
      {recipe.controls.map((c) => (
        <mesh key={'c' + c.id} position={c.pos}>
          <sphereGeometry args={[0.025, 12, 8]} />
          <meshBasicMaterial color="#ff2a1a" toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

function Cell({ recipe, pos, cell, debug }) {
  const [w, , d] = recipe.size;
  return (
    <group position={pos}>
      <mesh position={[0, 0.005, 0]} rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[cell - 0.15, cell - 0.15]} />
        <meshPhysicalMaterial color="#cdc8bf" roughness={0.8} polygonOffset polygonOffsetFactor={-1} />
      </mesh>
      <Prop recipe={recipe} />
      {debug && <Bounds size={recipe.size} />}
      {debug && <Markers recipe={recipe} />}
      <Html position={[0, 0.02, Math.max(d / 2 + 0.25, 0.45)]} center zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
        <div style={{ whiteSpace: 'nowrap', textAlign: 'center', font: '600 12px "Segoe UI",system-ui,sans-serif', color: '#1b1b1c', background: 'rgba(255,255,255,0.85)', padding: '3px 8px', borderRadius: 6, borderBottom: `3px solid ${KIND_COLOR[recipe.kind] ?? '#999'}` }}>
          {recipe.name}
          <div style={{ font: '500 10px ui-monospace,monospace', color: '#666' }}>{recipe.id} · {w.toFixed(2)}×{recipe.size[1].toFixed(2)}×{d.toFixed(2)}</div>
        </div>
      </Html>
    </group>
  );
}

function StudioLighting({ extent }) {
  return (
    <>
      <color attach="background" args={['#e6e2db']} />
      <hemisphereLight args={['#f4f1ea', '#6b5d50', 0.8]} />
      <directionalLight
        position={[-extent * 0.4, extent * 1.2 + 8, extent * 0.8 + 6]}
        intensity={2.6}
        color="#fff1df"
        castShadow
        shadow-mapSize={[4096, 4096]}
        shadow-bias={-0.0003}
        shadow-normalBias={0.02}
        shadow-camera-left={-extent}
        shadow-camera-right={extent}
        shadow-camera-top={extent}
        shadow-camera-bottom={-extent}
        shadow-camera-near={0.5}
        shadow-camera-far={extent * 4 + 40}
      />
      <directionalLight position={[extent, 6, -extent]} intensity={0.7} color="#cfe0ff" />
      <Environment resolution={256} frames={1} environmentIntensity={0.9}>
        <color attach="background" args={['#5a5652']} />
        <Lightformer form="rect" intensity={2.4} color="#fff3e2" position={[0, 6, 0]} rotation-x={Math.PI / 2} scale={[10, 10, 1]} />
        <Lightformer form="rect" intensity={1.6} color="#dfe9ff" position={[-6, 2, 4]} rotation-y={Math.PI / 3} scale={[6, 3, 1]} />
        <Lightformer form="rect" intensity={1.2} color="#ffd9b0" position={[6, 2, 4]} rotation-y={-Math.PI / 3} scale={[6, 3, 1]} />
      </Environment>
    </>
  );
}

export default function PropGallery() {
  const [q] = useState(params);
  const shell = q.get('shell');
  const only = q.get('id');
  const kind = q.get('kind');
  const debug = q.get('bounds') === '1' || q.get('debug') === '1';
  const quality = q.get('quality') ?? 'high';
  const list = CATALOG.filter((r) => (!shell || r.shells.includes(shell)) && (!only || only.split(',').includes(r.id)) && (!kind || r.kind === kind));
  const cell = Math.max(2.2, ...list.map((r) => Math.max(r.size[0], r.size[2]) + 0.8));
  const cols = Math.max(1, Math.ceil(Math.sqrt(list.length * 1.3)));
  const rows = Math.ceil(list.length / cols);
  const extent = Math.max(cols, rows) * cell * 0.6 + 2;
  const cells = list.map((r, i) => {
    const cx = (i % cols) - (cols - 1) / 2;
    const cz = Math.floor(i / cols) - (rows - 1) / 2;
    return { r, pos: [cx * cell, 0, cz * cell] };
  });
  const dist = Math.max(3.5, Math.max(cols, rows) * cell * 0.9);
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#111' }}>
      <Canvas shadows="soft" flat dpr={[1, 2]} camera={{ fov: 40, near: 0.05, far: 500, position: [0, dist * 0.65, dist] }} gl={{ antialias: false }}>
        <Suspense fallback={null}>
          <StudioLighting extent={extent} />
          <mesh rotation-x={-Math.PI / 2} receiveShadow>
            <planeGeometry args={[400, 400]} />
            <meshPhysicalMaterial color="#e2ddd5" roughness={0.9} />
          </mesh>
          {cells.map(({ r, pos }) => <Cell key={r.id} recipe={r} pos={pos} cell={cell} debug={debug} />)}
          <OrbitControls makeDefault target={[0, 0.6, 0]} maxPolarAngle={Math.PI * 0.49} />
          <PostFX quality={quality} />
        </Suspense>
      </Canvas>
      <div style={{ position: 'fixed', top: 12, left: 12, padding: '10px 14px', borderRadius: 10, background: 'rgba(17,17,17,0.82)', color: '#eee', font: '500 13px "Segoe UI",system-ui,sans-serif', maxWidth: 560 }}>
        <div style={{ fontWeight: 800, letterSpacing: 2, color: '#f2b233', fontSize: 11 }}>PROP GALLERY</div>
        <div style={{ marginTop: 4 }}>{list.length} of {CATALOG.length} recipes{shell ? ` in ${shell}` : ''}{kind ? ` (${kind})` : ''}</div>
        <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {[null, ...SHELL_IDS].map((s) => (
            <a key={s ?? 'all'} href={s ? `?shell=${s}${debug ? '&bounds=1' : ''}` : `?${debug ? 'bounds=1' : ''}`} style={{ color: s === shell ? '#111' : '#ddd', background: s === shell ? '#f2b233' : 'rgba(255,255,255,0.1)', padding: '2px 8px', borderRadius: 6, textDecoration: 'none' }}>{s ?? 'all'}</a>
          ))}
        </div>
      </div>
    </div>
  );
}
