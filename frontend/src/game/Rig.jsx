'use client';
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { M } from './materials';
import { B, C, S, T, Beam, Lathe, Tube, Hazard, Bolts } from './parts';
import { A, registerInteractable } from './world';
import { useGame, live } from './store';
import * as F from './flow';

function useInteract(def, deps = []) {
  useEffect(() => registerInteractable(def), deps); // eslint-disable-line react-hooks/exhaustive-deps
}
const step = () => useGame.getState().step;

/* ---------- Deck, substructure, railings ---------- */
function Deck() {
  const posts = [];
  const rails = [];
  const W = 15, D = 12;
  for (let x = -W; x <= W; x += 2) { posts.push([x, -D]); posts.push([x, D]); }
  for (let z = -D + 2; z < D; z += 2) { posts.push([-W, z]); posts.push([W, z]); }
  const edges = [[[-W, -D], [W, -D]], [[-W, D], [W, D]], [[-W, -D], [-W, D]], [[W, -D], [W, D]]];
  return (
    <group>
      <B s={[30.6, 0.5, 24.6]} p={[0, -0.25, 0]} m={M.deck} />
      {/* grating panels */}
      {[[-8, 3], [6, -6], [5, 3], [-6, 8]].map(([x, z], i) => (
        <group key={i} position={[x, 0.005, z]}>
          <B s={[6, 0.02, 4]} p={[0, 0, 0]} m={M.darkSteel} />
          {Array.from({ length: 30 }, (_, k) => <B key={k} s={[0.03, 0.035, 4]} p={[-2.9 + k * 0.2, 0.02, 0]} m={M.grating} />)}
        </group>
      ))}
      {/* deck plate seams */}
      {Array.from({ length: 7 }, (_, i) => <B key={i} s={[30.4, 0.012, 0.04]} p={[0, 0.006, -12 + i * 4]} m={M.black} />)}
      {/* kick plate */}
      {edges.map(([a, b], i) => {
        const cx = (a[0] + b[0]) / 2, cz = (a[1] + b[1]) / 2;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const rotY = a[0] === b[0] ? Math.PI / 2 : 0;
        return (
          <group key={i} position={[cx, 0, cz]} rotation={[0, rotY, 0]}>
            <B s={[len, 0.15, 0.05]} p={[0, 0.075, 0]} m={M.yellow} />
            <B s={[len, 0.06, 0.06]} p={[0, 0.55, 0]} m={M.yellow} />
            <B s={[len, 0.07, 0.07]} p={[0, 1.08, 0]} m={M.yellow} round={0.02} />
          </group>
        );
      })}
      {posts.map(([x, z], i) => <C key={i} rt={0.03} h={1.1} p={[x, 0.55, z]} m={M.yellow} seg={8} />)}
      {/* hazard ring around rotary */}
      <Hazard w={5} d={0.25} p={[0, 0, -4.6]} mA={M.yellow} mB={M.black} n={14} />
      <Hazard w={5} d={0.25} p={[0, 0, 0.6]} mA={M.yellow} mB={M.black} n={14} />
      {/* substructure legs to sea */}
      {[[-13, -10], [13, -10], [-13, 10], [13, 10]].map(([x, z], i) => (
        <group key={i}>
          <C rt={1.6} h={60} p={[x, -30.5, z]} m={M.yellow} seg={32} />
          <C rt={1.75} h={2} p={[x, -40, z]} m={M.rust} seg={32} />
        </group>
      ))}
      {[[-13, -10, 13, -10], [-13, 10, 13, 10], [-13, -10, -13, 10], [13, -10, 13, 10]].map(([x1, z1, x2, z2], i) => (
        <group key={i}>
          <Beam a={[x1, -6, z1]} b={[x2, -6, z2]} rad={0.45} m={M.yellow} />
          <Beam a={[x1, -22, z1]} b={[x2, -22, z2]} rad={0.5} m={M.yellow} />
          <Beam a={[x1, -6, z1]} b={[x2, -22, z2]} rad={0.35} m={M.yellow} />
          <Beam a={[x2, -6, z2]} b={[x1, -22, z1]} rad={0.35} m={M.yellow} />
        </group>
      ))}
      {/* cellar deck */}
      <B s={[30, 0.6, 24]} p={[0, -7, 0]} m={M.darkSteel} />
      {Array.from({ length: 8 }, (_, i) => <B key={i} s={[30, 0.9, 0.35]} p={[0, -1.0, -10.5 + i * 3]} m={M.darkSteel} />)}
    </group>
  );
}

