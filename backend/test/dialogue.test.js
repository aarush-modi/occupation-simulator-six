import assert from 'node:assert/strict';
import test from 'node:test';
import { createNpcResponder, cleanUtterance, capSpeech, spokenMs, MAX_SPOKEN_WORDS } from '../src/dialogue.js';
import { Room } from '../src/rooms.js';
import { createVoices } from '../src/voices.js';
import { tidySteps, tryPlan } from '../src/replan.js';
import { createGenerator } from '../src/generate.js';
import { CATALOG, blueprint } from './fixtures.js';

const quiet = { log() {}, warn() {}, error() {} };
const flush = () => new Promise(resolve => setImmediate(resolve));

/** A room with one joined player standing next to Sam (mgr). */
function setup(respond) {
  const room = new Room('test', 'barista', { catalog: CATALOG, demos: [], respond, log: quiet });
  const messages = [];
  const ws = { readyState: 1, send: text => messages.push(JSON.parse(text)) };
  room.setBlueprint(blueprint(), 'gemini');
  room.attach(ws);
  room.onMessage(ws, JSON.stringify({ t: 'join', name: 'Player' }));
  const id = Object.keys(room.state.players)[0];
  const sam = room.snapshot().people.mgr.pos;
  room.onMessage(ws, JSON.stringify({ t: 'pose', pos: [sam[0], 0, sam[2] + 1.2], active: true }));
  messages.length = 0;
  const say = text => room.onMessage(ws, JSON.stringify({ t: 'speak', npc: 'mgr', text }));
  const events = () => messages.flatMap(m => m.events ?? []);
  return { room, id, say, events, messages };
}

test('the NPC model gets the live shift context and the player speech as data', async () => {
  let sent;
  const respond = createNpcResponder({ apiKey: 'test', fetcher: async (url, request) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    sent = JSON.parse(request.body);
    return Response.json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify({ reply: '  "Cups are on the left shelf."  ', conduct: 'fine', standing_change: 3, standing_reason: 'Clear question', scenario_change: null }) }] }] });
  } });
  const answer = await respond({ player_said: 'Where are the cups?' });
  assert.deepEqual(answer, { reply: 'Cups are on the left shelf.', conduct: 'fine', standingChange: 3, standingReason: 'Clear question', scenarioChange: null });
  assert.deepEqual(sent.response_format.schema.properties.conduct.enum, ['fine', 'rude', 'inappropriate']);
  assert.equal(sent.model, 'gemini-4-hydrogen');
  assert.equal(sent.store, false);
  assert.equal(JSON.parse(sent.input).player_said, 'Where are the cups?');
  assert.equal(createNpcResponder({}), null, 'no key, no model');
});

