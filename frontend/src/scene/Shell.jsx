'use client';
// Room shells: one 14 x 11 x 3.4 m interior per SHELLS id (see shared/layout.js), with built-in supply counters,
// windows with daylight, the entrance door behind the spawn, ceiling fixtures and wall dressing that never touches
// an anchor footprint. Wall-hugging dressing stays within WALL_MARGIN of the wall; anything that stands on the
// floor uses one of the fixed FLOOR_SLOTS so the colliders below are exact for every shell.
import * as THREE from 'three';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Environment, Lightformer } from '@react-three/drei';
import { M } from '../game/materials';
import { B, C, S, Lathe, Tube } from '../game/parts';
import { ROOM, SUPPLY_COUNTERS, SHELL_IDS } from '../shared/layout.js';
import { surfaceTextures, paintedTexture, rng } from './textures';

const { W, D, H } = ROOM;
const HX = W / 2; // 7
const HZ = D / 2; // 5.5
const T = 0.24; // wall thickness (outside the room)
const WALL_MARGIN = 0.14; // wall dressing depth budget; the wall colliders include it
const PI = Math.PI;

// ---------------------------------------------------------------------------------------------------------------
// Colliders (XZ AABBs, same shape as game/world.js colliders)

// Floor-standing dressing lives only here: front strips beside the door and the two back corners.
const FLOOR_SLOTS = {
  F1: { pos: [-1.85, 5.18], size: [0.62, 0.56] },
  F2: { pos: [1.85, 5.18], size: [0.62, 0.56] },
  C1: { pos: [-6.55, -5.05], size: [0.8, 0.8] },
  C2: { pos: [6.55, -5.05], size: [0.8, 0.8] },
};
const aabb = (x, z, w, d) => ({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });

export const shellColliders = [
  aabb(0, -HZ - T / 2 + WALL_MARGIN / 2, W + 2 * T, T + WALL_MARGIN), // north
  aabb(0, HZ + T / 2 - WALL_MARGIN / 2, W + 2 * T, T + WALL_MARGIN), // south (front, door closed)
  aabb(HX + T / 2 - WALL_MARGIN / 2, 0, T + WALL_MARGIN, D + 2 * T), // east
  aabb(-HX - T / 2 + WALL_MARGIN / 2, 0, T + WALL_MARGIN, D + 2 * T), // west
  // counters, including the raised back ledge that runs to the wall
  ...SUPPLY_COUNTERS.map((c) => aabb(c.pos[0], (c.pos[2] - c.size[2] / 2 + HZ) / 2, c.size[0] + 0.04, HZ - (c.pos[2] - c.size[2] / 2))),
  ...Object.values(FLOOR_SLOTS).map((s) => aabb(s.pos[0], s.pos[1], s.size[0], s.size[1])),
];

// ---------------------------------------------------------------------------------------------------------------
// Geometry helpers

// UVs in meters from (local + offset) position, projected along the dominant normal axis, so a texture with
// repeat = 1/span tiles continuously across every slab of a wall.
function meterUV(geo, off = [0, 0, 0]) {
  const pos = geo.attributes.position, nor = geo.attributes.normal, uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + off[0], y = pos.getY(i) + off[1], z = pos.getZ(i) + off[2];
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    if (ny >= nx && ny >= nz) uv.setXY(i, x, -z);
    else if (nx >= nz) uv.setXY(i, z * Math.sign(nor.getX(i) || 1) * -1, y);
    else uv.setXY(i, x * Math.sign(nor.getZ(i) || 1), y);
  }
  uv.needsUpdate = true;
  return geo;
}

// Ceiling-mounted and in-wall geometry must not cast: the key light is a directional 'ceiling' light from above.
function NoCast({ children }) {
  const ref = useRef();
  useLayoutEffect(() => {
    ref.current?.traverse((o) => { o.castShadow = false; });
  });
  return <group ref={ref}>{children}</group>;
}

function Slab({ s, p = [0, 0, 0], mat, cast = false }) {
  const geo = useMemo(() => meterUV(new THREE.BoxGeometry(s[0], s[1], s[2]), p), [s[0], s[1], s[2], p[0], p[1], p[2]]); // eslint-disable-line react-hooks/exhaustive-deps
  return <mesh geometry={geo} position={p} material={mat} receiveShadow castShadow={cast} />;
}

// Subtract rectangular holes from a rectangle: returns [x0, x1, y0, y1] pieces (vertical strips, merged).
function cutRect(x0, x1, y0, y1, holes) {
  const xs = new Set([x0, x1]);
  for (const h of holes) {
    if (h.x0 > x0 && h.x0 < x1) xs.add(h.x0);
    if (h.x1 > x0 && h.x1 < x1) xs.add(h.x1);
  }
  const sx = [...xs].sort((a, b) => a - b);
  const strips = [];
  for (let i = 0; i < sx.length - 1; i++) {
    const a = sx[i], b = sx[i + 1];
    const cover = holes.filter((h) => h.x0 <= a + 1e-6 && h.x1 >= b - 1e-6 && h.y1 > y0 && h.y0 < y1).sort((p, q) => p.y0 - q.y0);
    const ys = [];
    let y = y0;
    for (const h of cover) {
      if (h.y0 > y) ys.push([y, Math.min(h.y0, y1)]);
      y = Math.max(y, h.y1);
    }
    if (y < y1) ys.push([y, y1]);
    strips.push({ a, b, ys });
  }
  const out = [];
  // merge neighbouring strips with identical vertical pieces
  for (let i = 0; i < strips.length; i++) {
    const st = strips[i];
    let b = st.b;
    while (i + 1 < strips.length && JSON.stringify(strips[i + 1].ys) === JSON.stringify(st.ys)) b = strips[++i].b;
    for (const [ya, yb] of st.ys) if (yb - ya > 1e-4) out.push([st.a, b, ya, yb]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Materials

const MATS = new Map();
function surf(key, { tex, opts, span = 1, ...params }) {
  let mat = MATS.get(key);
  if (mat) return mat;
  const { bumpScale = 1, rough = 0.7, metal = 0, clearcoat = 0, ccRough = 0.25, env = 1, color = '#ffffff', sheen, sheenColor, ...rest } = params;
  const base = tex ? surfaceTextures(tex, opts) : null;
  const rep = (t) => {
    if (!t) return null;
    const c = t.clone();
    c.repeat.set(1 / span, 1 / span);
    c.needsUpdate = true;
    return c;
  };
  mat = new THREE.MeshPhysicalMaterial({
    color, roughness: rough, metalness: metal, clearcoat, clearcoatRoughness: ccRough, envMapIntensity: env,
    map: rep(base?.map), bumpMap: rep(base?.bump), bumpScale,
    ...(sheen ? { sheen, sheenColor: new THREE.Color(sheenColor ?? '#ffffff') } : {}),
    ...rest,
  });
  MATS.set(key, mat);
  return mat;
}
function flat(key, color, params = {}) {
  let mat = MATS.get('flat:' + key);
  if (!mat) {
    mat = new THREE.MeshPhysicalMaterial({ color, roughness: params.rough ?? 0.6, metalness: params.metal ?? 0, clearcoat: params.clearcoat ?? 0, clearcoatRoughness: 0.3, side: params.side ?? THREE.FrontSide, ...(params.extra ?? {}) });
    MATS.set('flat:' + key, mat);
  }
  return mat;
}
function glowMat(key, color, k) {
  let mat = MATS.get('glow:' + key);
  if (!mat) {
    mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), toneMapped: false, side: THREE.DoubleSide });
    MATS.set('glow:' + key, mat);
  }
  return mat;
}
function texMat(key, tex, { glow = 0, rough = 0.5, transparent = false, side = THREE.FrontSide } = {}) {
  let mat = MATS.get('tex:' + key);
  if (!mat) {
    mat = glow
      ? new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(1, 1, 1).multiplyScalar(glow), toneMapped: false, transparent, side })
      : new THREE.MeshPhysicalMaterial({ map: tex, roughness: rough, transparent, clearcoat: 0.2, side });
    MATS.set('tex:' + key, mat);
  }
  return mat;
}
// Floor paint (lines) sits a hair above the floor; polygon offset removes any z-fighting.
function paintMat(key, color) {
  let mat = MATS.get('paint:' + key);
  if (!mat) {
    mat = new THREE.MeshPhysicalMaterial({ color, roughness: 0.55, clearcoat: 0.3, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    MATS.set('paint:' + key, mat);
  }
  return mat;
}

// ---------------------------------------------------------------------------------------------------------------
// Painted graphics

const FONT = '"Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif';
const SERIF = 'Georgia, "Times New Roman", serif';

function signTexture(key, { w = 1024, h = 256, bg = '#1d1f22', fg = '#ffffff', lines, border, draw }) {
  return paintedTexture('sign:' + key, w, h, (g, cw, ch, r) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, cw, ch);
    if (draw) draw(g, cw, ch, r);
    if (border) {
      g.strokeStyle = border;
      g.lineWidth = ch * 0.03;
      g.strokeRect(ch * 0.05, ch * 0.05, cw - ch * 0.1, ch - ch * 0.1);
    }
    for (const L of lines ?? []) {
      g.fillStyle = L.color ?? fg;
      g.font = `${L.weight ?? 700} ${L.size * ch}px ${L.font ?? FONT}`;
      g.textAlign = L.align ?? 'center';
      g.textBaseline = 'middle';
      if (L.spacing) g.letterSpacing = `${L.spacing}px`;
      g.fillText(L.text, L.x !== undefined ? L.x * cw : cw / 2, L.y * ch);
      g.letterSpacing = '0px';
    }
  });
}

