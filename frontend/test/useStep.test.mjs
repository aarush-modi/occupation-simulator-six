import assert from 'node:assert/strict';
import test from 'node:test';
import { staticInteractables, matchesObjective, gesturesFor, gestureHint, indexBlueprint } from '../src/engine/world.js';
import { createLineQueue } from '../src/engine/store.js';

const bp = {
  stations: [{ id: 'bar', prop: 'espresso_machine', anchor: 'N2', label: 'Espresso machine' }],
  items: [{ id: 'jug', prop: 'milk_jug', anchor: 'S1', label: 'Milk jug' }, { id: 'cup', prop: 'coffee_cup', anchor: 'S2', label: 'Cup' }],
  npcs: [],
};
const pour = { id: 'p', verb: 'use', item: 'jug', target: 'bar.cup', action: 'pour', motion: 'tilt', label: 'Pour the milk' };
const state = (held) => ({
  phase: 'play', closed: [], cur: 0, objectives: [pour], done: [],
  players: { me: { held, step: 0 } },
  items: { jug: { at: held === 'jug' ? null : 'S1', holder: held === 'jug' ? 'me' : null, tags: [] }, cup: { at: 'bar.cup', holder: null, tags: [] } },
});

test('a use step shows one spot, only with the right thing in hand, done by its natural gesture', () => {
  const idx = indexBlueprint(bp);
  assert.equal(staticInteractables(idx, state(null), 'me').some((it) => it.kind === 'use'), false);
  const use = staticInteractables(idx, state('jug'), 'me').find((it) => it.kind === 'use');
  assert.ok(use, 'appears with the jug in hand');
  assert.equal(use.label, 'Pour the milk');
  assert.deepEqual(use.intent, { t: 'use', target: 'bar.cup' });
  assert.ok(matchesObjective(pour, use));
  assert.ok(gesturesFor(use).includes('tilt'));
  assert.equal(gestureHint(use), 'Tilt your hand to pour');
  assert.deepEqual(gesturesFor({ kind: 'use', motion: 'strike' }).slice(0, 1), ['strike']);
});

test('talking over an NPC cuts their line and drops what was queued', () => {
  const stops = [];
  const seen = [];
  const set = (patch) => seen.push(patch);
  const queue = createLineQueue({ speakLine: (who, text) => () => stops.push(text), prefetch: () => {}, setTimer: () => {} });
  queue.push({ who: 'Sam', text: 'First line' }, set);
  queue.push({ who: 'Sam', text: 'Second line' }, set);
  assert.deepEqual(queue.interrupt(set), { who: 'Sam', text: 'First line' });
  assert.deepEqual(stops, ['First line']);
  assert.equal(queue.pending, 0);
  assert.deepEqual(seen.at(-1), { subtitle: null });
  assert.equal(queue.interrupt(set), null, 'nothing left to cut');
});
