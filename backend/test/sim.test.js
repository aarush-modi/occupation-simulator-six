import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, applyIntent, tick, adjustStanding, STALE_MS, STANDING_START, MISTAKE_COST } from '../../frontend/src/shared/sim.js';
import { checkBlueprint } from '../../frontend/src/shared/validate.js';
import { CATALOG, blueprint } from './fixtures.js';

const T0 = 1_000_000;

function room() {
  let state = createRoom(blueprint(), CATALOG, T0);
  const all = [];
  const act = (pid, intent, now = T0) => {
    const r = applyIntent(state, pid, intent, now);
    state = r.state;
    all.push(...r.events);
    return r.events;
  };
  const advance = (now) => {
    const r = tick(state, now);
    state = r.state;
    all.push(...r.events);
    return r.events;
  };
  act('a', { t: 'join', name: 'Ana' });
  act('b', { t: 'join', name: 'Ben' });
  return { get state() { return state; }, act, advance, all };
}
const denied = (events) => events.find((e) => e.type === 'denied')?.reason ?? null;

test('state is JSON-serialisable and has the contract shape', () => {
  const r = room();
  const json = JSON.parse(JSON.stringify(r.state));
  assert.deepEqual(Object.keys(json).sort(), ['closed', 'cur', 'done', 'event', 'items', 'objectives', 'phase', 'players', 'score', 'standing', 'startedAt'].sort());
  assert.deepEqual(json.items.cup1, { at: 'S1', holder: null, tags: ['cup', 'ceramic'] });
  assert.equal(json.players.a.held, null);
});

test('applyIntent is pure and never throws', () => {
  const r = room();
  const before = JSON.stringify(r.state);
  const s0 = r.state;
  applyIntent(s0, 'a', { t: 'grab', item: 'cup1' }, T0);
  assert.equal(JSON.stringify(s0), before);
  for (const bad of [null, {}, { t: 'place' }, { t: 'press', target: 42 }, { t: 'pose', pos: 'x' }, { t: 'nope' }]) {
    assert.doesNotThrow(() => applyIntent(s0, 'a', bad, T0));
  }
  assert.equal(denied(r.act('ghost', { t: 'grab', item: 'cup1' })), 'not joined');
});

test('single hold: an item has one holder and a player holds one item', () => {
  const r = room();
  assert.equal(denied(r.act('a', { t: 'grab', item: 'cup1' })), null);
  assert.equal(denied(r.act('b', { t: 'grab', item: 'cup1' })), 'held by someone else');
  assert.equal(denied(r.act('a', { t: 'grab', item: 'cup2' })), 'hands full');
  assert.equal(r.state.items.cup1.holder, 'a');
  assert.equal(r.state.items.cup1.at, null);
  assert.equal(r.state.players.a.held, 'cup1');
  assert.equal(r.state.players.b.held, null);
});

test('handoff moves the item to a player with free hands', () => {
  const r = room();
  r.act('a', { t: 'grab', item: 'cup1', hand: 'left' });
  assert.equal(r.state.players.a.holdHand, 'left');
  r.act('b', { t: 'grab', item: 'cup2' });
  assert.equal(denied(r.act('a', { t: 'handoff', to: 'b' })), 'their hands are full');
  r.act('b', { t: 'place', item: 'cup2', target: 'S3' });
  assert.ok(r.act('a', { t: 'handoff', to: 'b' }).some((e) => e.type === 'handoff'));
  assert.equal(r.state.items.cup1.holder, 'b');
  assert.equal(r.state.players.b.held, 'cup1');
  assert.equal(r.state.players.a.held, null);
  assert.equal(r.state.players.a.holdHand, undefined);
});

test('objectives complete only in order', () => {
  const r = room();
  r.act('a', { t: 'grab', item: 'cup1' });
  r.act('a', { t: 'place', item: 'cup1', target: 'main.cup' });
  assert.equal(r.state.cur, 0, 'placing before checking in does not count');
  assert.deepEqual(r.state.done, []);
  r.act('a', { t: 'grab', item: 'cup1' });
  const ev = r.act('b', { t: 'talk', npc: 'mgr' });
  // o1 done; o2 (grab cup1) is already satisfied because Ana is holding it.
  assert.deepEqual(r.state.done, ['o1', 'o2']);
  assert.ok(ev.some((e) => e.type === 'objective' && e.id === 'o1'));
  const placed = r.act('a', { t: 'place', item: 'cup1', target: 'main.cup' });
  assert.deepEqual(r.state.done, ['o1', 'o2', 'o3']);
  assert.ok(placed.some((e) => e.type === 'say' && e.text === 'Nice and level.'), 'objective say line is emitted');
});

