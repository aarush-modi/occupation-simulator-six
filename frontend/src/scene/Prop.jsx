'use client';
// Renders a catalog recipe (see shared/schema.js `Recipe`) with the game's materials.
// Local frame: origin at the floor centre of the bounding box, +Y up, +Z faces the player.
import * as THREE from 'three';
import { memo, useMemo } from 'react';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { M } from '../game/materials';
import { ANCHORS } from '../shared/layout.js';

// Geometries are pure functions of the part's shape fields, so they are cached once per distinct shape and
// shared by every instance of every recipe (a catalog is a bounded set; geometries live for the session).
const GEO = new Map();

function shapeKey(part) {
  const { p, r, m, name, ...shape } = part; // eslint-disable-line no-unused-vars
  return JSON.stringify(shape);
}

// Default bevel when a box does not say: small enough to keep labels and slabs crisp, large enough to catch light.
function defaultRound(s) {
  const min = Math.min(...s);
  return min >= 0.04 ? Math.min(0.012, min * 0.1) : 0;
}

function buildGeometry(part) {
  switch (part.t) {
    case 'box': {
      const s = part.s;
      const round = part.round ?? defaultRound(s);
      const radius = Math.min(round, Math.min(...s) / 2 - 0.0005);
      if (radius > 0.0005) return new RoundedBoxGeometry(s[0], s[1], s[2], 3, radius);
      return new THREE.BoxGeometry(s[0], s[1], s[2]);
    }
    case 'cyl': {
      const seg = part.seg ?? (Math.max(part.rt, part.rb ?? part.rt) > 0.15 ? 48 : 32);
      return new THREE.CylinderGeometry(part.rt, part.rb ?? part.rt, part.h, seg);
    }
    case 'sph':
      return new THREE.SphereGeometry(part.rad, part.rad > 0.15 ? 40 : 28, part.rad > 0.15 ? 28 : 18);
    case 'cone':
      return new THREE.ConeGeometry(part.rad, part.h, 32);
    case 'torus': {
      const arc = Math.min(part.arc ?? Math.PI * 2, Math.PI * 2);
      return new THREE.TorusGeometry(part.R, part.tube, 14, Math.max(12, Math.round(48 * (arc / (Math.PI * 2)))), arc);
    }
    case 'capsule':
      return new THREE.CapsuleGeometry(part.rad, part.len, 8, 20);
    case 'lathe': {
      let pts = part.pts.map(([x, y]) => new THREE.Vector2(Math.max(0, x), y));
      // LatheGeometry faces outward when the profile runs bottom to top; flip top-to-bottom profiles.
      if (pts[0].y > pts[pts.length - 1].y) pts = pts.reverse();
      return new THREE.LatheGeometry(pts, part.seg ?? 40);
    }
    case 'tube': {
      const v = part.pts.map((q) => new THREE.Vector3(...q));
      const curve = v.length === 2 ? new THREE.LineCurve3(v[0], v[1]) : new THREE.CatmullRomCurve3(v, false, 'centripetal');
      const segs = v.length === 2 ? 1 : Math.min(160, Math.max(24, v.length * 12));
      return new THREE.TubeGeometry(curve, segs, part.rad, 12, false);
    }
    default:
      return null;
  }
}

export function partGeometry(part) {
  const key = shapeKey(part);
  let g = GEO.get(key);
  if (g === undefined) {
    g = buildGeometry(part);
    GEO.set(key, g);
  }
  return g;
}

const ZERO = [0, 0, 0];

function PartMesh({ part }) {
  if (part.t === 'repeat') {
    const step = part.step;
    return (
      <group position={part.p ?? ZERO} rotation={part.r ?? ZERO}>
        {Array.from({ length: part.n }, (_, i) => (
          <group key={i} position={[step[0] * i, step[1] * i, step[2] * i]}>
            <PartMesh part={part.part} />
          </group>
        ))}
      </group>
    );
  }
  const geometry = partGeometry(part);
  if (!geometry) return null;
  const material = M[part.m] ?? M.steel;
  // Glow materials are light sources: they should not darken what is behind them.
  const glow = material.isMeshBasicMaterial;
  return (
    <mesh
      name={part.name}
      geometry={geometry}
      material={material}
      position={part.p ?? ZERO}
      rotation={part.r ?? ZERO}
      scale={part.t === 'sph' && part.sy ? [1, part.sy, 1] : undefined}
      castShadow={!glow && !material.transparent}
      receiveShadow={!glow}
    />
  );
}

function PropImpl({ recipe, children, plated, ...groupProps }) {
  const parts = recipe?.parts;
  const meshes = useMemo(() => {
    const visible = recipe?.id === 'sushi_serving_plate' && plated === false
      ? parts.filter(part => part.name === 'getaBoard' || part.part?.name === 'getaFoot')
      : (parts ?? []);
    return visible.map((part, i) => <PartMesh key={i} part={part} />);
  }, [parts, plated, recipe?.id]);
  if (!recipe) return null;
  return (
    <group name={recipe.id} {...groupProps}>
      {meshes}
      {children}
    </group>
  );
}

const Prop = memo(PropImpl);
export default Prop;

// World placement for an anchor: spread onto a group as `position` + `rotation-y`.
export function placeAt(anchorId) {
  const a = ANCHORS[anchorId];
  if (!a) throw new Error(`unknown anchor ${anchorId}`);
  return { position: [...a.pos], rotationY: a.rotY ?? 0 };
}

// World-space XZ AABB ({ minX, maxX, minZ, maxZ }) of a recipe placed at an anchor, from its `size` [w, h, d].
export function recipeColliders(recipe, anchorId) {
  const { position, rotationY } = placeAt(anchorId);
  const [w, , d] = recipe.size;
  const c = Math.abs(Math.cos(rotationY));
  const s = Math.abs(Math.sin(rotationY));
  const hx = (w * c + d * s) / 2;
  const hz = (w * s + d * c) / 2;
  return { minX: position[0] - hx, maxX: position[0] + hx, minZ: position[2] - hz, maxZ: position[2] + hz };
}
