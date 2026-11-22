import assert from 'node:assert/strict';
import test from 'node:test';
import { talkLock, lockTalk, releaseTalk, updateTalkLock, yawToFace, MAX_LOCK_MS } from '../src/engine/talkLock.js';

test('the camera faces the NPC: yaw points the -z forward vector at them', () => {
  for (const [to, yaw] of [[[0, 0, -2], 0], [[2, 0, 0], -Math.PI / 2], [[-2, 0, 0], Math.PI / 2]]) {
    const y = yawToFace([0, 0, 0], to);
    assert.ok(Math.abs(y - yaw) < 1e-9, `${to} -> ${y}`);
    assert.ok(Math.abs(-Math.sin(y) - to[0] / 2) < 1e-9 && Math.abs(-Math.cos(y) - to[2] / 2) < 1e-9);
  }
});

test('the lock holds while the NPC speaks and lets go after', () => {
  releaseTalk();
  lockTalk('sam', 3000, 0);
  assert.equal(updateTalkLock({ speaking: false, distance: 1.5, now: 1000 }), true);
  assert.equal(updateTalkLock({ speaking: true, distance: 1.5, now: 6000 }), false, 'lapsed before the line started');
  lockTalk('sam', 3000, 10000);
  assert.equal(updateTalkLock({ speaking: true, distance: 1.5, now: 12900 }), true);
  assert.equal(updateTalkLock({ speaking: true, distance: 1.5, now: 14000 }), true, 'kept alive by speech');
  assert.equal(updateTalkLock({ speaking: false, distance: 1.5, now: 15500 }), false, 'released once speech ends');
  assert.equal(talkLock.npc, null);
});

test('walking away or a very long exchange releases the lock', () => {
  lockTalk('sam', 5000, 0);
  assert.equal(updateTalkLock({ speaking: true, distance: 6, now: 100 }), false);
  lockTalk('sam', 5000, 0);
  let t = 0;
  while (updateTalkLock({ speaking: true, distance: 1, now: t })) t += 500;
  assert.ok(t > MAX_LOCK_MS - 500 && t <= MAX_LOCK_MS + 500);
});