test('press requires its slots and applies the sets tag; slots check tags', () => {
  const r = room();
  assert.equal(denied(r.act('a', { t: 'press', target: 'main.brew' })), 'needs cup');
  r.act('a', { t: 'grab', item: 'cup1' });
  assert.equal(denied(r.act('a', { t: 'place', item: 'cup1', target: 'shelf.drink' })), 'cup1 does not fit drink');
  r.act('a', { t: 'place', item: 'cup1', target: 'main.cup' });
  r.act('b', { t: 'press', target: 'main.brew', skillScore: 0.7 });
  assert.ok(r.state.items.cup1.tags.includes('brewed'));
  r.act('a', { t: 'grab', item: 'cup1' });
  assert.equal(denied(r.act('a', { t: 'place', item: 'cup1', target: 'shelf.drink' })), null);
  r.act('b', { t: 'grab', item: 'cup2' });
  assert.equal(denied(r.act('b', { t: 'place', item: 'cup2', target: 'S1' })), null);
  r.act('a', { t: 'grab', item: 'cup1' });
  assert.equal(denied(r.act('a', { t: 'place', item: 'cup1', target: 'S1' })), 'occupied');
});

function playToO3(r) {
  r.act('a', { t: 'talk', npc: 'mgr' });
  r.act('a', { t: 'grab', item: 'cup1' });
  r.act('a', { t: 'place', item: 'cup1', target: 'main.cup' }, T0 + 1000);
}

test('event director fires after the delay, closes the station and replaces remaining objectives', () => {
  const r = room();
  playToO3(r);
  assert.equal(r.state.event.at, T0 + 1000 + 2000);
  // Players keep going during the delay; that progress is replaced.
  r.act('a', { t: 'press', target: 'main.brew', skillScore: 0.9 }, T0 + 1500);
  assert.deepEqual(r.state.done, ['o1', 'o2', 'o3', 'o4']);
  assert.deepEqual(r.advance(T0 + 2500), []);
  const ev = r.advance(T0 + 3000);
  assert.deepEqual(ev.map((e) => e.type), ['eventFired', 'say']);
  assert.equal(ev[0].announce.text, 'The main machine just died, use the backup!');
  assert.deepEqual(r.state.closed, ['main']);
  assert.equal(r.state.event.fired, true);
  assert.deepEqual(r.state.objectives.map((o) => o.id), ['o1', 'o2', 'o3', 'r1', 'r2', 'r3', 'r4', 'r5']);
  assert.equal(r.state.cur, 3);
  assert.deepEqual(r.state.done, ['o1', 'o2', 'o3']);
  assert.equal(r.state.score.skills.o4, undefined);
  assert.equal(denied(r.act('a', { t: 'press', target: 'main.brew' }, T0 + 3100)), 'closed');
  assert.equal(denied(r.act('a', { t: 'grab', item: 'cup1' }, T0 + 3100)), 'closed');
  assert.deepEqual(r.advance(T0 + 9000), [], 'fires once');
});

test('the revised task can be finished together and ends in review with skill scores', () => {
  const r = room();
  playToO3(r);
  r.advance(T0 + 3000);
  r.act('b', { t: 'grab', item: 'cup2' }, T0 + 3100);
  r.act('b', { t: 'handoff', to: 'a' }, T0 + 3200);
  r.act('a', { t: 'place', item: 'cup2', target: 'backup.cup' }, T0 + 3300);
  r.act('b', { t: 'press', target: 'backup.brew', skillScore: 0.4 }, T0 + 3400);
  r.act('b', { t: 'grab', item: 'cup2' }, T0 + 3500);
  assert.equal(r.state.phase, 'play');
  const ev = r.act('b', { t: 'place', item: 'cup2', target: 'shelf.drink' }, T0 + 3600);
  assert.equal(r.state.phase, 'review');
  assert.ok(ev.some((e) => e.type === 'review'));
  assert.equal(r.state.score.finishedAt, T0 + 3600);
  assert.equal(r.state.score.skills.r3, 0.4);
  assert.deepEqual(Object.keys(r.state.score.skills), ['o1', 'o2', 'o3', 'r1', 'r2', 'r3', 'r4', 'r5']);
  assert.equal(denied(r.act('a', { t: 'grab', item: 'cup1' }, T0 + 3700)), 'shift over');
});

test('players: max 4, poses are clamped, stale holders are released', () => {
  const r = room();
  r.act('c', { t: 'join', name: 'C' });
  r.act('d', { t: 'join', name: 'D' });
  assert.equal(denied(r.act('e', { t: 'join', name: 'E' })), 'room full');
  assert.equal(Object.keys(r.state.players).length, 4);
  r.act('a', { t: 'pose', pos: [100, 1.6, -2], yaw: 1.2, pitch: 0.1 });
  assert.deepEqual(r.state.players.a.pos, [7, 1.6, -2]);
  assert.equal(r.state.players.a.yaw, 1.2);
  r.act('b', { t: 'grab', item: 'cup2' }, T0);
  r.act('a', { t: 'ping' }, T0 + STALE_MS);
  assert.deepEqual(r.advance(T0 + STALE_MS), [], 'not stale yet');
  const ev = r.advance(T0 + STALE_MS + 1);
  assert.deepEqual(ev.filter((e) => e.type === 'released').map((e) => [e.playerId, e.item, e.at]), [['b', 'cup2', 'S2']]);
  assert.equal(r.state.items.cup2.holder, null);
  assert.equal(r.state.players.b.held, null);
  assert.equal(r.state.items.cup2.at, 'S2', 'returns to its spawn anchor');
});

