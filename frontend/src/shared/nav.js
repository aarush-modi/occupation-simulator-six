// Walkability for a blueprint room: a coarse occupancy grid built from the room walls, the built-in supply
// counters and every placed station / furniture / decor footprint. Pure (no React, no three).
// Used by the sim (NPC paths), the validator (every required station is reachable, F2) and tests.
//
//   buildNav(bp, recipes) -> nav            recipes: Map(id -> recipe) or array
//   standPoint(nav, target) -> [x, z]       where a player/NPC stands to use a station, surface or spot
//   findPath(nav, from, to) -> [[x, z]...]  null when unreachable; first point = from, last = to (snapped)
//   isReachable(nav, from, to) -> boolean
import { ANCHORS, ROOM, SUPPLY_COUNTERS } from './layout.js';

export const CELL = 0.25;
export const BODY_RADIUS = 0.3;
const HALF_W = ROOM.W / 2;
const HALF_D = ROOM.D / 2;

/** World XZ AABB of a recipe placed at an anchor (matches scene/Prop.jsx recipeColliders). */
export function footprint(recipe, anchorId) {
  const a = ANCHORS[anchorId];
  if (!a || !recipe) return null;
  const [w, , d] = recipe.size;
  const c = Math.abs(Math.cos(a.rotY ?? 0));
  const s = Math.abs(Math.sin(a.rotY ?? 0));
  const hx = (w * c + d * s) / 2;
  const hz = (w * s + d * c) / 2;
  return { minX: a.pos[0] - hx, maxX: a.pos[0] + hx, minZ: a.pos[2] - hz, maxZ: a.pos[2] + hz };
}

const toMap = (recipes) => (recipes instanceof Map ? recipes : new Map((recipes ?? []).map((r) => [r.id, r])));

export function buildNav(bp, recipes, { radius = BODY_RADIUS } = {}) {
  const rec = toMap(recipes);
  const boxes = [];
  // Supply counters run from their front edge back to the front wall.
  for (const c of SUPPLY_COUNTERS) {
    boxes.push({ minX: c.pos[0] - c.size[0] / 2, maxX: c.pos[0] + c.size[0] / 2, minZ: c.pos[2] - c.size[2] / 2, maxZ: HALF_D });
  }
  const placed = new Map(); // station id -> { box, anchor, recipe }
  for (const st of bp.stations ?? []) {
    const r = rec.get(st.prop);
    const box = footprint(r, st.anchor);
    if (box) { boxes.push(box); placed.set(st.id, { box, anchor: st.anchor, recipe: r }); }
  }
  for (const d of bp.decor ?? []) {
    const box = footprint(rec.get(d.prop), d.anchor);
    if (box) boxes.push(box);
  }
  const cols = Math.round(ROOM.W / CELL);
  const rows = Math.round(ROOM.D / CELL);
  const blocked = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const [x, z] = cellCenter(i, j);
      let hit = Math.abs(x) > HALF_W - radius || Math.abs(z) > HALF_D - radius;
      for (let k = 0; !hit && k < boxes.length; k++) {
        const b = boxes[k];
        const cx = Math.min(Math.max(x, b.minX), b.maxX);
        const cz = Math.min(Math.max(z, b.minZ), b.maxZ);
        if ((x - cx) ** 2 + (z - cz) ** 2 < radius * radius) hit = true;
      }
      blocked[j * cols + i] = hit ? 1 : 0;
    }
  }
  return { cols, rows, blocked, boxes, placed, radius };
}

function cellCenter(i, j) {
  return [-HALF_W + (i + 0.5) * CELL, -HALF_D + (j + 0.5) * CELL];
}
function cellOf(x, z, nav) {
  const i = Math.min(nav.cols - 1, Math.max(0, Math.floor((x + HALF_W) / CELL)));
  const j = Math.min(nav.rows - 1, Math.max(0, Math.floor((z + HALF_D) / CELL)));
  return [i, j];
}
const free = (nav, i, j) => i >= 0 && j >= 0 && i < nav.cols && j < nav.rows && !nav.blocked[j * nav.cols + i];