/* ---------- Derrick ---------- */
function Derrick() {
  const [cx, , cz] = A.rotary;
  const H = 34, b0 = 3.2, b1 = 1.0;
  const half = (y) => b0 + (b1 - b0) * (y / H);
  const legs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const parts = [];
  legs.forEach(([sx, sz], i) => parts.push(<Beam key={`l${i}`} a={[cx + sx * b0, 0, cz + sz * b0]} b={[cx + sx * b1, H, cz + sz * b1]} rad={0.16} m={M.white} square />));
  for (let y = 2; y < H; y += 3) {
    const h0 = half(y), h1 = half(Math.min(H, y + 3));
    for (let k = 0; k < 4; k++) {
      const [ax, az] = legs[k], [bx, bz] = legs[(k + 1) % 4];
      parts.push(<Beam key={`g${y}-${k}`} a={[cx + ax * h0, y, cz + az * h0]} b={[cx + bx * h0, y, cz + bz * h0]} rad={0.06} m={M.white} />);
      if (y + 3 < H) parts.push(<Beam key={`x${y}-${k}`} a={[cx + ax * h0, y, cz + az * h0]} b={[cx + bx * h1, y + 3, cz + bz * h1]} rad={0.045} m={M.white} />);
    }
  }
  const block = useRef();
  useFrame((st) => { if (block.current) block.current.position.y = 15 + Math.sin(st.clock.elapsedTime * 0.25) * 0.4; });
  return (
    <group>
      {parts}
      {/* crown */}
      <B s={[2.8, 1.2, 2.8]} p={[cx, H + 0.6, cz]} m={M.white} />
      <C rt={0.7} h={0.4} p={[cx, H + 1.4, cz]} r={[0, 0, Math.PI / 2]} m={M.steel} />
      {/* monkeyboard */}
      <B s={[3.6, 0.12, 1.4]} p={[cx, 20, cz + half(20) + 0.6]} m={M.grating} />
      <B s={[3.6, 0.9, 0.05]} p={[cx, 20.5, cz + half(20) + 1.3]} m={M.yellow} />
      {/* travelling block + lines */}
      <group ref={block} position={[cx, 15, cz]}>
        <B s={[1.1, 1.8, 0.8]} m={M.yellow} round={0.12} />
        <C rt={0.12} h={1.2} p={[0, -1.4, 0]} m={M.steel} />
        <T R={0.32} tube={0.08} p={[0, -2.2, 0]} m={M.steel} />
      </group>
      {[-0.35, 0, 0.35].map((dx, i) => <Beam key={i} a={[cx + dx, 16, cz]} b={[cx + dx * 0.5, H, cz]} rad={0.02} m={M.black} />)}
      {/* strobes on derrick */}
      <Strobe p={[cx + b1 + 0.1, H - 1, cz + b1 + 0.1]} />
      <Strobe p={[cx - half(12) - 0.1, 12, cz + half(12) + 0.1]} />
      {/* windwalls lower */}
      <B s={[0.05, 3, 4.5]} p={[cx - b0 - 0.05, 2.8, cz]} m={M.white} />
    </group>
  );
}

function Strobe({ p }) {
  const ref = useRef();
  const light = useRef();
  useFrame((st) => {
    const on = useGame.getState().alarm;
    const t = st.clock.elapsedTime;
    if (ref.current) { ref.current.visible = true; ref.current.material = on && Math.sin(t * 9) > 0 ? M.red_glow : M.red; ref.current.rotation.y = t * 6; }
    if (light.current) light.current.intensity = on ? (Math.sin(t * 9) > 0 ? 60 : 0) : 0;
  });
  return (
    <group position={p}>
      <mesh ref={ref} material={M.red}><cylinderGeometry args={[0.18, 0.18, 0.3, 16]} /></mesh>
      <pointLight ref={light} color="#ff2a1a" distance={22} intensity={0} decay={1.6} />
    </group>
  );
}

