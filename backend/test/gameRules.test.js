import assert from 'node:assert/strict';
import test from 'node:test';
import { createGenerator } from '../src/generate.js';
import { Room } from '../src/rooms.js';
import { clampToArena } from '../../frontend/src/shared/gameRules.js';
import { createRoom, applyIntent, tick } from '../../frontend/src/shared/sim.js';
import { validateBlueprint } from '../../frontend/src/shared/validate.js';
import { CATALOG, blueprint } from './fixtures.js';

const coach = { id: 'coach', name: 'Jo', role: 'Corner coach', anchor: 'P2', lines: { intro: 'Watch for the opening.', done: 'Good round.' } };
const rival = { id: 'rival', name: 'Vega', role: 'Opponent', anchor: 'P1', lines: { intro: 'Ready when you are.', done: 'Good match.' } };
const sparring = () => ({
  ...blueprint(), occupation: 'boxer', title: 'Rooftop Open', shell: 'workshop',
  venue: { name: 'Cedar Terrace', enclosure: 'outdoor', floor: 'rubber', palette: 'bold', lighting: 'dusk' },
  stations: [], items: [], decor: [], objectives: [], event: undefined, npcs: [rival, coach],
  game: { kind: 'sparring', arena: { sides: 5, radius: 3.5, mat: 'blue' }, opponent: rival.id, style: 'steady', rounds: 2, roundSeconds: 30, pointsToWin: 3 },
});
const t = 100000;

test('the boxing request reaches the director intact and new rooms generate separate games', async () => {
  const request = 'Boxer in a rooftop ring with a Street Fighter-style arcade match';
  let calls = 0;
  const generator = createGenerator({
    catalog: CATALOG, log: { log() {} },
    callModel: async ({ schema, user, system }) => {
      calls++;
      assert.ok(user.includes(request));
      assert.match(system, /existing game as a genre cue/);
      assert.match(system, /two-open-palm guard/);
      assert.equal(schema.properties.game.properties.kind.const, 'sparring');
      assert.equal(schema.properties.game.properties.arena.properties.sides.const, 5);
      if (calls > 1) assert.match(user, /Rooftop Open/);
      const raw = sparring();
      if (calls > 1) {
        raw.title = 'Terrace Cup';
        raw.game.style = 'pressure';
      }
      return { text: JSON.stringify({ ...raw, event: null }) };
    },
  });
  const first = new Room('first', request, { catalog: CATALOG, demos: [] });
  const second = new Room('second', request, { catalog: CATALOG, demos: [] });
  const a = await first.startGeneration(generator);
  const b = await second.startGeneration(generator);
  assert.equal(a.ok, true, a.error);
  assert.equal(b.ok, true, b.error);
  assert.equal(first.snapshot().people.rival.mode, 'sparring');
  assert.equal(first.snapshot().people.coach.mode, 'idle');
  assert.equal(second.blueprint.title, 'Terrace Cup');
  assert.equal(second.blueprint.game.style, 'pressure');
  assert.equal(calls, 2);

  const clients = ['Ana', 'Ben'].map(name => {
    const messages = [];
    const socket = { readyState: 1, send: data => messages.push(JSON.parse(data)) };
    first.attach(socket);
    first.onMessage(socket, JSON.stringify({ t: 'join', name }));
    first.onMessage(socket, JSON.stringify({ t: 'pose', active: true, pos: [0, 0, 0.1], yaw: 0 }));
    return { socket, messages };
  });
  first.step(Date.now());
  first.onMessage(clients[0].socket, JSON.stringify({ t: 'strike' }));
  first.step(Date.now());
  for (const { messages } of clients) {
    assert.equal(messages.at(-1).state.game.points, 1);
    assert.equal(messages.at(-1).state.people.rival.action, 'recoil');
    assert.ok(messages.some(msg => msg.events?.some(ev => ev.type === 'say' && ev.npc === coach.id)));
  }
});

