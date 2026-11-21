// Snapshot buffer shared by net.js (writer) and the renderers (readers). Remote players and NPCs are drawn
// INTERP_MS in the past and interpolated between the two snapshots around that time (N3).
export const INTERP_MS = 110;
const snaps = []; // { t, players, npcs }

export function pushSnap(state) {
  if (!state?.players) return;
  snaps.push({ t: performance.now(), players: state.players, npcs: state.npcs ?? {} });
  while (snaps.length > 30) snaps.shift();
}

function around(now) {
  const t = now - INTERP_MS;
  let a = null, b = null;
  for (let i = snaps.length - 1; i >= 0; i--) {
    if (snaps[i].t <= t) { a = snaps[i]; b = snaps[i + 1] ?? null; break; }
  }
  if (!a) a = snaps[0];
  return { a, b, k: a && b ? Math.min(1, Math.max(0, (t - a.t) / Math.max(1, b.t - a.t))) : 0 };
}

const lerpAngle = (x, y, k) => {
  let d = y - x;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return x + d * k;
};

/** Interpolated pose of a player at render time: { pos:[x,y,z], yaw, pitch } or null. */
export function samplePlayer(id, now = performance.now()) {
  const { a, b, k } = around(now);
  const pa = a?.players?.[id];
  if (!pa) return null;
  const pb = b?.players?.[id];
  if (!pb) return { pos: pa.pos, yaw: pa.yaw, pitch: pa.pitch ?? 0 };
  return {
    pos: [pa.pos[0] + (pb.pos[0] - pa.pos[0]) * k, pa.pos[1] + (pb.pos[1] - pa.pos[1]) * k, pa.pos[2] + (pb.pos[2] - pa.pos[2]) * k],
    yaw: lerpAngle(pa.yaw, pb.yaw, k),
    pitch: (pa.pitch ?? 0) + ((pb.pitch ?? 0) - (pa.pitch ?? 0)) * k,
  };
}

/** Interpolated NPC: { pos:[x,z], yaw, moving, goal, target } or null (before the first snapshot). */
export function sampleNpc(id, now = performance.now()) {
  const { a, b, k } = around(now);
  const na = a?.npcs?.[id];
  if (!na) return null;
  const nb = b?.npcs?.[id];
  if (!nb) return na;
  return { ...nb, pos: [na.pos[0] + (nb.pos[0] - na.pos[0]) * k, na.pos[1] + (nb.pos[1] - na.pos[1]) * k], yaw: lerpAngle(na.yaw, nb.yaw, k) };
}