/* ---------- Rotary, drawworks, mousehole, roughneck ---------- */
function DrillFloor() {
  const [cx, , cz] = A.rotary;
  const placed = useGame((s) => s.pipeInHole);
  useInteract({ id: 'mousehole', pos: [A.mousehole[0], 0.6, A.mousehole[2]], r: 0.9,
    label: () => (step() === 'pipePlace' && useGame.getState().held === 'pipe' ? 'Stab pipe in the mousehole' : null), use: F.useMousehole, gesture: ['pushDown'] });
  useInteract({ id: 'stand', pos: [A.controlStand[0], 1.2, A.controlStand[2]], r: 0.7,
    label: () => (step() === 'torque' ? 'Operate iron roughneck' : null), use: F.useControlStand, gesture: ['fist'] });
  return (
    <group>
      {/* rotary table */}
      <C rt={1.1} h={0.35} p={[cx, 0.17, cz]} m={M.darkSteel} seg={40} />
      <C rt={0.85} h={0.08} p={[cx, 0.38, cz]} m={M.steel} seg={40} />
      <B s={[0.7, 0.12, 0.7]} p={[cx, 0.45, cz]} m={M.black} />
      <C rt={0.13} h={1.6} p={[cx, 1.2, cz]} m={M.pipe} />
      <C rt={0.17} h={0.35} p={[cx, 1.9, cz]} m={M.pipe} />
      {/* mousehole */}
      <C rt={0.3} h={0.1} p={[A.mousehole[0], 0.05, A.mousehole[2]]} m={M.black} />
      <T R={0.28} tube={0.05} p={[A.mousehole[0], 0.1, A.mousehole[2]]} r={[Math.PI / 2, 0, 0]} m={M.yellow} />
      {placed && (
        <group position={[A.mousehole[0], 0, A.mousehole[2]]}>
          <C rt={0.12} h={7} p={[0, 3.3, 0]} m={M.pipe} />
          <C rt={0.16} h={0.4} p={[0, 6.8, 0]} m={M.pipe} />
          <C rt={0.16} h={0.35} p={[0, 0.4, 0]} m={M.pipe} />
        </group>
      )}
      {/* iron roughneck */}
      <group position={[cx - 2.2, 0, cz + 1.6]}>
        <B s={[0.6, 0.15, 2.6]} p={[0, 0.07, 0]} m={M.darkSteel} />
        <B s={[1.1, 1.5, 0.9]} p={[0, 1.0, 0.3]} m={M.orange} round={0.08} />
        <B s={[0.9, 0.35, 0.6]} p={[0.6, 1.3, 0.3]} m={M.steel} round={0.05} />
        <C rt={0.2} h={0.4} p={[0.95, 1.3, 0.3]} r={[0, 0, Math.PI / 2]} m={M.black} />
        <Bolts w={0.8} h={0.9} p={[0, 1.05, 0.76]} m={M.chrome} nx={4} ny={3} />
      </group>
      {/* control stand */}
      <group position={A.controlStand}>
        <C rt={0.12} h={1.0} p={[0, 0.5, 0]} m={M.darkSteel} />
        <B s={[0.8, 0.5, 0.35]} p={[0, 1.15, 0]} r={[-0.5, 0, 0]} m={M.orange} round={0.04} />
        <C rt={0.1} h={0.03} p={[-0.18, 1.3, 0.12]} r={[1.07, 0, 0]} m={M.gaugeFace} />
        <TorqueNeedle p={[-0.18, 1.31, 0.135]} />
        {[0.05, 0.2].map((x, i) => (
          <group key={i} position={[x, 1.25, 0.1]}>
            <C rt={0.015} h={0.22} p={[0, 0.11, 0]} m={M.chrome} />
            <S rad={0.035} p={[0, 0.23, 0]} m={M.red} />
          </group>
        ))}
        <B s={[0.1, 0.05, 0.03]} p={[0.28, 1.08, 0.2]} r={[-0.5, 0, 0]} m={M.green_glow} />
      </group>
      {/* drawworks */}
      <group position={[-4.6, 0, -2]}>
        <B s={[2.0, 1.6, 3.0]} p={[0, 0.8, 0]} m={M.red} round={0.1} />
        <C rt={0.55} h={2.2} p={[0.5, 1.4, 0]} r={[Math.PI / 2, 0, 0]} m={M.darkSteel} />
        {Array.from({ length: 10 }, (_, i) => <T key={i} R={0.56} tube={0.025} p={[0.5, 1.4, -0.9 + i * 0.2]} m={M.steel} />)}
        <B s={[0.9, 1.1, 1.0]} p={[-0.6, 0.55, -1.0]} m={M.blue} round={0.05} />
      </group>
    </group>
  );
}

function TorqueNeedle({ p }) {
  const ref = useRef();
  useFrame(() => { if (ref.current) ref.current.rotation.z = Math.PI * 0.75 - live.torque * Math.PI * 1.5; });
  return (
    <group position={p} rotation={[1.07 - Math.PI / 2, 0, 0]}>
      <group ref={ref}><B s={[0.008, 0.08, 0.004]} p={[0, 0.035, 0.006]} m={M.red} /></group>
    </group>
  );
}

/* ---------- Gauge with live needle ---------- */
function Gauge({ p, r = [0, 0, 0], size = 0.22, value }) {
  const needle = useRef();
  useFrame((st) => {
    const v = value() + Math.sin(st.clock.elapsedTime * 13) * 0.006;
    if (needle.current) needle.current.rotation.z = Math.PI * 0.75 - THREE.MathUtils.clamp(v, 0, 1) * Math.PI * 1.5;
  });
  return (
    <group position={p} rotation={r}>
      <C rt={size} h={0.06} r={[Math.PI / 2, 0, 0]} m={M.chrome} seg={32} />
      <C rt={size * 0.9} h={0.065} r={[Math.PI / 2, 0, 0]} m={M.gaugeFace} seg={32} />
      {/* red zone arc */}
      <T R={size * 0.75} tube={size * 0.06} p={[0, 0, 0.035]} r={[0, 0, -Math.PI * 0.75]} arc={Math.PI * 0.4} m={M.red} />
      <T R={size * 0.75} tube={size * 0.06} p={[0, 0, 0.035]} r={[0, 0, -Math.PI * 0.12]} arc={Math.PI * 0.25} m={M.green_glow} />
      <group ref={needle} position={[0, 0, 0.04]}>
        <B s={[size * 0.06, size * 0.8, 0.01]} p={[0, size * 0.35, 0]} m={M.black} />
      </group>
      <S rad={size * 0.08} p={[0, 0, 0.045]} m={M.black} />
    </group>
  );
}