// A pour step: grab the jug, pour it into the seated cup (which becomes a latte), then serve.
function latteBlueprint() {
  const bp = blueprint();
  bp.items.push({ id: 'jug', prop: 'cup', anchor: 'S3', label: 'Milk jug' });
  bp.objectives = [
    { id: 'p1', verb: 'grab', target: 'cup1', label: 'Grab a cup', skill: 'none' },
    { id: 'p2', verb: 'place', target: 'main.cup', item: 'cup1', label: 'Seat the cup', skill: 'none' },
    { id: 'p3', verb: 'grab', target: 'jug', label: 'Pick up the milk jug', skill: 'none' },
    { id: 'p4', verb: 'use', target: 'main.cup', item: 'jug', action: 'pour', motion: 'tilt', sets: 'latte', label: 'Pour the milk', skill: 'none' },
    { id: 'p5', verb: 'press', target: 'shelf.bell', label: 'Ring the bell', skill: 'none' },
  ];
  delete bp.event;
  return bp;
}

test('use: the current step\'s trade action with the item in hand tags the item in the slot', () => {
  let state = createRoom(latteBlueprint(), CATALOG, T0);
  const act = (intent) => { const r = applyIntent(state, 'a', intent, T0); state = r.state; return r.events; };
  act({ t: 'join', name: 'Ana' });
  act({ t: 'grab', item: 'cup1' });
  act({ t: 'place', item: 'cup1', target: 'main.cup' });
  assert.equal(denied(act({ t: 'use', target: 'main.cup' })), 'not now', 'only once it is the step');
  act({ t: 'grab', item: 'jug' });
  assert.equal(denied(act({ t: 'use', target: 'backup.cup' })), 'not now', 'the wrong spot does nothing');
  const ev = act({ t: 'use', target: 'main.cup' });
  assert.deepEqual(ev.find(e => e.type === 'used'), { type: 'used', playerId: 'a', item: 'jug', target: 'main.cup', action: 'pour', on: 'cup1', sets: 'latte' });
  assert.ok(state.items.cup1.tags.includes('latte'));
  assert.ok(state.done.includes('p4'));
});

test('use steps are validated and played through by the bot', () => {
  const withEvent = () => {
    const bp = latteBlueprint();
    bp.event = {
      after: 'p3', delaySec: 2, announce: { npc: 'mgr', text: 'They want it extra milky!' },
      replaceRemaining: [{ ...bp.objectives[3], id: 'q4' }, { ...bp.objectives[4], id: 'q5' }],
    };
    return bp;
  };
  const ok = checkBlueprint(withEvent(), CATALOG);
  assert.deepEqual(ok.errors, []);
  const bad = withEvent();
  bad.objectives[3] = { ...bad.objectives[3], target: 'main', motion: undefined };
  const { errors } = checkBlueprint(bad, CATALOG);
  assert.ok(errors.some(e => /needs "motion"/.test(e)));
  assert.ok(errors.some(e => /"sets" must target "station.slot"/.test(e)));
});

test('fumbles cost standing once per moment, and at zero the player loses the job', () => {
  const r = room();
  assert.equal(r.state.standing.value, STANDING_START);
  r.act('a', { t: 'grab', item: 'cup1' });
  r.act('a', { t: 'place', item: 'cup1', target: 'shelf.drink' }, T0 + 10); // does not fit: not brewed yet
  r.act('a', { t: 'place', item: 'cup1', target: 'shelf.drink' }, T0 + 500); // same fumble, same moment
  assert.equal(r.state.standing.value, STANDING_START - MISTAKE_COST);
  assert.ok(r.all.some(e => e.type === 'standing' && e.reason === 'Fumbled a task'));
  const lost = adjustStanding(r.state, -200, 'Rude to a customer', T0 + 1000, 'a');
  assert.equal(lost.state.phase, 'review');
  assert.deepEqual(lost.state.standing.failed, { reason: 'Rude to a customer', at: T0 + 1000 });
  assert.ok(lost.events.some(e => e.type === 'fired' && e.reason === 'Rude to a customer'));
  assert.equal(r.state.phase, 'play', 'adjustStanding is pure');
});

test('a customer kept waiting past their patience slowly costs standing', () => {
  const bp = blueprint();
  bp.order = { npc: 'mgr', text: 'One espresso', patienceSec: 60, waiting: 'Still waiting!' };
  let state = createRoom(bp, CATALOG, T0);
  state = applyIntent(state, 'a', { t: 'join', name: 'Ana' }, T0).state;
  const at = (ms) => { state.players.a.lastSeen = T0 + ms; state = tick(state, T0 + ms).state; };
  at(59_000);
  assert.equal(state.standing.value, STANDING_START);
  at(61_000);
  at(62_000);
  assert.equal(state.standing.value, STANDING_START - 2, 'charged once per 5 s');
  at(71_000);
  assert.equal(state.standing.value, STANDING_START - 6);
});
