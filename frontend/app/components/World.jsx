'use client';

import { Canvas, useFrame } from '@react-three/fiber';
import { Component, useEffect, useMemo, useRef } from 'react';
import { CanvasTexture, DoubleSide, Quaternion, SRGBColorSpace, Vector3 } from 'three';
import { toWorld } from '../lib/gesture';

const themes = {
  cafe: { wall: '#51666a', floor: '#263f40', surface: '#d1a782', frame: '#303e3e', trim: '#f2bc79', light: '#fff0d9' },
  warehouse: { wall: '#5a6577', floor: '#333e53', surface: '#b3baca', frame: '#323b4b', trim: '#ffb760', light: '#e1ecff' },
  garden: { wall: '#517a6a', floor: '#273f37', surface: '#bdaf81', frame: '#3b5143', trim: '#f2a3a5', light: '#e9fce8' },
  studio: { wall: '#625972', floor: '#353047', surface: '#b6a3c7', frame: '#3e3552', trim: '#c9a2fc', light: '#f7eaff' },
  clinic: { wall: '#577080', floor: '#354a55', surface: '#c5d7d7', frame: '#405467', trim: '#83e5ee', light: '#e9faff' },
  workshop: { wall: '#6c6255', floor: '#42382c', surface: '#c5a47f', frame: '#514134', trim: '#f6b76c', light: '#fff3d8' },
};
const colors = { mint: '#57e3b4', gold: '#ffc478', rose: '#ef7c98', blue: '#70b5f7', violet: '#b49cf5', neutral: '#ccd9cf' };
const LIMIT = 5;
const up = new Vector3(0, 1, 0);
const pose = new Vector3();
const rotation = new Quaternion();

function Box({ size, position, color, emissive, opacity = 1 }) {
  return <mesh position={position} castShadow receiveShadow>
    <boxGeometry args={size} />
    <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={0.52}
      opacity={opacity} transparent={opacity < 1} />
  </mesh>;
}

function Sign({ text, position, yaw = 0, accent = '#bdebd2', width = 1.75 }) {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 148;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#132923'; ctx.fillRect(0, 0, 640, 148);
    ctx.fillStyle = accent; ctx.fillRect(0, 0, 12, 148);
    ctx.fillStyle = '#f6f8eb'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    ctx.font = '700 45px system-ui';
    ctx.fillText(text, 322, 72, 592);
    const result = new CanvasTexture(canvas);
    result.colorSpace = SRGBColorSpace;
    return result;
  }, [text, accent]);
  useEffect(() => () => texture.dispose(), [texture]);
  return <mesh position={position} rotation-y={yaw}>
    <planeGeometry args={[width, width * 0.231]} />
    <meshBasicMaterial map={texture} />
  </mesh>;
}

function Architecture({ theme, title }) {
  return <>
    <Box size={[10, 0.16, 10]} position={[0, -0.09, 0]} color={theme.floor} />
    <gridHelper position={[0, 0.003, 0]} args={[10, 20, theme.trim, '#526063']} />
    <Box size={[10.14, 3.3, 0.16]} position={[0, 1.65, -LIMIT]} color={theme.wall} />
    {[-LIMIT, LIMIT].map(x => <group key={x}>
      <Box size={[0.16, 3.3, 10]} position={[x, 1.65, 0]} color={theme.wall} />
      <Box size={[0.19, 0.12, 10]} position={[x, 0.10, 0]} color={theme.frame} />
      <Box size={[0.20, 0.04, 9.8]} position={[x, 2.63, 0]} color={theme.trim} emissive={theme.trim} />
      {[-3, -0.1, 2.8].map(z => <Box key={z} size={[0.25, 3.28, 0.045]} position={[x, 1.64, z]} color={theme.frame} />)}
    </group>)}
    <Box size={[10.14, 2.8, 0.16]} position={[0, 1.4, LIMIT]} color={theme.wall} />
    <Box size={[9.8, 0.11, 0.2]} position={[0, 0.09, -LIMIT]} color={theme.frame} />
    <Box size={[5.0, 0.70, 0.20]} position={[0, 2.74, -4.94]} color={theme.frame} />
    <Sign text={title} position={[0, 2.75, -4.82]} accent={theme.trim} width={4.4} />
    {[-2.5, 0, 2.5].map(x => <group key={x}>
      <Box size={[1.54, 0.07, 0.33]} position={[x, 3.16, -1.8]} color={theme.light} emissive={theme.light} />
      <Box size={[1.54, 0.07, 0.33]} position={[x, 3.16, 2.0]} color={theme.light} emissive={theme.light} />
    </group>)}
  </>;
}

