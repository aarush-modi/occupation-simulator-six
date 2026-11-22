import assert from 'node:assert/strict';
import test from 'node:test';
import { createNpcPlanner, playerStations, RoomCrowd } from '../src/npcs.js';
import { Room } from '../src/rooms.js';
import { CATALOG, blueprint } from './fixtures.js';

test('a generated room adds moving coworkers, shared snapshots and private proximity greetings', () => {
  const room = new Room('test', 'barista', { catalog: CATALOG, demos: [] });
  const messages = [];
  const client = { readyState: 1, send: text => messages.push(JSON.parse(text)) };
  room.setBlueprint(blueprint(), 'openai');
  room.attach(client);
  room.onMessage(client, JSON.stringify({ t: 'join', name: 'Player' }));
  room.onMessage(client, JSON.stringify({ t: 'pose', pos: [0, 0, 4.3], active: true }));
  const now = Date.now();
  const initial = room.snapshot();
  const id = Object.keys(initial.players)[0];
  assert.equal(Object.keys(initial.people).length, 2);
  const lines = [];
  let work = false;
  for (let t = 0; t < 14000; t += 50) {
    room.state.players[id].lastSeen = now + t;
    room.step(now + t);
    const snapshot = messages.pop();
    assert.equal(snapshot.type, 'snapshot');
    work ||= Object.values(snapshot.state.people).some(npc => npc.mode === 'work');
    lines.push(...messages.splice(0).flatMap(message => message.events ?? []).filter(event => event.type === 'say' && event.playerId === id));
  }
  assert.ok(lines.length > 0, 'a nearby coworker spoke independently');
  assert.equal(new Set(lines.map(line => line.npc)).size, lines.length, 'NPCs greet a player once');
  assert.ok(work, 'a coworker reached a station');
  assert.notDeepEqual(room.snapshot().people.coworker.pos, initial.people.coworker.pos);
  assert.equal(room.state.cur, 0, 'greetings leave talk task available');
});

const geminiReply = (value) => Response.json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(value) }] }] });

test('the smaller Gemini model directs NPCs with job-specific activities and the room rejects unknown station IDs', async () => {
  let calls = 0;
  const planner = createNpcPlanner({ apiKey: 'test', fetcher: async (url, request) => {
    calls++;
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    const input = JSON.parse(request.body);
    assert.equal(input.model, 'gemini-4-hydrogen');
    assert.equal(input.store, false);
    assert.deepEqual(input.response_format.schema.properties.cast.items.required, ['npc', 'station', 'action', 'activity', 'line']);
    const payload = JSON.parse(input.input);
    assert.equal(payload.npcs.length, 2);
    assert.equal(payload.player.current_task, calls === 1 ? 'Check in with Sam' : 'Grab a cup');
    return geminiReply({
      cast: [
        { npc: 'mgr', station: calls === 1 ? 'main' : 'backup', action: 'prepare', activity: calls === 1 ? 'Dialing in the grinder' : 'Warming cups for your shot', line: 'Good morning. We are setting up for service.' },
        { npc: 'coworker', station: 'missing', action: 'stock', activity: 'Nothing', line: 'I will use the missing station.' },
      ],
    });
  } });
  const bp = blueprint();
  const crowd = new RoomCrowd(bp, CATALOG, planner);
  const player = { active: true, pos: [6, 0, 4], lastSeen: 1000, step: 0 };
  const state = { phase: 'play', players: { p: player }, closed: [], cur: 0, done: [], objectives: bp.objectives };
  crowd.step(state, 1000);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(calls, 1);
  assert.equal(crowd.plans.get('mgr').action, 'prepare');
  assert.equal(crowd.plans.get('mgr').activity, 'Dialing in the grinder');
  assert.equal(crowd.plans.has('coworker'), false);
  assert.equal(crowd.smallTalk('mgr', { pos: crowd.snapshot().mgr.pos }), 'Good morning. We are setting up for service.');

  // The player moves on: coworkers are re-directed, but not more often than every few seconds.
  player.step = 1; state.done = ['o1'];
  player.lastSeen = 3000;
  crowd.step(state, 3000);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(calls, 1, 'too soon to re-plan');
  player.lastSeen = 7500;
  crowd.step(state, 7500);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(calls, 2);
  assert.equal(crowd.plans.get('mgr').activity, 'Warming cups for your shot');
  for (let t = 7550; t < 16000; t += 50) {
    player.lastSeen = t;
    crowd.step(state, t);
    if (crowd.snapshot().mgr.station === 'backup') break;
  }
  assert.equal(crowd.snapshot().mgr.station, 'backup', 'the main machine is next for the player, so Sam works elsewhere');
  assert.equal(crowd.snapshot().mgr.activity, 'Warming cups for your shot', 'the activity label is the generated one');
});

