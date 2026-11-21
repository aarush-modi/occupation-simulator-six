import assert from 'node:assert/strict';
import test from 'node:test';
import { createNpcPlanner, RoomCrowd } from '../src/npcs.js';
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

test('the smaller OpenAI model batches NPC direction and the room rejects unknown station IDs', async () => {
  let called = false;
  const planner = createNpcPlanner({ apiKey: 'test', fetcher: async (url, request) => {
    called = true;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const input = JSON.parse(request.body);
    assert.equal(input.model, 'gpt-5-mini');
    assert.equal(input.store, false);
    const payload = JSON.parse(input.input);
    assert.equal(payload.npcs.length, 2);
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
      cast: [
        { npc: 'mgr', station: 'main', action: 'prepare', line: 'Good morning. We are setting up for service.' },
        { npc: 'coworker', station: 'missing', action: 'stock', line: 'I will use the missing station.' },
      ],
    }) }] }] });
  } });
  const bp = blueprint();
  const crowd = new RoomCrowd(bp, CATALOG, planner);
  const player = { active: true, pos: [6, 0, 4], lastSeen: 1000 };
  const state = { phase: 'play', players: { p: player }, closed: [], cur: 0, objectives: bp.objectives };
  crowd.step(state, 1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(called, true);
  assert.equal(crowd.plans.get('mgr').action, 'prepare');
  assert.equal(crowd.plans.has('coworker'), false);
  assert.equal(crowd.smallTalk('mgr', { pos: crowd.snapshot().mgr.pos }), 'Good morning. We are setting up for service.');
});
