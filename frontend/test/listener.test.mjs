import assert from 'node:assert/strict';
import test from 'node:test';
import { pickListener, MIC_RANGE } from '../src/engine/listener.js';

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

test('the open mic only addresses someone close and in front', () => {
  const people = { a: { id: 'a', pos: [0, 0, -2] }, b: { id: 'b', pos: [2, 0, 0] } };
  const strict = { range: MIC_RANGE, minFacing: 0.55 };
  // facing -z: a is ahead, b is to the side
  assert.equal(pickListener({ people, pos: [0, 0, 0], yaw: 0, ...strict })?.id, 'a');
  assert.equal(pickListener({ people, pos: [0, 0, 0], yaw: Math.PI, ...strict }), null, 'nobody in front');
  assert.equal(pickListener({ people: { a: { id: 'a', pos: [0, 0, -3.2] } }, pos: [0, 0, 0], yaw: 0, ...strict }), null, 'too far for the mic');
  assert.equal(pickListener({ people, pos: [0, 0, 0], yaw: Math.PI })?.id, 'b', 'typed lines still reach whoever is near');
});
