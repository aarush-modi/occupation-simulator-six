// Rooms: lobby status, the authoritative sim state, connected sockets, and the 20 Hz loop (N3).
import { randomBytes } from 'node:crypto';
import { createRoom, applyIntent, tick } from '../../frontend/src/shared/sim.js';
import { pickDemo } from './demos.js';

export const TICK_MS = 50; // 20 snapshots per second
const IDLE_MS = 30 * 60 * 1000;

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes, easy to read off a screen
const newId = (n) => [...randomBytes(n)].map((b) => ALPHABET[b % ALPHABET.length]).join('');

export class Room {
  constructor(id, occupation, deps) {
    this.id = id;
    this.occupation = occupation;
    this.deps = deps; // { catalog, demos, log }
    this.status = 'generating';
    this.error = null;
    this.source = null; // 'gemini' | 'demo'
    this.blueprint = null;
    this.state = null;
    this.clients = new Map(); // ws -> { playerId, name, joined }
    this.genToken = 0;
    this.createdAt = Date.now();
    this.lastActive = Date.now();
  }

  summary() {
    return {
      roomId: this.id,
      occupation: this.occupation,
      status: this.status,
      error: this.error,
      source: this.source,
      blueprint: this.blueprint,
      players: this.state ? Object.keys(this.state.players).length : [...this.clients.values()].filter((c) => c.joined).length,
      demos: this.deps.demos.map((d) => ({ id: d.id, occupation: d.occupation, title: d.title })),
    };
  }

  statusMsg() {
    return { type: 'status', status: this.status, ...(this.blueprint ? { blueprint: this.blueprint } : {}), ...(this.error ? { error: this.error } : {}) };
  }

  // ----- generation -----

  /** Run a generator job; its result is ignored if a demo was picked (or another job started) meanwhile. */
  async startGeneration(generator) {
    const token = ++this.genToken;
    this.status = 'generating';
    this.error = null;
    this.broadcast(this.statusMsg());
    const r = await generator.generate(this.occupation);
    if (token !== this.genToken) return r;
    if (r.ok) this.setBlueprint(r.blueprint, 'gemini');
    else this.fail(r.error || 'generation failed');
    return r;
  }

  fail(error) {
    this.status = 'failed';
    this.error = error;
    this.broadcast(this.statusMsg());
  }

  loadDemo(occupation) {
    const demo = pickDemo(this.deps.demos, occupation ?? this.occupation);
    if (!demo) return { ok: false, error: 'no demo shifts available' };
    this.genToken++; // cancel any running generation
    this.setBlueprint(demo.blueprint, 'demo');
    return { ok: true, demo: demo.id };
  }

  setBlueprint(blueprint, source) {
    const now = Date.now();
    this.blueprint = blueprint;
    this.source = source;
    this.status = 'ready';
    this.error = null;
    this.state = createRoom(blueprint, this.deps.catalog, now);
    const events = [];
    for (const c of this.clients.values()) {
      if (!c.joined) continue;
      const r = applyIntent(this.state, c.playerId, { t: 'join', name: c.name }, now);
      this.state = r.state;
      events.push(...r.events);
    }
    this.broadcast(this.statusMsg());
    for (const [ws, c] of this.clients) if (c.joined) send(ws, this.welcome(c));
    if (events.length) this.broadcast({ type: 'events', events });
  }

  welcome(c) {
    return { type: 'welcome', you: c.playerId, state: this.state, blueprint: this.blueprint };
  }

  // ----- sockets -----

  attach(ws) {
    this.clients.set(ws, { playerId: null, name: null, joined: false });
    this.lastActive = Date.now();
    send(ws, this.statusMsg());
  }

  detach(ws) {
    this.clients.delete(ws);
    this.lastActive = Date.now();
    // The player stays in the sim: tick() releases their held item after 5 s and forgets them after 30 s,
    // so a quick reconnect (join with the same id) resumes seamlessly.
  }

