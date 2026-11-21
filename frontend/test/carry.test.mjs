import assert from 'node:assert/strict';
import test from 'node:test';
import { CARRY_GRACE_MS, carryingNeeded, mayRelease } from '../src/engine/carry.js';

// Barista demo: the cup was just grabbed and the next objective is to seat it under the espresso machine.
const state = {
  cur: 1,
  objectives: [{ verb: 'grab', target: 'cup' }, { verb: 'place', target: 'espresso.cup', item: 'cup' }],
  players: { me: { held: 'cup' } },
};
const counter = { kind: 'place', intent: { t: 'place', item: 'cup', target: 'counter.spot' } };
const espresso = { kind: 'place', intent: { t: 'place', item: 'cup', target: 'espresso.cup' } };
const base = { state, you: 'me', grabAt: 0, now: CARRY_GRACE_MS + 1, moving: false };

test('carry: the plan needs the cup, so only its destination takes it', () => {
  assert.equal(carryingNeeded(state, 'me'), true);
  assert.equal(mayRelease({ ...base, it: counter, matches: false }), false);
  assert.equal(mayRelease({ ...base, it: espresso, matches: true }), true);
});

test('carry: no put-down right after the grab or while walking', () => {
  assert.equal(mayRelease({ ...base, it: espresso, matches: true, now: 500 }), false);
  assert.equal(mayRelease({ ...base, it: espresso, matches: true, moving: true }), false);
});

test('carry: an item the plan does not need can go anywhere, and handoffs still work', () => {
  const spare = { ...state, players: { me: { held: 'spoon' } } };
  assert.equal(carryingNeeded(spare, 'me'), false);
  assert.equal(mayRelease({ ...base, state: spare, it: counter, matches: false }), true);
  assert.equal(mayRelease({ ...base, it: { kind: 'handoff' }, matches: false }), true);
});
