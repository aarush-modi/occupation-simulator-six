import assert from 'node:assert/strict';
import test from 'node:test';
import { createNpcPlanner, playerStations, RoomCrowd } from '../src/npcs.js';
import { Room } from '../src/rooms.js';
import { CATALOG, blueprint } from './fixtures.js';
import { ANCHORS } from '../../frontend/src/shared/layout.js';

test('a generated room adds moving coworkers and shared snapshots, and nobody talks unprompted', () => {
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
  assert.deepEqual(lines, [], 'NPCs only speak when spoken to or when the shift calls for it');
  assert.ok(work, 'a coworker reached a station');
  assert.notDeepEqual(room.snapshot().people.coworker.pos, initial.people.coworker.pos);
  assert.equal(room.state.cur, 0);
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
        { npc: 'mgr', station: calls === 1 ? 'main' : 'shelf', action: 'prepare', activity: calls === 1 ? 'Dialing in the grinder' : 'Warming cups for your shot', line: 'Good morning. We are setting up for service.' },
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
    if (crowd.snapshot().mgr.station === 'shelf') break;
  }
  assert.equal(crowd.snapshot().mgr.station, 'shelf', 'the main machine is next for the player, so Sam works elsewhere at their post');
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

test('customers wait to be served and staff only work at their own post', () => {
  const bp = blueprint();
  bp.npcs.push({ id: 'guest', name: 'Dev', role: 'Customer', anchor: 'P3', outfit: 'casual', lines: { intro: 'A flat white, please.' } });
  bp.npcs[0].lines.ambient = ['Behind!', 'Order up'];
  bp.order = { npc: 'guest', text: 'A flat white', patienceSec: 120, waiting: 'Is my coffee coming?' };
  const state = { phase: 'play', closed: [], cur: 0, objectives: bp.objectives, items: {},
    players: { p: { active: true, pos: [6, 0, 4.3], lastSeen: 0 } } };
  const crowd = new RoomCrowd(bp, CATALOG, null);
  const start = crowd.snapshot().guest.pos;
  assert.equal(crowd.snapshot().guest.kind, 'customer');
  assert.equal(crowd.snapshot().mgr.kind, 'staff');
  const said = [];
  const visited = new Map();
  for (let t = 0; t < 40000; t += 50) {
    state.players.p.lastSeen = t;
    said.push(...crowd.step(state, t).filter(event => event.type === 'say'));
    for (const actor of crowd.actors) if (actor.station) visited.set(actor.id, new Set([...(visited.get(actor.id) ?? []), actor.station]));
  }
  const guest = crowd.snapshot().guest;
  assert.deepEqual(guest.pos, start, 'the customer stays where they are');
  assert.equal(guest.mode, 'idle');
  assert.equal(guest.activity, 'Waiting for flat white');
  assert.equal(visited.has('guest'), false, 'the customer never works a station');
  assert.deepEqual(said, [], 'no call-outs or greetings out of nowhere');
  assert.deepEqual([...visited.get('mgr')].every(id => crowd.actors[0].posts.includes(id)), true);
  assert.equal(visited.size, 1, 'only the one staff member works');
});

test('client-facing shifts have a line that grows, and people who wait too long leave', () => {
  const bp = blueprint();
  bp.npcs.push({ id: 'guest', name: 'Dev', role: 'Customer', anchor: 'P1', outfit: 'casual', lines: { intro: 'A flat white, please.' } });
  bp.order = { npc: 'guest', text: 'A flat white', patienceSec: 120, waiting: 'Is my coffee coming?' };
  bp.queue = [{ name: 'Priya', wants: 'Oat flat white' }, { name: 'Marcus', wants: 'Two americanos' }];
  const state = { phase: 'play', closed: [], cur: 0, objectives: bp.objectives, items: {},
    players: { p: { active: true, pos: [4, 0, -1], lastSeen: 0 } } };
  const crowd = new RoomCrowd(bp, CATALOG, null);
  const people = () => crowd.snapshot();
  assert.deepEqual(crowd.line.map(a => a.name), ['Priya', 'Marcus']);
  const front = people().guest.pos;
  const [first, second] = crowd.line.map(a => people()[a.id]);
  assert.ok(Math.abs(first.pos[0] - front[0]) > 0.5 && Math.abs(second.pos[0] - front[0]) > Math.abs(first.pos[0] - front[0]), 'standing in a line beside the counter spot');
  assert.ok([first, second].every(p => Math.abs(p.pos[2] - front[2]) < 0.3), 'one straight line');
  assert.equal(first.kind, 'customer');
  assert.equal(first.activity, 'Waiting to order: Oat flat white');
  assert.ok(crowd.speakers().length > 4, 'later arrivals are cast voices up front');
  let joined = 0, left = 0;
  const seen = new Set(Object.keys(people()));
  const T0 = 1.7e12; // a real clock: patience runs from when the shift starts, not from zero
  state.players.p.lastSeen = T0;
  crowd.step(state, T0);
  assert.deepEqual(crowd.line.map(a => a.name), ['Priya', 'Marcus'], 'nobody leaves as soon as the shift starts');
  for (let t = T0; t < T0 + 200000; t += 100) {
    state.players.p.lastSeen = t;
    crowd.step(state, t);
    for (const id of Object.keys(people())) if (!seen.has(id)) { seen.add(id); joined++; }
    left = [...seen].filter(id => !people()[id]).length;
  }
  assert.ok(joined >= 2, `new customers arrived (${joined})`);
  assert.ok(left >= 1, 'someone gave up and walked out');
  assert.ok(crowd.line.length <= 4);
  assert.ok(people().guest, 'the order customer stays until served');
  crowd.line.forEach((a, i) => assert.ok(Math.hypot(a.pos[0] - crowd.lineSpots[i][0], a.pos[2] - crowd.lineSpots[i][2]) < 0.05, 'everyone shuffled up to their place'));
});

test('customers keep to the public floor: never behind counters, among the machines or in the back', () => {
  const bp = blueprint();
  // A generated spot in the middle of the work area must not put a customer there.
  bp.npcs.push({ id: 'guest', name: 'Dev', role: 'Customer', anchor: 'P2', outfit: 'casual', lines: { intro: 'Hi.' } });
  bp.npcs.push({ id: 'pat', name: 'Kim', role: 'Patient', anchor: 'P3', outfit: 'casual', lines: { intro: 'Hello.' } });
  bp.order = { npc: 'guest', text: 'A flat white', patienceSec: 120, waiting: 'Still waiting.' };
  bp.queue = [{ name: 'Priya', wants: 'Oat flat white' }, { name: 'Marcus', wants: 'Two americanos' }, { name: 'Ana', wants: 'Tea' }];
  const crowd = new RoomCrowd(bp, CATALOG, null);
  const line = crowd.publicZ;
  assert.ok(line >= 2.7, `public floor starts at z ${line}`);
  const state = { phase: 'play', closed: [], cur: 0, objectives: bp.objectives, items: {},
    players: { p: { active: true, pos: [4, 0, -1], lastSeen: 0 } } };
  const T0 = 1.7e12;
  let lowest = Infinity;
  for (let t = T0; t < T0 + 260000; t += 100) {
    state.players.p.lastSeen = t;
    crowd.step(state, t);
    for (const actor of crowd.actors) if (actor.kind === 'customer') lowest = Math.min(lowest, actor.pos[2]);
  }
  assert.ok(lowest >= line - 1e-9, `a customer went to z ${lowest.toFixed(2)}, behind the public line at ${line}`);
  assert.ok(crowd.actors.some(a => a.kind === 'staff' && a.pos[2] < line), 'staff still work the back');
  // The customer stands in front of the pickup shelf, the venue's service point.
  const shelf = ANCHORS.I2.pos;
  assert.ok(Math.abs(crowd.snapshot().guest.pos[0] - shelf[0]) < 1.2, 'at the service counter');
});
