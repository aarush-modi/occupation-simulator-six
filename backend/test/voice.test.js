// Spoken prompt (F1, N4): the audio clip rides in the single generateContent request, and the room adopts the
// occupation the model inferred. Also covers the HTTPS invite / origin rules (F5).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createApp, inviteUrlFor, originAllowed, parseAudio, httpsOptions } from '../src/app.js';
import { createGenerator, geminiRequest, DEFAULT_MODEL, AUDIO_PROMPT } from '../src/generate.js';
import { CATALOG, blueprint } from './fixtures.js';

const quiet = { log() {}, warn() {}, error() {} };
const demos = [{ id: 'barista', occupation: 'barista', title: 'Morning rush', blueprint: blueprint() }];
const clip = Buffer.alloc(4096, 7).toString('base64');

// Fake model: records each request and answers with a "florist" blueprint when it hears audio.
const calls = [];
const callModel = async (req) => {
  calls.push(req);
  await new Promise((r) => setTimeout(r, 60));
  const bp = { ...blueprint(), occupation: req.audio ? 'florist' : 'barista' };
  delete bp.version;
  return { text: JSON.stringify(bp), usage: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 } };
};

let app;
let base;
let generator;
before(async () => {
  generator = createGenerator({ catalog: CATALOG, apiKey: 'test', callModel, log: quiet });
  app = createApp({ catalog: CATALOG, demos, generator, env: { FRONTEND_ORIGIN: 'http://localhost:3000' }, log: quiet });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `127.0.0.1:${app.server.address().port}`;
});
after(() => app.close());

const post = (path, body) => fetch(`http://${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('default model is gemini-4-carbon', () => {
  assert.equal(DEFAULT_MODEL, 'gemini-4-carbon');
  if (!process.env.GEMINI_MODEL) assert.equal(createGenerator({ catalog: CATALOG, log: quiet }).model, 'gemini-4-carbon');
});

test('spoken request: audio arrives in the model call, room occupation becomes the inferred one', async () => {
  calls.length = 0;
  const r = await post('/api/rooms', { audio: { mimeType: 'audio/webm;codecs=opus', data: clip } });
  assert.equal(r.status, 201);
  const { roomId, occupation } = await r.json();
  assert.equal(occupation, 'Spoken request');

  const ws = new WebSocket(`ws://${base}/room/${roomId}`);
  const statuses = [];
  const ready = new Promise((resolve) =>
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.type === 'status') statuses.push(m);
      if (m.type === 'status' && m.status === 'ready') resolve(m);
    }),
  );
  const msg = await ready;
  ws.close();
  assert.equal(msg.occupation, 'florist');
  assert.equal(statuses[0].occupation, 'Spoken request');

  assert.equal(calls.length, 1, 'one bounded request');
  assert.deepEqual(calls[0].audio, { mimeType: 'audio/webm', data: clip });
  assert.equal(calls[0].user, AUDIO_PROMPT);

  const room = await (await fetch(`http://${base}/api/rooms/${roomId}`)).json();
  assert.equal(room.occupation, 'florist');
  assert.equal(app.rooms.get(roomId).audio, null, 'clip is dropped after generation');

  // Cached under the inferred occupation: a typed "florist" now costs no model call.
  const g = await generator.generate('Florist');
  assert.equal(g.meta.cacheHit, true);
  assert.equal(calls.length, 1);
  const stats = generator.stats();
  assert.equal(stats.cacheHits, 1);
  assert.equal(stats.firstPassRate, 1);
});

test('spoken requests are never answered from the cache', async () => {
  calls.length = 0;
  const r1 = await generator.generate('spoken request', { audio: { mimeType: 'audio/wav', data: clip } });
  const r2 = await generator.generate('spoken request', { audio: { mimeType: 'audio/wav', data: clip } });
  assert.ok(r1.ok && r2.ok);
  assert.equal(calls.length, 2);
  assert.equal(r1.meta.inferredOccupation, 'florist');
});

test('the default Gemini request puts the clip in an inlineData part of the same request', () => {
  const req = geminiRequest({ model: 'm', system: 'sys', user: AUDIO_PROMPT, schema: {}, audio: { mimeType: 'audio/wav', data: clip }, thinking: 'MINIMAL' });
  assert.equal(req.contents.length, 1);
  assert.deepEqual(req.contents[0].parts[0], { inlineData: { mimeType: 'audio/wav', data: clip } });
  assert.equal(req.contents[0].parts[1].text, AUDIO_PROMPT);
  assert.equal(req.config.thinkingConfig.thinkingLevel, 'MINIMAL');
  const typed = geminiRequest({ model: 'm', system: 'sys', user: 'Occupation: barista', schema: {} });
  assert.deepEqual(typed.contents[0].parts, [{ text: 'Occupation: barista' }]);
  assert.equal(typed.config.thinkingConfig, undefined);
});

test('audio validation: mime type must be audio/*, data base64 and bounded', async () => {
  assert.ok(parseAudio({ mimeType: 'audio/mp4', data: clip }).audio);
  assert.match(parseAudio({ mimeType: 'video/webm', data: clip }).error, /audio/);
  assert.match(parseAudio({ mimeType: 'audio/wav', data: 'not base64!!' }).error, /base64/);
  assert.match(parseAudio({ mimeType: 'audio/wav', data: 'AAAA' }).error, /empty/);
  assert.match(parseAudio({ mimeType: 'audio/wav', data: Buffer.alloc(1100 * 1024).toString('base64') }).error, /too long/);
  assert.equal((await post('/api/rooms', { audio: { mimeType: 'text/plain', data: clip } })).status, 400);
  // ~1 MB clip fits under the raised body limit for this route.
  const big = Buffer.alloc(1000 * 1024, 1).toString('base64');
  assert.equal((await post('/api/rooms', { audio: { mimeType: 'audio/wav', data: big } })).status, 201);
});

test('failed spoken generation falls back to a demo and takes its occupation', async () => {
  const failing = { generate: async () => ({ ok: false, error: 'GEMINI_API_KEY is not set' }) };
  const a = createApp({ catalog: CATALOG, demos, generator: failing, env: {}, log: quiet });
  const room = a.rooms.create('Spoken request', { audio: { mimeType: 'audio/wav', data: clip } });
  await room.genJob;
  assert.equal(room.status, 'failed');
  assert.equal(room.loadDemo().ok, true);
  assert.equal(room.occupation, 'barista');
  assert.equal(room.statusMsg().occupation, 'barista');
  await a.close();
});

test('HTTPS: invite links use https, https LAN origins are allowed', () => {
  assert.match(inviteUrlFor('abc', {}, true), /^https:\/\/[^/]+:3000\/shift\?room=abc$/);
  assert.match(inviteUrlFor('abc', {}), /^http:\/\//);
  assert.equal(inviteUrlFor('abc', { PUBLIC_FRONTEND_URL: 'https://play.example/' }), 'https://play.example/shift?room=abc');
  assert.equal(originAllowed('https://192.168.1.20:3000', {}), true);
  assert.equal(originAllowed('https://localhost:3000', {}), true);
  assert.equal(originAllowed('https://evil.example', {}), false);
  assert.equal(httpsOptions({}), null);
  assert.throws(() => httpsOptions({ HTTPS_KEY: '/x' }), /both/);
});