function Station({ station, state, active, theme }) {
  const { x, y, z, width, depth, inward, control, kind, label } = station;
  const face = Math.atan2(inward.x, inward.z);
  const border = state?.closed ? '#ba4e55' : active ? '#8affc8' : theme.trim;
  const lit = state?.closed || active;
  return <group>
    <Box size={[width * 0.88, y - 0.10, depth * 0.92]} position={[x, (y - 0.10) / 2, z]} color={theme.frame} />
    <Box size={[width, 0.12, depth]} position={[x, y - 0.06, z]} color={theme.surface} />
    <Box size={[inward.x ? 0.045 : width, 0.06, inward.z ? 0.045 : depth]}
      position={[x + inward.x * (width / 2 + 0.015), y - 0.04, z + inward.z * (depth / 2 + 0.015)]}
      color={border} emissive={lit ? border : undefined} />
    {[[-0.34, -0.49], [0.34, -0.49], [-0.34, 0.49], [0.34, 0.49]].map(([a, b]) =>
      <Box key={`${a}-${b}`} size={[0.10, 0.14, 0.10]} position={[x + a * width, 0.07, z + b * depth]} color={theme.trim} />)}
    {kind === 'machine' && <>
      <Box size={inward.x ? [0.37, 0.40, 0.95] : [0.95, 0.40, 0.37]}
        position={[x - inward.x * 0.30, y + 0.24, z - inward.z * 0.30]} color="#8c9d9d" />
      <Box size={[0.19, 0.15, 0.19]} position={[control.x, control.y, control.z]} color={border} emissive={border} />
    </>}
    {kind === 'shelf' && <Box size={[width, 0.07, depth]} position={[x, 0.34, z]} color={theme.surface} />}
    {kind === 'bin' && <Box size={[width * 0.74, 0.035, depth * 0.84]} position={[x, y + 0.014, z]} color={theme.floor} />}
    <Sign text={state?.closed ? 'Station closed' : label} accent={border} yaw={face}
      position={[x - inward.x * 0.33, 1.83, z - inward.z * 0.33]} />
    {lit && <mesh rotation-x={-Math.PI / 2} position={[x + inward.x * 1.00, 0.015, z + inward.z * 1.00]}>
      <ringGeometry args={[0.31, 0.35, 36]} /><meshBasicMaterial color={border} />
    </mesh>}
  </group>;
}

