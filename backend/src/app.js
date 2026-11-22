// HTTP API + WebSocket room server on one http.Server.
//   GET  /health
//   GET  /api/demos
//   POST /api/rooms           { occupation }   -> { roomId, inviteUrl }  (generation runs in the background)
//   GET  /api/rooms/:id
//   POST /api/rooms/:id/demo  { occupation? }  -> loads a prevalidated demo shift
//   POST /api/rooms/:id/voice { who, text }    -> audio/wav of an NPC line (only lines from this room's shift)
//   WS   /room/:id           intents, incl. { t: 'speak', npc, text } for spoken NPC conversation
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import { RoomManager } from './rooms.js';
import { createNpcPlanner } from './npcs.js';
import { createNpcResponder } from './dialogue.js';
import { createVoices } from './voices.js';
import { createReplanner } from './replan.js';
import { MODELS } from './geminiClient.js';

const MAX_BODY = 16 * 1024;

export function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return 'localhost';
}

/** Invite link on the host's LAN address. https when the backend serves HTTPS (the frontend then runs dev:https). */
export function inviteUrlFor(roomId, env = process.env, secure = false) {
  const base = env.PUBLIC_FRONTEND_URL?.replace(/\/+$/, '') || `${secure ? 'https' : 'http'}://${lanAddress()}:${env.FRONTEND_PORT || 3000}`;
  return `${base}/shift?room=${encodeURIComponent(roomId)}`;
}

const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9-]+\.local)$/i;

export function originAllowed(origin, env = process.env) {
  if (!origin) return true; // non-browser clients (curl, tests)
  const allowed = (env.FRONTEND_ORIGIN || 'http://localhost:3000').split(',').map((s) => s.trim().replace(/\/+$/, ''));
  if (allowed.includes('*') || allowed.includes(origin)) return true;
  if (env.NODE_ENV === 'production') return false;
  try {
    return PRIVATE_HOST.test(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/**
 * @param {{ catalog: Array, demos: Array, generator: { generate(occupation): Promise }, env?: object, log?: Console, tls?: { key, cert } | null }} deps
 * With `tls` the API is HTTPS and the room sockets are wss on the same port, so pages served over https can reach it.
 */
export function createApp({ catalog, demos, generator, env = process.env, log = console, tls = null }) {
  const secure = Boolean(tls);
  const npcModel = { apiKey: env.GEMINI_API_KEY, model: env.GEMINI_NPC_MODEL || MODELS.npc };
  const voice = createVoices({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_TTS_MODEL || MODELS.speech, style: env.GEMINI_TTS_STYLE || undefined, log });
  const rooms = new RoomManager({ catalog, demos, generator, log, voice, planNpcs: createNpcPlanner(npcModel), respond: createNpcResponder(npcModel), replan: createReplanner(npcModel) });

  const handler = async (req, res) => {
    const origin = req.headers.origin;
    const headers = { 'content-type': 'application/json; charset=utf-8', vary: 'Origin' };
    if (origin && originAllowed(origin, env)) {
      Object.assign(headers, {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
      });
    }
    const reply = (status, body) => {
      res.writeHead(status, headers);
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') return reply(origin && !originAllowed(origin, env) ? 403 : 204);
    if (origin && !originAllowed(origin, env)) return reply(403, { error: 'origin not allowed' });

    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (req.method === 'GET' && url.pathname === '/health') return reply(200, { ok: true, rooms: rooms.rooms.size, catalog: catalog.length, demos: demos.length });
      if (req.method === 'GET' && url.pathname === '/api/demos') return reply(200, { demos: demos.map((d) => ({ id: d.id, occupation: d.occupation, title: d.title })) });
      if (parts[0] === 'api' && parts[1] === 'rooms') {
        if (req.method === 'POST' && parts.length === 2) {
          const body = await readJson(req);
          const occupation = String(body.occupation ?? '').trim().slice(0, 320);
          if (!occupation) return reply(400, { error: 'occupation is required' });
          const room = rooms.create(occupation);
          log.log(`[room] ${room.id} created for "${occupation}"`);
          return reply(201, { roomId: room.id, inviteUrl: inviteUrlFor(room.id, env, secure), status: room.status });
        }
        const room = parts[2] ? rooms.get(parts[2]) : null;
        if (parts.length >= 3 && !room) return reply(404, { error: 'room not found' });
        if (req.method === 'GET' && parts.length === 3) return reply(200, { ...room.summary(), inviteUrl: inviteUrlFor(room.id, env, secure) });
        if (req.method === 'POST' && parts.length === 4 && parts[3] === 'demo') {
          const body = await readJson(req);
          const r = room.loadDemo(body.occupation ? String(body.occupation) : undefined);
          if (!r.ok) return reply(409, { error: r.error });
          log.log(`[room] ${room.id} loaded demo ${r.demo}`);
          return reply(200, { ...room.summary(), demo: r.demo });
        }
        if (req.method === 'POST' && parts.length === 4 && parts[3] === 'voice') {
          const voices = room.deps.voice;
          if (!voices) return reply(503, { error: 'NPC voices need GEMINI_API_KEY' });
          const body = await readJson(req);
          const text = typeof body.text === 'string' ? body.text : '';
          const who = String(body.who ?? '').slice(0, 40);
          // Only this shift's own lines, so the endpoint cannot be used as a general text-to-speech service.
          if (!text || !room.canVoice(text)) return reply(403, { error: 'not a line from this shift' });
          let audio;
          try {
            audio = await voices.speak(who, text, room.voiceOf(who));
          } catch (err) {
            return reply(502, { error: String(err?.message ?? 'voice failed') });
          }
          res.writeHead(200, { ...headers, 'content-type': 'audio/wav', 'content-length': audio.length, 'cache-control': 'private, max-age=3600' });
          return res.end(audio);
        }
      }
      return reply(404, { error: 'Not found' });
    } catch (err) {
      return reply(err.status ?? 500, { error: err.message ?? 'server error' });
    }
  };
  const server = tls ? createHttpsServer(tls, handler) : createServer(handler);

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const m = url.pathname.match(/^\/room\/([a-z0-9]+)\/?$/i);
    const room = m ? rooms.get(m[1]) : null;
    if (!room || !originAllowed(req.headers.origin, env)) {
      socket.write(`HTTP/1.1 ${room ? '403 Forbidden' : '404 Not Found'}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      room.attach(ws);
      ws.on('message', (data) => room.onMessage(ws, data));
      ws.on('close', () => room.detach(ws));
      ws.on('error', () => room.detach(ws));
    });
  });

  const close = () =>
    new Promise((resolve) => {
      rooms.close();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.closeAllConnections?.();
      server.close(() => resolve());
    });

  return { server, rooms, close, secure };
}
