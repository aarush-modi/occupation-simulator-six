import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, applyIntent, tick, STALE_MS } from '../../frontend/src/shared/sim.js';
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
  assert.deepEqual(Object.keys(json).sort(), ['closed', 'cur', 'done', 'event', 'items', 'objectives', 'phase', 'players', 'score', 'startedAt'].sort());
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
  r.act('a', { t: 'grab', item: 'cup1' });
  r.act('b', { t: 'grab', item: 'cup2' });
  assert.equal(denied(r.act('a', { t: 'handoff', to: 'b' })), 'their hands are full');
  r.act('b', { t: 'place', item: 'cup2', target: 'S3' });
  assert.ok(r.act('a', { t: 'handoff', to: 'b' }).some((e) => e.type === 'handoff'));
  assert.equal(r.state.items.cup1.holder, 'b');
  assert.equal(r.state.players.b.held, 'cup1');
  assert.equal(r.state.players.a.held, null);
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