/** Nearest free cell to a point (breadth-first over rings), or null. */
function snap(nav, x, z, maxRing = 8) {
  const [ci, cj] = cellOf(x, z, nav);
  if (free(nav, ci, cj)) return [ci, cj];
  let best = null, bestD = Infinity;
  for (let ring = 1; ring <= maxRing && !best; ring++) {
    for (let dj = -ring; dj <= ring; dj++) {
      for (let di = -ring; di <= ring; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== ring || !free(nav, ci + di, cj + dj)) continue;
        const [cx, cz] = cellCenter(ci + di, cj + dj);
        const d = (cx - x) ** 2 + (cz - z) ** 2;
        if (d < bestD) { bestD = d; best = [ci + di, cj + dj]; }
      }
    }
  }
  return best;
}

/**
 * Where to stand to use something. target: station id, anchor id (surface / spot / wall / island) or [x, z].
 * Stations: in front of the footprint along the anchor's facing. Surfaces: in front of the supply counter.
 */
export function standPoint(nav, target) {
  if (Array.isArray(target)) return target;
  const st = nav.placed.get(target);
  const anchorId = st ? st.anchor : target;
  const a = ANCHORS[anchorId];
  if (!a) return null;
  const rot = a.rotY ?? 0;
  const fx = Math.sin(rot), fz = Math.cos(rot); // local +Z (front) in world space
  if (a.kind === 'spot' || a.kind === 'spawn') return [a.pos[0], a.pos[2]];
  const depth = st ? st.recipe.size[2] : a.kind === 'surface' ? 0.7 : 1;
  const off = depth / 2 + nav.radius + 0.35;
  return [a.pos[0] + fx * off, a.pos[2] + fz * off];
}

/** A* over the grid (8-connected, no corner cutting), then line-of-sight smoothing. */
export function findPath(nav, from, to) {
  const s = snap(nav, from[0], from[1]);
  const g = snap(nav, to[0], to[1]);
  if (!s || !g) return null;
  const { cols, rows } = nav;
  const N = cols * rows;
  const start = s[1] * cols + s[0], goal = g[1] * cols + g[0];
  const gScore = new Float32Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const open = [start];
  gScore[start] = 0;
  const h = (k) => { const dx = Math.abs((k % cols) - g[0]), dz = Math.abs(Math.floor(k / cols) - g[1]); return Math.max(dx, dz) + 0.414 * Math.min(dx, dz); };
  const f = new Float32Array(N).fill(Infinity);
  f[start] = h(start);
  let found = start === goal;
  while (open.length && !found) {
    let bi = 0;
    for (let k = 1; k < open.length; k++) if (f[open[k]] < f[open[bi]]) bi = k;
    const cur = open[bi];
    open[bi] = open[open.length - 1];
    open.pop();
    if (cur === goal) { found = true; break; }
    closed[cur] = 1;
    const ci = cur % cols, cj = Math.floor(cur / cols);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = ci + di, nj = cj + dj;
        if (!free(nav, ni, nj)) continue;
        if (di && dj && (!free(nav, ci + di, cj) || !free(nav, ci, cj + dj))) continue;
        const nk = nj * cols + ni;
        if (closed[nk]) continue;
        const t = gScore[cur] + (di && dj ? 1.414 : 1);
        if (t < gScore[nk]) {
          if (gScore[nk] === Infinity) open.push(nk);
          gScore[nk] = t;
          came[nk] = cur;
          f[nk] = t + h(nk);
        }
      }
    }
  }
  if (!found) return null;
  const cells = [];
  for (let k = goal; k !== -1; k = came[k]) cells.push(k);
  cells.reverse();
  const pts = cells.map((k) => cellCenter(k % cols, Math.floor(k / cols)));
  // smoothing: keep a point only when the straight line from the last kept point to the next one is blocked
  const out = [pts[0]];
  let anchor = 0;
  for (let k = 2; k < pts.length; k++) {
    if (!lineFree(nav, pts[anchor], pts[k])) { out.push(pts[k - 1]); anchor = k - 1; }
  }
  if (pts.length > 1) out.push(pts[pts.length - 1]);
  return out.map(([x, z]) => [Math.round(x * 100) / 100, Math.round(z * 100) / 100]);
}

function lineFree(nav, a, b) {
  const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (CELL * 0.5));
  for (let k = 0; k <= steps; k++) {
    const t = steps ? k / steps : 0;
    const [i, j] = cellOf(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, nav);
    if (!free(nav, i, j)) return false;
  }
  return true;
}

export function isReachable(nav, from, to) {
  return findPath(nav, from, to) !== null;
}

export function spawnPoint() {
  return [ANCHORS.SPAWN.pos[0], ANCHORS.SPAWN.pos[2]];
}
