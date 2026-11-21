'use client';
import * as THREE from 'three';
import { useMemo } from 'react';
import { RoundedBox } from '@react-three/drei';

const UP = new THREE.Vector3(0, 1, 0);

// Every box gets a small bevel by default: bevels catch specular highlights and drive edge wear.
export function B({ s = [1, 1, 1], p = [0, 0, 0], r = [0, 0, 0], m, round, ...rest }) {
  if (round === undefined) round = Math.min(...s) >= 0.06 ? Math.min(0.025, Math.min(...s) * 0.12) : 0;
  if (round > 0) {
    return (
      <RoundedBox args={s} radius={Math.min(round, Math.min(...s) / 2 - 0.001)} smoothness={2} position={p} rotation={r} material={m} castShadow receiveShadow {...rest} />
    );
  }
  return (
    <mesh position={p} rotation={r} material={m} castShadow receiveShadow {...rest}>
      <boxGeometry args={s} />
    </mesh>
  );
}

export function C({ rt = 0.5, rb, h = 1, p = [0, 0, 0], r = [0, 0, 0], m, seg = 32, ...rest }) {
  return (
    <mesh position={p} rotation={r} material={m} castShadow receiveShadow {...rest}>
      <cylinderGeometry args={[rt, rb ?? rt, h, seg]} />
    </mesh>
  );
}

export function S({ rad = 0.5, p = [0, 0, 0], m, seg = 24, ...rest }) {
  return (
    <mesh position={p} material={m} castShadow receiveShadow {...rest}>
      <sphereGeometry args={[rad, seg, seg / 2]} />
    </mesh>
  );
}

export function T({ R = 0.5, tube = 0.05, p = [0, 0, 0], r = [0, 0, 0], m, arc = Math.PI * 2, ...rest }) {
  return (
    <mesh position={p} rotation={r} material={m} castShadow receiveShadow {...rest}>
      <torusGeometry args={[R, tube, 12, 40, arc]} />
    </mesh>
  );
}

// Cylinder between two points.
export function Beam({ a, b, rad = 0.08, m, seg = 8, square = false }) {
  const { pos, quat, len } = useMemo(() => {
    const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
    const dir = vb.clone().sub(va);
    const len = dir.length();
    const quat = new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize());
    return { pos: va.add(vb).multiplyScalar(0.5).toArray(), quat, len };
  }, [a, b]);
  return (
    <mesh position={pos} quaternion={quat} material={m} castShadow receiveShadow>
      {square ? <boxGeometry args={[rad * 2, len, rad * 2]} /> : <cylinderGeometry args={[rad, rad, len, seg]} />}
    </mesh>
  );
}

// Lathe from profile [[r,y],...]
export function Lathe({ pts, p = [0, 0, 0], r = [0, 0, 0], m, seg = 32 }) {
  const geo = useMemo(() => new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), seg), [pts, seg]);
  return <mesh geometry={geo} position={p} rotation={r} material={m} castShadow receiveShadow />;
}

// Tube along points
export function Tube({ pts, rad = 0.06, m, seg = 48 }) {
  const geo = useMemo(() => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((q) => new THREE.Vector3(...q))), seg, rad, 10, false), [pts, rad, seg]);
  return <mesh geometry={geo} material={m} castShadow receiveShadow />;
}

// Hazard stripes along X on a slab
export function Hazard({ w = 2, d = 0.3, p = [0, 0, 0], r = [0, 0, 0], y = 0.012, mA, mB, n = 8 }) {
  const step = w / n;
  return (
    <group position={p} rotation={r}>
      {Array.from({ length: n }, (_, i) => (
        <B key={i} s={[step, 0.02, d]} p={[-w / 2 + step * (i + 0.5), y, 0]} r={[0, 0, 0]} m={i % 2 ? mA : mB} />
      ))}
    </group>
  );
}

export function Bolts({ w, h, p = [0, 0, 0], r = [0, 0, 0], m, nx = 4, ny = 2 }) {
  const out = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    out.push(<C key={`${i}-${j}`} rt={0.018} h={0.025} r={[Math.PI / 2, 0, 0]} p={[-w / 2 + (w / (nx - 1 || 1)) * i, -h / 2 + (h / (ny - 1 || 1)) * j, 0]} m={m} seg={6} />);
  }
  return <group position={p} rotation={r}>{out}</group>;
}