function Prop({ spec, state, selected }) {
  const mesh = useRef(null);
  const [width, height, depth] = spec.size;
  const position = state?.position ?? spec.spawn;
  const tint = state?.processed ? '#e78e51' : colors[spec.color];
  useFrame((_, delta) => {
    if (!mesh.current) return;
    mesh.current.position.lerp(pose.set(position.x, position.y, position.z), 1 - Math.exp(-27 * delta));
    if (state?.rotation) {
      const q = state.rotation;
      mesh.current.quaternion.slerp(rotation.set(q.x, q.y, q.z, q.w), 1 - Math.exp(-30 * delta));
    }
  });
  return <group ref={mesh} position={[spec.spawn.x, spec.spawn.y, spec.spawn.z]}>
    {spec.shape === 'cup' && <>
      <mesh castShadow><cylinderGeometry args={[width / 2, width * 0.39, height, 24, 1, true]} />
        <meshStandardMaterial color={tint} emissive={selected ? tint : '#000000'} emissiveIntensity={0.42} side={DoubleSide} />
      </mesh>
      <mesh position={[0, -height / 2 + 0.01, 0]}><cylinderGeometry args={[width * 0.40, width * 0.39, 0.022, 24]} /><meshStandardMaterial color={tint} /></mesh>
      <mesh position={[width / 2, 0.015, 0]}><torusGeometry args={[0.067, 0.021, 10, 24]} /><meshStandardMaterial color={tint} /></mesh>
      {state?.processed && <mesh position={[0, height * 0.29, 0]}><cylinderGeometry args={[width * 0.47, width * 0.47, 0.01, 24]} /><meshStandardMaterial color="#693e25" /></mesh>}
    </>}
    {spec.shape === 'bottle' && <>
      <mesh castShadow><cylinderGeometry args={[width * 0.43, width / 2, height * 0.8, 20]} /><meshStandardMaterial color={tint} /></mesh>
      <Box size={[width * 0.46, height * 0.21, depth * 0.46]} position={[0, height * 0.41, 0]} color="#263f37" />
    </>}
    {spec.shape === 'bundle' && <>
      <Box size={[width * 0.66, height * 0.68, depth * 0.79]} position={[-width * 0.10, 0, 0]} color="#cfae82" />
      {[-1, 0, 1].map(index => <group key={index} position={[width * 0.19, index % 2 * height * 0.1, index * depth * 0.24]}>
        <mesh rotation-z={-Math.PI / 2} castShadow><cylinderGeometry args={[0.02, 0.02, width * 0.60, 7]} /><meshStandardMaterial color="#4e7049" /></mesh>
        <mesh position={[width * 0.23, 0, 0]} castShadow><sphereGeometry args={[height * 0.25, 8, 6]} /><meshStandardMaterial color={tint} /></mesh>
      </group>)}
    </>}
    {spec.shape === 'tray' && <>
      <Box size={[width, height * 0.47, depth]} position={[0, -height * 0.16, 0]} color={tint} />
      {[-1, 1].map(side => <group key={side}>
        <Box size={[width, height * 0.42, 0.03]} position={[0, height * 0.15, side * (depth / 2 - 0.01)]} color={tint} />
        <Box size={[0.03, height * 0.42, depth]} position={[side * (width / 2 - 0.01), height * 0.15, 0]} color={tint} />
      </group>)}
    </>}
    {spec.shape === 'tool' && <>
      <Box size={[width * 0.63, height * 0.87, depth * 0.59]} position={[-width * 0.15, 0, 0]} color={tint} />
      <Box size={[width * 0.40, height * 0.55, depth * 0.30]} position={[width * 0.29, 0, 0]} color="#9aaba7" />
    </>}
    {['box', 'parcel', 'case'].includes(spec.shape) && <>
      <Box size={spec.size} color={tint} emissive={selected ? tint : undefined} />
      {spec.shape === 'case'
        ? <Box size={[width * 0.31, 0.035, 0.055]} position={[0, height / 2 + 0.022, 0]} color="#2b4140" />
        : <Box size={[width * 0.39, 0.006, depth]} position={[0, height / 2 + 0.004, 0]} color="#fff1d1" opacity={0.75} />}
    </>}
    {selected && <mesh position={[0, -height / 2 + 0.015, 0]} rotation-x={-Math.PI / 2}>
      <ringGeometry args={[width * 0.62, width * 0.70, 30]} /><meshBasicMaterial color="#b8ffd7" />
    </mesh>}
  </group>;
}

function Arm({ player, side, color }) {
  const mesh = useRef(null);
  const [origin, tip, line] = useMemo(() => [new Vector3(), new Vector3(), new Vector3()], []);
  useFrame(() => {
    if (!mesh.current) return;
    const hand = toWorld(player, player[side]);
    const shoulder = toWorld(player, { x: side === 'left' ? -0.24 : 0.24, y: 1.34, z: 0.08 });
    origin.set(shoulder.x - player.x, shoulder.y, shoulder.z - player.z);
    tip.set(hand.x - player.x, hand.y, hand.z - player.z);
    line.subVectors(tip, origin);
    mesh.current.position.copy(origin).addScaledVector(line, 0.5);
    mesh.current.scale.y = Math.max(0.01, line.length());
    mesh.current.quaternion.setFromUnitVectors(up, line.normalize());
  });
  return <mesh ref={mesh}><cylinderGeometry args={[0.045, 0.065, 1, 10]} /><meshStandardMaterial color={color} /></mesh>;
}

