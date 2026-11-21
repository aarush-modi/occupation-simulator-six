'use client';
// TEMPORARY stub for frontend/src/scene/Shell.jsx (owned by another agent). Delete once the real module exists.
import { ROOM, SUPPLY_COUNTERS } from '../../shared/layout.js';
import { M } from '../../game/materials';

const { W, D, H } = ROOM;
export const shellColliders = [
  { minX: -W / 2 - 1, maxX: W / 2 + 1, minZ: -D / 2 - 1, maxZ: -D / 2 },
  { minX: -W / 2 - 1, maxX: W / 2 + 1, minZ: D / 2, maxZ: D / 2 + 1 },
  { minX: -W / 2 - 1, maxX: -W / 2, minZ: -D / 2, maxZ: D / 2 },
  { minX: W / 2, maxX: W / 2 + 1, minZ: -D / 2, maxZ: D / 2 },
  ...SUPPLY_COUNTERS.map((c) => ({ minX: c.pos[0] - c.size[0] / 2, maxX: c.pos[0] + c.size[0] / 2, minZ: c.pos[2] - c.size[2] / 2, maxZ: c.pos[2] + c.size[2] / 2 })),
];

export function ShellLighting() {
  return (
    <>
      <color attach="background" args={['#202020']} />
      <hemisphereLight args={['#fff4e0', '#3b3028', 0.9]} />
      <directionalLight position={[3, 8, 4]} intensity={1.6} castShadow shadow-mapSize={[2048, 2048]} shadow-camera-left={-9} shadow-camera-right={9} shadow-camera-top={9} shadow-camera-bottom={-9} />
      <pointLight position={[0, 3, 0]} intensity={8} distance={14} />
    </>
  );
}

export default function Shell() {
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} receiveShadow material={M.tileWhite}><planeGeometry args={[W, D]} /></mesh>
      <mesh position={[0, H, 0]} rotation-x={Math.PI / 2} material={M.plasticWhite}><planeGeometry args={[W, D]} /></mesh>
      <mesh position={[0, H / 2, -D / 2]} material={M.white}><planeGeometry args={[W, H]} /></mesh>
      <mesh position={[0, H / 2, D / 2]} rotation-y={Math.PI} material={M.white}><planeGeometry args={[W, H]} /></mesh>
      <mesh position={[-W / 2, H / 2, 0]} rotation-y={Math.PI / 2} material={M.white}><planeGeometry args={[D, H]} /></mesh>
      <mesh position={[W / 2, H / 2, 0]} rotation-y={-Math.PI / 2} material={M.white}><planeGeometry args={[D, H]} /></mesh>
      {SUPPLY_COUNTERS.map((c, i) => (
        <mesh key={i} position={[c.pos[0], c.size[1] / 2, c.pos[2]]} material={M.woodLight} castShadow receiveShadow>
          <boxGeometry args={[c.size[0], c.size[1] + 0.04, c.size[2]]} />
        </mesh>
      ))}
    </group>
  );
}