test('an NPC talking to a player keeps facing them for the whole line', () => {
  const crowd = new RoomCrowd(blueprint(), CATALOG, null);
  const npc = crowd.snapshot().mgr;
  const player = { pos: [npc.pos[0] + 1, 0, npc.pos[2]] };
  crowd.lastTime = 0;
  assert.equal(crowd.holdTalk('mgr', player, 'p', 9000), true);
  const after = crowd.snapshot().mgr;
  assert.equal(after.mode, 'talk');
  assert.ok(Math.abs(after.yaw - Math.PI / 2) < 1e-9, 'turned toward the player');
  assert.equal(crowd.actors.find(a => a.id === 'mgr').until, 9000);
  assert.equal(crowd.holdTalk('mgr', { pos: [npc.pos[0] + 9, 0, npc.pos[2]] }, 'p', 1000), false, 'too far away');
});

test('coworkers keep away from the stations the player needs next', () => {
  const bp = blueprint();
  // The cup is in hand and the next steps are seating it in the main machine and pulling the shot there.
  const state = { phase: 'play', closed: [], cur: 2, objectives: bp.objectives, items: { cup1: { at: 'hand' } },
    players: { p: { active: true, pos: [0, 0, 4.3], lastSeen: 0 } } };
  assert.deepEqual([...playerStations(state)], ['main']);
  const crowd = new RoomCrowd(bp, CATALOG, null);
  crowd.actors.forEach(actor => actor.greeted.add('p'));
  // a coworker already working at the main machine leaves it
  crowd.actors[0].station = 'main'; crowd.actors[0].mode = 'work'; crowd.actors[0].until = Infinity;
  const visited = new Set();
  for (let t = 0; t < 30000; t += 50) {
    state.players.p.lastSeen = t;
    crowd.step(state, t);
    for (const actor of crowd.actors) if (actor.station) visited.add(actor.station);
  }
  assert.equal(visited.has('main'), false, `coworkers used ${[...visited]}`);
  assert.ok(visited.size > 0, 'coworkers still work elsewhere');
});

test('a grab reserves the station the item sits in', () => {
  const bp = blueprint();
  const state = { cur: 4, objectives: bp.objectives, items: { cup1: { at: 'main.cup' } } };
  assert.deepEqual([...playerStations(state)].sort(), ['main', 'shelf']);
});

test('coworkers call out while they work, at most once every 20 s', () => {
  const bp = blueprint();
  bp.npcs[0].lines.ambient = ['Behind!', 'Order up'];
  const state = { phase: 'play', closed: [], cur: 0, objectives: bp.objectives, items: {},
    players: { p: { active: true, pos: [6, 0, 4.3], lastSeen: 0 } } };
  const crowd = new RoomCrowd(bp, CATALOG, null);
  crowd.actors.forEach(actor => actor.greeted.add('p'));
  const calls = [];
  for (let t = 0; t < 60000; t += 50) {
    state.players.p.lastSeen = t;
    for (const event of crowd.step(state, t)) if (event.type === 'say') calls.push({ t, text: event.text });
  }
  assert.ok(calls.length >= 2, `call-outs ${calls.length}`);
  for (let i = 1; i < calls.length; i++) assert.ok(calls[i].t - calls[i - 1].t >= 20000);
  assert.ok(calls.every(call => bp.npcs[0].lines.ambient.includes(call.text)));
});