function Avatar({ player, npc = false }) {
  const group = useRef(null);
  const leftLeg = useRef(null);
  const rightLeg = useRef(null);
  const color = player.color || '#ecc29a';
  useFrame(({ clock }, delta) => {
    const root = group.current;
    if (!root) return;
    root.position.lerp(pose.set(player.x, 0, player.z), 1 - Math.exp(-15 * delta));
    const stride = player.moving ? Math.sin(clock.elapsedTime * 12) * player.moving * 0.29 : 0;
    leftLeg.current.rotation.x = stride; rightLeg.current.rotation.x = -stride;
  });
  return <group ref={group} position={[player.x, 0, player.z]}>
    <group rotation-y={-player.yaw}>
      <Box size={[0.40, 0.58, 0.25]} position={[0, 1.12, 0]} color={color} />
      <Box size={[0.24, 0.25, 0.24]} position={[0, 1.56, 0]} color="#dfad85" />
      <Box size={[0.21, 0.03, 0.016]} position={[0, 1.59, -0.13]} color="#213834" />
      <group ref={leftLeg} position={[-0.11, 0.78, 0]}><Box size={[0.15, 0.73, 0.17]} position={[0, -0.38, 0]} color="#25374a" /></group>
      <group ref={rightLeg} position={[0.11, 0.78, 0]}><Box size={[0.15, 0.73, 0.17]} position={[0, -0.38, 0]} color="#25374a" /></group>
    </group>
    {!npc && <><Arm player={player} side="left" color={color} /><Arm player={player} side="right" color={color} /></>}
  </group>;
}

function FirstPerson({ player, local }) {
  const initialized = useRef(false);
  const left = useRef(null);
  const right = useRef(null);
  useFrame(({ camera }, delta) => {
    if (!player) {
      camera.position.set(-0.72, 1.61, 3.55);
      camera.rotation.set(-0.14, 0.86, 0, 'YXZ');
      return;
    }
    const alpha = initialized.current ? 1 - Math.exp(-20 * delta) : 1;
    camera.position.lerp(pose.set(player.x, 1.62, player.z), alpha);
    const yaw = -player.yaw;
    const angle = Math.atan2(Math.sin(yaw - camera.rotation.y), Math.cos(yaw - camera.rotation.y));
    camera.rotation.set(camera.rotation.x + (player.pitch - camera.rotation.x) * alpha, camera.rotation.y + angle * alpha, 0, 'YXZ');
    initialized.current = true;
    for (const [side, mesh] of [['left', left.current], ['right', right.current]]) {
      if (!mesh) continue;
      const sample = local.current;
      mesh.visible = Boolean(sample?.tracked);
      const target = toWorld(player, sample?.[side] ?? player[side]);
      mesh.position.lerp(pose.set(target.x, target.y, target.z), alpha);
    }
  });
  return <>
    {[left, right].map((ref, index) => <mesh key={index} ref={ref} visible={false} castShadow>
      <sphereGeometry args={[0.075, 12, 9]} /><meshStandardMaterial color={player?.color ?? '#6effc9'} />
    </mesh>)}
  </>;
}

class GraphicsBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <div className="graphics-error" role="alert">The 3D view could not start. Enable hardware acceleration and reload.</div>
      : this.props.children;
  }
}

export default function World({ blueprint, snapshot, playerId, local }) {
  const theme = themes[blueprint.theme] || themes.studio;
  const player = snapshot?.players.find(item => item.id === playerId);
  return <GraphicsBoundary>
    <Canvas shadows dpr={[1, 1.65]} camera={{ fov: 67, near: 0.045, far: 45 }}
      fallback={<div className="graphics-error">This device needs a browser with WebGL.</div>}>
      <color attach="background" args={[theme.floor]} />
      <ambientLight intensity={0.83} color={theme.light} />
      <hemisphereLight args={[theme.light, theme.floor, 1.7]} />
      <directionalLight position={[0.8, 5, 2.4]} color={theme.light} intensity={2.25} castShadow shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-6} shadow-camera-right={6} shadow-camera-top={6} shadow-camera-bottom={-6}
        shadow-normalBias={0.024} />
      <Architecture theme={theme} title={blueprint.title} />
      {blueprint.stations.map(station => <Station key={station.id} station={station} theme={theme}
        active={snapshot?.objective?.station === station.id} state={snapshot?.stations.find(item => item.id === station.id)} />)}
      {blueprint.props.map(spec => <Prop key={spec.id} spec={spec}
        state={snapshot?.props.find(item => item.id === spec.id)}
        selected={player?.hint === spec.id || (snapshot?.objective?.item === spec.id && snapshot.objective.verb === 'inspect')} />)}
      {snapshot?.players.filter(item => item.id !== playerId).map(item => <Avatar key={item.id} player={item} />)}
      {snapshot?.npcs.map(item => <Avatar key={item.id} player={item} npc />)}
      <FirstPerson player={player} local={local} />
    </Canvas>
  </GraphicsBoundary>;
}