/* ---------- Mud pumps ---------- */
function MudPump({ p, label, primary }) {
  const closed = useGame((s) => s.pump1Closed);
  const off = primary && closed;
  const rod = useRef();
  useFrame((st) => { if (rod.current) rod.current.position.x = off ? 0 : Math.sin(st.clock.elapsedTime * 5) * 0.12; });
  if (primary) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useInteract({ id: 'pump1', pos: [p[0] - 1.2, 1.6, p[2]], r: 0.8, label: () => (step() === 'gauge' ? 'Read pressure gauge' : null), use: F.usePump1, gesture: ['one'] });
  }
  return (
    <group position={p}>
      <B s={[3.4, 0.2, 1.8]} p={[0, 0.1, 0]} m={M.darkSteel} />
      <B s={[1.6, 1.3, 1.5]} p={[0.8, 0.85, 0]} m={primary ? M.red : M.blue} round={0.1} />
      <B s={[1.2, 1.0, 1.2]} p={[-0.7, 0.7, 0]} m={M.steel} round={0.06} />
      {[-0.4, 0, 0.4].map((z, i) => <C key={i} rt={0.16} h={1.0} p={[-1.4, 0.7, z]} r={[0, 0, Math.PI / 2]} m={M.chrome} />)}
      <group ref={rod}><C rt={0.07} h={0.8} p={[0.1, 0.9, 0]} r={[0, 0, Math.PI / 2]} m={M.chrome} /></group>
      <Tube pts={[[-1.9, 0.7, 0], [-2.3, 0.7, 0], [-2.3, 0.3, -0.6], [-2.3, 0.2, -1.6]]} rad={0.1} m={M.pipe} />
      {/* gauge on standpipe */}
      <C rt={0.04} h={0.9} p={[-1.2, 1.2, 0.5]} m={M.pipe} />
      <Gauge p={[-1.2, 1.7, 0.56]} r={[0, -Math.PI / 2, 0]} size={0.2} value={() => (primary ? (off ? 0.02 : live.pressure) : useGame.getState().alarm ? 0.85 : 0.4)} />
      {/* status lamp */}
      <S rad={0.08} p={[0.8, 1.6, 0.5]} m={off ? M.red_glow : M.green_glow} />
      <B s={[0.6, 0.18, 0.02]} p={[0.8, 1.15, 0.76]} m={M.white} />
      {label}
    </group>
  );
}

/* ---------- Choke manifold ---------- */
function Choke() {
  const wheel = useRef();
  useFrame(() => { if (wheel.current) wheel.current.rotation.z = live.pressure * 8; });
  useInteract({ id: 'choke', pos: [A.choke[0] + 0.8, 1.2, A.choke[2] + 0.5], r: 0.8,
    label: () => (['choke', 'kickChoke'].includes(step()) ? 'Turn choke handwheel' : null), use: F.useChoke, gesture: ['fist'] });
  return (
    <group position={A.choke}>
      <B s={[4.2, 0.15, 1.0]} p={[0, 0.07, 0]} m={M.darkSteel} />
      <C rt={0.14} h={4.0} p={[0, 0.8, 0]} r={[0, 0, Math.PI / 2]} m={M.pipe} />
      {[-1.4, -0.4, 0.8].map((x, i) => (
        <group key={i} position={[x, 0.8, 0]}>
          <B s={[0.4, 0.45, 0.4]} m={M.red} round={0.04} />
          <C rt={0.04} h={0.6} p={[0, 0.45, 0]} m={M.steel} />
          {i === 2 ? (
            <group ref={wheel} position={[0, 0.78, 0]} rotation={[Math.PI / 2, 0, 0]}>
              <T R={0.3} tube={0.035} m={M.yellow} />
              {[0, 1, 2, 3].map((k) => <B key={k} s={[0.03, 0.6, 0.03]} r={[0, 0, (k * Math.PI) / 4]} m={M.yellow} />)}
            </group>
          ) : (
            <group position={[0, 0.78, 0]} rotation={[Math.PI / 2, 0, 0]}>
              <T R={0.2} tube={0.025} m={M.yellow} />
              <B s={[0.02, 0.4, 0.02]} m={M.yellow} />
            </group>
          )}
        </group>
      ))}
      {[-1.9, 1.9].map((x, i) => <C key={i} rt={0.06} h={0.8} p={[x, 0.4, 0]} m={M.darkSteel} />)}
      <C rt={0.04} h={0.7} p={[1.6, 1.15, 0.2]} m={M.pipe} />
      <Gauge p={[1.6, 1.55, 0.26]} size={0.22} value={() => live.pressure} />
      <Tube pts={[[-2.1, 0.8, 0], [-2.6, 0.8, 0], [-2.8, 0.3, 0.8], [-3.0, 0.2, 2.5]]} rad={0.12} m={M.pipe} />
    </group>
  );
}

/* ---------- BOP control panel ---------- */
function BopPanel() {
  const guardOpen = useGame((s) => s.guardOpen);
  const alarm = useGame((s) => s.alarm);
  const guard = useRef();
  useFrame((_, dt) => {
    if (guard.current) guard.current.rotation.x = THREE.MathUtils.damp(guard.current.rotation.x, guardOpen ? -1.9 : 0, 6, dt);
  });
  useInteract({ id: 'bopGuard', pos: [A.bop[0], 1.25, A.bop[2] + 0.4], r: 0.6, label: () => (step() === 'kickGuard' ? 'Lift the guard' : null), use: F.useBopGuard, gesture: ['swipeUp'] });
  useInteract({ id: 'bopButton', pos: [A.bop[0], 1.2, A.bop[2] + 0.45], r: 0.5, label: () => (step() === 'kickButton' ? 'Close the annular preventer' : null), use: F.useBopButton, gesture: ['palmPush'] });
  return (
    <group position={A.bop}>
      <B s={[1.6, 1.8, 0.6]} p={[0, 0.9, 0]} m={M.red} round={0.05} />
      <B s={[1.45, 0.9, 0.04]} p={[0, 1.25, 0.31]} m={M.darkSteel} />
      {[-0.5, -0.25, 0.25, 0.5].map((x, i) => (
        <group key={i} position={[x, 1.45, 0.34]}>
          <C rt={0.05} h={0.04} r={[Math.PI / 2, 0, 0]} m={[M.green_glow, M.amber_glow, M.amber_glow, M.green_glow][i]} />
          <C rt={0.04} h={0.08} p={[0, -0.25, 0]} r={[Math.PI / 2, 0, 0]} m={M.black} />
        </group>
      ))}
      <C rt={0.09} h={0.06} p={[0, 1.15, 0.35]} r={[Math.PI / 2, 0, 0]} m={alarm ? M.red_glow : M.red} />
      <group ref={guard} position={[0, 1.33, 0.36]}>
        <mesh position={[0, -0.17, 0.06]} material={M.glass}><boxGeometry args={[0.36, 0.34, 0.1]} /></mesh>
      </group>
      <B s={[1.2, 0.14, 0.02]} p={[0, 1.78, 0.31]} m={M.white} />
      <Hazard w={1.6} d={0.4} p={[0, 0, 0.6]} mA={M.yellow} mB={M.black} n={6} />
    </group>
  );
}