test('a shared sparring match guards, scores, confines poses and ends after its generated rounds', () => {
  const bp = sparring();
  assert.deepEqual(validateBlueprint(bp, CATALOG), []);
  assert.match(validateBlueprint({ ...bp, game: { ...bp.game, opponent: 'absent' } }, CATALOG).join(), /listed NPC/);
  let state = createRoom(bp, CATALOG, t);
  const act = (id, intent, dt) => { state = applyIntent(state, id, intent, t + dt).state; };
  const advance = (dt) => { state = tick(state, t + dt).state; };
  const pose = (id, dt, guard = false) => act(id, { t: 'pose', pos: [0, 0, 0.1], yaw: 0, active: true, guard }, dt);
  act('a', { t: 'join' }, 0);
  act('b', { t: 'join' }, 0);
  advance(0);
  assert.equal(state.game.status, 'waiting');
  act('b', { t: 'pose', pos: [8, 0, 8] }, 5);
  const clamped = state.players.b.pos;
  assert.deepEqual(clamped, clampToArena([7, 0, 5.5], bp.game.arena));
  pose('a', 50);
  advance(50);
  assert.equal(state.game.status, 'live');
  advance(1300);
  assert.equal(state.game.opponent.action, 'windup');
  pose('a', 2000, true);
  advance(2060);
  assert.equal(state.game.rivalPoints, 0);
  pose('b', 2100);
  act('a', { t: 'strike' }, 2140);
  act('b', { t: 'strike' }, 2180);
  act('b', { t: 'strike' }, 2240);
  assert.equal(state.game.points, 2);
  act('b', { t: 'strike' }, 2650);
  assert.equal(state.game.status, 'rest');
  assert.equal(state.game.wins, 1);
  advance(4850);
  assert.equal(state.game.round, 2);
  assert.equal(state.game.points, 0);
  pose('a', 4900);
  for (const dt of [4900, 5500, 6100]) act('a', { t: 'strike' }, dt);
  assert.equal(state.phase, 'review');
  assert.equal(state.game.result, 'win');
  assert.equal(state.game.wins, 2);
});

test('timed work challenges give allies shared credit or let rivals win the race', () => {
  for (const role of ['ally', 'rival']) {
    const bp = blueprint();
    bp.game = { kind: 'challenge', partner: bp.npcs[0].id, role, seconds: 30, pointsPerTask: 2, goal: 5, rivalEverySeconds: 4 };
    assert.deepEqual(validateBlueprint(bp, CATALOG), []);
    let state = createRoom(bp, CATALOG, t);
    state = applyIntent(state, 'a', { t: 'join' }, t).state;
    state = applyIntent(state, 'a', { t: 'pose', active: true }, t + 10).state;
    state = tick(state, t + 10).state;
    state = applyIntent(state, 'a', { t: 'grab', item: 'cup1' }, t + 100).state;
    state = applyIntent(state, 'a', { t: 'talk', npc: 'mgr' }, t + 200).state;
    if (role === 'ally') {
      assert.equal(state.game.points, 5);
      assert.equal(state.game.result, 'win');
    } else {
      assert.equal(state.game.points, 4);
      state = tick(state, t + 4010).state;
      assert.equal(state.game.rivalPoints, 0, 'a rival in transit does not score');
      for (const dt of [5010, 9010, 13010]) state = tick(state, t + dt, { rivalStation: 'main' }).state;
      assert.equal(state.game.rivalPoints, 6);
      assert.equal(state.game.result, 'loss');
    }
  }
});

test('a rival walks to a station and shares their first point with the room', () => {
  const bp = blueprint();
  bp.game = { kind: 'challenge', partner: 'mgr', role: 'rival', seconds: 75, pointsPerTask: 2, goal: 8, rivalEverySeconds: 4 };
  const room = new Room('race', 'barista', { catalog: CATALOG, demos: [] });
  room.setBlueprint(bp, 'openai');
  const messages = [];
  const ws = { readyState: 1, send: text => messages.push(JSON.parse(text)) };
  room.attach(ws);
  room.onMessage(ws, JSON.stringify({ t: 'join', name: 'Player' }));
  room.onMessage(ws, JSON.stringify({ t: 'pose', pos: [5.9, 0, 4.5], active: true }));
  const id = Object.keys(room.state.players)[0];
  const start = Date.now();
  const initialPos = room.snapshot().people.mgr.pos;
  let worked = false;
  for (let dt = 0; dt < 14000 && !room.state.game.rivalPoints; dt += 50) {
    room.state.players[id].lastSeen = start + dt;
    room.step(start + dt);
    worked ||= messages.at(-1).state.people.mgr.mode === 'work';
  }
  const { people, game } = messages.at(-1).state;
  assert.equal(people.mgr.side, 'rival');
  assert.ok(worked);
  assert.notDeepEqual(people.mgr.pos, initialPos);
  assert.equal(game.rivalPoints, 2);
});