  onMessage(ws, data) {
    const c = this.clients.get(ws);
    if (!c) return;
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return send(ws, { type: 'error', error: 'bad json' });
    }
    if (!msg || typeof msg !== 'object') return;
    this.lastActive = Date.now();
    const now = Date.now();

    if (msg.t === 'demo') {
      const r = this.loadDemo(msg.occupation);
      if (!r.ok) send(ws, { type: 'error', error: r.error });
      return;
    }
    if (msg.t === 'join') return this.join(ws, c, msg, now);
    if (!c.joined) return send(ws, { type: 'events', events: [{ type: 'denied', playerId: null, reason: 'not joined' }] });
    if (!this.state) return; // still generating: nothing to act on yet
    const r = applyIntent(this.state, c.playerId, msg, now);
    this.state = r.state;
    if (r.events.length) this.broadcast({ type: 'events', events: r.events });
  }

  join(ws, c, msg, now) {
    const name = String(msg.name ?? '').trim().slice(0, 24) || 'Player';
    if (!c.playerId) {
      const wanted = typeof msg.id === 'string' && /^[a-z0-9]{1,16}$/i.test(msg.id) ? msg.id : null;
      const taken = (id) => [...this.clients.values()].some((o) => o !== c && o.playerId === id);
      // Reconnect: reuse a player id that is still in the sim and not attached to another socket.
      c.playerId = wanted && this.state?.players[wanted] && !taken(wanted) ? wanted : 'p' + newId(6);
    }
    c.name = name;
    if (this.state) {
      const r = applyIntent(this.state, c.playerId, { t: 'join', name }, now);
      if (r.events.some((e) => e.type === 'denied')) {
        send(ws, { type: 'events', events: r.events });
        ws.close(4003, 'room full');
        return;
      }
      this.state = r.state;
      c.joined = true;
      send(ws, this.welcome(c));
      this.broadcast({ type: 'events', events: r.events });
    } else {
      const joined = [...this.clients.values()].filter((o) => o.joined && o !== c).length;
      if (joined >= 4) {
        send(ws, { type: 'events', events: [{ type: 'denied', playerId: c.playerId, reason: 'room full' }] });
        ws.close(4003, 'room full');
        return;
      }
      c.joined = true;
      send(ws, this.welcome(c));
    }
  }

  // ----- loop -----

  step(now) {
    if (!this.state || !this.clients.size) return;
    const r = tick(this.state, now);
    this.state = r.state;
    if (r.events.length) this.broadcast({ type: 'events', events: r.events });
    this.broadcast({ type: 'snapshot', state: this.state });
  }

  broadcast(msg) {
    if (!this.clients.size) return;
    const text = JSON.stringify(msg);
    for (const ws of this.clients.keys()) send(ws, text);
  }
}

function send(ws, msg) {
  if (ws.readyState !== 1) return;
  ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

export class RoomManager {
  constructor(deps) {
    this.deps = deps; // { catalog, demos, generator, log }
    this.rooms = new Map();
    this.loop = setInterval(() => {
      const now = Date.now();
      for (const room of this.rooms.values()) room.step(now);
    }, TICK_MS);
    this.reaper = setInterval(() => {
      const now = Date.now();
      for (const [id, room] of this.rooms) if (!room.clients.size && now - room.lastActive > IDLE_MS) this.rooms.delete(id);
    }, 60_000);
    this.loop.unref?.();
    this.reaper.unref?.();
  }

  create(occupation) {
    let id;
    do id = newId(6); while (this.rooms.has(id));
    const room = new Room(id, occupation, this.deps);
    this.rooms.set(id, room);
    room.genJob = room.startGeneration(this.deps.generator).catch((err) => room.fail(String(err?.message ?? err)));
    return room;
  }

  get(id) {
    return this.rooms.get(id) ?? null;
  }

  close() {
    clearInterval(this.loop);
    clearInterval(this.reaper);
  }
}
