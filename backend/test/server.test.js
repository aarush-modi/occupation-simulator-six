import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createApp, originAllowed } from '../src/app.js';
import { CATALOG, blueprint } from './fixtures.js';

const quiet = { log() {}, warn() {}, error() {} };
const demos = [{ id: 'barista', occupation: 'barista', title: 'Morning rush', blueprint: blueprint() }];
// Stub generator: "barista" succeeds after 150 ms, anything else fails.
const generator = {
  generate: (occupation) =>
    new Promise((resolve) =>
      setTimeout(() => resolve(occupation === 'barista' ? { ok: true, blueprint: blueprint() } : { ok: false, error: 'model said no' }), 150),
    ),
};

let app;
let base;
before(async () => {
  app = createApp({ catalog: CATALOG, demos, generator, env: { FRONTEND_ORIGIN: 'http://localhost:3000', PUBLIC_FRONTEND_URL: 'https://play.example' }, log: quiet });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `127.0.0.1:${app.server.address().port}`;
});
after(() => app.close());

const post = (path, body, headers = {}) =>
  fetch(`http://${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

/** A ws client that records every message and can wait for one matching a predicate. */
function client(roomId) {
  const ws = new WebSocket(`ws://${base}/room/${roomId}`);
  const msgs = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    msgs.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  const opened = new Promise((r) => ws.once('open', r));
  return {
    ws, msgs, opened,
    send: (o) => ws.send(JSON.stringify(o)),
    wait(pred, ms = 2000) {
      const hit = msgs.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error('timed out waiting for message')), ms);
      });
    },
    // Wait for a message that arrives after this call.
    next(pred, ms = 2000) {
      const seen = msgs.length;
      return this.wait((m) => msgs.indexOf(m) >= seen && pred(m), ms);
    },
    // Wait for a message that the server sent after `msg` (messages on one socket are ordered).
    after(msg, pred, ms = 2000) {
      return this.wait((m) => msgs.indexOf(m) > msgs.indexOf(msg) && pred(m), ms);
    },
  };
}