// Daylit exterior seen through windows: sky, hazy city, trees, pavement. Horizon is at 35 % height.
function exteriorTexture(kind) {
  return paintedTexture('exterior:' + kind, 2048, 1024, (g, w, h, r) => {
    const hz = h * 0.65;
    const sky = g.createLinearGradient(0, 0, 0, hz);
    sky.addColorStop(0, '#7fa8d6');
    sky.addColorStop(0.6, '#bcd3e8');
    sky.addColorStop(1, '#eef1ee');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, hz);
    // soft clouds
    for (let i = 0; i < 26; i++) {
      const x = r() * w, y = r() * hz * 0.6, rx = 80 + r() * 220, ry = 18 + r() * 40;
      const gr = g.createRadialGradient(x, y, 0, x, y, rx);
      gr.addColorStop(0, 'rgba(255,255,255,0.55)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.save(); g.translate(x, y); g.scale(1, ry / rx); g.translate(-x, -y);
      g.fillRect(x - rx, y - rx, rx * 2, rx * 2); g.restore();
    }
    // far buildings (hazy), then near buildings
    for (const [n, haze, minH, maxH] of [[34, 0.72, 60, 260], [18, 0.45, 120, 380]]) {
      for (let i = 0; i < n; i++) {
        const bw = 60 + r() * 160, bh = minH + r() * (maxH - minH), x = r() * w;
        const base = kind === 'industrial' ? [150, 146, 140] : [128 + r() * 40, 120 + r() * 30, 112 + r() * 30];
        const c = base.map((v) => Math.round(v * (1 - haze) + 220 * haze));
        g.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
        g.fillRect(x, hz - bh, bw, bh);
        g.fillStyle = `rgba(255,255,255,${0.18 * (1 - haze)})`;
        for (let yy = hz - bh + 12; yy < hz - 14; yy += 22) for (let xx = x + 8; xx < x + bw - 12; xx += 18) if (r() > 0.25) g.fillRect(xx, yy, 9, 11);
      }
    }
    // tree line
    for (let i = 0; i < 70; i++) {
      const x = r() * w, rad = 14 + r() * 26;
      g.fillStyle = `rgba(${70 + r() * 30},${100 + r() * 30},${60 + r() * 20},0.95)`;
      g.beginPath(); g.ellipse(x, hz - rad * 0.4, rad, rad * 0.9, 0, 0, PI * 2); g.fill();
    }
    // pavement / street
    const gr = g.createLinearGradient(0, hz, 0, h);
    gr.addColorStop(0, '#a8a7a1');
    gr.addColorStop(1, '#7d7c78');
    g.fillStyle = gr;
    g.fillRect(0, hz, w, h - hz);
    g.fillStyle = 'rgba(255,255,255,0.35)';
    for (let x = 0; x < w; x += 160) g.fillRect(x, hz + 60, 90, 6);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Shell configurations

const WIN_SIDE = { c: 2.9, w: 2.4, y0: 1.05, y1: 2.65 }; // free wall zone between the side anchors and the counters
const DOOR = { c: 0, w: 1.8, y0: 0, y1: 2.2 };

const CFG = {
  sushi: {
    floor: { tex: 'planks', opts: { seed: 91, n: 12, color: '#a77b52', vary: 0.11, gap: '#4a3025' }, span: 2.1, rough: 0.5, clearcoat: 0.27, bumpScale: 0.9 },
    wall: { tex: 'plaster', opts: { seed: 92, color: '#e9d7b9' }, span: 2.6, rough: 0.88, bumpScale: 0.43 },
    dado: { y: 1.12, tex: 'planks', opts: { seed: 93, n: 8, color: '#664230', vary: 0.13, gap: '#321f18' }, span: 1.4, rough: 0.62, rail: 'woodDark' },
    ceiling: { tex: 'planks', opts: { seed: 94, n: 9, color: '#554233', vary: 0.10, gap: '#38291f' }, span: 2.4, rough: 0.8 },
    beams: 'woodDark',
    skirting: { m: 'woodDark', h: 0.12 },
    counter: { style: 'cabinet', body: 'woodDark', front: 'woodLight', top: 'woodLight', handle: 'brass', noShelves: true },
    lights: { kind: 'lantern', color: '#ffcf91' },
    windows: { W: [WIN_SIDE], E: [WIN_SIDE] },
    door: { m: 'woodDark', glass: true },
    frame: 'woodDark',
    light: { warm: '#ffc995', cool: '#dce8ff', hemi: ['#ffe9cf', '#5c4131', 0.68], key: 2.12, fill: 0.65, point: 7, env: '#412d28' },
  },
  cafe: {
    floor: { tex: 'tiles', opts: { seed: 11, nx: 10, ny: 10, color: ['#8c6a5b', '#836152', '#93715f', '#7b5a4b'], vary: 0.05, grout: '#5e5249', groutPx: 5 }, span: 2, rough: 0.62, clearcoat: 0.12, ccRough: 0.4, bumpScale: 1.5 },
    wall: { tex: 'plaster', opts: { seed: 12, color: '#eadcc6' }, span: 3, rough: 0.9, bumpScale: 0.6 },
    dado: { y: 1.0, tex: 'tiles', opts: { seed: 13, nx: 4, ny: 8, color: '#f3f0e8', vary: 0.025, grout: '#cfc8bb', groutPx: 4, offset: 0.5 }, span: 0.6, rough: 0.2, clearcoat: 0.8, bumpScale: 1.2, rail: 'woodDark' },
    ceiling: { tex: 'plaster', opts: { seed: 14, color: '#f2ede4' }, span: 3, rough: 0.95 },
    beams: 'woodDark',
    skirting: { m: 'tileDark', h: 0.12 },
    counter: { style: 'cabinet', body: 'woodDark', front: 'woodDark', top: 'marble', handle: 'brass', splash: 'tileWhite' },
    lights: { kind: 'pendant', color: '#ffd2a0' },
    windows: { E: [WIN_SIDE], W: [WIN_SIDE] },
    door: { m: 'woodDark', glass: true },
    frame: 'black',
    light: { warm: '#ffc690', cool: '#d4e2ff', hemi: ['#ffe8cf', '#5a3a28', 0.55], key: 2.3, fill: 0.9, point: 7, env: '#3b2c22' },
  },
  warehouse: {
    floor: { tex: 'concrete', opts: { seed: 21, color: '#7d7a74', joints: true }, span: 4, rough: 0.6, clearcoat: 0.18, bumpScale: 0.8 },
    wall: { tex: 'ribbed', opts: { seed: 22, color: '#d4d7d8', n: 8 }, span: 1.6, rough: 0.5, metal: 0.4, bumpScale: 2 },
    dado: { y: 1.2, tex: 'tiles', opts: { seed: 23, nx: 2, ny: 4, color: '#8e9297', vary: 0.04, grout: '#a3a6a9', groutPx: 6, offset: 0.5, bevel: 0.6 }, span: 0.8, rough: 0.85, bumpScale: 2, rail: null },
    ceiling: { tex: 'ribbed', opts: { seed: 24, color: '#4a4d50', n: 6 }, span: 1.2, rough: 0.6, metal: 0.5 },
    joists: true,
    skirting: null,
    counter: { style: 'bench', body: 'darkSteel', top: 'woodLight', handle: 'steel' },
    lights: { kind: 'linear', color: '#eef3ff' },
    windows: { N: [{ c: -4.7, w: 2.6, y0: 2.72, y1: 3.2 }, { c: 0, w: 2.6, y0: 2.72, y1: 3.2 }, { c: 4.7, w: 2.6, y0: 2.72, y1: 3.2 }], W: [WIN_SIDE] },
    roller: 'E',
    door: { m: 'steel', glass: false },
    frame: 'darkSteel',
    exterior: 'industrial',
    light: { warm: '#ffe2c0', cool: '#dce8ff', hemi: ['#e8eef7', '#4a4640', 0.6], key: 2.4, fill: 0.9, point: 6, env: '#3a3c3e' },
  },
  shop: {
    floor: { tex: 'planks', opts: { seed: 31, n: 13, color: '#9a7d62', vary: 0.12, gap: '#3d2a1a' }, span: 2.4, rough: 0.45, clearcoat: 0.45, bumpScale: 1.2 },
    wall: { tex: 'plaster', opts: { seed: 32, color: '#efe8dc' }, span: 3, rough: 0.9, bumpScale: 0.5 },
    dado: { y: 1.0, tex: 'planks', opts: { seed: 33, n: 9, color: '#b9c7b5', vary: 0.02, gap: '#7f8c7c' }, span: 1.2, rough: 0.55, clearcoat: 0.2, bumpScale: 1.5, rail: 'white' },
    ceiling: { tex: 'plaster', opts: { seed: 34, color: '#f4f1ea' }, span: 3, rough: 0.95 },
    skirting: { m: 'white', h: 0.14 },
    counter: { style: 'cabinet', body: 'woodLight', front: 'woodLight', top: 'woodDark', handle: 'brass', noShelves: true },
    lights: { kind: 'track', color: '#ffe0b8' },
    windows: { S: [{ c: -3.95, w: 5.3, y0: 1.08, y1: 3.0 }, { c: 3.95, w: 5.3, y0: 1.08, y1: 3.0 }] },
    door: { m: 'black', glass: true, full: true },
    frame: 'black',
    light: { warm: '#ffd09a', cool: '#d8e6ff', hemi: ['#fff1de', '#5b4632', 0.6], key: 2.3, fill: 0.8, point: 6, env: '#463a2e', fromFront: true },
  },
  clinic: {
    floor: { tex: 'chips', opts: { seed: 41, color: '#cfd5d8', chipColors: ['#9aa4aa', '#ffffff', '#b7c1c6'], n: 9000, min: 0.6, max: 1.8, alpha: 0.45, mott: 0.04 }, span: 2, rough: 0.3, clearcoat: 0.5 },
    wall: { tex: 'plaster', opts: { seed: 42, color: '#f2f3f1' }, span: 3, rough: 0.85, bumpScale: 0.3 },
    dado: { y: 0.95, tex: 'plaster', opts: { seed: 43, color: '#a9cfca' }, span: 3, rough: 0.6, rail: 'woodLight', railH: 0.14 },
    ceiling: { tex: 'ceilingGrid', opts: { seed: 44 }, span: 1.2, rough: 0.95, bumpScale: 1 },
    skirting: { m: 'plasticGrey', h: 0.1, cove: true },
    counter: { style: 'cabinet', body: 'plasticWhite', front: 'plasticWhite', top: 'marble', handle: 'stainless', splash: 'plasticWhite' },
    lights: { kind: 'panel', color: '#f2f6ff' },
    windows: { E: [WIN_SIDE], W: [WIN_SIDE] },
    blinds: true,
    door: { m: 'plasticWhite', glass: true },
    frame: 'plasticWhite',
    light: { warm: '#fff0dc', cool: '#e4eeff', hemi: ['#f4f7ff', '#7a7570', 0.7], key: 2.2, fill: 0.9, point: 5, env: '#585c60' },
  },
  lab: {
    floor: { tex: 'chips', opts: { seed: 51, color: '#8f9aa1', chipColors: ['#5f6a70', '#c9d0d4', '#7a858b'], n: 7000, min: 0.6, max: 1.6, alpha: 0.5, mott: 0.05 }, span: 2, rough: 0.2, clearcoat: 0.9 },
    wall: { tex: 'plaster', opts: { seed: 52, color: '#f0f1f0' }, span: 3, rough: 0.8, bumpScale: 0.3 },
    dado: { y: 1.0, tex: 'plaster', opts: { seed: 53, color: '#d5dadd' }, span: 3, rough: 0.6, rail: 'stainless', railH: 0.05 },
    ceiling: { tex: 'ceilingGrid', opts: { seed: 54 }, span: 1.2, rough: 0.95, bumpScale: 1 },
    skirting: { m: 'tileDark', h: 0.1, cove: true },
    counter: { style: 'cabinet', body: 'plasticWhite', front: 'plasticGrey', top: 'tileDark', handle: 'stainless', splash: 'tileDark' },
    lights: { kind: 'panel', color: '#eef4ff' },
    windows: { E: [WIN_SIDE], W: [WIN_SIDE] },
    door: { m: 'plasticGrey', glass: true },
    frame: 'stainless',
    services: true,
    light: { warm: '#fff4e6', cool: '#e0ecff', hemi: ['#f0f5ff', '#6a6d70', 0.7], key: 2.2, fill: 1.0, point: 5, env: '#51575c' },
  },
  workshop: {
    floor: { tex: 'concrete', opts: { seed: 61, color: '#706b63', joints: true, stains: 10 }, span: 4, rough: 0.8, clearcoat: 0.08, bumpScale: 1 },
    wall: { tex: 'tiles', opts: { seed: 62, nx: 2, ny: 4, color: '#d8d4cb', vary: 0.03, grout: '#bdb8ae', groutPx: 6, offset: 0.5, bevel: 0.6 }, span: 0.8, rough: 0.85, bumpScale: 2 },
    dado: { y: 1.2, tex: 'tiles', opts: { seed: 63, nx: 2, ny: 4, color: '#5d6268', vary: 0.03, grout: '#4c5156', groutPx: 6, offset: 0.5, bevel: 0.6 }, span: 0.8, rough: 0.8, bumpScale: 2, rail: 'yellow', railH: 0.1 },
    ceiling: { tex: 'ribbed', opts: { seed: 64, color: '#55585b', n: 6 }, span: 1.2, rough: 0.6, metal: 0.5 },
    joists: true,
    skirting: null,
    counter: { style: 'chest', body: 'red', front: 'red', top: 'woodLight', handle: 'chrome' },
    lights: { kind: 'linear', color: '#f2f5ff' },
    windows: { N: [{ c: -4.7, w: 2.6, y0: 2.72, y1: 3.2 }, { c: 0, w: 2.6, y0: 2.72, y1: 3.2 }, { c: 4.7, w: 2.6, y0: 2.72, y1: 3.2 }] },
    roller: 'E',
    pegboard: 'W',
    door: { m: 'darkSteel', glass: false },
    frame: 'darkSteel',
    exterior: 'industrial',
    light: { warm: '#ffdcb0', cool: '#dbe6ff', hemi: ['#e6ecf5', '#3e3a35', 0.6], key: 2.4, fill: 0.9, point: 6, env: '#38393a' },
  },
  office: {
    floor: { tex: 'carpet', opts: { seed: 71, color: '#40444b', alt: '#383c43' }, span: 1, rough: 0.98, bumpScale: 1.2, sheen: 0.4, sheenColor: '#9aa3b0' },
    wall: { tex: 'plaster', opts: { seed: 72, color: '#f0eee9' }, span: 3, rough: 0.85, bumpScale: 0.3 },
    accent: { side: 'N', tex: 'plaster', opts: { seed: 75, color: '#3d4b5f' }, span: 3, rough: 0.8 },
    ceiling: { tex: 'ceilingGrid', opts: { seed: 74 }, span: 1.2, rough: 0.95, bumpScale: 1 },
    skirting: { m: 'plasticBlack', h: 0.08 },
    counter: { style: 'cabinet', body: 'plasticWhite', front: 'plasticWhite', top: 'woodLight', handle: 'plasticBlack' },
    lights: { kind: 'panel', color: '#f6f8ff' },
    windows: { E: [{ ...WIN_SIDE, y0: 0.8, y1: 2.8 }], W: [{ ...WIN_SIDE, y0: 0.8, y1: 2.8 }] },
    blinds: true,
    door: { m: 'woodLight', glass: true },
    frame: 'black',
    light: { warm: '#fff0dd', cool: '#e2ecff', hemi: ['#f3f6ff', '#5c5650', 0.65], key: 2.2, fill: 1.0, point: 5, env: '#4a4d52' },
  },
  salon: {
    floor: { tex: 'chips', opts: { seed: 81, color: '#e9e2d7', chipColors: ['#b9a58f', '#8f8a84', '#ffffff', '#c98f7a', '#6b665f'], n: 3200, min: 1.5, max: 5, alpha: 0.75, mott: 0.04 }, span: 2, rough: 0.12, clearcoat: 1, ccRough: 0.08 },
    wall: { tex: 'plaster', opts: { seed: 82, color: '#e7d2c4' }, span: 3, rough: 0.92, bumpScale: 0.8 },
    ceiling: { tex: 'plaster', opts: { seed: 84, color: '#f5efe8' }, span: 3, rough: 0.95 },
    skirting: { m: 'brass', h: 0.06 },
    counter: { style: 'cabinet', body: 'woodLight', front: 'woodLight', top: 'marble', handle: 'brass', splash: 'marble' },
    lights: { kind: 'globe', color: '#ffe0bf' },
    windows: { W: [WIN_SIDE] },
    slats: 'E',
    door: { m: 'brass', glass: true, full: true },
    frame: 'brass',
    light: { warm: '#ffc896', cool: '#dfe8ff', hemi: ['#ffeede', '#6a4a3c', 0.6], key: 2.1, fill: 0.8, point: 7, env: '#4a3a33' },
  },
};

const sideMat = (cfg, side) => (cfg.accent && cfg.accent.side === side ? cfg.accent : cfg.wall);
const mk = (id, part, def) => surf(`${id}:${part}`, def);

// ---------------------------------------------------------------------------------------------------------------
// Walls with openings. A wall is built in its own frame: x along the wall, interior face at z = 0, +z into the room.

const SIDES = {
  N: { pos: [0, 0, -HZ], rot: 0, len: W + 2 * T, toLocal: (c) => c },
  S: { pos: [0, 0, HZ], rot: PI, len: W + 2 * T, toLocal: (c) => -c },
  E: { pos: [HX, 0, 0], rot: -PI / 2, len: D, toLocal: (c) => c },
  W: { pos: [-HX, 0, 0], rot: PI / 2, len: D, toLocal: (c) => -c },
};

function openingsFor(cfg, side) {
  const list = (cfg.windows[side] ?? []).map((o) => ({ ...o, type: 'window' }));
  if (side === 'S') list.push({ ...DOOR, type: 'door' });
  if (cfg.roller === side) list.push({ c: 2.9, w: 2.6, y0: 0, y1: 2.8, type: 'roller' });
  return list.map((o) => {
    const lc = SIDES[side].toLocal(o.c);
    return { ...o, x0: lc - o.w / 2, x1: lc + o.w / 2 };
  });
}

function Wall({ id, cfg, side }) {
  const sd = SIDES[side];
  const holes = openingsFor(cfg, side);
  const L = sd.len;
  const main = mk(id, 'wall' + (cfg.accent?.side === side ? 'A' : ''), sideMat(cfg, side));
  const dado = cfg.dado && !(cfg.accent?.side === side) ? mk(id, 'dado', cfg.dado) : null;
  const yd = dado ? cfg.dado.y : 0;
  const pieces = [];
  if (dado) for (const [x0, x1, y0, y1] of cutRect(-L / 2, L / 2, 0, yd, holes)) pieces.push({ x0, x1, y0, y1, mat: dado });
  for (const [x0, x1, y0, y1] of cutRect(-L / 2, L / 2, yd, H + 0.02, holes)) pieces.push({ x0, x1, y0, y1, mat: main });
  const railM = cfg.dado?.rail ? M[cfg.dado.rail] : null;
  const railH = cfg.dado?.railH ?? 0.045;
  const inner = side === 'E' || side === 'W' ? [-HZ, HZ] : [-HX, HX];
  const lim = (x0, x1) => [Math.max(x0, inner[0]), Math.min(x1, inner[1])];
  return (
    <group position={sd.pos} rotation-y={sd.rot}>
      {pieces.map((p, i) => (
        <Slab key={i} s={[p.x1 - p.x0, p.y1 - p.y0, T]} p={[(p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2, -T / 2]} mat={p.mat} />
      ))}
      {railM && dado && cutRect(...lim(-L / 2, L / 2), yd - railH / 2, yd + railH / 2, holes).map(([x0, x1], i) => (
        <B key={'rail' + i} s={[x1 - x0, railH, 0.03]} p={[(x0 + x1) / 2, yd, 0.015]} m={railM} round={0.008} />
      ))}
      {cfg.skirting && cutRect(...lim(-L / 2, L / 2), 0, cfg.skirting.h, holes).map(([x0, x1], i) => (
        <group key={'sk' + i}>
          <B s={[x1 - x0, cfg.skirting.h, 0.018]} p={[(x0 + x1) / 2, cfg.skirting.h / 2, 0.009]} m={M[cfg.skirting.m]} round={0.004} />
          {cfg.skirting.cove && <mesh position={[(x0 + x1) / 2, 0.02, 0.02]} rotation={[0, 0, PI / 2]} material={M[cfg.skirting.m]} receiveShadow><cylinderGeometry args={[0.02, 0.02, x1 - x0, 8, 1, false, 0, PI / 2]} /></mesh>}
        </group>
      ))}
      {holes.map((o, i) => {
        if (o.type === 'window') return <Window key={i} id={id} cfg={cfg} o={o} />;
        if (o.type === 'door') return <Door key={i} cfg={cfg} o={o} />;
        if (o.type === 'roller') return <RollerDoor key={i} o={o} />;
        return null;
      })}
      {holes.length > 0 && <Exterior cfg={cfg} len={L} />}
    </group>
  );
}

function Exterior({ cfg, len }) {
  const mat = texMat('ext:' + (cfg.exterior ?? 'city'), exteriorTexture(cfg.exterior ?? 'city'), { glow: 1.35 });
  return (
    <mesh position={[0, 2.2, -5]} material={mat}>
      <planeGeometry args={[len + 16, 11]} />
    </mesh>
  );
}

function Window({ id, cfg, o }) {
  const fm = M[cfg.frame] ?? M.black;
  const w = o.x1 - o.x0, h = o.y1 - o.y0, cx = (o.x0 + o.x1) / 2, cy = (o.y0 + o.y1) / 2;
  const f = 0.055; // frame member
  const n = Math.max(1, Math.round(w / 1.25)); // panes
  const tall = h > 1;
  const sillM = cfg.dado?.rail ? M[cfg.dado.rail] : M.white;
  return (
    <group>
      {/* frame */}
      <B s={[w, f, 0.1]} p={[cx, o.y0 + f / 2, -T * 0.55]} m={fm} round={0.006} />
      <B s={[w, f, 0.1]} p={[cx, o.y1 - f / 2, -T * 0.55]} m={fm} round={0.006} />
      <B s={[f, h, 0.1]} p={[o.x0 + f / 2, cy, -T * 0.55]} m={fm} round={0.006} />
      <B s={[f, h, 0.1]} p={[o.x1 - f / 2, cy, -T * 0.55]} m={fm} round={0.006} />
      {Array.from({ length: n - 1 }, (_, i) => (
        <B key={i} s={[f * 0.8, h, 0.09]} p={[o.x0 + (w / n) * (i + 1), cy, -T * 0.55]} m={fm} round={0.006} />
      ))}
      {tall && h > 1.6 && <B s={[w, f * 0.7, 0.08]} p={[cx, o.y0 + h * 0.72, -T * 0.55]} m={fm} round={0.005} />}
      <mesh position={[cx, cy, -T * 0.55]} material={M.glassClear}>
        <planeGeometry args={[w, h]} />
      </mesh>
      {/* sill */}
      {tall && <B s={[w + 0.12, 0.035, T * 0.5 + 0.06]} p={[cx, o.y0 - 0.0175, -T * 0.25 + 0.03]} m={o.y0 > 1.02 && cfg.dado ? sillM : M.white} round={0.008} />}
      {tall && cfg.blinds && <Blinds o={o} />}
    </group>
  );
}

function Blinds({ o }) {
  const w = o.x1 - o.x0 - 0.06, cx = (o.x0 + o.x1) / 2;
  const drop = (o.y1 - o.y0) * 0.42;
  const n = Math.floor(drop / 0.045);
  const slatM = flat('blind', '#ecebe6', { rough: 0.5, metal: 0.1 });
  return (
    <group position={[cx, 0, -0.03]}>
      <B s={[w + 0.04, 0.05, 0.05]} p={[0, o.y1 - 0.06, 0]} m={M.plasticWhite} round={0.01} />
      {Array.from({ length: n }, (_, i) => (
        <mesh key={i} position={[0, o.y1 - 0.11 - i * 0.045, 0]} rotation-x={-0.5} material={slatM} castShadow>
          <boxGeometry args={[w, 0.003, 0.025]} />
        </mesh>
      ))}
      <B s={[w + 0.02, 0.02, 0.035]} p={[0, o.y1 - 0.12 - n * 0.045, 0]} m={M.plasticWhite} round={0.006} />
    </group>
  );
}

function Door({ cfg, o }) {
  const dm = M[cfg.door.m] ?? M.woodDark;
  const fm = M[cfg.frame] ?? M.black;
  const lw = (o.x1 - o.x0) / 2 - 0.02;
  const lh = o.y1 - 0.02;
  const leaf = (sx) => {
    const x = sx * (lw / 2 + 0.01);
    if (cfg.door.full) {
      // full glass leaf in a slim frame
      return (
        <group key={sx} position={[x, 0, -T / 2]}>
          <B s={[lw, 0.06, 0.05]} p={[0, lh - 0.03, 0]} m={dm} round={0.005} />
          <B s={[lw, 0.14, 0.05]} p={[0, 0.07, 0]} m={dm} round={0.005} />
          <B s={[0.06, lh, 0.05]} p={[-lw / 2 + 0.03, lh / 2, 0]} m={dm} round={0.005} />
          <B s={[0.06, lh, 0.05]} p={[lw / 2 - 0.03, lh / 2, 0]} m={dm} round={0.005} />
          <mesh position={[0, lh / 2 + 0.04, 0]} material={M.glassClear}><planeGeometry args={[lw - 0.1, lh - 0.18]} /></mesh>
          <C rt={0.014} h={0.9} p={[-sx * (lw / 2 - 0.12), 1.05, 0.08]} m={M.chrome} seg={16} />
          <C rt={0.009} h={0.06} p={[-sx * (lw / 2 - 0.12), 0.7, 0.05]} r={[PI / 2, 0, 0]} m={M.chrome} seg={10} />
          <C rt={0.009} h={0.06} p={[-sx * (lw / 2 - 0.12), 1.4, 0.05]} r={[PI / 2, 0, 0]} m={M.chrome} seg={10} />
        </group>
      );
    }
    return (
      <group key={sx} position={[x, 0, -T / 2]}>
        <B s={[lw, lh, 0.05]} p={[0, lh / 2, 0]} m={dm} round={0.006} />
        {cfg.door.glass && (
          <>
            <B s={[0.32, 0.86, 0.054]} p={[0, 1.42, 0]} m={M.black} round={0.004} />
            <mesh position={[0, 1.42, 0.028]} material={M.glassClear}><planeGeometry args={[0.28, 0.82]} /></mesh>
          </>
        )}
        {/* kick plate and push bar */}
        <B s={[lw - 0.06, 0.22, 0.004]} p={[0, 0.13, 0.027]} m={M.stainless} round={0} />
        <C rt={0.018} h={lw - 0.2} p={[0, 1.0, 0.08]} r={[0, 0, PI / 2]} m={M.stainless} seg={16} />
        <B s={[0.05, 0.06, 0.06]} p={[-lw / 2 + 0.12, 1.0, 0.055]} m={M.stainless} />
        <B s={[0.05, 0.06, 0.06]} p={[lw / 2 - 0.12, 1.0, 0.055]} m={M.stainless} />
      </group>
    );
  };
  const exit = signTexture('exit', { w: 512, h: 160, bg: '#0f7a3a', lines: [{ text: 'EXIT', size: 0.62, y: 0.54, weight: 800, spacing: 18 }] });
  return (
    <group>
      {leaf(-1)}
      {leaf(1)}
      {/* architrave */}
      <B s={[0.08, o.y1 + 0.08, 0.03]} p={[o.x0 - 0.04, (o.y1 + 0.08) / 2, 0.015]} m={fm} round={0.006} />
      <B s={[0.08, o.y1 + 0.08, 0.03]} p={[o.x1 + 0.04, (o.y1 + 0.08) / 2, 0.015]} m={fm} round={0.006} />
      <B s={[o.x1 - o.x0 + 0.16, 0.08, 0.03]} p={[0, o.y1 + 0.04, 0.015]} m={fm} round={0.006} />
      <B s={[o.x1 - o.x0, 0.012, T + 0.06]} p={[0, 0.006, -T / 2 + 0.03]} m={M.stainless} round={0.004} />
      {/* exit sign */}
      <B s={[0.44, 0.16, 0.05]} p={[0, o.y1 + 0.3, 0.03]} m={M.plasticWhite} round={0.01} />
      <mesh position={[0, o.y1 + 0.3, 0.056]} material={texMat('exit', exit, { glow: 1.6 })}><planeGeometry args={[0.4, 0.125]} /></mesh>
      {/* closer arms */}
      {[-1, 1].map((sx) => <B key={sx} s={[0.28, 0.05, 0.05]} p={[sx * 0.45, o.y1 - 0.1, 0.03]} m={M.plasticGrey} round={0.01} />)}
    </group>
  );
}

function RollerDoor({ o }) {
  const w = o.x1 - o.x0, cx = (o.x0 + o.x1) / 2;
  const slatM = surf('roller', { tex: 'ribbed', opts: { seed: 91, color: '#b7bcc0', n: 2 }, span: 0.25, rough: 0.45, metal: 0.6, bumpScale: 3 });
  const n = 26, sh = (o.y1 - 0.05) / n;
  return (
    <group position={[cx, 0, 0]}>
      {/* horizontal slats, rotated texture via a group */}
      {Array.from({ length: n }, (_, i) => (
        <mesh key={i} position={[0, 0.05 + sh * (i + 0.5), -T * 0.45]} rotation-z={PI / 2} material={slatM} receiveShadow>
          <boxGeometry args={[sh * 0.96, w, 0.04]} />
        </mesh>
      ))}
      <B s={[w, 0.06, 0.06]} p={[0, 0.04, -T * 0.4]} m={M.darkSteel} />
      <B s={[0.1, o.y1, 0.12]} p={[-w / 2 - 0.05, o.y1 / 2, 0.02]} m={M.darkSteel} />
      <B s={[0.1, o.y1, 0.12]} p={[w / 2 + 0.05, o.y1 / 2, 0.02]} m={M.darkSteel} />
      <B s={[w + 0.3, 0.38, 0.12]} p={[0, o.y1 + 0.19, 0.04]} m={M.darkSteel} round={0.02} />
      {/* dock bumpers + hazard posts */}
      {[-1, 1].map((sx) => (
        <group key={sx}>
          <B s={[0.12, 0.3, 0.1]} p={[sx * (w / 2 + 0.22), 0.9, 0.05]} m={M.rubber} round={0.02} />
          <HazardPost p={[sx * (w / 2 + 0.22), 0, 0.06]} h={0.6} />
        </group>
      ))}
      <B s={[0.12, 0.2, 0.06]} p={[w / 2 + 0.35, 1.3, 0.03]} m={M.plasticYellow} round={0.015} />
      <C rt={0.022} h={0.02} p={[w / 2 + 0.35, 1.34, 0.065]} r={[PI / 2, 0, 0]} m={M.green_glow} />
      <C rt={0.022} h={0.02} p={[w / 2 + 0.35, 1.26, 0.065]} r={[PI / 2, 0, 0]} m={M.red_glow} />
    </group>
  );
}

function HazardPost({ p, h }) {
  return (
    <group position={p}>
      {Array.from({ length: 6 }, (_, i) => (
        <B key={i} s={[0.1, h / 6, 0.012]} p={[0, (h / 6) * (i + 0.5), 0.006]} m={i % 2 ? M.plasticBlack : M.plasticYellow} round={0} />
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Floor, ceiling and fixtures

function Floor({ id, cfg }) {
  const mat = mk(id, 'floor', cfg.floor);
  return <Slab s={[W + 2 * T, 0.1, D + 2 * T]} p={[0, -0.05, 0]} mat={mat} />;
}

function Ceiling({ id, cfg }) {
  const mat = mk(id, 'ceiling', cfg.ceiling);
  return (
    <group>
      <Slab s={[W + 2 * T, 0.1, D + 2 * T]} p={[0, H + 0.05, 0]} mat={mat} />
      {cfg.beams && Array.from({ length: 6 }, (_, i) => (
        <B key={i} s={[0.16, 0.24, D]} p={[-HX + 1 + i * 2.4, H - 0.12, 0]} m={M[cfg.beams]} round={0.01} />
      ))}
      {cfg.joists && (
        <>
          {Array.from({ length: 6 }, (_, i) => <Joist key={i} z={-HZ + 0.9 + i * 1.85} />)}
          <Tube pts={[[-HX, H - 0.42, -HZ + 0.35], [HX, H - 0.42, -HZ + 0.35]]} rad={0.04} m={M.red} seg={2} />
          {[-5, -2, 1, 4].map((x) => <C key={x} rt={0.025} h={0.1} p={[x, H - 0.5, -HZ + 0.35]} m={M.brass} seg={10} />)}
        </>
      )}
      {/* smoke detectors and sprinkler heads */}
      {[[-3.5, 2.6], [3.5, -2.2]].map(([x, z], i) => (
        <group key={i} position={[x, H, z]}>
          <C rt={0.065} rb={0.07} h={0.035} p={[0, -0.018, 0]} m={M.plasticWhite} seg={28} />
          <C rt={0.006} h={0.004} p={[0, -0.037, 0.03]} m={M.red_glow} seg={8} />
        </group>
      ))}
      {!cfg.joists && [[-5.2, -3.6], [0, -3.6], [5.2, -3.6], [-5.2, 0.8], [0, 0.8], [5.2, 0.8], [-1.8, 3.6], [1.8, 3.6]].map(([x, z], i) => (
        <group key={'sp' + i} position={[x, H, z]}>
          <C rt={0.03} h={0.012} p={[0, -0.006, 0]} m={M.chrome} seg={16} />
          <C rt={0.006} h={0.05} p={[0, -0.035, 0]} m={M.brass} seg={8} />
          <C rt={0.022} h={0.006} p={[0, -0.062, 0]} m={M.brass} seg={12} />
        </group>
      ))}
      {!cfg.joists && cfg.ceiling.tex === 'ceilingGrid' && [[-3.9, -1.5], [3.9, -1.5], [-3.9, 3.3], [3.9, 3.3]].map(([x, z], i) => <Diffuser key={'d' + i} x={x} z={z} />)}
    </group>
  );
}

function Joist({ z }) {
  const m = M.darkSteel;
  return (
    <group position={[0, H, z]}>
      <B s={[W, 0.012, 0.12]} p={[0, -0.03, 0]} m={m} round={0} />
      <B s={[W, 0.012, 0.12]} p={[0, -0.33, 0]} m={m} round={0} />
      <B s={[W, 0.3, 0.012]} p={[0, -0.18, 0]} m={m} round={0} />
    </group>
  );
}

function Diffuser({ x, z }) {
  return (
    <group position={[x, H, z]}>
      {[0.6, 0.46, 0.32, 0.18].map((s, i) => (
        <B key={i} s={[s, 0.012 + i * 0.012, s]} p={[0, -0.006 - i * 0.006, 0]} m={i % 2 ? M.plasticGrey : M.plasticWhite} round={0.002} />
      ))}
    </group>
  );
}

const PENDANTS = [[-4.4, -1.4], [0, -1.4], [4.4, -1.4], [-4.4, 1.6], [0, 1.6], [4.4, 1.6]];
const PANELS = (() => {
  const out = [];
  for (const x of [-4.5, -1.5, 1.5, 4.5]) for (const z of [-3.3, -0.3, 2.7]) out.push([x, z]);
  return out;
})();

function CeilingLights({ cfg }) {
  const kind = cfg.lights.kind;
  const glow = glowMat('ceil:' + cfg.lights.color, cfg.lights.color, kind === 'panel' ? 1.5 : 2.6);
  if (kind === 'lantern') {
    const paper = glowMat('sushi-paper', '#ffdcb0', 1.45);
    const rib = flat('sushi-lantern-rib', '#97725a', { rough: 0.85 });
    const levels = [-0.18, -0.12, -0.06, 0, 0.06, 0.12, 0.18];
    return [-3.9, -1.95, 0, 1.95, 3.9].flatMap(x => [-2.65, 1.45].map(z => (
      <group key={`${x}:${z}`} position={[x, 2.69, z]}>
        <C rt={0.011} h={0.48} p={[0, 0.47, 0]} m={M.black} seg={8} />
        <C rt={0.122} h={0.045} p={[0, 0.223, 0]} m={M.woodDark} seg={24} />
        <C rt={0.113} h={0.042} p={[0, -0.224, 0]} m={M.woodDark} seg={24} />
        <mesh scale={[0.183, 0.232, 0.183]} material={paper}><sphereGeometry args={[1, 24, 16]} /></mesh>
        {levels.map(y => <mesh key={y} position={[0, y, 0]} rotation-x={PI / 2} material={rib}>
          <torusGeometry args={[0.183 * Math.sqrt(1 - (y / 0.232) ** 2) + 0.001, 0.0025, 6, 28]} />
        </mesh>)}
      </group>
    )));
  }
  if (kind === 'panel') {
    return PANELS.map(([x, z], i) => (
      <group key={i} position={[x, H, z]}>
        <B s={[0.6, 0.03, 0.6]} p={[0, -0.015, 0]} m={M.plasticWhite} round={0.004} />
        <mesh position={[0, -0.0305, 0]} rotation-x={PI / 2} material={glow}><planeGeometry args={[0.55, 0.55]} /></mesh>
      </group>
    ));
  }
  if (kind === 'linear') {
    const out = [];
    for (const x of [-4.2, 0, 4.2]) for (const z of [-3.4, -0.4, 2.6]) out.push([x, z]);
    return out.map(([x, z], i) => (
      <group key={i} position={[x, 2.95, z]}>
        <B s={[2.4, 0.07, 0.16]} p={[0, 0, 0]} m={M.stainless} round={0.012} />
        <mesh position={[0, -0.036, 0]} rotation-x={PI / 2} material={glow}><planeGeometry args={[2.34, 0.11]} /></mesh>
        {[-0.9, 0.9].map((cx) => <C key={cx} rt={0.003} h={H - 2.95} p={[cx, (H - 2.95) / 2, 0]} m={M.steel} seg={4} />)}
      </group>
    ));
  }
  if (kind === 'track') {
    return (
      <group>
        {[-2.2, 1.0].map((z) => (
          <group key={z}>
            <B s={[11, 0.035, 0.05]} p={[0, H - 0.0175, z]} m={M.plasticBlack} round={0.005} />
            {[-4.8, -3.2, -1.6, 0, 1.6, 3.2, 4.8].map((x, i) => (
              <group key={x} position={[x, H - 0.04, z]}>
                <C rt={0.012} h={0.07} p={[0, -0.035, 0]} m={M.plasticBlack} seg={10} />
                <group position={[0, -0.09, 0]} rotation={[z < 0 ? -0.6 : 0.6, 0, (i % 2 ? 0.2 : -0.2)]}>
                  <C rt={0.045} rb={0.04} h={0.14} p={[0, -0.05, 0]} m={M.plasticBlack} seg={20} />
                  <mesh position={[0, -0.121, 0]} rotation-x={PI / 2} material={glow}><circleGeometry args={[0.036, 20]} /></mesh>
                </group>
              </group>
            ))}
          </group>
        ))}
        <Pendants cfg={cfg} spots={[[-2.6, 3.4], [2.6, 3.4]]} />
      </group>
    );
  }
  if (kind === 'globe') {
    const opal = glowMat('opal:' + cfg.lights.color, cfg.lights.color, 1.5);
    return PENDANTS.map(([x, z], i) => (
      <group key={i} position={[x, H, z]}>
        <C rt={0.05} h={0.02} p={[0, -0.01, 0]} m={M.brass} seg={24} />
        <C rt={0.003} h={0.5} p={[0, -0.27, 0]} m={M.black} seg={4} />
        <C rt={0.03} h={0.05} p={[0, -0.53, 0]} m={M.brass} seg={16} />
        <mesh position={[0, -0.68, 0]} material={opal}><sphereGeometry args={[0.15, 32, 20]} /></mesh>
      </group>
    ));
  }
  return <Pendants cfg={cfg} spots={PENDANTS} />;
}

const SHADE = [[0.02, 0.26], [0.05, 0.255], [0.12, 0.2], [0.2, 0.08], [0.24, 0.0]];
function Pendants({ cfg, spots }) {
  const shadeM = flat('shade', '#1c1d1f', { rough: 0.4, metal: 0.6, side: THREE.DoubleSide });
  const inner = flat('shadeIn', '#f3efe6', { rough: 0.6, side: THREE.BackSide });
  const bulb = glowMat('bulb:' + cfg.lights.color, cfg.lights.color, 3.2);
  return spots.map(([x, z], i) => (
    <group key={i} position={[x, H, z]}>
      <C rt={0.05} h={0.025} p={[0, -0.012, 0]} m={M.black} seg={24} />
      <C rt={0.003} h={0.6} p={[0, -0.32, 0]} m={M.black} seg={4} />
      <group position={[0, -0.88, 0]}>
        <Lathe pts={SHADE} m={shadeM} seg={40} />
        <Lathe pts={SHADE.map(([r, y]) => [r * 0.97, y])} m={inner} seg={40} />
        <C rt={0.02} h={0.06} p={[0, 0.24, 0]} m={M.brass} seg={16} />
        <mesh position={[0, 0.1, 0]} material={bulb}><sphereGeometry args={[0.05, 20, 14]} /></mesh>
      </group>
    </group>
  ));
}

// ---------------------------------------------------------------------------------------------------------------
// Supply counters (front wall, either side of the door). Built in counter-local space: +z faces into the room.

function SupplyCounter({ id, cfg, c }) {
  const cc = cfg.counter;
  const [w] = c.size;
  const back = HZ - c.pos[2]; // distance from counter centre to the wall
  const body = M[cc.body], front = M[cc.front ?? cc.body], top = M[cc.top], handle = M[cc.handle];
  const bays = 4, bw = w / bays;
  return (
    <group position={c.pos} rotation-y={PI}>
      {/* worktop: top face at exactly y = 0.92 */}
      <B s={[w + 0.04, 0.04, 0.72]} p={[0, 0.9, 0.01]} m={top} round={0.008} />
      {/* raised back ledge to the wall */}
      <B s={[w + 0.04, 0.12, back - 0.35]} p={[0, 0.94, -(0.35 + back) / 2]} m={top} round={0.008} />
      {cc.splash && <B s={[w + 0.04, 0.5, 0.012]} p={[0, 1.25, -back + 0.006]} m={M[cc.splash]} round={0.003} />}
      {cc.style === 'bench' ? (
        <group>
          {[-1, 1].map((sx) => [-1, 1].map((sz) => (
            <B key={`${sx}${sz}`} s={[0.06, 0.88, 0.06]} p={[sx * (w / 2 - 0.05), 0.44, sz * 0.29]} m={body} round={0.008} />
          )))}
          <B s={[0.06, 0.88, 0.06]} p={[0, 0.44, 0.29]} m={body} round={0.008} />
          <B s={[w - 0.04, 0.06, 0.06]} p={[0, 0.85, 0.32]} m={body} round={0.008} />
          <B s={[w - 0.1, 0.03, 0.6]} p={[0, 0.16, 0]} m={M.woodLight} round={0.005} />
          {/* plastic picking bins on the lower shelf */}
          {Array.from({ length: 6 }, (_, i) => (
            <group key={i} position={[-w / 2 + 0.32 + i * 0.59, 0.175, 0.02]}>
              <B s={[0.42, 0.2, 0.5]} p={[0, 0.1, 0]} m={i % 3 === 1 ? M.plasticYellow : M.plasticBlue} round={0.015} />
              <B s={[0.12, 0.05, 0.004]} p={[0, 0.14, 0.252]} m={M.paper} round={0} />
            </group>
          ))}
          <B s={[w - 0.04, 0.04, 0.012]} p={[0, 0.82, -0.33]} m={body} round={0} />
        </group>
      ) : cc.style === 'chest' ? (
        <group>
          <B s={[w, 0.08, 0.62]} p={[0, 0.04, 0]} m={M.black} round={0.01} />
          <B s={[w, 0.8, 0.66]} p={[0, 0.48, -0.02]} m={body} round={0.012} />
          {[0, 1, 2].map((b) => [0.1, 0.1, 0.13, 0.13, 0.2].map((hh, j, arr) => {
            const y0 = 0.1 + arr.slice(0, j).reduce((a, v) => a + v + 0.012, 0);
            const bx = -w / 2 + (w / 3) * (b + 0.5);
            return (
              <group key={`${b}-${j}`} position={[bx, y0 + hh / 2, 0.315]}>
                <B s={[w / 3 - 0.03, hh, 0.02]} m={front} round={0.004} />
                <B s={[w / 3 - 0.18, 0.018, 0.025]} p={[0, hh / 2 - 0.02, 0.018]} m={handle} round={0.004} />
              </group>
            );
          }))}
          {[-1, 1].map((sx) => <C key={sx} rt={0.035} h={0.03} p={[sx * (w / 2 - 0.12), 0.04, 0.24]} r={[0, 0, PI / 2]} m={M.rubber} seg={14} />)}
        </group>
      ) : (
        <group>
          <B s={[w - 0.02, 0.1, 0.6]} p={[0, 0.05, -0.05]} m={M.black} round={0.004} />
          <B s={[w, 0.78, 0.64]} p={[0, 0.49, -0.03]} m={body} round={0.006} />
          {Array.from({ length: bays }, (_, i) => {
            const x = -w / 2 + bw * (i + 0.5);
            return (
              <group key={i} position={[x, 0, 0.3]}>
                <B s={[bw - 0.008, 0.17, 0.02]} p={[0, 0.782, 0]} m={front} round={0.004} />
                <B s={[bw - 0.008, 0.575, 0.02]} p={[0, 0.4025, 0]} m={front} round={0.004} />
                <C rt={0.006} h={0.16} p={[0, 0.79, 0.032]} r={[0, 0, PI / 2]} m={handle} seg={10} />
                {[-0.07, 0.07].map((hx) => <C key={hx} rt={0.005} h={0.022} p={[hx, 0.79, 0.019]} r={[PI / 2, 0, 0]} m={handle} seg={8} />)}
                <C rt={0.006} h={0.16} p={[(i % 2 ? -1 : 1) * (bw / 2 - 0.06), 0.58, 0.032]} m={handle} seg={10} />
                {[-0.07, 0.07].map((hy) => <C key={hy} rt={0.005} h={0.022} p={[(i % 2 ? -1 : 1) * (bw / 2 - 0.06), 0.58 + hy, 0.019]} r={[PI / 2, 0, 0]} m={handle} seg={8} />)}
              </group>
            );
          })}
        </group>
      )}
      {!cc.noShelves && <CounterShelves id={id} w={w} back={back} cfg={cfg} />}
    </group>
  );
}

// Two floating shelves above each counter with shell-appropriate stock. Shelf undersides clear 0.92 + 0.7 items.
function CounterShelves({ id, w, back, cfg }) {
  const shelfM = cfg.counter.style === 'cabinet' ? M[cfg.counter.top === 'marble' ? 'woodLight' : cfg.counter.top] : M.woodLight;
  const r = useMemo(() => rng(id.length * 31 + Math.round(w * 10)), [id, w]);
  const items = useMemo(() => {
    const out = [];
    for (const y of [1.78, 2.24]) {
      let x = -w / 2 + 0.14;
      while (x < w / 2 - 0.2) {
        const kind = STOCK[id] ?? STOCK.office;
        const it = kind(r);
        out.push({ ...it, x: x + it.w / 2, y });
        x += it.w + 0.03 + r() * 0.08;
      }
    }
    return out;
  }, [id, w, r]);
  const d = 0.28;
  const z = -back + d / 2;
  return (
    <group>
      {[1.78, 2.24].map((y) => (
        <group key={y}>
          <B s={[w - 0.1, 0.035, d]} p={[0, y - 0.0175, z]} m={shelfM} round={0.006} />
          {[-1, 1].map((sx) => <B key={sx} s={[0.03, 0.12, 0.2]} p={[sx * (w / 2 - 0.4), y - 0.08, -back + 0.1]} m={M.black} round={0.004} />)}
        </group>
      ))}
      {items.map((it, i) => <group key={i} position={[it.x, it.y, z + 0.01]}>{it.node}</group>)}
    </group>
  );
}

const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const STOCK = {
  cafe: (r) => {
    const t = r();
    if (t < 0.35) { // glass jar of beans
      return { w: 0.14, node: (<group><C rt={0.065} h={0.2} p={[0, 0.1, 0]} m={M.glassClear} seg={20} /><C rt={0.06} h={0.15} p={[0, 0.077, 0]} m={M.coffee} seg={20} /><C rt={0.068} h={0.03} p={[0, 0.215, 0]} m={M.woodDark} seg={20} /></group>) };
    }
    if (t < 0.7) { // stacked cups
      return { w: 0.12, node: (<group>{[0, 1, 2, 3].map((k) => <Lathe key={k} pts={[[0.035, 0], [0.05, 0.08]]} p={[0, k * 0.022, 0]} m={M.ceramic} seg={20} />)}</group>) };
    }
    return { w: 0.2, node: (<group><B s={[0.18, 0.26, 0.08]} p={[0, 0.13, 0]} m={pick(r, [M.cardboard, M.paper, M.plasticBlack])} round={0.01} /><B s={[0.12, 0.08, 0.004]} p={[0, 0.15, 0.042]} m={M.flowerYellow} round={0} /></group>) };
  },
  warehouse: (r) => {
    const w = 0.3 + r() * 0.2, h = 0.18 + r() * 0.2;
    return { w, node: (<group><B s={[w, h, 0.24]} p={[0, h / 2, 0]} m={M.cardboard} round={0.006} /><B s={[w + 0.002, 0.04, 0.242]} p={[0, h * 0.5, 0]} m={M.paper} round={0} /></group>) };
  },
  clinic: (r) => {
    const m = pick(r, [M.plasticBlue, M.flowerPurple, M.plasticWhite]);
    return { w: 0.24, node: (<group><B s={[0.24, 0.12, 0.13]} p={[0, 0.06, 0]} m={m} round={0.008} /><B s={[0.08, 0.004, 0.06]} p={[0, 0.121, 0.02]} m={M.white} round={0} /></group>) };
  },
  lab: (r) => {
    if (r() < 0.5) {
      const m = pick(r, [M.glassAmber, M.glassClear, M.liquidBlue]);
      return { w: 0.1, node: (<group><C rt={0.045} h={0.18} p={[0, 0.09, 0]} m={m} seg={18} /><C rt={0.02} h={0.04} p={[0, 0.2, 0]} m={M.plasticBlack} seg={12} /><B s={[0.06, 0.06, 0.003]} p={[0, 0.09, 0.046]} m={M.paper} round={0} /></group>) };
    }
    return { w: 0.07, node: (<B s={[0.06, 0.3, 0.24]} p={[0, 0.15, 0]} m={pick(r, [M.plasticBlue, M.plasticRed, M.plasticGrey, M.plasticYellow])} round={0.006} />) };
  },
  workshop: (r) => {
    if (r() < 0.5) {
      const m = pick(r, [M.red, M.yellow, M.blue]);
      return { w: 0.12, node: (<group><C rt={0.055} h={0.2} p={[0, 0.1, 0]} m={m} seg={20} /><C rt={0.02} h={0.05} p={[0, 0.225, 0]} m={M.black} seg={10} /></group>) };
    }
    return { w: 0.36, node: (<group><B s={[0.34, 0.16, 0.2]} p={[0, 0.08, 0]} m={pick(r, [M.plasticRed, M.plasticYellow, M.plasticBlack])} round={0.015} /><B s={[0.12, 0.02, 0.03]} p={[0, 0.17, 0]} m={M.black} round={0.006} /></group>) };
  },
  office: (r) => {
    const n = 3 + Math.floor(r() * 4);
    const m = pick(r, [M.plasticBlack, M.plasticBlue, M.plasticGrey, M.white]);
    return { w: n * 0.075, node: (<group>{Array.from({ length: n }, (_, k) => <B key={k} s={[0.07, 0.3, 0.24]} p={[-n * 0.0375 + 0.0375 + k * 0.075, 0.15, 0]} m={m} round={0.005} />)}</group>) };
  },
  salon: (r) => {
    if (r() < 0.6) {
      const m = pick(r, [M.plasticWhite, M.ceramic, M.glassAmber, M.plasticBlack]);
      const h = 0.14 + r() * 0.1;
      return { w: 0.08, node: (<group><C rt={0.032} h={h} p={[0, h / 2, 0]} m={m} seg={18} /><C rt={0.012} h={0.04} p={[0, h + 0.02, 0]} m={M.brass} seg={10} /></group>) };
    }
    return { w: 0.24, node: (<group>{[0, 1, 2].map((k) => <B key={k} s={[0.22, 0.05, 0.2]} p={[0, 0.026 + k * 0.052, 0]} m={pick(r, [M.flowerWhite, M.fabricGrey, M.flowerPink])} round={0.02} />)}</group>) };
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Fixtures for floor slots and walls

function Plant({ p, big = false, pot = M.ceramic, leaves = 26, seed = 1 }) {
  const r = rng(seed);
  const h = big ? 1.55 : 1.1;
  const ls = useMemo(() => Array.from({ length: leaves }, () => {
    const a = r() * PI * 2, y = h * (0.45 + r() * 0.55), rad = 0.08 + r() * (big ? 0.3 : 0.2);
    return { a, y, rad, tilt: 0.3 + r() * 0.6, m: r() > 0.5 ? M.leaf : M.leafDark, s: 0.8 + r() * 0.5 };
  }), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <group position={p}>
      <Lathe pts={[[0.001, 0], [0.16, 0], [0.19, 0.06], [0.21, 0.4], [0.2, 0.42], [0.18, 0.42]]} m={pot} seg={40} />
      <C rt={0.185} h={0.02} p={[0, 0.39, 0]} m={M.soil} seg={32} />
      {[-0.03, 0.04, 0].map((x, i) => <Tube key={i} pts={[[x, 0.4, 0], [x * 2, h * 0.6, x], [x * 3, h * 0.9, -x]]} rad={0.012} m={M.woodDark} seg={12} />)}
      {ls.map((l, i) => (
        <mesh key={i} position={[Math.cos(l.a) * l.rad, l.y, Math.sin(l.a) * l.rad]} rotation={[l.tilt, -l.a + PI / 2, 0]} scale={[0.09 * l.s, 0.012, 0.16 * l.s]} material={l.m} castShadow receiveShadow>
          <sphereGeometry args={[1, 14, 8]} />
        </mesh>
      ))}
    </group>
  );
}

function Bin({ p, m = M.stainless, pedal = false, lid = M.plasticBlack }) {
  return (
    <group position={p}>
      <Lathe pts={[[0.001, 0], [0.15, 0], [0.18, 0.6], [0.001, 0.6]]} m={m} seg={36} />
      <C rt={0.185} h={0.04} p={[0, 0.62, 0]} m={lid} seg={36} />
      {pedal && <B s={[0.12, 0.02, 0.08]} p={[0, 0.03, 0.18]} m={M.plasticBlack} round={0.006} />}
    </group>
  );
}

function Extinguisher({ p, co2 = false }) {
  const body = co2 ? M.plasticBlack : M.plasticRed;
  return (
    <group position={p}>
      <B s={[0.42, 0.04, 0.32]} p={[0, 0.02, 0]} m={M.plasticBlack} round={0.01} />
      <C rt={0.012} h={0.9} p={[0, 0.47, -0.12]} m={M.chrome} seg={10} />
      <group position={[0, 0.06, 0.02]}>
        <C rt={0.08} h={0.5} p={[0, 0.25, 0]} m={M.plasticRed} seg={28} />
        <S rad={0.08} p={[0, 0.5, 0]} m={M.plasticRed} seg={24} />
        <C rt={0.081} h={0.08} p={[0, 0.3, 0]} m={body} seg={28} />
        <B s={[0.1, 0.12, 0.004]} p={[0, 0.25, 0.081]} m={M.paper} round={0} />
        <C rt={0.02} h={0.08} p={[0, 0.6, 0]} m={M.black} seg={12} />
        <B s={[0.14, 0.02, 0.03]} p={[0.03, 0.65, 0]} m={M.black} round={0.006} />
        <Tube pts={[[0.02, 0.6, 0.02], [0.1, 0.55, 0.06], [0.1, 0.25, 0.09], [0.06, 0.15, 0.09]]} rad={0.01} m={M.black} seg={20} />
      </group>
      <WallSign p={[0, 1.2, -0.13]} k="fire" w={0.26} h={0.26} tex={signTexture('fire', { w: 256, h: 256, bg: '#c4241c', lines: [{ text: 'FIRE', size: 0.24, y: 0.36, weight: 800 }, { text: 'EXTINGUISHER', size: 0.1, y: 0.62, weight: 700 }] })} />
    </group>
  );
}

function Drum({ p, m = M.blue }) {
  return (
    <group position={p}>
      <C rt={0.29} h={0.88} p={[0, 0.44, 0]} m={m} seg={36} />
      {[0.03, 0.3, 0.58, 0.85].map((y) => <mesh key={y} position={[0, y, 0]} rotation-x={PI / 2} material={m} castShadow><torusGeometry args={[0.29, 0.012, 8, 40]} /></mesh>)}
      <C rt={0.03} h={0.02} p={[0.15, 0.89, 0.05]} m={M.darkSteel} seg={12} />
    </group>
  );
}

function WaterCooler({ p }) {
  return (
    <group position={p}>
      <B s={[0.32, 1.0, 0.32]} p={[0, 0.5, 0]} m={M.plasticWhite} round={0.03} />
      <B s={[0.2, 0.22, 0.03]} p={[0, 0.8, 0.16]} m={M.plasticGrey} round={0.01} />
      <C rt={0.012} h={0.04} p={[-0.05, 0.86, 0.19]} r={[PI / 2, 0, 0]} m={M.plasticBlue} />
      <C rt={0.012} h={0.04} p={[0.05, 0.86, 0.19]} r={[PI / 2, 0, 0]} m={M.plasticRed} />
      <B s={[0.18, 0.02, 0.08]} p={[0, 0.7, 0.18]} m={M.plasticGrey} round={0.005} />
      <Lathe pts={[[0.02, 1.0], [0.04, 1.03], [0.13, 1.08], [0.14, 1.4], [0.12, 1.45], [0.001, 1.46]]} m={M.liquidBlue} seg={32} />
    </group>
  );
}

function SanitizerStand({ p }) {
  return (
    <group position={p}>
      <C rt={0.16} rb={0.17} h={0.03} p={[0, 0.015, 0]} m={M.plasticGrey} seg={32} />
      <C rt={0.02} h={1.15} p={[0, 0.6, 0]} m={M.stainless} seg={16} />
      <B s={[0.13, 0.24, 0.1]} p={[0, 1.2, 0.04]} m={M.plasticWhite} round={0.02} />
      <B s={[0.07, 0.04, 0.02]} p={[0, 1.08, 0.09]} m={M.plasticBlue} round={0.006} />
      <B s={[0.24, 0.32, 0.01]} p={[0, 1.55, 0.0]} m={texMat('sanitize', signTexture('sanitize', { w: 256, h: 340, bg: '#ffffff', lines: [{ text: 'PLEASE', size: 0.08, y: 0.25, color: '#2f6fb3' }, { text: 'SANITIZE', size: 0.11, y: 0.38, color: '#2f6fb3', weight: 800 }, { text: 'your hands', size: 0.07, y: 0.52, color: '#444', weight: 500 }], draw: (g, w, h) => { g.fillStyle = '#2f6fb3'; g.fillRect(0, h * 0.8, w, h * 0.2); } }))} round={0} />
    </group>
  );
}

function Pallets({ p, boxes = true, seed = 3 }) {
  const r = rng(seed);
  const pallet = (y, k) => (
    <group key={k} position={[0, y, 0]}>
      {[-0.32, 0, 0.32].map((x) => <B key={x} s={[0.1, 0.09, 0.72]} p={[x, 0.045, 0]} m={M.wood} round={0.005} />)}
      {Array.from({ length: 6 }, (_, i) => <B key={i} s={[0.74, 0.022, 0.1]} p={[0, 0.101, -0.3 + i * 0.12]} m={M.woodLight} round={0.003} />)}
    </group>
  );
  const bx = [];
  if (boxes) for (let i = 0; i < 4; i++) {
    const s = 0.3 + r() * 0.06;
    bx.push(<B key={i} s={[s, s * 0.8, s]} p={[(i % 2 ? 0.18 : -0.18), 0.45 + Math.floor(i / 2) * 0.27 + s * 0.4, (i % 2 ? -0.1 : 0.12)]} m={M.cardboard} round={0.006} />);
  }
  return <group position={p}>{pallet(0, 0)}{pallet(0.112, 1)}{pallet(0.224, 2)}{bx}</group>;
}

function SafetyShower({ p }) {
  const g = M.plasticGreen;
  return (
    <group position={p}>
      <C rt={0.14} h={0.03} p={[0, 0.015, 0]} m={M.stainless} seg={24} />
      <C rt={0.025} h={2.3} p={[0, 1.15, -0.2]} m={M.stainless} seg={14} />
      <Tube pts={[[0, 2.28, -0.2], [0, 2.34, -0.05], [0, 2.3, 0.08]]} rad={0.025} m={M.stainless} seg={12} />
      <Lathe pts={[[0.01, 2.27], [0.06, 2.24], [0.13, 2.2], [0.13, 2.19], [0.001, 2.2]]} m={g} seg={28} />
      <C rt={0.006} h={0.6} p={[0.15, 1.95, 0.04]} m={M.stainless} seg={6} />
      <B s={[0.04, 0.2, 0.04]} p={[0.15, 1.6, 0.04]} m={g} round={0.01} />
      {/* eyewash bowl */}
      <Lathe pts={[[0.001, 1.0], [0.1, 1.0], [0.14, 1.07], [0.13, 1.07], [0.09, 1.015]]} m={M.plasticGreen} seg={28} p={[0, 0, 0.0]} />
      <B s={[0.12, 0.04, 0.03]} p={[0, 0.97, 0.12]} m={g} round={0.008} />
      <WallSign p={[0.3, 2.0, -0.33]} k="shower" w={0.3} h={0.3} tex={signTexture('shower', { w: 256, h: 256, bg: '#0e8a47', lines: [{ text: 'SAFETY', size: 0.14, y: 0.35, weight: 800 }, { text: 'SHOWER', size: 0.14, y: 0.52, weight: 800 }, { text: '& EYEWASH', size: 0.09, y: 0.7 }] })} />
    </group>
  );
}

function FlammableCabinet({ p }) {
  const y = M.yellow;
  return (
    <group position={p}>
      <B s={[0.6, 1.7, 0.5]} p={[0, 0.85, 0]} m={y} round={0.015} />
      <B s={[0.008, 1.6, 0.02]} p={[0, 0.85, 0.255]} m={M.black} round={0} />
      <B s={[0.03, 0.2, 0.04]} p={[-0.05, 0.95, 0.27]} m={M.chrome} round={0.008} />
      <B s={[0.03, 0.2, 0.04]} p={[0.05, 0.95, 0.27]} m={M.chrome} round={0.008} />
      <mesh position={[0, 1.38, 0.252]} material={texMat('flam', signTexture('flam', { w: 512, h: 200, bg: '#e8a512', lines: [{ text: 'FLAMMABLE', size: 0.36, y: 0.38, color: '#b41f18', weight: 900 }, { text: 'KEEP FIRE AWAY', size: 0.2, y: 0.72, color: '#b41f18', weight: 800 }] }))}><planeGeometry args={[0.5, 0.2]} /></mesh>
    </group>
  );
}

function WallSign({ p, r = [0, 0, 0], w, h, tex, k, glow = 0, frame }) {
  return (
    <group position={p} rotation={r}>
      {frame && <B s={[w + 0.05, h + 0.05, 0.025]} p={[0, 0, 0.0125]} m={M[frame]} round={0.006} />}
      <mesh position={[0, 0, frame ? 0.027 : 0.004]} material={texMat(k, tex, { glow })} receiveShadow>
        <planeGeometry args={[w, h]} />
      </mesh>
    </group>
  );
}

function Clock({ p, r = [0, 0, 0], rim = M.black, rad = 0.2 }) {
  return (
    <group position={p} rotation={r}>
      <C rt={rad} h={0.04} p={[0, 0, 0.02]} r={[PI / 2, 0, 0]} m={rim} seg={40} />
      <C rt={rad * 0.9} h={0.02} p={[0, 0, 0.032]} r={[PI / 2, 0, 0]} m={M.gaugeFace} seg={40} />
      {Array.from({ length: 12 }, (_, i) => (
        <B key={i} s={[0.008, i % 3 ? 0.02 : 0.035, 0.003]} p={[Math.sin((i / 12) * PI * 2) * rad * 0.78, Math.cos((i / 12) * PI * 2) * rad * 0.78, 0.043]} r={[0, 0, -(i / 12) * PI * 2]} m={M.black} round={0} />
      ))}
      <B s={[0.012, rad * 0.55, 0.004]} p={[Math.sin(5.2) * rad * 0.24, Math.cos(5.2) * rad * 0.24, 0.046]} r={[0, 0, -5.2]} m={M.black} round={0} />
      <B s={[0.008, rad * 0.8, 0.004]} p={[Math.sin(1.1) * rad * 0.36, Math.cos(1.1) * rad * 0.36, 0.049]} r={[0, 0, -1.1]} m={M.black} round={0} />
      <C rt={0.01} h={0.01} p={[0, 0, 0.05]} r={[PI / 2, 0, 0]} m={M.red} seg={10} />
    </group>
  );
}

// Poster painters: abstract but tasteful prints, per shell.
function poster(key, palette, title, sub) {
  return paintedTexture('poster:' + key, 512, 720, (g, w, h, r) => {
    g.fillStyle = palette[0]; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 7; i++) {
      g.fillStyle = palette[1 + (i % (palette.length - 1))];
      g.globalAlpha = 0.85;
      const t = r();
      if (t < 0.4) { g.beginPath(); g.arc(r() * w, h * 0.15 + r() * h * 0.5, 40 + r() * 120, 0, PI * 2); g.fill(); }
      else if (t < 0.7) g.fillRect(r() * w * 0.7, h * 0.1 + r() * h * 0.5, 60 + r() * 200, 20 + r() * 120);
      else { g.beginPath(); g.moveTo(r() * w, h * 0.65); g.lineTo(r() * w, h * 0.1); g.lineTo(r() * w, h * 0.65); g.fill(); }
    }
    g.globalAlpha = 1;
    g.fillStyle = palette[0];
    g.fillRect(0, h * 0.74, w, h * 0.26);
    g.fillStyle = palette[palette.length - 1];
    g.font = `700 ${h * 0.065}px ${SERIF}`;
    g.textAlign = 'left';
    g.fillText(title, w * 0.08, h * 0.83);
    g.font = `500 ${h * 0.03}px ${FONT}`;
    g.fillStyle = '#555';
    g.fillText(sub, w * 0.08, h * 0.9);
  });
}

// Wall mount helpers. Each returns world-space position/rotation for a point on the interior face of a wall.
// along = coordinate along the wall (x for N/S, z for E/W), y height, out = distance from the wall face.
function onWall(side, along, y, out = 0) {
  switch (side) {
    case 'N': return { p: [along, y, -HZ + out], r: [0, 0, 0] };
    case 'S': return { p: [along, y, HZ - out], r: [0, PI, 0] };
    case 'E': return { p: [HX - out, y, along], r: [0, -PI / 2, 0] };
    default: return { p: [-HX + out, y, along], r: [0, PI / 2, 0] };
  }
}

function Poster({ side, along, y, k, palette, title, sub, w = 0.6, h = 0.84, frame = 'black' }) {
  const { p, r } = onWall(side, along, y);
  return <WallSign p={p} r={r} w={w} h={h} k={'p:' + k} tex={poster(k, palette, title, sub)} frame={frame} />;
}

function Pegboard({ side }) {
  const { p, r } = onWall(side, 2.9, 0, 0);
  const tex = paintedTexture('pegboard', 1024, 512, (g, w, h) => {
    g.fillStyle = '#b48d5e'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#4a3620';
    for (let x = 12; x < w; x += 25.6) for (let y = 12; y < h; y += 25.6) { g.beginPath(); g.arc(x, y, 3.2, 0, PI * 2); g.fill(); }
  });
  const tools = [];
  // hammers, wrenches, screwdrivers, saw, tape roll
  for (let i = 0; i < 5; i++) tools.push(<group key={'w' + i} position={[-0.95 + i * 0.12, 1.85, 0.03]}><B s={[0.025, 0.22 + i * 0.03, 0.008]} p={[0, 0, 0]} m={M.chrome} round={0.003} /><mesh position={[0, 0.13 + i * 0.015, 0]} material={M.chrome}><torusGeometry args={[0.025, 0.008, 8, 16]} /></mesh></group>);
  for (let i = 0; i < 2; i++) tools.push(<group key={'h' + i} position={[-0.25 + i * 0.22, 1.75, 0.04]}><C rt={0.014} h={0.32} m={M.woodLight} seg={10} /><B s={[0.13, 0.035, 0.035]} p={[0, 0.17, 0]} m={M.darkSteel} round={0.006} /></group>);
  for (let i = 0; i < 6; i++) tools.push(<group key={'s' + i} position={[0.2 + i * 0.07, 1.8, 0.035]}><C rt={0.004} h={0.14} p={[0, -0.1, 0]} m={M.chrome} seg={8} /><C rt={0.014} h={0.1} p={[0, 0, 0]} m={i % 2 ? M.plasticRed : M.plasticYellow} seg={10} /></group>);
  tools.push(<group key="saw" position={[0.8, 1.6, 0.03]}><B s={[0.12, 0.5, 0.004]} p={[0, -0.1, 0]} m={M.steel} round={0} /><B s={[0.1, 0.13, 0.03]} p={[0, 0.2, 0]} m={M.plasticBlack} round={0.015} /></group>);
  tools.push(<mesh key="tape" position={[0.95, 2.05, 0.04]} material={M.plasticYellow} castShadow><torusGeometry args={[0.05, 0.02, 10, 20]} /></mesh>);
  // shelf with parts bins
  tools.push(<B key="sh" s={[2.3, 0.025, 0.12]} p={[0, 1.25, 0.06]} m={M.darkSteel} round={0.004} />);
  for (let i = 0; i < 8; i++) tools.push(<B key={'b' + i} s={[0.2, 0.1, 0.11]} p={[-1.0 + i * 0.285, 1.31, 0.065]} m={i % 2 ? M.plasticBlue : M.plasticRed} round={0.01} />);
  return (
    <group position={p} rotation={r}>
      <mesh position={[0, 1.65, 0.012]} material={texMat('peg', tex, { rough: 0.8 })} receiveShadow>
        <boxGeometry args={[2.4, 1.2, 0.02]} />
      </mesh>
      <B s={[2.46, 0.04, 0.03]} p={[0, 2.27, 0.015]} m={M.darkSteel} round={0.004} />
      <B s={[2.46, 0.04, 0.03]} p={[0, 1.03, 0.015]} m={M.darkSteel} round={0.004} />
      {tools}
    </group>
  );
}

function Slats({ side }) {
  const { p, r } = onWall(side, 2.9, 0, 0);
  return (
    <group position={p} rotation={r}>
      {Array.from({ length: 34 }, (_, i) => <B key={i} s={[0.045, 2.8, 0.04]} p={[-1.32 + i * 0.08, 1.48, 0.02]} m={M.woodLight} round={0.006} />)}
      <B s={[2.8, 0.04, 0.012]} p={[0, 0.06, 0.005]} m={M.black} round={0} />
      {/* round mirror with brass rim in front of the slats */}
      <mesh position={[0, 1.6, 0.06]} material={M.brass} castShadow><torusGeometry args={[0.45, 0.018, 12, 64]} /></mesh>
      <mesh position={[0, 1.6, 0.052]} material={flat('mirror', '#d9dee2', { rough: 0.02, metal: 1 })}><circleGeometry args={[0.45, 64]} /></mesh>
    </group>
  );
}

// Lab service runs: gas, vacuum and water lines on the north wall above the benches, with labelled valves.
function Services() {
  const runs = [[2.82, M.copper, 0.022], [2.9, M.stainless, 0.025], [2.98, M.plasticYellow, 0.018], [3.06, M.plasticBlue, 0.02]];
  return (
    <group>
      {runs.map(([y, m, rad], i) => <Tube key={i} pts={[[-HX, y, -HZ + 0.07], [HX, y, -HZ + 0.07]]} rad={rad} m={m} seg={2} />)}
      {[-6, -3.6, -1.2, 1.2, 3.6, 6].map((x) => <B key={x} s={[0.03, 0.36, 0.04]} p={[x, 2.94, -HZ + 0.02]} m={M.darkSteel} round={0.004} />)}
      <B s={[W, 0.32, 0.12]} p={[0, H - 0.16, -HZ + 0.06]} m={M.stainless} round={0.01} />
    </group>
  );
}

// Per-shell dressing. Floor-standing items only in FLOOR_SLOTS; wall items within WALL_MARGIN of the wall.
const slot = (k, y = 0) => [FLOOR_SLOTS[k].pos[0], y, FLOOR_SLOTS[k].pos[1]];

function Dressing({ id, cfg }) {
  const wallPanel = (side, along, y, k, tex, w, h, frame, glow) => {
    const { p, r } = onWall(side, along, y);
    return <WallSign key={k} p={p} r={r} w={w} h={h} k={k} tex={tex} frame={frame} glow={glow} />;
  };
  const common = [];
  if (cfg.pegboard) common.push(<Pegboard key="peg" side={cfg.pegboard} />);
  if (cfg.slats) common.push(<Slats key="slats" side={cfg.slats} />);
  if (cfg.services) common.push(<NoCast key="svc"><Services /></NoCast>);

  switch (id) {
    case 'sushi': {
      const indigo = flat('sushi-indigo', '#253e51', { rough: 0.94 });
      const title = signTexture('sushi-noren', {
        w: 528, h: 430, bg: '#253e51',
        lines: [{ text: '寿司', size: 0.32, y: 0.42, weight: 700, color: '#f0dfbe' },
          { text: 'SUSHI BAR', size: 0.10, y: 0.73, weight: 700, color: '#f0dfbe' }],
      });
      const menu = (title, items) => signTexture(`sushi-menu:${title}`, {
        w: 640, h: 410, bg: '#e4caa2', border: '#ae7f53',
        lines: [{ text: title, size: 0.17, y: 0.2, font: SERIF, weight: 700, color: '#423329' },
          ...items.map((text, i) => ({ text, size: 0.105, y: 0.43 + i * 0.16, color: '#52382a' }))],
      });
      return (
        <group>
          <NoCast>
            {[-5.1, -3.65, 3.65, 5.1].map(x => <group key={x} position={[x, 2.04, -HZ]}>
              <B s={[1.29, 2.26, 0.038]} p={[0, 0, 0.043]} m={M.paper} round={0.005} />
              {[-0.65, -0.22, 0.22, 0.65].map(v => <B key={v} s={[0.037, 2.32, 0.06]} p={[v, 0, 0.071]} m={M.woodDark} round={0.003} />)}
              {[-1.15, -0.57, 0, 0.57, 1.15].map(y => <B key={y} s={[1.34, 0.036, 0.061]} p={[0, y, 0.071]} m={M.woodDark} round={0.003} />)}
            </group>)}
            <group position={[0, 2.5, -HZ + 0.105]}>
              <C rt={0.025} h={3.28} p={[0, 0.59, 0]} r={[0, 0, PI / 2]} m={M.woodDark} seg={16} />
              {[-1.04, 0, 1.04].map(x => <B key={x} s={[1.012, 1.10, 0.02]} p={[x, 0, 0.004]} m={indigo} round={0.009} />)}
              <WallSign p={[0, 0, 0.013]} w={0.95} h={0.88} k="sushi-shop-sign" tex={title} />
            </group>
          </NoCast>
          {wallPanel('E', -4.26, 2.12, 'sushi-menu-left', menu('At the counter', ['Salmon nigiri', 'Tuna maki', 'Cucumber maki']), 1.92, 1.13, 'woodDark')}
          {wallPanel('W', -4.26, 2.12, 'sushi-menu-right', menu('From the kitchen', ['Miso soup', 'Edamame', 'Green tea']), 1.92, 1.13, 'woodDark')}
          <Plant p={slot('C1')} seed={33} pot={M.tileDark} />
          <Plant p={slot('C2')} seed={48} pot={M.ceramic} />
          {common}
        </group>
      );
    }
    case 'cafe': {
      const menu = (k, title, items) => signTexture('menu:' + k, {
        w: 1024, h: 560, bg: '#1e2320', border: '#cfc7b4',
        lines: [{ text: title, size: 0.13, y: 0.17, font: SERIF, weight: 700, color: '#f3ecd9' },
          ...items.map(([n, pr], i) => ({ text: n, size: 0.085, y: 0.36 + i * 0.14, x: 0.12, align: 'left', weight: 500, color: '#e9e3d3' })),
          ...items.map(([n, pr], i) => ({ text: pr, size: 0.085, y: 0.36 + i * 0.14, x: 0.88, align: 'right', weight: 600, color: '#f2c66a' }))],
      });
      return (
        <group>
          {wallPanel('N', -2.5, 3.0, 'm1', menu('a', 'Espresso Bar', [['Espresso', '3.20'], ['Flat white', '4.50'], ['Cappuccino', '4.60'], ['Long black', '3.90']]), 1.3, 0.71, 'woodDark')}
          {wallPanel('N', 0, 3.0, 'm2', menu('b', 'Kitchen', [['Avocado toast', '12'], ['Big breakfast', '18'], ['Soup of the day', '9'], ['Banana bread', '5']]), 1.3, 0.71, 'woodDark')}
          {wallPanel('N', 2.5, 3.0, 'm3', menu('c', 'Pastries', [['Croissant', '4.20'], ['Pain au choc', '4.80'], ['Cinnamon scroll', '5.00'], ['Almond tart', '5.50']]), 1.3, 0.71, 'woodDark')}
          <Poster side="S" along={-1.8} y={1.85} k="cafe1" palette={['#f2e8d5', '#c4683a', '#e0a64a', '#3d5a4a', '#2a2a2a']} title="Single Origin" sub="Ethiopia - Yirgacheffe" frame="woodDark" />
          <Poster side="S" along={1.8} y={1.85} k="cafe2" palette={['#efe6d6', '#7a4a2e', '#d9b48a', '#a33b2a', '#2a2a2a']} title="Slow Mornings" sub="Roasted in-house daily" frame="woodDark" />
          <Poster side="E" along={-4.5} y={1.6} k="cafe3" palette={['#ece2cf', '#3d5a4a', '#c4683a', '#e0a64a', '#2a2a2a']} title="Est. 2014" sub="Neighbourhood coffee" frame="woodDark" />
          <Poster side="W" along={-4.5} y={1.6} k="cafe4" palette={['#f4ecdc', '#a33b2a', '#2f4858', '#e8b04a', '#2a2a2a']} title="Fresh Bread" sub="Out of the oven at 7" frame="woodDark" />
          <Plant p={slot('F1')} seed={3} />
          <Plant p={slot('F2')} seed={7} pot={M.tileDark} />
          <Plant p={slot('C1')} big seed={11} pot={M.ceramic} />
          <Plant p={slot('C2')} big seed={13} pot={M.tileDark} />
          {common}
        </group>
      );
    }
    case 'warehouse': {
      const zone = (k, t) => signTexture('zone:' + k, { w: 512, h: 512, bg: '#e8a512', lines: [{ text: 'ZONE', size: 0.16, y: 0.25, color: '#141516', weight: 800, spacing: 8 }, { text: t, size: 0.56, y: 0.62, color: '#141516', weight: 900 }] });
      return (
        <group>
          {wallPanel('E', -4.5, 1.9, 'zA', zone('a', 'A'), 0.8, 0.8)}
          {wallPanel('W', -4.5, 1.9, 'zB', zone('b', 'B'), 0.8, 0.8)}
          {wallPanel('S', -1.85, 1.75, 'ppe', signTexture('ppe', { w: 512, h: 700, bg: '#1d5fae', lines: [{ text: 'HI-VIS', size: 0.09, y: 0.42, weight: 800 }, { text: '& SAFETY BOOTS', size: 0.06, y: 0.52 }, { text: 'MUST BE WORN', size: 0.06, y: 0.6 }], draw: (g, w, h) => { g.fillStyle = '#fff'; g.beginPath(); g.arc(w / 2, h * 0.2, w * 0.2, 0, PI * 2); g.fill(); g.fillStyle = '#1d5fae'; g.fillRect(w * 0.42, h * 0.12, w * 0.16, h * 0.16); g.fillStyle = '#fff'; g.fillRect(0, h * 0.75, w, h * 0.25); g.fillStyle = '#1d5fae'; g.font = `700 ${h * 0.05}px ${FONT}`; g.textAlign = 'center'; g.fillText('THIS AREA', w / 2, h * 0.86); } }), 0.5, 0.68)}
          {wallPanel('S', 1.85, 1.75, 'days', signTexture('days', { w: 600, h: 700, bg: '#f3f1ea', border: '#0e8a47', lines: [{ text: 'DAYS WITHOUT', size: 0.06, y: 0.16, color: '#0e8a47', weight: 800 }, { text: 'AN INCIDENT', size: 0.06, y: 0.24, color: '#0e8a47', weight: 800 }, { text: '214', size: 0.3, y: 0.52, color: '#141516', weight: 900 }, { text: 'Safety is everyone’s job', size: 0.045, y: 0.82, color: '#333', weight: 500 }] }), 0.55, 0.64)}
          <FloorLines />
          <Extinguisher p={slot('F1')} />
          <Bin p={slot('F2')} m={M.plasticGreen} lid={M.plasticGreen} />
          <Pallets p={slot('C1')} seed={4} />
          <Pallets p={slot('C2')} seed={9} />
          {common}
        </group>
      );
    }
    case 'shop': {
      const decal = signTexture('shopdecal', { w: 1024, h: 256, bg: 'rgba(0,0,0,0)', lines: [{ text: 'OPEN 7 DAYS · 8AM - 8PM', size: 0.22, y: 0.5, color: 'rgba(255,255,255,0.92)', weight: 600, spacing: 6 }] });
      const neon = signTexture('neon', { w: 512, h: 200, bg: '#000000', lines: [{ text: 'OPEN', size: 0.62, y: 0.54, color: '#ff4f7a', weight: 700, font: SERIF }] });
      return (
        <group>
          {/* window lettering, read from the street so it appears mirrored inside */}
          <mesh position={[-3.95, 2.72, HZ + 0.11]} material={texMat('decal', decal, { transparent: true, side: THREE.DoubleSide })}><planeGeometry args={[2.4, 0.6]} /></mesh>
          <mesh position={[3.9, 2.55, HZ + 0.1]} material={texMat('neon', neon, { glow: 2.2, side: THREE.DoubleSide })}><planeGeometry args={[0.7, 0.27]} /></mesh>
          {wallPanel('N', 0, 3.0, 'shopsign', signTexture('shopsign', { w: 1400, h: 300, bg: '#2f3b33', lines: [{ text: 'THE CORNER STORE', size: 0.36, y: 0.46, font: SERIF, color: '#f1e6cc', spacing: 10 }, { text: 'GOODS · GIFTS · FLOWERS', size: 0.14, y: 0.8, color: '#d6b46a', spacing: 8 }] }), 2.8, 0.6, 'brass')}
          <Poster side="E" along={2.9} y={1.7} k="shop1" palette={['#f6efe4', '#e48aa5', '#7aa37a', '#f2c66a', '#2a2a2a']} title="In Season" sub="Peonies, ranunculus, tulips" frame="woodLight" w={0.8} h={1.12} />
          <Poster side="W" along={2.9} y={1.7} k="shop2" palette={['#eef2ea', '#3c7a5a', '#d9b48a', '#c4683a', '#2a2a2a']} title="Local Makers" sub="Handmade within 50 km" frame="woodLight" w={0.8} h={1.12} />
          <Poster side="E" along={-4.5} y={1.7} k="shop3" palette={['#f4ecdc', '#2f4858', '#e8b04a', '#e48aa5', '#2a2a2a']} title="Gift Wrap" sub="Free with every purchase" frame="woodLight" />
          <Poster side="W" along={-4.5} y={1.7} k="shop4" palette={['#f3ebe0', '#a33b2a', '#7aa37a', '#f2c66a', '#2a2a2a']} title="Est. 1987" sub="Family owned" frame="woodLight" />
          <Plant p={slot('F1')} seed={5} pot={flat('terracotta', '#b0603c', { rough: 0.85 })} />
          <Plant p={slot('F2')} seed={6} pot={M.ceramic} />
          <Plant p={slot('C1')} big seed={21} />
          <Plant p={slot('C2')} big seed={22} pot={M.tileDark} />
          {common}
        </group>
      );
    }
    case 'clinic': {
      return (
        <group>
          <Clock p={[0, 2.95, -HZ]} rim={M.plasticGrey} rad={0.22} />
          {wallPanel('S', -1.85, 1.6, 'hands', signTexture('hands', { w: 512, h: 720, bg: '#ffffff', lines: [{ text: 'Clean hands', size: 0.075, y: 0.2, color: '#1f6f8b', font: SERIF }, { text: 'save lives', size: 0.075, y: 0.29, color: '#1f6f8b', font: SERIF }, ...['1. Wet', '2. Soap 20 sec', '3. Rinse', '4. Dry'].map((t, i) => ({ text: t, size: 0.045, y: 0.45 + i * 0.08, x: 0.18, align: 'left', color: '#333', weight: 500 }))], draw: (g, w, h) => { g.fillStyle = '#a9cfca'; g.fillRect(0, 0, w, h * 0.06); g.fillRect(0, h * 0.94, w, h * 0.06); } }), 0.5, 0.7, 'plasticWhite')}
          {/* glove box dispenser */}
          {(() => {
            const { p, r } = onWall('S', 1.85, 1.35);
            return (
              <group position={p} rotation={r}>
                <B s={[0.8, 0.3, 0.1]} p={[0, 0, 0.05]} m={M.stainless} round={0.008} />
                {[-0.26, 0, 0.26].map((x, i) => <B key={x} s={[0.24, 0.12, 0.085]} p={[x, -0.02, 0.06]} m={[M.plasticBlue, M.flowerPurple, M.plasticWhite][i]} round={0.006} />)}
              </group>
            );
          })()}
          {(() => {
            const { p, r } = onWall('S', 1.85, 1.75);
            return <group position={p} rotation={r}><B s={[0.14, 0.24, 0.1]} p={[0, 0, 0.05]} m={M.plasticWhite} round={0.02} /><B s={[0.06, 0.04, 0.02]} p={[0, -0.1, 0.1]} m={M.plasticGrey} round={0.006} /></group>;
          })()}
          <Poster side="E" along={-4.5} y={1.65} k="clin1" palette={['#f4f7f7', '#a9cfca', '#1f6f8b', '#f2b6a0', '#22303a']} title="Your Health" sub="Ask us about checkups" frame="plasticWhite" />
          <Poster side="W" along={-4.5} y={1.65} k="clin2" palette={['#f6f4f0', '#9ec3dd', '#e8c07a', '#3f7a6a', '#22303a']} title="Breathe Easy" sub="Flu shots available" frame="plasticWhite" />
          <SanitizerStand p={slot('F1')} />
          <Bin p={slot('F2')} pedal m={M.plasticWhite} lid={M.plasticYellow} />
          <Plant p={slot('C1')} big seed={31} pot={M.plasticWhite} />
          <Plant p={slot('C2')} big seed={32} pot={M.plasticWhite} />
          {common}
        </group>
      );
    }
    case 'lab': {
      const mandatory = signTexture('glasses', { w: 512, h: 700, bg: '#ffffff', lines: [{ text: 'SAFETY GLASSES', size: 0.07, y: 0.62, color: '#1d5fae', weight: 800 }, { text: 'MUST BE WORN', size: 0.06, y: 0.71, color: '#1d5fae', weight: 700 }], draw: (g, w, h) => { g.fillStyle = '#1d5fae'; g.beginPath(); g.arc(w / 2, h * 0.3, w * 0.28, 0, PI * 2); g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 16; g.beginPath(); g.arc(w * 0.4, h * 0.3, 40, 0, PI * 2); g.stroke(); g.beginPath(); g.arc(w * 0.6, h * 0.3, 40, 0, PI * 2); g.stroke(); g.fillStyle = '#1d5fae'; g.fillRect(0, h * 0.9, w, h * 0.1); } });
      const hazard = signTexture('hazard', { w: 512, h: 512, bg: '#ffffff', draw: (g, w, h) => { g.save(); g.translate(w / 2, h / 2); g.rotate(PI / 4); g.fillStyle = '#e8a512'; g.fillRect(-w * 0.3, -h * 0.3, w * 0.6, h * 0.6); g.strokeStyle = '#141516'; g.lineWidth = 14; g.strokeRect(-w * 0.3, -h * 0.3, w * 0.6, h * 0.6); g.restore(); g.fillStyle = '#141516'; g.font = `900 ${h * 0.3}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('!', w / 2, h / 2 + 6); } });
      return (
        <group>
          {wallPanel('S', -1.85, 1.65, 'glasses', mandatory, 0.48, 0.66, 'plasticWhite')}
          {wallPanel('S', 1.85, 1.75, 'hazard', hazard, 0.42, 0.42)}
          <Poster side="E" along={-4.5} y={1.65} k="lab1" palette={['#f3f5f6', '#3e7cb1', '#86c5a4', '#f2c66a', '#1d2a33']} title="Periodic Table" sub="Elements 1-118" frame="stainless" w={0.9} h={0.66} />
          <Extinguisher p={slot('F1')} co2 />
          <Bin p={slot('F2')} pedal m={M.plasticYellow} lid={M.plasticRed} />
          <SafetyShower p={slot('C1')} />
          <FlammableCabinet p={slot('C2', 0)} />
          {common}
        </group>
      );
    }
    case 'workshop': {
      return (
        <group>
          {wallPanel('S', -1.85, 1.75, 'shopsafe', signTexture('shopsafe', { w: 600, h: 700, bg: '#f3f1ea', border: '#e8a512', lines: [{ text: 'SAFETY FIRST', size: 0.08, y: 0.18, color: '#141516', weight: 900 }, ...['Eye protection on', 'Guards in place', 'Clean as you go', 'Report every hazard'].map((t, i) => ({ text: t, size: 0.045, y: 0.36 + i * 0.1, color: '#333', weight: 600 }))] }), 0.55, 0.64)}
          <Clock p={[0, 2.35, HZ]} r={[0, PI, 0]} rim={M.darkSteel} rad={0.2} />
          <Poster side="E" along={-4.5} y={1.7} k="ws1" palette={['#ece9e2', '#b41f18', '#e8a512', '#24507f', '#141516']} title="Torque Specs" sub="Check before you fit" frame="darkSteel" />
          <Poster side="W" along={-4.5} y={1.7} k="ws2" palette={['#efece4', '#24507f', '#d9561a', '#3e5a3a', '#141516']} title="Since 1972" sub="Built to last" frame="darkSteel" />
          <Extinguisher p={slot('F1')} />
          <group position={slot('F2')}>
            <C rt={0.2} h={0.62} p={[0, 0.31, 0]} m={M.red} seg={32} />
            <C rt={0.21} h={0.05} p={[0, 0.64, 0]} m={M.red} seg={32} />
            <B s={[0.16, 0.1, 0.004]} p={[0, 0.4, 0.2]} m={M.paper} round={0} />
          </group>
          <Drum p={slot('C1')} m={M.blue} />
          <group position={slot('C2')}><Drum p={[0.0, 0, 0]} m={M.red} /></group>
          <HazardFloor />
          {common}
        </group>
      );
    }
    case 'office': {
      return (
        <group>
          <Clock p={[0, 2.95, -HZ]} rim={M.white} rad={0.22} />
          <Poster side="S" along={-1.85} y={1.6} k="off1" palette={['#f4f2ee', '#3d4b5f', '#d9a36a', '#9ab0c4', '#1e2530']} title="Think Big" sub="Q3 all-hands" frame="black" w={0.7} h={0.98} />
          <Poster side="S" along={1.85} y={1.6} k="off2" palette={['#f2f0ea', '#c4683a', '#3d4b5f', '#e8d6b0', '#1e2530']} title="Ship It" sub="Done beats perfect" frame="black" w={0.7} h={0.98} />
          <Poster side="E" along={-4.5} y={1.6} k="off3" palette={['#eef0f2', '#5a7a9a', '#d9b48a', '#2f3e55', '#1e2530']} title="Horizon" sub="Print No. 7" frame="woodLight" />
          <Poster side="W" along={-4.5} y={1.6} k="off4" palette={['#f5f1ea', '#a35a3a', '#e3c48a', '#33475b', '#1e2530']} title="Terrain" sub="Print No. 3" frame="woodLight" />
          <Plant p={slot('F1')} seed={41} pot={M.plasticBlack} />
          <WaterCooler p={slot('F2')} />
          <Plant p={slot('C1')} big seed={43} pot={M.plasticWhite} />
          <Plant p={slot('C2')} big seed={44} pot={M.plasticBlack} />
          {common}
        </group>
      );
    }
    case 'salon': {
      return (
        <group>
          {wallPanel('N', 0, 3.0, 'salonsign', signTexture('salonsign', { w: 1200, h: 260, bg: '#f2e4da', lines: [{ text: 'Maison', size: 0.5, y: 0.45, font: SERIF, color: '#8a5a44', weight: 400 }, { text: 'HAIR · SKIN · NAILS', size: 0.13, y: 0.83, color: '#b08a5a', spacing: 10 }] }), 2.4, 0.52, 'brass')}
          <Poster side="S" along={-1.85} y={1.65} k="sal1" palette={['#f6ece6', '#e4b7a0', '#c98f7a', '#e8d6b0', '#4a3a33']} title="Glow" sub="Signature facial" frame="brass" />
          <Poster side="S" along={1.85} y={1.65} k="sal2" palette={['#f3ebe4', '#b9a58f', '#e48aa5', '#f2d6c6', '#4a3a33']} title="Balayage" sub="Ask your stylist" frame="brass" />
          <Poster side="W" along={-4.5} y={1.65} k="sal3" palette={['#f4ede7', '#d9b48a', '#a8b8a0', '#c98f7a', '#4a3a33']} title="Unwind" sub="Spa rituals" frame="brass" />
          <Poster side="E" along={-4.5} y={1.65} k="sal4" palette={['#f5efe9', '#c98f7a', '#7a8a70', '#e8d6b0', '#4a3a33']} title="Botanica" sub="Organic care" frame="brass" />
          <Plant p={slot('F1')} seed={51} pot={M.ceramic} />
          <Plant p={slot('F2')} seed={52} pot={M.ceramic} />
          <Plant p={slot('C1')} big seed={53} pot={M.brass} />
          <Plant p={slot('C2')} big seed={54} pot={M.brass} />
          {common}
        </group>
      );
    }
    default:
      return <group>{common}</group>;
  }
}

// Painted walkway lines from the door into the room (warehouse).
function FloorLines() {
  const y = paintMat('yellow', '#e3b11e');
  const g = paintMat('green', '#2f8f4e');
  const line = (x0, z0, x1, z1, m, k) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    return (
      <mesh key={k} material={m} position={[(x0 + x1) / 2, 0.001, (z0 + z1) / 2]} rotation={[-PI / 2, 0, -Math.atan2(z1 - z0, x1 - x0)]} receiveShadow>
        <planeGeometry args={[len, 0.1]} />
      </mesh>
    );
  };
  return (
    <group>
      {line(-1.2, 5.45, -1.2, 2.9, y, 'a')}
      {line(1.2, 5.45, 1.2, 2.9, y, 'b')}
      {line(-6.9, 3.6, -1.2, 3.6, y, 'c')}
      {line(1.2, 3.6, 6.9, 3.6, y, 'd')}
      {[-0.6, 0, 0.6].map((x, i) => line(x - 0.25, 3.3, x + 0.25, 3.3, g, 'e' + i))}
    </group>
  );
}

// Hazard stripes on the floor in front of the roller door (workshop).
function HazardFloor() {
  const yel = paintMat('hz-y', '#e3b11e');
  const blk = paintMat('hz-k', '#1b1b1c');
  return (
    <group position={[HX - 0.55, 0.001, 2.9]} rotation-x={-PI / 2}>
      {Array.from({ length: 13 }, (_, i) => (
        <mesh key={i} position={[0, -1.2 + i * 0.2, 0]} material={i % 2 ? blk : yel} receiveShadow>
          <planeGeometry args={[0.5, 0.2]} />
        </mesh>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------------------------------------------

const VENUE_FLOORS = {
  timber: { tex: 'planks', opts: { seed: 104, n: 10, color: '#9e7655', gap: '#3b2c22' }, span: 2.6, rough: 0.58 },
  tile: { tex: 'tiles', opts: { seed: 105, nx: 4, ny: 4, color: ['#e2dfd2', '#d3cfc3'], grout: '#8c8d83' }, span: 1.7, rough: 0.51 },
  rubber: { tex: 'chips', opts: { seed: 106, color: '#455256', chipColors: ['#737f7d', '#343d40'], n: 4900 }, span: 1.25, rough: 0.89 },
  concrete: { tex: 'concrete', opts: { seed: 107, color: '#8e8e83' }, span: 4, rough: 0.75 },
  gravel: { tex: 'chips', opts: { seed: 108, color: '#786c5b', chipColors: ['#a99981', '#574f44', '#948675'], n: 9000 }, span: 1.5, rough: 0.99 },
  grass: { tex: 'carpet', opts: { seed: 109, color: '#51734a', alt: '#344c30' }, span: 1.8, rough: 0.99 },
};

const VENUE_WALLS = {
  warm: '#ebd2af', coastal: '#c4d8d7', forest: '#a9bd9f',
  industrial: '#adb4b8', clinical: '#e9eeee', bold: '#a1a7cb',
};

const VENUE_LIGHTS = {
  daylight: { color: '#e8f2ff', warm: '#fff2dc', cool: '#c7e5ff', key: 2.65, fill: 1.2, sky: '#b4d7ea' },
  warm: { color: '#ffdeb3', warm: '#ffd2a0', cool: '#e1e7ef', key: 2.2, fill: 0.78, sky: '#dfb696' },
  task: { color: '#f7faff', warm: '#fff1dc', cool: '#e1eeff', key: 2.6, fill: 1.07, sky: '#a6c7db' },
  dusk: { color: '#f3d9cd', warm: '#ffac78', cool: '#a7b0e0', key: 1.55, fill: 0.65, sky: '#706c91' },
};

function VenueBoundary({ sides, outdoor }) {
  const rail = outdoor ? M.woodDark : M.stainless;
  return sides.map((side) => {
    const { p, r } = onWall(side, 0, 0, 0.03);
    const span = side === 'E' || side === 'W' ? D : W;
    const segments = Math.ceil(span / 1.6);
    return (
      <group key={side} position={p} rotation={r}>
        <B s={[span, 0.09, 0.1]} p={[0, 0.9, 0]} m={rail} round={0.012} />
        <B s={[span, 0.055, 0.07]} p={[0, 0.38, 0]} m={rail} round={0.006} />
        {Array.from({ length: segments + 1 }, (_, i) =>
          <B key={i} s={[0.09, 0.94, 0.09]} p={[i * (span - 0.16) / segments - (span - 0.16) / 2, 0.47, 0]} m={rail} round={0.012} />)}
      </group>
    );
  });
}

function VenueSign({ name, outdoor }) {
  const map = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 768;
    canvas.height = 128;
    const g = canvas.getContext('2d');
    g.fillStyle = '#223844';
    g.fillRect(0, 0, 768, 128);
    g.strokeStyle = '#d0a572';
    g.lineWidth = 3;
    g.strokeRect(8, 8, 752, 112);
    g.fillStyle = '#f8eada';
    g.font = '700 52px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(name, 384, 65, 700);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }, [name]);
  useEffect(() => () => map.dispose(), [map]);
  return (
    <group position={[0, outdoor ? 1.88 : 3.22, -HZ + 0.11]}>
      {outdoor && [-1.28, 1.28].map(x =>
        <B key={x} s={[0.10, 2.0, 0.10]} p={[x, -0.93, -0.04]} m={M.woodDark} round={0.005} />)}
      <B s={[2.82, 0.39, 0.04]} m={M.woodDark} round={0.012} />
      <mesh position={[0, 0, 0.023]}>
        <planeGeometry args={[2.73, 0.34]} />
        <meshBasicMaterial map={map} toneMapped={false} />
      </mesh>
    </group>
  );
}

export default function Shell({ id = 'cafe', venue, cutaway = false }) {
  const sid = CFG[id] ? id : 'cafe';
  const native = CFG[sid];
  const floor = VENUE_FLOORS[venue?.floor] ?? native.floor;
  const wallColor = VENUE_WALLS[venue?.palette];
  const wall = wallColor ? { tex: 'plaster', opts: { seed: 111, color: wallColor }, span: 2.6, rough: 0.88 } : native.wall;
  const outdoor = venue?.enclosure === 'outdoor';
  const openFront = venue?.enclosure === 'open_front';
  const areas = cutaway ? ['N', 'E', 'W'] : ['N', 'S', 'E', 'W'];
  const walls = outdoor ? [] : areas.filter(side => !openFront || side !== 'S');
  const fence = outdoor ? areas : openFront && !cutaway ? ['S'] : [];
  const cfg = { ...native, floor, wall, counter: outdoor || openFront ? { ...native.counter, noShelves: true, splash: null } : native.counter };
  const materialId = `${sid}:${venue?.floor ?? 'native'}:${venue?.palette ?? 'native'}`;
  return (
    <group name={`shell-${sid}`}>
      {(outdoor || openFront) && <Slab s={[180, 0.10, 180]} p={[0, -0.19, 0]} mat={M.soil} />}
      <Floor id={materialId} cfg={cfg} />
      <NoCast>
        {!outdoor && !cutaway && <Ceiling id={sid} cfg={cfg} />}
        {!outdoor && !cutaway && <CeilingLights cfg={cfg} />}
        {walls.map(side => <Wall key={side} id={materialId} cfg={cfg} side={side} />)}
      </NoCast>
      <VenueBoundary sides={fence} outdoor={outdoor} />
      {SUPPLY_COUNTERS.map((c, i) => <SupplyCounter key={i} id={sid} cfg={cfg} c={c} />)}
      {!outdoor && !openFront && <Dressing id={sid} cfg={cfg} />}
      {venue?.name && <VenueSign name={venue.name} outdoor={outdoor} />}
    </group>
  );
}

// Interior light rig (replaces the outdoor Lighting from game/Look.jsx). Real lights: hemisphere, shadowed key,
// window fill, two ceiling points = 5.
export function ShellLighting({ id = 'cafe', venue }) {
  const cfg = CFG[id] ?? CFG.cafe;
  const outdoor = venue?.enclosure === 'outdoor';
  const visibleSky = outdoor || venue?.enclosure === 'open_front';
  const variation = VENUE_LIGHTS[venue?.lighting] ?? (outdoor ? VENUE_LIGHTS.daylight : null);
  const L = { ...cfg.light, ...variation };
  const winSide = cfg.windows.W ? -1 : cfg.windows.E ? 1 : 0;
  const fillPos = L.fromFront ? [0, 4, 14] : winSide ? [winSide * 14, 4, 2.9] : [0, 6, -12];
  const ceil = variation?.color ?? cfg.lights.color;
  return (
    <>
      <color attach="background" args={[visibleSky ? L.sky ?? '#b4d7ea' : '#0c0c0d']} />
      <hemisphereLight args={[L.hemi[0], L.hemi[1], L.hemi[2]]} />
      <directionalLight
        color={ceil}
        intensity={L.key}
        position={[-2.5, 10, 4.5]}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-radius={4}
        shadow-bias={-0.0003}
        shadow-normalBias={0.025}
        shadow-camera-left={-9}
        shadow-camera-right={9}
        shadow-camera-top={9}
        shadow-camera-bottom={-9}
        shadow-camera-near={1}
        shadow-camera-far={25}
      />
      <directionalLight color={L.cool} intensity={L.fill} position={fillPos} />
      <pointLight color={L.warm} intensity={outdoor ? 0 : L.point} position={[-3.2, 2.3, 0.2]} distance={14} decay={2} />
      <pointLight color={L.warm} intensity={outdoor ? 0 : L.point} position={[3.2, 2.3, 0.2]} distance={14} decay={2} />
      <Environment resolution={256} frames={1} environmentIntensity={0.9}>
        <color attach="background" args={[L.env]} />
        {/* ceiling fixtures */}
        {[-4, 0, 4].map((x) => <Lightformer key={x} form="rect" intensity={2.2} color={ceil} position={[x, 3.3, 0]} rotation-x={PI / 2} scale={[2.4, 6, 1]} />)}
        {/* window daylight */}
        {cfg.windows.W && <Lightformer form="rect" intensity={3} color={L.cool} position={[-7, 1.9, 2.9]} rotation-y={PI / 2} scale={[2.4, 1.6, 1]} />}
        {cfg.windows.E && <Lightformer form="rect" intensity={3} color={L.cool} position={[7, 1.9, 2.9]} rotation-y={-PI / 2} scale={[2.4, 1.6, 1]} />}
        {cfg.windows.S && <Lightformer form="rect" intensity={3} color={L.cool} position={[0, 2, 5.5]} rotation-y={PI} scale={[12, 2, 1]} />}
        {cfg.windows.N && <Lightformer form="rect" intensity={2.5} color={L.cool} position={[0, 2.95, -5.5]} scale={[12, 0.5, 1]} />}
        {/* warm floor bounce */}
        <Lightformer form="rect" intensity={0.35} color={L.warm} position={[0, -0.5, 0]} rotation-x={-PI / 2} scale={[14, 11, 1]} />
      </Environment>
    </>
  );
}

export const SHELL_CONFIGS = CFG;
export { SHELL_IDS };