/* ---------- Doghouse ---------- */
function Doghouse() {
  const [x, , z] = A.doghouse;
  const W = 5, D = 4, H = 3;
  return (
    <group position={[x, 0, z]}>
      <B s={[W, 0.2, D]} p={[0, 0.1, 0]} m={M.darkSteel} />
      <B s={[W, H, 0.12]} p={[0, H / 2, -D / 2]} m={M.white} />
      <B s={[0.12, H, D]} p={[-W / 2, H / 2, 0]} m={M.white} />
      {/* front wall with window band (faces +z) */}
      <B s={[W, 1.1, 0.12]} p={[0, 0.55, D / 2]} m={M.white} />
      <B s={[W, 0.6, 0.12]} p={[0, H - 0.3, D / 2]} m={M.white} />
      <mesh position={[0, 1.75, D / 2]} material={M.glass}><boxGeometry args={[W - 0.2, 1.3, 0.04]} /></mesh>
      {[-1.6, 0, 1.6].map((dx, i) => <B key={i} s={[0.1, 1.3, 0.14]} p={[dx, 1.75, D / 2]} m={M.white} />)}
      {/* right wall (faces +x, toward drill floor) with door + window */}
      <B s={[0.12, H, 1.2]} p={[W / 2, H / 2, -D / 2 + 0.6]} m={M.white} />
      <B s={[0.12, 1.1, 1.6]} p={[W / 2, 0.55, 0.6]} m={M.white} />
      <mesh position={[W / 2, 1.75, 0.6]} material={M.glass}><boxGeometry args={[0.04, 1.3, 1.6]} /></mesh>
      <B s={[0.12, 0.6, 2.8]} p={[W / 2, H - 0.3, 0.6]} m={M.white} />
      <B s={[0.1, 2.3, 0.9]} p={[W / 2 + 0.02, 1.15, 1.6]} m={M.red} />
      <B s={[0.12, 0.7, 0.9]} p={[W / 2, H - 0.35 + 0.0, 1.6]} m={M.white} />
      <B s={[W + 0.4, 0.2, D + 0.4]} p={[0, H + 0.1, 0]} m={M.darkSteel} />
      {/* AC unit + antenna */}
      <B s={[1.0, 0.5, 0.8]} p={[-1.4, H + 0.45, -0.8]} m={M.white} round={0.05} />
      <C rt={0.02} h={2.5} p={[1.8, H + 1.4, -1.6]} m={M.steel} />
      <Strobe p={[1.8, H + 2.7, -1.6]} />
      {/* driller console */}
      <B s={[2.6, 0.9, 0.8]} p={[0.4, 0.65, -1.3]} m={M.darkSteel} round={0.04} />
      {[-0.4, 0.4, 1.2].map((dx, i) => (
        <group key={i} position={[dx, 1.4, -1.6]} rotation={[-0.2, 0, 0]}>
          <B s={[0.7, 0.45, 0.06]} m={M.black} />
          <B s={[0.62, 0.38, 0.02]} p={[0, 0, 0.035]} m={i === 1 ? M.screenGreen : M.screen} />
        </group>
      ))}
      <B s={[0.6, 0.12, 0.6]} p={[0.4, 0.55, -0.3]} m={M.black} />
      <C rt={0.04} h={0.5} p={[0.4, 0.3, -0.3]} m={M.chrome} />
      {/* coffee mug + clipboard */}
      <Lathe pts={[[0, 0], [0.04, 0], [0.042, 0.1], [0.038, 0.1], [0.036, 0.01], [0, 0.01]]} p={[-0.7, 1.1, -1.1]} m={M.white} seg={20} />
      <B s={[0.22, 0.01, 0.3]} p={[-0.3, 1.105, -1.05]} r={[0, 0.3, 0]} m={M.wood} />
      <pointLight position={[0.3, 2.6, 0]} intensity={8} distance={7} color="#ffe2b8" />
    </group>
  );
}

