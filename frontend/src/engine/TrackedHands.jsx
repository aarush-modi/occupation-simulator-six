'use client';
import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { M } from '../game/materials';
import { B } from '../game/parts';
import { cam } from '../game/webcam/gestures';
import { FINGERS, handPoints, restingFingers, solveElbow, trackedFingers, trackedWrist } from '../game/handPose';
import { latestHandAction } from './actions';
import { handGrips } from './handGrips';
import { useShift } from './store';

const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, -1);
const sphere = new THREE.SphereGeometry(1, 10, 8);
const segment = new THREE.CylinderGeometry(1, 1, 1, 9);
const radii = [0.011, 0.0095, 0.01, 0.0092, 0.008];
const v = () => new THREE.Vector3();

function fitSegment(mesh, a, b, radius, direction) {
  direction.copy(b).sub(a);
  mesh.position.copy(a).lerp(b, 0.5);
  mesh.scale.set(radius, direction.length(), radius);
  mesh.quaternion.setFromUnitVectors(UP, direction.normalize());
}

function Hand({ side, boxing, strike }) {
  const outer = useRef(), wrist = useRef(), palm = useRef(), links = useRef(), joints = useRef();
  const upperArm = useRef(), forearm = useRef(), grip = useRef(), glove = useRef();
  const you = useShift(s => s.you);
  const sign = side === 'left' ? -1 : 1;
  const data = useMemo(() => {
    const points = handPoints();
    restingFingers(points, side, 0);
    return {
      points, goal: handPoints(), transform: new THREE.Object3D(), basis: new THREE.Matrix4(),
      shoulder: new THREE.Vector3(sign * 0.235, -0.265, 0.035), bend: new THREE.Vector3(sign * 0.46, -1, 0.19),
      elbow: v(), axis: v(), pole: v(), direction: v(), position: new THREE.Vector3(sign * 0.235, -0.60, -0.28),
      target: v(), desired: v(), world: v(), across: v(), along: v(), normal: v(), lastSeen: -Infinity,
    };
  }, [side, sign]);

  useEffect(() => {
    if (!you) return;
    const anchors = handGrips.get(you) ?? {};
    anchors[side] = grip.current;
    handGrips.set(you, anchors);
    const anchor = grip.current;
    return () => {
      if (anchors[side] === anchor) delete anchors[side];
      if (!anchors.left && !anchors.right && handGrips.get(you) === anchors) handGrips.delete(you);
    };
  }, [you, side]);

  useFrame(({ camera }, delta) => {
    const dt = Math.min(delta, 0.05);
    const now = performance.now();
    const s = useShift.getState();
    const me = s.state?.players?.[s.you];
    const carrying = !!me?.held && (me.holdHand ?? 'right') === side;
    const frame = cam.enabled && cam.calibrated ? cam.frame : null;
    const index = frame?.handSides?.indexOf(side) ?? -1;
    const tracking = index >= 0;
    const aspect = frame?.aspect || 4 / 3;
    const { points, goal, transform, basis, shoulder, bend, elbow, axis, pole, direction, position, target, desired, world, across, along, normal } = data;
    if (tracking) {
      data.lastSeen = now;
      const face = frame.face;
      const width = face ? Math.hypot(face[234].x - face[454].x, (face[234].y - face[454].y) / aspect) : 0.155;
      trackedWrist(target, frame.hands[index], width, aspect);
      // Full-body mode synthesises hands from the pose wrists, so it has no real finger data.
      if (frame.synthetic || !trackedFingers(goal, frame.hands[index], frame.handWorld?.[index], aspect)) restingFingers(goal, side, carrying ? 0.75 : 0);
    } else if (now - data.lastSeen > 180 || carrying) {
      const ready = carrying || boxing;
      target.set(sign * (ready ? 0.22 : 0.29), ready ? -0.37 : -0.63, ready ? -0.39 : -0.21);
      restingFingers(goal, side, carrying ? 0.8 : 0);
    }
    desired.copy(target);
    if (!boxing && latestHandAction?.side === side) {
      const { time, kind, target: contact } = latestHandAction;
      const duration = kind === 'press' ? 290 : 390;
      const progress = (now - time) / duration;
      if (progress >= 0 && progress < 1) {
        world.fromArray(contact);
        camera.worldToLocal(world);
        // Bring the palm to the side of the object or below the fingertip's contact point.
        world.x += sign * (kind === 'press' ? 0.015 : 0.055);
        world.y -= kind === 'press' ? 0.065 : 0.014;
        world.z += 0.045;
        if (world.z < -0.12) desired.lerp(world, Math.sin(Math.PI * progress) * 0.85);
      }
    }
    if (boxing && strike.current.side === side) {
      const progress = (now - strike.current.time) / 230;
      if (progress >= 0 && progress < 1) desired.z -= Math.sin(Math.PI * progress) * 0.20;
    }
    position.lerp(desired, 1 - Math.exp(-17 * dt));
    wrist.current.position.copy(position);
    solveElbow(shoulder, wrist.current.position, elbow, bend, 0.32, 0.30, axis, pole);
    fitSegment(upperArm.current, shoulder, elbow, 0.050, direction);
    fitSegment(forearm.current, elbow, wrist.current.position, 0.036, direction);
    outer.current.visible = s.started;

    const alpha = 1 - Math.exp(-23 * dt);
    points.forEach((point, i) => point.lerp(goal[i], alpha));
    grip.current.position.copy(points[9]).multiplyScalar(0.63);
    along.copy(points[9]).normalize();
    if (boxing) {
      if (along.lengthSq() > 0.5) glove.current.quaternion.setFromUnitVectors(FORWARD, along);
      return;
    }
    across.copy(points[17]).sub(points[5]);
    normal.crossVectors(across, along).normalize();
    across.crossVectors(along, normal).normalize();
    palm.current.position.copy(grip.current.position).multiplyScalar(0.84);
    if (normal.lengthSq() > 0.5) palm.current.quaternion.setFromRotationMatrix(basis.makeBasis(across, along, normal));
    palm.current.scale.set(THREE.MathUtils.clamp(points[5].distanceTo(points[17]) * 0.57, 0.031, 0.050), 0.051, 0.015);

    for (const [finger, chain] of FINGERS.entries()) {
      const radius = radii[finger];
      for (let joint = 0; joint < 4; joint++) {
        const point = points[chain[joint]];
        const width = radius * (1 - joint * 0.09);
        transform.position.copy(point);
        transform.quaternion.identity();
        transform.scale.setScalar(width);
        transform.updateMatrix();
        joints.current.setMatrixAt(finger * 4 + joint, transform.matrix);
        if (joint === 3) continue;
        fitSegment(transform, point, points[chain[joint + 1]], width, direction);
        transform.updateMatrix();
        links.current.setMatrixAt(finger * 3 + joint, transform.matrix);
      }
    }
    links.current.instanceMatrix.needsUpdate = true;
    joints.current.instanceMatrix.needsUpdate = true;
  }, -2);

  return (
    <group ref={outer} visible={false}>
      <mesh ref={upperArm} geometry={segment} material={M.fabricBlue} />
      <mesh ref={forearm} geometry={segment} material={boxing ? M.fabricBlue : M.skin} />
      <group ref={wrist}>
        <group ref={grip} />
        {boxing ? <group ref={glove}><B s={[0.14, 0.13, 0.19]} p={[0, 0.016, -0.057]} m={M.fabricBlue} round={0.057} /></group> : <>
          <mesh ref={palm} geometry={sphere} material={M.skin} />
          <instancedMesh ref={links} args={[segment, M.skin, 15]} frustumCulled={false} />
          <instancedMesh ref={joints} args={[sphere, M.skin, 20]} frustumCulled={false} />
        </>}
      </group>
    </group>
  );
}

export default function TrackedHands({ boxing, strike }) {
  const rig = useRef();
  useFrame(({ camera }) => {
    rig.current.position.copy(camera.position);
    rig.current.quaternion.copy(camera.quaternion);
  }, -2);
  return (
    <group ref={rig}>
      <Hand side="left" boxing={boxing} strike={strike} />
      <Hand side="right" boxing={boxing} strike={strike} />
    </group>
  );
}
