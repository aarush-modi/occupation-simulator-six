import assert from 'node:assert/strict';
import test from 'node:test';
import { pickListener } from '../src/engine/listener.js';

// Player at the origin facing -z (yaw 0).
const people = {
  ahead: { id: 'ahead', name: 'Sam', pos: [0, 0, -2.5] },
  behind: { id: 'behind', name: 'Casey', pos: [0, 0, 2] },
  far: { id: 'far', name: 'Ari', pos: [6, 0, 0] },
};
const at = { pos: [0, 0, 0], yaw: 0 };

test('the NPC under the crosshair hears the player first', () => {
  const focus = { kind: 'talk', intent: { t: 'talk', npc: 'behind' } };
  assert.equal(pickListener({ ...at, focus, people }).id, 'behind');
});

test('otherwise the NPC in front wins over a slightly closer one behind', () => {
  assert.equal(pickListener({ ...at, focus: { kind: 'grab' }, people }).id, 'ahead');
});

test('someone right behind the player still hears them', () => {
  assert.equal(pickListener({ ...at, focus: null, people: { behind: { ...people.behind, pos: [0, 0, 1] } } }).id, 'behind');
});

test('no one out of earshot hears the player', () => {
  assert.equal(pickListener({ ...at, focus: null, people: { far: people.far } }), null);
});

import { isEcho } from '../src/engine/listener.js';

test('the NPC hearing their own voice is echo; the player talking over them is not', () => {
  const line = 'Morning! Table four wants two flat whites, extra hot.';
  assert.equal(isEcho('two flat whites extra hot', line), true);
  assert.equal(isEcho('wait, do we have oat milk', line), false);
  assert.equal(isEcho('', line), true);
});