/* ---------- PPE locker ---------- */
function Locker() {
  const hat = useGame((s) => s.hat);
  const ppe = useGame((s) => s.gloves);
  useInteract({ id: 'locker', pos: [A.locker[0] + 0.5, 1.2, A.locker[2]], r: 0.9,
    label: () => (step() === 'ppe' ? (useGame.getState().hat ? 'Put on gloves' : 'Put on hard hat') : null), use: F.useLocker,
    gesture: () => (useGame.getState().hat ? ['rub'] : ['handsOnHead']) });
  return (
    <group position={A.locker} rotation={[0, Math.PI / 2, 0]}>
      <B s={[2.1, 2.0, 0.6]} p={[0, 1.0, 0]} m={M.blue} round={0.03} />
      {[-0.7, 0, 0.7].map((x, i) => (
        <group key={i} position={[x, 1.0, 0.31]}>
          <B s={[0.66, 1.9, 0.02]} m={M.blue} />
          {Array.from({ length: 5 }, (_, k) => <B key={k} s={[0.4, 0.02, 0.025]} p={[0, 0.7 - k * 0.05, 0.01]} m={M.black} />)}
          <B s={[0.03, 0.15, 0.04]} p={[0.25, 0, 0.02]} m={M.chrome} />
        </group>
      ))}
      {!hat && <Hardhat p={[-0.5, 2.0, 0]} m={M.hatYellow} />}
      <Hardhat p={[0.2, 2.0, 0.05]} m={M.hatWhite} />
      {!ppe && <B s={[0.25, 0.06, 0.15]} p={[0.65, 2.03, 0]} m={M.glove} round={0.02} />}
      <B s={[1.6, 0.4, 0.02]} p={[0, 1.6, -0.31]} m={M.white} />
    </group>
  );
}

export function Hardhat({ p, m, s = 1 }) {
  return (
    <group position={p} scale={s}>
      <Lathe pts={[[0, 0.14], [0.06, 0.135], [0.11, 0.11], [0.135, 0.06], [0.145, 0.0], [0.0, 0.0]]} m={m} seg={24} />
      <Lathe pts={[[0.14, 0.005], [0.19, 0.0], [0.19, -0.01], [0.14, -0.005]]} m={m} seg={24} />
      <B s={[0.03, 0.02, 0.28]} p={[0, 0.14, 0]} m={m} />
    </group>
  );
}

/* ---------- Pipe rack ---------- */
function PipeRack() {
  const held = useGame((s) => s.held);
  const st = useGame((s) => s.step);
  const taken = held === 'pipe' || ['pipePlace', 'torque', 'gauge', 'choke', 'wait', 'kickGuard', 'kickButton', 'kickChoke', 'judgment', 'done'].includes(st);
  useInteract({ id: 'rack', pos: [A.pipeRack[0] - 2, 1.0, A.pipeRack[2] - 1.2], r: 1.4,
    label: () => (step() === 'pipeGrab' ? 'Pick up drill pipe joint' : null), use: F.useRack, gesture: ['twoFists'] });
  const pipes = [];
  let k = 0;
  for (let row = 0; row < 3; row++) {
    for (let i = 0; i < 7 - row; i++) {
      if (taken && row === 2 && i === 0) continue;
      pipes.push(
        <group key={k++} position={[0, 0.85 + row * 0.24, -0.8 + i * 0.26 + row * 0.13]}>
          <C rt={0.11} h={8} r={[0, 0, Math.PI / 2]} m={M.pipe} seg={16} />
          <C rt={0.14} h={0.4} p={[3.9, 0, 0]} r={[0, 0, Math.PI / 2]} m={M.pipe} seg={16} />
          <C rt={0.145} h={0.3} p={[-3.95, 0, 0]} r={[0, 0, Math.PI / 2]} m={M.yellow} seg={16} />
        </group>
      );
    }
  }
  return (
    <group position={A.pipeRack}>
      {[-3, -1, 1, 3].map((x, i) => (
        <group key={i} position={[x, 0, 0]}>
          <B s={[0.25, 0.75, 2.4]} p={[0, 0.37, 0]} m={M.yellow} />
          <B s={[0.25, 0.9, 0.12]} p={[0, 0.45, 1.25]} m={M.yellow} />
          <B s={[0.25, 0.9, 0.12]} p={[0, 0.45, -1.25]} m={M.yellow} />
        </group>
      ))}
      {pipes}
    </group>
  );
}

/* ---------- Containers, crane, flare, lights, clutter ---------- */
function Container({ p, r = 0, m }) {
  return (
    <group position={p} rotation={[0, r, 0]}>
      <B s={[2.44, 2.59, 6.06]} p={[0, 1.3, 0]} m={m} />
      {Array.from({ length: 24 }, (_, i) => <B key={i} s={[2.5, 2.4, 0.06]} p={[0, 1.3, -2.9 + i * 0.25]} m={m} />)}
      {[[-1.2, -3], [1.2, -3], [-1.2, 3], [1.2, 3]].map(([x, z], i) => <B key={i} s={[0.15, 2.6, 0.15]} p={[x, 1.3, z]} m={M.darkSteel} />)}
      {[-0.4, 0.4].map((x, i) => <C key={i} rt={0.025} h={2.3} p={[x, 1.3, 3.06]} m={M.steel} seg={8} />)}
    </group>
  );
}