test('no NPC line runs past 20 seconds of speech', () => {
  const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i + 1} is here.`).join(' ');
  const capped = capSpeech(long);
  assert.ok(capped.split(' ').length <= MAX_SPOKEN_WORDS);
  assert.match(capped, /here\.$/, 'ends on a whole sentence');
  assert.ok(spokenMs(capped) <= 20000);
  assert.equal(spokenMs(Array(500).fill('word').join(' ')), 20000);
  assert.equal(capSpeech('Short and sweet.'), 'Short and sweet.');
});

test('every NPC line becomes speakable and starts its voice; other text is not speakable', () => {
  const warmed = [];
  const voice = { warm: (who, text) => warmed.push([who, text]) };
  const room = new Room('test', 'barista', { catalog: CATALOG, demos: [], voice, log: quiet });
  room.setBlueprint(blueprint(), 'gemini');
  assert.ok(room.speakable.has('Grab a cup and pull a shot.'));
  assert.ok(room.speakable.has('Nice and level.'));
  assert.deepEqual(warmed, [['Sam', 'Grab a cup and pull a shot.']], 'only the opening line is prepared up front');
  room.emit([{ type: 'say', npc: 'mgr', text: 'A fresh line from the model.' }]);
  assert.ok(room.speakable.has('A fresh line from the model.'));
  assert.deepEqual(warmed.at(-1), ['Sam', 'A fresh line from the model.']);
  assert.equal(room.speakable.has('Read out my bank details'), false);
});

test('speaking to the NPC a talk step names completes it, and the model gets its instructions across in character', async () => {
  const contexts = [];
  const { room, id, say, events } = setup(async (context) => { contexts.push(context); return 'Morning! Grab a cup from the shelf and pull a shot for me.'; });
  say('Hi Sam, I am ready to start');
  await flush();
  assert.ok(room.state.done.includes('o1'));
  assert.equal(contexts[0].brief_to_deliver, 'Grab a cup and pull a shot.');
  assert.equal(contexts[0].player.current_task, 'Grab a cup', 'the model sees the step that comes next');
  const lines = events().filter(e => e.type === 'say' && e.npc === 'mgr');
  assert.deepEqual(lines.map(e => [e.text, e.playerId]), [['Morning! Grab a cup from the shelf and pull a shot for me.', id]], 'no scripted line on top');
});

test('if the model fails on a talk step, the scripted instructions are said instead', async () => {
  const { room, say, events } = setup(async () => { throw new Error('timeout'); });
  say('Hi Sam');
  await flush(); await flush();
  assert.ok(room.state.done.includes('o1'));
  assert.ok(events().some(e => e.type === 'say' && e.text === 'Grab a cup and pull a shot.'));
});

test('other speech gets an in-character answer for the speaker only, with the conversation remembered', async () => {
  const contexts = [];
  const { room, id, say, events } = setup(async (context) => { contexts.push(context); return `Reply ${contexts.length}`; });
  say('Hi Sam'); // completes the check-in step
  await flush();
  say('How long does a shot take?');
  await flush();
  say('And then what?');
  await flush();
  assert.equal(contexts.length, 3);
  assert.equal(contexts[1].you.name, 'Sam');
  assert.equal(contexts[1].player.current_task, 'Grab a cup');
  assert.equal(contexts[1].player_said, 'How long does a shot take?');
  assert.equal(contexts[1].brief_to_deliver, undefined);
  assert.deepEqual(contexts[2].conversation_so_far.slice(-2), [{ who: 'player', text: 'How long does a shot take?' }, { who: 'npc', text: 'Reply 2' }]);
  const replies = events().filter(e => e.type === 'say' && e.text.startsWith('Reply'));
  assert.deepEqual(replies.map(e => e.playerId), [id, id, id]);
  assert.equal(room.snapshot().people.mgr.mode, 'talk', 'Sam stops to answer');
});

test('a failed or missing model falls back to the scripted pointer at the current task', async () => {
  const failing = setup(async () => { throw new Error('timeout'); });
  failing.room.state.done.push('o1');
  failing.say('Hi Sam');
  failing.say('What now?');
  await flush(); await flush();
  assert.ok(failing.events().some(e => e.type === 'say' && /^Next up:/.test(e.text)));

  const offline = setup(null);
  offline.say('Hi Sam');
  offline.say('What now?');
  assert.ok(offline.events().some(e => e.type === 'say' && e.text === 'Next up: Grab a cup'));
});

test('NPCs only hear players nearby, and speech is trimmed', () => {
  const { room, id, say, events } = setup(null);
  room.state.players[id].pos = [room.snapshot().people.mgr.pos[0] + 6, 0, 0];
  say('Can you hear me?');
  assert.ok(events().some(e => e.type === 'denied' && e.reason === 'too far to hear'));
  assert.equal(room.state.done.length, 0);
  assert.equal(cleanUtterance(`  hello \n there ${'x'.repeat(400)}`).length, 280);
  assert.equal(cleanUtterance(42), '');
});

test('a line someone is waiting to hear jumps ahead of lines being prepared, and a rate limit is retried once', async () => {
  const order = [];
  let limited = false;
  const voices = createVoices({ apiKey: 'k', log: quiet, retryMs: 5, fetcher: async (url, request) => {
    const text = JSON.parse(request.body).input[0].content[0].text;
    if (text === 'flaky' && !limited) { limited = true; return new Response('{}', { status: 429 }); }
    order.push(text);
    await new Promise(resolve => setTimeout(resolve, 5));
    return Response.json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: Buffer.from(text).toString('base64') }] }] });
  } });
  for (const text of ['w1', 'w2', 'w3', 'w4']) voices.warm('Sam', text);
  const urgent = voices.speak('Sam', 'now please');
  assert.equal(String(await urgent), 'now please');
  assert.ok(order.indexOf('now please') <= 2, `played early: ${order}`);
  assert.equal(String(await voices.speak('Sam', 'flaky')), 'flaky');
  assert.equal(voices.speak('Sam', 'w1'), voices.speak('Sam', 'w1'), 'cached per voice and line');
});

test('rudeness costs job standing and the NPC holds a boundary; good service earns a little', async () => {
  const answers = [
    { reply: 'Hey, let\'s keep it respectful, okay?', conduct: 'rude', standing_change: -5, standing_reason: 'Snapped at Sam', scenario_change: null },
    { reply: 'Thanks for asking!', conduct: 'fine', standing_change: 4, standing_reason: 'Good question', scenario_change: null },
  ];
  const { room, say, events } = setup(async () => answers.shift());
  room.state.done.push('o1');
  say('Ugh, you are useless');
  await flush();
  assert.equal(room.state.standing.value, 85, 'rude costs at least 15');
  assert.ok(events().some(e => e.type === 'standing' && e.reason === 'Rude to Sam'));
  say('How do I know the shot is right?');
  await flush();
  assert.equal(room.state.standing.value, 89);
});

test('what is said can change the plan: the rest of the shift is rewritten if it still plays to the end', async () => {
  const changed = [];
  const replan = async ({ change, state }) => {
    changed.push(change);
    return tidySteps([
      { id: 'n1', verb: 'grab', target: 'cup2', label: 'Grab the spare cup', item: null, action: null, motion: null, sets: null, skill: 'none', tip: 't', real: 'r' },
      { id: 'n2', verb: 'place', target: 'backup.cup', item: 'cup2', label: 'Seat it in the backup', action: null, motion: null, sets: null, skill: 'none', tip: 't', real: 'r' },
      { id: 'n3', verb: 'press', target: 'backup.brew', label: 'Pull a second shot', item: null, action: null, motion: null, sets: null, skill: 'none', tip: 't', real: 'r' },
    ], state.objectives.map(o => o.id));
  };
  const { room, say, events } = setup(async () => ({ reply: 'Make it two, please!', conduct: 'fine', standing_change: 0, standing_reason: '', scenario_change: 'The customer now wants a second espresso from the backup machine.' }));
  room.deps = { ...room.deps, replan };
  room.state.done.push('o1');
  say('Anything else for you today?');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(changed, ['The customer now wants a second espresso from the backup machine.']);
  assert.deepEqual(room.state.objectives.map(o => o.id), ['o1', 'n1', 'n2', 'n3']);
  assert.equal(room.state.event.fired, true, 'the change replaces the scripted complication');
  assert.ok(events().some(e => e.type === 'replanned'));
});

test('a plan that cannot be finished from the live state is rejected', () => {
  const { room, id } = setup(null);
  const impossible = tidySteps([{ id: 'z1', verb: 'press', target: 'main.brew', label: 'Pull a shot with no cup', skill: 'none' }], []);
  assert.match(tryPlan(room.state, impossible, id).error, /needs cup/);
});

test('an interrupted NPC is told so', async () => {
  const contexts = [];
  const { room } = setup(async (c) => { contexts.push(c); return 'Oh, sorry, go ahead.'; });
  room.state.done.push('o1');
  const ws = [...room.clients.keys()][0];
  room.onMessage(ws, JSON.stringify({ t: 'speak', npc: 'mgr', text: 'Wait, one question', interrupted: true }));
  await flush();
  assert.equal(contexts[0].player_interrupted_you, true);
});

test('inappropriate job requests are turned away with a nearby real job to try', async () => {
  const generator = createGenerator({
    catalog: CATALOG, log: quiet, callModel: async () => ({ text: '{}' }),
    screen: async () => ({ appropriate: false, reason: 'It describes a crime', suggestion: 'pharmacist' }),
  });
  const r = await generator.generate('drug dealer');
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
  assert.equal(r.error, 'That isn\'t a shift Workshift can run: It describes a crime. Try "pharmacist" instead.');
});
