import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { checkBlueprint } from '../src/shared/validate.js';
import { CATALOG } from '../src/shared/catalog/catalog.generated.js';
import { createLineQueue } from '../src/engine/store.js';

const barista = () => JSON.parse(fs.readFileSync(new URL('../../backend/src/demos/barista.json', import.meta.url), 'utf8'));

test('realism: the barista demo carries tips, a mentor, an order and a career profile', () => {
  const { errors, blueprint } = checkBlueprint(barista(), CATALOG);
  assert.deepEqual(errors, []);
  assert.ok(blueprint.objectives.every(o => o.tip));
  assert.equal(blueprint.mentor, 'maya');
  assert.equal(blueprint.order.npc, 'leo');
  assert.equal(blueprint.career.loves.length, 3);
});

test('realism: unknown mentor or customer NPCs are rejected', () => {
  const raw = barista();
  raw.mentor = 'ghost';
  raw.order.npc = 'nobody';
  const { errors } = checkBlueprint(raw, CATALOG);
  assert.ok(errors.includes('mentor ghost is not an npc'), errors.join('; '));
  assert.ok(errors.includes('order.npc nobody is not an npc'), errors.join('; '));
});

test('realism: shifts without the new fields stay valid', () => {
  const raw = barista();
  delete raw.mentor; delete raw.order; delete raw.career;
  for (const o of raw.objectives) delete o.tip;
  assert.deepEqual(checkBlueprint(raw, CATALOG).errors, []);
});

test('line queue: lines play one after another, and a backlog drops the oldest', () => {
  const timers = [], spoken = [], shown = [];
  const ends = [];
  const queue = createLineQueue({
    speakLine: (who, text, end) => { spoken.push(text); ends.push(end); },
    setTimer: (fn) => timers.push(fn),
    max: 2,
  });
  const set = (patch) => shown.push(patch.subtitle?.text ?? null);
  queue.push({ who: 'Maya', text: 'one' }, set);
  queue.push({ who: 'Maya', text: 'two' }, set);
  queue.push({ who: 'Maya', text: 'three' }, set);
  queue.push({ who: 'Maya', text: 'four' }, set);
  assert.deepEqual(spoken, ['one'], 'a new line waits for the current one');
  timers.shift()();
  assert.deepEqual(spoken, ['one'], 'the subtitle time alone does not advance while the voice is still talking');
  ends.shift()();
  assert.deepEqual(spoken, ['one', 'three'], 'then the next line plays, and the backlog kept the newest two');
  ends.shift()(); timers.shift()();
  assert.deepEqual(spoken, ['one', 'three', 'four']);
  ends.shift()(); timers.shift()();
  assert.equal(shown.at(-1), null, 'the subtitle clears when the queue is empty');
});
