// Conversation camera lock: while the player talks with an NPC, the view turns to face them and walking pauses.
// Set when the player speaks or waves at an NPC, or an NPC addresses them; kept alive while that NPC is speaking.
export const MAX_LOCK_MS = 22000;
export const talkLock = { npc: null, until: 0, since: 0 };

export function lockTalk(npc, ms = 4000, now = performance.now()) {
  if (!npc) return;
  if (talkLock.npc !== npc) { talkLock.npc = npc; talkLock.since = now; talkLock.until = 0; }
  talkLock.until = Math.max(talkLock.until, now + ms);
}

export function releaseTalk() {
  talkLock.npc = null; talkLock.until = 0; talkLock.since = 0;
}

/** Keep the lock while `speaking`; drop it once it lapses, the NPC is gone or far, or it has run too long. */
export function updateTalkLock({ speaking, distance, now = performance.now() }) {
  if (!talkLock.npc) return false;
  if (distance == null || distance > 4.6 || now > talkLock.until || now - talkLock.since > MAX_LOCK_MS) {
    releaseTalk();
    return false;
  }
  if (speaking) talkLock.until = Math.max(talkLock.until, now + 1200);
  return true;
}

/** Heading (camera yaw, forward = -z) that looks from `from` to `to`. */
export const yawToFace = (from, to) => Math.atan2(-(to[0] - from[0]), -(to[2] - from[2]));
