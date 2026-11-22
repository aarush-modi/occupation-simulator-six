import assert from 'node:assert/strict';
import test from 'node:test';
import { castVoices, VOICES, voiceFor } from '../src/voices.js';
import { Room } from '../src/rooms.js';
import { CATALOG, blueprint } from './fixtures.js';

test('everyone in a shift gets their own voice, and keeps it', () => {
  const names = ['Maya', 'Leo', 'Casey', 'Coach'];
  const cast = castVoices(names);
  assert.equal(new Set(cast.values()).size, names.length, 'no two people share a voice');
  assert.deepEqual(castVoices(names), cast, 'the same cast every time');
  assert.equal(cast.get('Maya'), voiceFor('Maya'), 'the first name keeps its own pick');
  assert.equal(new Set(castVoices(Array.from({ length: VOICES.length + 2 }, (_, i) => `N${i}`)).values()).size, VOICES.length);
});

test('a room voices each speaker with its cast voice, including tips of replanned steps', () => {
  const room = new Room('t', 'barista', { catalog: CATALOG, demos: [] });
  const warmed = [];
  room.deps.voice = { warm: (who, text, voice) => warmed.push([who, voice]), speak: async () => Buffer.alloc(0) };
  room.setBlueprint(blueprint(), 'demo');
  const sam = room.voiceOf('Sam');
  assert.ok(warmed.filter(([who]) => who === 'Sam').every(([, voice]) => voice === sam));
  assert.notEqual(room.voiceOf('Casey'), sam);
  room.state = { ...room.state, objectives: [...room.state.objectives, { id: 'n1', verb: 'talk', target: 'mgr', label: 'x', tip: 'A brand new tip.' }] };
  assert.equal(room.canVoice('A brand new tip.'), true);
  assert.equal(room.canVoice('Read out anything I like.'), false);
});
