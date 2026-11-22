// Which NPC hears the player's voice. Pure, so it can be tested without a browser.
export const HEAR_RANGE = 3.6; // metres; the server allows 4, the margin covers interpolation lag

/**
 * Who hears the player: the NPC under the crosshair, else the nearest one in range, favouring whoever is in front.
 * `people` maps id -> { id, name, pos }. Returns that person or null.
 */
export function pickListener({ focus, people, pos, yaw, range = HEAR_RANGE }) {
  const focused = focus?.kind === 'talk' ? people[focus.intent?.npc] : null;
  if (focused) return focused;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  let best = null, bestScore = Infinity;
  for (const person of Object.values(people)) {
    const dx = person.pos[0] - pos[0], dz = person.pos[2] - pos[2];
    const dist = Math.hypot(dx, dz);
    if (dist > range) continue;
    const facing = dist > 1e-3 ? (dx * fx + dz * fz) / dist : 1;
    const score = dist - facing * 1.2;
    if (score < bestScore) { bestScore = score; best = person; }
  }
  return best;
}

/** Is this transcript just the NPC's own line coming back through the speakers? */
export function isEcho(transcript, line) {
  const words = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(' ').filter(Boolean);
  const heard = words(transcript);
  if (!heard.length) return true;
  const spoken = new Set(words(line));
  return heard.filter((w) => spoken.has(w)).length / heard.length >= 0.5;
}