function Crane() {
  const [x, , z] = A.crane;
  const boomLen = 22, ang = 0.55;
  const tip = [x - Math.cos(ang) * boomLen * 0.7, 4 + Math.sin(ang) * boomLen, z - Math.cos(ang) * boomLen * 0.7];
  return (
    <group>
      <C rt={1.0} h={4} p={[x, 2, z]} m={M.yellow} seg={32} />
      <C rt={1.2} h={0.4} p={[x, 4.1, z]} m={M.darkSteel} seg={32} />
      <B s={[2.2, 2.0, 3.0]} p={[x + 0.6, 5.3, z + 0.4]} m={M.yellow} round={0.12} />
      <mesh position={[x - 0.52, 5.6, z + 0.4]} material={M.glass}><boxGeometry args={[0.04, 1.0, 2.4]} /></mesh>
      {[-0.6, 0.6].map((o, i) => (
        <group key={i}>
          <Beam a={[x - 0.4, 4.6, z + o]} b={[tip[0], tip[1], tip[2] + o * 0.3]} rad={0.12} m={M.yellow} square />
          <Beam a={[x - 0.4, 6.2, z + o]} b={[tip[0], tip[1] + 0.6, tip[2] + o * 0.3]} rad={0.08} m={M.yellow} square />
        </group>
      ))}
      {Array.from({ length: 9 }, (_, i) => {
        const t = (i + 1) / 10;
        const a = [x - 0.4 + (tip[0] - x + 0.4) * t, 4.6 + (tip[1] - 4.6) * t, z + (tip[2] - z) * t];
        return <Beam key={i} a={[a[0], a[1], a[2] - 0.5]} b={[a[0], a[1] + 1.3, a[2] + 0.5]} rad={0.04} m={M.yellow} />;
      })}
      <Beam a={tip} b={[tip[0], tip[1] - 10, tip[2]]} rad={0.02} m={M.black} />
      <B s={[0.5, 0.7, 0.4]} p={[tip[0], tip[1] - 10.3, tip[2]]} m={M.red} round={0.06} />
    </group>
  );
}

function Flare() {
  const flame = useRef();
  const light = useRef();
  const base = [14.5, 1, -11.5], tip = [30, 14, -27];
  useFrame((st) => {
    const t = st.clock.elapsedTime;
    const surge = useGame.getState().alarm ? 1.8 : 1;
    const f = (1 + Math.sin(t * 11) * 0.08 + Math.sin(t * 23) * 0.05) * surge;
    if (flame.current) { flame.current.scale.set(f, f * (1.1 + Math.sin(t * 7) * 0.15), f); }
    if (light.current) light.current.intensity = 900 * f;
  });
  const segs = 8;
  const pts = Array.from({ length: segs + 1 }, (_, i) => base.map((b, k) => b + (tip[k] - b) * (i / segs)));
  return (
    <group>
      {[[-0.5, -0.5], [0.5, -0.5], [0, 0.5]].map(([ox, oy], i) => <Beam key={i} a={[base[0] + ox, base[1] + oy, base[2]]} b={[tip[0] + ox * 0.3, tip[1] + oy * 0.3, tip[2]]} rad={0.1} m={M.white} square />)}
      {pts.slice(0, -1).map((p, i) => <Beam key={i} a={[p[0] - 0.5, p[1] - 0.5, p[2]]} b={[pts[i + 1][0], pts[i + 1][1] + 0.5, pts[i + 1][2]]} rad={0.05} m={M.white} />)}
      <C rt={0.3} h={1.2} p={[tip[0], tip[1] + 0.6, tip[2]]} m={M.darkSteel} />
      <group ref={flame} position={[tip[0], tip[1] + 1.2, tip[2]]}>
        {[[0, 1.4, 0, 1.0], [0.25, 2.6, 0.1, 0.75], [-0.15, 3.6, -0.1, 0.5], [0.1, 4.4, 0, 0.3]].map(([x, y, z, r], i) => (
          <mesh key={i} position={[x, y, z]} scale={[r, r * 1.5, r]}>
            <sphereGeometry args={[1, 16, 12]} />
            <meshBasicMaterial color={i === 0 ? [9, 6, 2.5] : [6, 2.0 - i * 0.3, 0.3]} toneMapped={false} fog={false} />
          </mesh>
        ))}
      </group>
      <pointLight ref={light} position={[tip[0], tip[1] + 3, tip[2]]} color="#ff8a3a" distance={90} decay={1.4} />
    </group>
  );
}

function Floodlight({ p, rot = 0 }) {
  return (
    <group position={p} rotation={[0, rot, 0]}>
      <C rt={0.09} h={9} p={[0, 4.5, 0]} m={M.white} />
      <B s={[1.4, 0.08, 0.08]} p={[0, 9, 0]} m={M.white} />
      {[-0.5, 0.5].map((x, i) => (
        <group key={i} position={[x, 9.1, 0.1]} rotation={[0.6, 0, 0]}>
          <B s={[0.45, 0.35, 0.25]} m={M.darkSteel} round={0.04} />
          <B s={[0.38, 0.28, 0.02]} p={[0, 0, 0.13]} m={M.lamp} />
        </group>
      ))}
    </group>
  );
}

function Drum({ p, m }) {
  return (
    <group position={p}>
      <C rt={0.29} h={0.88} p={[0, 0.44, 0]} m={m} seg={24} />
      {[0.25, 0.63].map((y, i) => <T key={i} R={0.292} tube={0.012} p={[0, y, 0]} r={[Math.PI / 2, 0, 0]} m={m} />)}
      <C rt={0.04} h={0.02} p={[0.15, 0.885, 0]} m={M.chrome} seg={10} />
    </group>
  );
}

