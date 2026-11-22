import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { applyIntent, createRoom, playerStep, tick } from '../src/shared/sim.js';
import { checkBlueprint } from '../src/shared/validate.js';
import { CATALOG } from '../src/shared/catalog/catalog.generated.js';

const raw = JSON.parse(fs.readFileSync(new URL('../../backend/src/demos/barista.json', import.meta.url), 'utf8'));
const { blueprint } = checkBlueprint(raw, CATALOG);

function room(...names) {
  let state = createRoom(blueprint, CATALOG, 0);
  const events = [];
  const act = (id, intent) => {
    const r = applyIntent(state, id, intent, 1);
    state = r.state;
    events.push(...r.events);
    return r.events.find(e => e.type === 'denied')?.reason ?? null;
  };
  for (const name of names) act(name, { t: 'join', name });
  const advance = (now) => { state = tick(state, now).state; };
  return { act, advance, events, get state() { return state; }, step: (id) => playerStep(state, id) };
}

test('roles: two players split register and bar and each works their own steps', () => {
  const r = room('ana', 'ben');
  assert.equal(r.state.players.ana.role, 'register');
  assert.equal(r.state.players.ben.role, 'bar');
  assert.equal(r.step('ana').obj.id, 'take_order');
  assert.equal(r.step('ben').obj.id, 'checkin');
  r.act('ben', { t: 'talk', npc: 'leo' }); // not the bar's step
  assert.equal(r.step('ana').obj.id, 'take_order');
  r.act('ana', { t: 'talk', npc: 'leo' });
  r.act('ben', { t: 'talk', npc: 'maya' });
  assert.equal(r.step('ana').obj.id, 'grab_cup');
  assert.equal(r.step('ben').obj.id, 'grab_beans');
});

test('roles: the bar waits for the register to pass the cup, then takes it', () => {
  const r = room('ana', 'ben');
  r.act('ana', { t: 'talk', npc: 'leo' });
  r.act('ben', { t: 'talk', npc: 'maya' });
  r.act('ben', { t: 'grab', item: 'beans' });
  r.act('ben', { t: 'place', item: 'beans', target: 'grinder.bag' });
  r.act('ben', { t: 'press', target: 'grinder.grind' });
  assert.equal(r.step('ben').obj.id, 'take_cup_bar');
  assert.equal(r.step('ben').waiting, true);
  assert.equal(r.step('ben').waitingOn.id, 'pass_cup');
  r.act('ana', { t: 'grab', item: 'cup' });
  assert.equal(r.step('ben').waiting, true, 'the register holding the cup is not the hand-off');
  r.act('ana', { t: 'place', item: 'cup', target: 'S5' });
  assert.equal(r.step('ben').waiting, false);
  r.act('ben', { t: 'grab', item: 'cup' });
  assert.equal(r.step('ben').obj.id, 'seat_cup');
  assert.equal(r.step('ana').obj.id, 'grab_milk', 'the register moves on to prepping milk');
});

test('roles: handing the cup straight to the bar counts as passing it', () => {
  const r = room('ana', 'ben');
  r.act('ana', { t: 'talk', npc: 'leo' });
  r.act('ben', { t: 'talk', npc: 'maya' });
  r.act('ben', { t: 'grab', item: 'beans' });
  r.act('ben', { t: 'place', item: 'beans', target: 'grinder.bag' });
  r.act('ben', { t: 'press', target: 'grinder.grind' });
  r.act('ana', { t: 'grab', item: 'cup' });
  assert.equal(r.act('ana', { t: 'handoff', to: 'ben' }), null);
  assert.equal(r.state.players.ben.held, 'cup');
  assert.ok(r.state.done.includes('pass_cup') && r.state.done.includes('take_cup_bar'));
  assert.equal(r.step('ben').obj.id, 'seat_cup');
});

test('roles: a solo player does every step in list order, and a leaver frees their role', () => {
  const solo = room('ana');
  assert.deepEqual(solo.state.players.ana.lane.toSorted(), ['bar', 'register']);
  assert.equal(solo.step('ana').obj.id, 'take_order');
  solo.act('ana', { t: 'talk', npc: 'leo' });
  assert.equal(solo.step('ana').obj.id, 'checkin', 'solo continues with the bar step next in the list');
  const duo = room('ana', 'ben');
  duo.act('ben', { t: 'leave' });
  assert.deepEqual(duo.state.players.ana.lane.toSorted(), ['bar', 'register']);
});

test('roles: the shift reviews once both roles finish', () => {
  const r = room('ana', 'ben');
  const A = (i) => r.act('ana', i), B = (i) => r.act('ben', i);
  A({ t: 'talk', npc: 'leo' }); B({ t: 'talk', npc: 'maya' });
  B({ t: 'grab', item: 'beans' }); B({ t: 'place', item: 'beans', target: 'grinder.bag' }); B({ t: 'press', target: 'grinder.grind' });
  A({ t: 'grab', item: 'cup' }); A({ t: 'place', item: 'cup', target: 'S5' });
  A({ t: 'grab', item: 'milk' }); A({ t: 'place', item: 'milk', target: 'steamer.jug' }); A({ t: 'press', target: 'steamer.steam' });
  B({ t: 'grab', item: 'cup' }); B({ t: 'place', item: 'cup', target: 'espresso.cup' });
  r.advance(4500); // 4 s later the main machine clogs: the bar switches to the spare cup and the backup machine
  assert.equal(r.step('ben').obj.id, 'grab_spare');
  assert.equal(r.step('ana').obj.id, 'bell_spare');
  assert.equal(r.step('ana').waiting, true);
  B({ t: 'grab', item: 'cup2' }); B({ t: 'place', item: 'cup2', target: 'backup.cup' }); B({ t: 'press', target: 'backup.brew' });
  B({ t: 'grab', item: 'cup2' }); B({ t: 'place', item: 'cup2', target: 'pickup.pickup' });
  assert.equal(r.step('ana').waiting, false);
  A({ t: 'press', target: 'pickup.bell' });
  assert.equal(r.state.phase, 'review');
});
