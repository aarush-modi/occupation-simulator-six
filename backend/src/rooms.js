// Rooms: lobby status, the authoritative sim state, connected sockets, and the 20 Hz loop (N3).
import { randomBytes } from 'node:crypto';
import { createRoom, applyIntent, tick, playerStep, adjustStanding } from '../../frontend/src/shared/sim.js';
import { ANCHORS } from '../../frontend/src/shared/layout.js';
import { pickDemo } from './demos.js';
import { RoomCrowd } from './npcs.js';
import { capSpeech, cleanUtterance, conversationContext, HISTORY_TURNS, readReply, spokenMs, TALK_RANGE } from './dialogue.js';
import { tryPlan } from './replan.js';
import { castVoices, voiceFor } from './voices.js';
import { arrangeLayout } from '../../frontend/src/shared/arrange.js';

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
    this.crowd = null;
    this.clients = new Map(); // ws -> { playerId, name, joined, replying }
    this.chats = new Map(); // `${playerId}:${npcId}` -> recent spoken turns [{ who, text }]
    this.speakable = new Set(); // lines the voice endpoint may synthesize for this room (its script + what NPCs said)
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
    const r = await generator.generate(this.occupation, { fresh: true });
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
    blueprint = arrangeLayout(withoutMiniGames(blueprint), this.deps.catalog); // a real workplace layout
    const now = Date.now();
    this.blueprint = blueprint;
    this.source = source;
    this.status = 'ready';
    this.error = null;
    this.state = createRoom(blueprint, this.deps.catalog, now);
    this.crowd = blueprint.game?.kind === 'sparring' ? null : new RoomCrowd(blueprint, this.deps.catalog, this.deps.planNpcs);
    this.chats.clear();
    this.prepareVoices(blueprint);
    const events = [];
    for (const c of this.clients.values()) {
      if (!c.joined) continue;
      const r = applyIntent(this.state, c.playerId, { t: 'join', name: c.name }, now);
      this.state = r.state;
      events.push(...r.events);
    }
    this.broadcast(this.statusMsg());
    for (const [ws, c] of this.clients) if (c.joined) send(ws, this.welcome(c));
    this.emit(events);
  }

  /** Every scripted line may be voiced; synthesize them now so they play without a wait. */
  prepareVoices(bp) {
    this.speakable.clear();
    const name = (id) => bp.npcs.find(npc => npc.id === id)?.name ?? id;
    const mentor = bp.npcs.find(npc => npc.id === bp.mentor) ?? bp.npcs.find(npc => npc.id !== bp.order?.npc);
    const lines = [];
    for (const npc of bp.npcs) {
      lines.push([npc.name, npc.lines?.intro], [npc.name, npc.lines?.done]);
    }
    for (const obj of [...(bp.objectives ?? []), ...(bp.event?.replaceRemaining ?? [])]) {
      if (obj.tip) lines.push([mentor?.name ?? 'Coach', obj.tip]);
      if (obj.say) lines.push([name(obj.say.npc), obj.say.text]);
    }
    if (bp.event?.announce) lines.push([name(bp.event.announce.npc), bp.event.announce.text]);
    if (bp.order) lines.push([name(bp.order.npc), bp.order.waiting]);
    for (const [, text] of lines) if (text) this.speakable.add(text);
    this.mentorName = mentor?.name ?? 'Coach';
    // One voice per person for the whole shift, all different, so nobody changes voice between lines.
    this.voiceCast = castVoices([...(this.crowd?.speakers() ?? bp.npcs.map(npc => npc.name)), 'Coach']);
    this.warmTips(0);
    const first = bp.objectives?.[0];
    if (first?.verb === 'talk') this.warm(name(first.target), capSpeech(bp.npcs.find(npc => npc.id === first.target)?.lines?.intro ?? ''));
  }

  /** Prepare the mentor's tips for the step at `index` and the one after, which are about to be said. */
  warmTips(index) {
    for (const obj of (this.state?.objectives ?? this.blueprint?.objectives ?? []).slice(index, index + 2)) {
      if (obj.tip) { this.speakable.add(obj.tip); this.warm(this.mentorName, obj.tip); } // replanned steps too
    }
  }

  /** This room's voice for a speaker (by name). */
  voiceOf(who) {
    return this.voiceCast?.get(who) ?? voiceFor(who);
  }

  warm(who, text) {
    this.deps.voice?.warm(who, text, this.voiceOf(who));
  }

  /** Lines the voice endpoint may read: this shift's script, what NPCs said, and the tips of its current steps. */
  canVoice(text) {
    return this.speakable.has(text) || Boolean(this.state?.objectives?.some(o => o.tip === text));
  }

  npcName(id) {
    return this.crowd?.actors.find(actor => actor.id === id)?.name ?? this.blueprint?.npcs.find(npc => npc.id === id)?.name ?? id;
  }

  /**
   * Send events (to one socket, or everyone). NPC lines are capped to 20 seconds of speech, become speakable, start
   * synthesizing, and keep the speaker facing the player they are talking to.
   */
  emit(events, { ws = null, audience = null } = {}) {
    if (!events?.length) return;
    for (const ev of events) {
      if (ev.type === 'objective' && this.state) this.warmTips(Math.min(...Object.values(this.state.players).map(p => p.step ?? this.state.cur)));
      if (ev.type !== 'say' || typeof ev.text !== 'string') continue;
      ev.text = capSpeech(ev.text);
      if (this.speakable.size > 3000) this.speakable.clear();
      this.speakable.add(ev.text);
      this.warm(this.npcName(ev.npc), ev.text);
      const listener = ev.playerId ?? audience;
      if (listener && this.state?.players[listener]) this.crowd?.holdTalk(ev.npc, this.state.players[listener], listener, spokenMs(ev.text) + 1500);
    }
    const msg = { type: 'events', events };
    if (ws) send(ws, msg); else this.broadcast(msg);
  }

  welcome(c) {
    return { type: 'welcome', you: c.playerId, state: this.snapshot(), blueprint: this.blueprint };
  }

  snapshot() {
    if (!this.state) return null;
    if (this.crowd) return { ...this.state, people: this.crowd.snapshot() };
    const { arena, opponent } = this.blueprint.game;
    const people = Object.fromEntries(this.blueprint.npcs.map((npc, index) => {
      const match = npc.id === opponent;
      const corner = ANCHORS[npc.anchor].pos;
      const x = (index % 2 ? -1 : 1) * (arena.radius + 0.75);
      const pos = [x, 0, corner[2]];
      const pose = match ? this.state.game.opponent : { pos, yaw: Math.atan2(-x, -pos[2]), speed: 0 };
      return [npc.id, { id: npc.id, name: npc.name, role: npc.role, outfit: npc.outfit, ...pose, mode: match ? 'sparring' : 'idle' }];
    }));
    return { ...this.state, people };
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
    if (msg.t === 'talk') return this.talk(ws, c, msg.npc, now);
    if (msg.t === 'speak') return this.speak(ws, c, msg, now);
    const r = applyIntent(this.state, c.playerId, msg, now);
    this.state = r.state;
    this.emit(r.events);
  }

  /** The scripted conversation: a talk step's instructions, a pointer at the current task, or small talk. */
  talk(ws, c, npcId, now) {
    if (!this.blueprint.npcs.some(npc => npc.id === npcId)) {
      const line = this.crowd?.smallTalk(npcId, this.state.players[c.playerId], c.playerId);
      if (line) this.emit([{ type: 'say', npc: npcId, playerId: c.playerId, text: line }], { ws });
      return;
    }
    const r = applyIntent(this.state, c.playerId, { t: 'talk', npc: npcId }, now);
    this.state = r.state;
    this.emit(r.events, { audience: c.playerId });
  }

  /** The player said something out loud to an NPC (transcribed in their browser). */
  speak(ws, c, msg, now) {
    const said = cleanUtterance(msg.text);
    const player = this.state.players[c.playerId];
    const person = this.snapshot().people?.[msg.npc];
    if (!said || !player || !person || this.state.phase !== 'play') return;
    if (Math.hypot(person.pos[0] - player.pos[0], person.pos[2] - player.pos[2]) > TALK_RANGE) {
      return send(ws, { type: 'events', events: [{ type: 'denied', playerId: c.playerId, reason: 'too far to hear' }] });
    }
    const npc = this.crowd?.actors.find(actor => actor.id === msg.npc) ?? this.blueprint.npcs.find(n => n.id === msg.npc);
    const key = `${c.playerId}:${msg.npc}`;
    const history = this.chats.get(key) ?? [];
    const remember = (who, text) => {
      history.push({ who, text });
      while (history.length > HISTORY_TURNS) history.shift();
      this.chats.set(key, history);
    };
    // Without a model to answer, every utterance gets the scripted reply (and a "talk to" step completes).
    const step = playerStep(this.state, c.playerId);
    const due = step && !step.waiting && step.obj.verb === 'talk' && step.obj.target === msg.npc;
    if (!this.deps.respond) {
      remember('player', said);
      return this.talk(ws, c, msg.npc, now);
    }
    if (c.replying) return; // one answer at a time per player
    c.replying = true;
    // A "talk to" step completes when the player speaks to that NPC. The model answers in character and gets the
    // step's scripted instructions across; the scripted line is kept only as the fallback.
    let brief = null;
    if (due) {
      const r = applyIntent(this.state, c.playerId, { t: 'talk', npc: msg.npc }, now);
      this.state = r.state;
      const scripted = r.events.filter(ev => ev.type === 'say' && ev.npc === msg.npc);
      brief = scripted.map(ev => ev.text).join(' ') || null;
      this.emit(r.events.filter(ev => !scripted.includes(ev)), { audience: c.playerId });
    }
    this.crowd?.smallTalk(msg.npc, player, c.playerId); // stop and face the player while thinking
    const blueprint = this.blueprint;
    const context = conversationContext({ blueprint, state: this.state, npc, playerId: c.playerId, history: [...history], said, brief, interrupted: msg.interrupted === true });
    remember('player', said);
    const fallback = () => {
      if (this.blueprint !== blueprint || !this.clients.has(ws) || !this.state) return;
      if (brief) this.emit([{ type: 'say', npc: msg.npc, playerId: c.playerId, text: brief }], { ws });
      else this.talk(ws, c, msg.npc, Date.now());
    };
    Promise.resolve().then(() => this.deps.respond(context)).then((answer) => {
      if (this.blueprint !== blueprint || !this.clients.has(ws)) return;
      const out = readReply(answer ?? '');
      if (!out.reply) return fallback();
      remember('npc', out.reply);
      this.emit([{ type: 'say', npc: msg.npc, playerId: c.playerId, text: out.reply }], { ws });
      this.applyConversation(c, npc, out);
    }).catch((err) => {
      this.deps.log?.warn?.(`[room] ${this.id} NPC reply failed: ${err?.message ?? err}`);
      fallback();
    }).finally(() => { c.replying = false; });
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
      this.emit(r.events);
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

  /** What a conversation did at work: conduct and service move the job standing; some talk changes the plan. */
  applyConversation(c, npc, out) {
    if (!this.state || this.state.phase !== 'play') return;
    const name = npc?.name ?? 'a coworker';
    let delta = out.standingChange;
    let reason = out.standingReason || (delta > 0 ? `Good talk with ${name}` : `Talk with ${name}`);
    if (out.conduct === 'rude') { delta = Math.min(delta, -15); reason = `Rude to ${name}`; }
    if (out.conduct === 'inappropriate') { delta = Math.min(delta, -35); reason = 'Inappropriate language at work'; }
    if (delta) {
      const r = adjustStanding(this.state, delta, reason, Date.now(), c.playerId);
      this.state = r.state;
      this.emit(r.events);
    }
    if (out.scenarioChange && this.state.phase === 'play' && out.conduct === 'fine') this.replan(c, out.scenarioChange);
  }

  /** Rewrite the rest of the shift around what changed, if a playable plan can be found. */
  async replan(c, change) {
    if (!this.deps.replan || this.replanning) return;
    this.replanning = true;
    const blueprint = this.blueprint;
    try {
      const steps = await this.deps.replan({ blueprint, catalog: this.deps.catalog, state: this.state, playerId: c.playerId, change });
      if (!steps || this.blueprint !== blueprint || this.state.phase !== 'play') return;
      // The room moved on while the model thought: apply only if the plan still plays from here.
      const r = tryPlan(this.state, steps, c.playerId);
      if (r.error) return this.deps.log?.warn?.(`[room] ${this.id} plan change dropped: ${r.error}`);
      this.state = r.state;
      this.emit([{ type: 'replanned', change }, ...r.events]);
      this.deps.log?.log?.(`[room] ${this.id} plan changed: ${change}`);
    } catch (err) {
      this.deps.log?.warn?.(`[room] ${this.id} plan change failed: ${err?.message ?? err}`);
    } finally {
      this.replanning = false;
    }
  }

  // ----- loop -----

  step(now) {
    if (!this.state || !this.clients.size) return;
    const waiting = this.state.game?.status === 'waiting';
    const r = tick(this.state, now, { rivalStation: this.crowd?.rivalStation() });
    this.state = r.state;
    this.emit(r.events);
    if (waiting && this.state.game.status === 'live') {
      const game = this.blueprint.game;
      const speaker = game.kind === 'sparring'
        ? this.blueprint.npcs.find(npc => npc.id !== game.opponent) ?? this.blueprint.npcs.find(npc => npc.id === game.opponent)
        : this.blueprint.npcs.find(npc => npc.id === game.partner);
      if (speaker) this.emit([{ type: 'say', npc: speaker.id, text: speaker.lines.intro }]);
    }
    this.emit(this.crowd?.step(this.state, now) ?? []);
    this.broadcast({ type: 'snapshot', state: this.snapshot() });
  }

  broadcast(msg) {
    if (!this.clients.size) return;
    const text = JSON.stringify(msg);
    for (const ws of this.clients.keys()) send(ws, text);
  }
}

/** Every step is a plain grab, place, press or talk: no timing, steadiness or hold mini-games. */
export function withoutMiniGames(bp) {
  const plain = (list) => list?.map((o) => (o.skill && o.skill !== 'none' ? { ...o, skill: 'none' } : o));
  return {
    ...bp,
    objectives: plain(bp.objectives),
    ...(bp.event?.replaceRemaining ? { event: { ...bp.event, replaceRemaining: plain(bp.event.replaceRemaining) } } : {}),
  };
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