test('GET /health', async () => {
  const r = await fetch(`http://${base}/health`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
});

test('CORS allows the frontend origin and LAN origins in dev, rejects others', async () => {
  const ok = await fetch(`http://${base}/health`, { headers: { origin: 'http://localhost:3000' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  const pre = await fetch(`http://${base}/api/rooms`, { method: 'OPTIONS', headers: { origin: 'http://192.168.1.20:3000' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'http://192.168.1.20:3000');
  const bad = await fetch(`http://${base}/health`, { headers: { origin: 'https://evil.example' } });
  assert.equal(bad.status, 403);
  assert.equal(originAllowed('http://10.0.0.5:3000', { NODE_ENV: 'production', FRONTEND_ORIGIN: 'https://x.vercel.app' }), false);
  assert.equal(originAllowed('https://x.vercel.app', { NODE_ENV: 'production', FRONTEND_ORIGIN: 'https://x.vercel.app' }), true);
});

test('POST /api/rooms returns immediately, guests can join while generating, then everyone gets the blueprint', async () => {
  const t0 = Date.now();
  const r = await post('/api/rooms', { occupation: 'barista' });
  assert.equal(r.status, 201);
  const { roomId, inviteUrl } = await r.json();
  assert.ok(Date.now() - t0 < 100, 'does not wait for generation');
  assert.equal(inviteUrl, `https://play.example/shift?room=${roomId}`);
  assert.equal((await (await fetch(`http://${base}/api/rooms/${roomId}`)).json()).status, 'generating');

  const a = client(roomId);
  await a.wait((m) => m.type === 'status' && m.status === 'generating');
  a.send({ t: 'join', name: 'Ana' });
  const w0 = await a.wait((m) => m.type === 'welcome');
  assert.equal(w0.state, null);
  const ready = await a.wait((m) => m.type === 'status' && m.status === 'ready');
  assert.equal(ready.blueprint.title, 'Morning rush');
  const w1 = await a.wait((m) => m.type === 'welcome' && m.state);
  assert.equal(w1.you, w0.you);
  assert.ok(w1.state.players[w1.you]);
  a.ws.close();
});

test('two clients: snapshots at ~20 Hz, simultaneous grab gives one holder, handoff is shared', async () => {
  const { roomId } = await (await post('/api/rooms', { occupation: 'barista' })).json();
  const a = client(roomId);
  const b = client(roomId);
  await Promise.all([a.opened, b.opened]);
  await a.wait((m) => m.type === 'status' && m.status === 'ready');
  a.send({ t: 'join', name: 'Ana' });
  b.send({ t: 'join', name: 'Ben' });
  const ya = (await a.wait((m) => m.type === 'welcome' && m.state)).you;
  const yb = (await b.wait((m) => m.type === 'welcome' && m.state)).you;
  assert.notEqual(ya, yb);

  // Snapshot rate.
  const n0 = a.msgs.filter((m) => m.type === 'snapshot').length;
  await new Promise((r) => setTimeout(r, 500));
  const rate = (a.msgs.filter((m) => m.type === 'snapshot').length - n0) * 2;
  assert.ok(rate >= 15 && rate <= 25, `snapshot rate ${rate}/s`);

  // Simultaneous grab.
  a.send({ t: 'grab', item: 'cup1' });
  b.send({ t: 'grab', item: 'cup1' });
  const denied = await a.wait((m) => m.type === 'events' && m.events.some((e) => e.type === 'denied' && e.reason === 'held by someone else'));
  const loser = denied.events.find((e) => e.type === 'denied').playerId;
  const winner = loser === ya ? yb : ya;
  const bEv = await b.wait((m) => m.type === 'events' && m.events.some((e) => e.type === 'denied'));
  const snap = await b.after(bEv, (m) => m.type === 'snapshot');
  assert.equal(snap.state.items.cup1.holder, winner);
  assert.equal(snap.state.players[winner].held, 'cup1');
  assert.equal(snap.state.players[loser].held, null);

  // Handoff from the winner to the loser; both clients see the same result.
  (winner === ya ? a : b).send({ t: 'handoff', to: loser });
  const isHandoff = (m) => m.type === 'events' && m.events.some((e) => e.type === 'handoff');
  const [ha, hb] = await Promise.all([a.wait(isHandoff), b.wait(isHandoff)]);
  const [sa, sb] = await Promise.all([a.after(ha, (m) => m.type === 'snapshot'), b.after(hb, (m) => m.type === 'snapshot')]);
  for (const s of [sa, sb]) {
    assert.equal(s.state.items.cup1.holder, loser);
    assert.equal(s.state.players[loser].held, 'cup1');
    assert.equal(s.state.players[winner].held, null);
  }

  // Pose is reflected for the other player.
  a.send({ t: 'pose', pos: [1, 0, 2], yaw: 0.5, pitch: 0 });
  const ps = await b.next((m) => m.type === 'snapshot' && m.state.players[ya]?.pos[0] === 1);
  assert.equal(ps.state.players[ya].yaw, 0.5);
  a.ws.close();
  b.ws.close();
});

test('failed generation -> host picks the demo in the same room (HTTP and ws)', async () => {
  const { roomId } = await (await post('/api/rooms', { occupation: 'lighthouse keeper' })).json();
  const a = client(roomId);
  await a.opened;
  a.send({ t: 'join', name: 'Host' });
  const failed = await a.wait((m) => m.type === 'status' && m.status === 'failed');
  assert.equal(failed.error, 'model said no');
  const r = await post(`/api/rooms/${roomId}/demo`, {});
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'ready');
  await a.wait((m) => m.type === 'status' && m.status === 'ready');
  const w = await a.wait((m) => m.type === 'welcome' && m.state);
  assert.equal(w.blueprint.occupation, 'barista');

  // ws demo intent also works (reloads a fresh shift).
  a.send({ t: 'grab', item: 'cup1' });
  await a.wait((m) => m.type === 'snapshot' && m.state.items.cup1.holder === w.you);
  a.send({ t: 'demo', occupation: 'barista' });
  const w2 = await a.next((m) => m.type === 'welcome' && m.state);
  assert.equal(w2.state.items.cup1.holder, null);
  a.ws.close();
});

test('unknown rooms 404 over HTTP and ws', async () => {
  assert.equal((await fetch(`http://${base}/api/rooms/nope`)).status, 404);
  const ws = new WebSocket(`ws://${base}/room/nope`);
  const err = await new Promise((r) => ws.once('unexpected-response', (_, res) => r(res.statusCode)).once('error', () => r('error')));
  assert.equal(err, 404);
});

test('reconnect with the same id resumes the player', async () => {
  const { roomId } = await (await post('/api/rooms', { occupation: 'barista' })).json();
  const a = client(roomId);
  await a.wait((m) => m.type === 'status' && m.status === 'ready');
  a.send({ t: 'join', name: 'Ana' });
  const { you } = await a.wait((m) => m.type === 'welcome' && m.state);
  a.ws.close();
  await new Promise((r) => setTimeout(r, 50));
  const a2 = client(roomId);
  await a2.opened;
  a2.send({ t: 'join', name: 'Ana', id: you });
  const w = await a2.wait((m) => m.type === 'welcome' && m.state);
  assert.equal(w.you, you);
  assert.equal(Object.keys(w.state.players).length, 1);
  a2.ws.close();
});