function Clutter() {
  return (
    <group>
      {[[11.5, 2.2], [12.2, 2.8], [11.6, 3.3], [-13.6, -10.6]].map(([x, z], i) => <Drum key={i} p={[x, 0, z]} m={[M.blue, M.red, M.yellow, M.green][i]} />)}
      {/* toolbox */}
      <group position={[-1.8, 0, 3.2]} rotation={[0, 0.4, 0]}>
        <B s={[0.7, 0.35, 0.35]} p={[0, 0.17, 0]} m={M.red} round={0.03} />
        <B s={[0.4, 0.04, 0.04]} p={[0, 0.38, 0]} m={M.black} />
      </group>
      {/* pipe wrench on deck */}
      <group position={[2.6, 0.03, 1.8]} rotation={[0, 0.9, 0]}>
        <B s={[0.06, 0.04, 0.9]} m={M.red} />
        <B s={[0.16, 0.06, 0.12]} p={[0, 0, 0.47]} m={M.steel} />
      </group>
      {/* extinguishers */}
      {[[-6.8, -3.0], [9.0, 11.6], [-14.6, 4]].map(([x, z], i) => (
        <group key={i} position={[x, 0, z]}>
          <Lathe pts={[[0, 0], [0.09, 0], [0.09, 0.5], [0.06, 0.58], [0.02, 0.6], [0, 0.6]]} m={M.red} seg={20} />
          <B s={[0.12, 0.04, 0.03]} p={[0, 0.63, 0]} m={M.black} />
        </group>
      ))}
      {/* lifebuoys on railing */}
      {[[-15.05, 0], [15.05, -4], [4, 12.05]].map(([x, z], i) => (
        <T key={i} R={0.32} tube={0.08} p={[x, 0.75, z]} r={[0, x !== 4 ? Math.PI / 2 : 0, 0]} m={M.orange} />
      ))}
      {/* hose reel */}
      <group position={[6.5, 0, 10.8]}>
        <B s={[0.1, 1.0, 1.0]} p={[-0.3, 0.5, 0]} m={M.red} />
        <B s={[0.1, 1.0, 1.0]} p={[0.3, 0.5, 0]} m={M.red} />
        <C rt={0.38} h={0.5} p={[0, 0.55, 0]} r={[0, 0, Math.PI / 2]} m={M.rubber} />
      </group>
      {/* mud hose from pumps to standpipe */}
      <Tube pts={[[8.2, 0.25, -4.4], [5, 0.2, -4.6], [3.2, 0.5, -4.8], [3.1, 4, -4.9], [3.0, 9, -4.0]]} rad={0.11} m={M.rubber} />
      {/* cable tray */}
      <group position={[-12.5, 2.6, 0]}>
        <B s={[0.5, 0.05, 20]} m={M.grating} />
        <B s={[0.03, 0.15, 20]} p={[-0.24, 0.07, 0]} m={M.grating} />
        <B s={[0.03, 0.15, 20]} p={[0.24, 0.07, 0]} m={M.grating} />
        {[-0.1, 0, 0.1].map((x, i) => <C key={i} rt={0.03} h={20} p={[x, 0.06, 0]} r={[Math.PI / 2, 0, 0]} m={M.black} seg={8} />)}
        {[-8, 0, 8].map((z, i) => <B key={i} s={[0.08, 2.6, 0.08]} p={[0.3, -1.3, z]} m={M.yellow} />)}
      </group>
    </group>
  );
}

function Helideck() {
  const ring = useMemo(() => Array.from({ length: 8 }, (_, i) => (i / 8) * Math.PI * 2), []);
  return (
    <group position={[-31, 2.5, -2]}>
      <C rt={11} h={0.5} m={M.green} seg={8} />
      <T R={7} tube={0.25} p={[0, 0.27, 0]} r={[Math.PI / 2, 0, 0]} m={M.yellow} />
      <B s={[0.8, 0.05, 5]} p={[-1.4, 0.27, 0]} m={M.white} />
      <B s={[0.8, 0.05, 5]} p={[1.4, 0.27, 0]} m={M.white} />
      <B s={[2.2, 0.05, 0.8]} p={[0, 0.27, 0]} m={M.white} />
      {ring.map((a, i) => <Beam key={i} a={[Math.cos(a) * 9, -0.2, Math.sin(a) * 9]} b={[Math.cos(a) * 3 + 12, -42, Math.sin(a) * 3]} rad={0.35} m={M.yellow} />)}
      {ring.map((a, i) => <S key={i} rad={0.12} p={[Math.cos(a) * 10.6, 0.35, Math.sin(a) * 10.6]} m={M.amber_glow} seg={10} />)}
    </group>
  );
}

export default function Rig() {
  return (
    <group>
      <Deck />
      <Derrick />
      <DrillFloor />
      <MudPump p={A.pump1} primary />
      <MudPump p={A.pump2} />
      <Choke />
      <BopPanel />
      <Doghouse />
      <Locker />
      <PipeRack />
      <Container p={A.containers} m={M.orange} />
      <Container p={[A.containers[0] + 0.2, 0, A.containers[2] - 6.6]} m={M.blue} />
      <Container p={[A.containers[0], 2.6, A.containers[2] - 0.3]} m={M.green} />
      <Crane />
      <Flare />
      <Floodlight p={[-14.3, 0, -11.3]} rot={0.8} />
      <Floodlight p={[14.3, 0, 11.3]} rot={-2.4} />
      <Floodlight p={[14.3, 0, -1]} rot={-1.57} />
      <Clutter />
      <Helideck />
    </group>
  );
}
