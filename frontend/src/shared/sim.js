// Authoritative shift simulation. Pure reducer shared by the backend room server and the blueprint validator.
// See CONTRACTS.md "Sim". The state is JSON-serialisable and is exactly what snapshots carry; the blueprint and catalog
// lookups ride along on a Symbol key, which JSON.stringify ignores.
//
//   createRoom(blueprint, catalog, now?) -> state
//   applyIntent(state, playerId, intent, now) -> { state, events }   never throws
//   tick(state, now) -> { state, events }                            event director + stale-player hold release
import { ANCHORS, ROOM } from './layout.js';
import { buildNav, standPoint, findPath } from './nav.js';

export const MAX_PLAYERS = 4;
export const STALE_MS = 5000; // release held items of players unseen for longer than this
export const DROP_MS = 30000; // forget players unseen for longer than this (frees one of the 4 seats)
export const STUCK_MS = 35000; // an idle NPC walks over to help when the crew is stuck on one step this long
export const NPC_SPEED = 1.3; // m/s

const CTX = Symbol('workshift.ctx');
const SURFACES = Object.keys(ANCHORS).filter((id) => ANCHORS[id].kind === 'surface');
const SPAWN = ANCHORS.SPAWN.pos;

// ---------- context (derived, never serialised) ----------

function buildCtx(bp, catalog) {
  const recipes = new Map((catalog ?? []).map((r) => [r.id, r]));
  const stations = new Map();
  for (const st of bp.stations ?? []) {
    const rec = recipes.get(st.prop);
    stations.set(st.id, {
      ...st,
      slots: new Map((rec?.slots ?? []).map((s) => [s.id, s])),
      controls: new Map((rec?.controls ?? []).map((c) => [c.id, c])),
    });
  }
  const items = new Map((bp.items ?? []).map((it) => [it.id, { ...it, recipe: recipes.get(it.prop) }]));
  const npcs = new Map((bp.npcs ?? []).map((n) => [n.id, n]));
  let nav = null;
  try { nav = buildNav(bp, recipes); } catch { nav = null; }
  return { bp, recipes, stations, items, npcs, nav, event: bp.event ?? null };
}

function ctxOf(state) {
  const c = state?.[CTX];
  if (!c) throw new Error('sim: state has no blueprint context (use createRoom)');
  return c;
}

function clone(state) {
  const next = JSON.parse(JSON.stringify(state));
  Object.defineProperty(next, CTX, { value: state[CTX], enumerable: false });
  return next;
}

/** Re-attach the blueprint context to a state that went through JSON (e.g. a stored snapshot). */
export function rehydrate(plainState, blueprint, catalog) {
  const next = JSON.parse(JSON.stringify(plainState));
  Object.defineProperty(next, CTX, { value: buildCtx(blueprint, catalog), enumerable: false });
  return next;
}

// ---------- room creation ----------

export function createRoom(blueprint, catalog, now = Date.now()) {
  const ctx = buildCtx(blueprint, catalog);
  const items = {};
  for (const it of ctx.items.values()) {
    items[it.id] = { at: it.anchor ?? null, holder: null, tags: [...new Set(it.recipe?.tags ?? [])] };
  }
  const state = {
    phase: 'play',
    startedAt: now,
    players: {},
    items,
    objectives: JSON.parse(JSON.stringify(blueprint.objectives ?? [])),
    cur: 0,
    done: [],
    closed: [],
    event: { fired: false, at: null },
    score: { startedAt: now, finishedAt: null, skills: {} },
    npcs: {},
    stepSince: now, // when the current objective became current (NPC help timing)
    npcTick: now,
  };
  for (const n of ctx.npcs.values()) {
    const a = ANCHORS[n.anchor];
    state.npcs[n.id] = { home: n.anchor, pos: a ? [a.pos[0], a.pos[2]] : [0, 0], yaw: a?.rotY ?? 0, goal: 'post', target: null, path: [], moving: false };
  }
  Object.defineProperty(state, CTX, { value: ctx, enumerable: false });
  return state;
}

// ---------- helpers ----------

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function splitTarget(target) {
  if (typeof target !== 'string') return [null, null];
  const i = target.indexOf('.');
  return i < 0 ? [target, null] : [target.slice(0, i), target.slice(i + 1)];
}

function itemAt(state, at) {
  for (const [id, it] of Object.entries(state.items)) if (it.at === at && !it.holder && !it.in) return id;
  return null;
}

/** Is `at` (a surface anchor or "station.slot") currently free? */
function isFree(state, at) {
  return itemAt(state, at) === null;
}

/** Return the station id an item location belongs to, or null for surfaces / hands. */
function stationOfLocation(at) {
  if (!at || !at.includes('.')) return null;
  return splitTarget(at)[0];
}

export function fits(itemTags, slot) {
  return !!slot && itemTags.some((t) => slot.accepts.includes(t));
}

function deny(events, playerId, reason) {
  events.push({ type: 'denied', playerId, reason });
}

function maybeReview(state, ctx, now, events) {
  if (state.phase !== 'play') return;
  if (state.cur < state.objectives.length) return;
  const pending = ctx.event && state.event.at !== null && !state.event.fired;
  if (pending) return;
  state.phase = 'review';
  state.score.finishedAt = now;
  for (const n of Object.values(state.npcs ?? {})) if (n.goal !== 'post') setGoal(state, ctx, n, 'post', null);
  const npc = ctx.bp.npcs?.[0];
  if (npc?.lines?.done) events.push({ type: 'say', npc: npc.id, text: npc.lines.done });
  events.push({ type: 'review' });
}

function completeCurrent(state, ctx, skillScore, now, events) {
  const obj = state.objectives[state.cur];
  state.done.push(obj.id);
  state.cur += 1;
  state.score.skills[obj.id] = isNum(skillScore) ? clamp(skillScore, 0, 1) : 1;
  state.stepSince = now;
  for (const n of Object.values(state.npcs ?? {})) if (n.goal === 'guide') setGoal(state, ctx, n, 'post', null);
  events.push({ type: 'objective', id: obj.id });
  if (obj.say) events.push({ type: 'say', npc: obj.say.npc, text: obj.say.text });
  if (ctx.event && ctx.event.after === obj.id && !state.event.fired && state.event.at === null) {
    state.event.at = now + (ctx.event.delaySec ?? 3) * 1000;
  }
  settle(state, ctx, now, events);
}

/** Auto-complete current objectives that the world already satisfies (e.g. "grab X" while X is held). */
function settle(state, ctx, now, events) {
  const obj = state.phase === 'play' ? state.objectives[state.cur] : null;
  if (obj) {
    const it = state.items[obj.verb === 'grab' ? obj.target : obj.item];
    const satisfied =
      (obj.verb === 'grab' && it && it.holder) ||
      (obj.verb === 'place' && it && !it.holder && it.at === obj.target);
    if (satisfied) return completeCurrent(state, ctx, undefined, now, events); // settles again, recursively
  }
  maybeReview(state, ctx, now, events);
}

function progress(state, ctx, match, skillScore, now, events) {
  if (state.phase !== 'play') return;
  const obj = state.objectives[state.cur];
  if (obj && match(obj)) completeCurrent(state, ctx, skillScore, now, events);
}

/** Put a released item back where it spawned, else on any free surface, else nowhere (it stays grabbable). */
function restingPlace(state, ctx, itemId) {
  const home = ctx.items.get(itemId)?.anchor;
  if (home && isFree(state, home) && !state.closed.includes(stationOfLocation(home))) return home;
  return SURFACES.find((s) => isFree(state, s)) ?? null;
}

function release(state, ctx, playerId, events) {
  const p = state.players[playerId];
  if (!p?.held) return;
  const itemId = p.held;
  const it = state.items[itemId];
  p.held = null;
  if (it && it.holder === playerId) {
    it.holder = null;
    it.at = restingPlace(state, ctx, itemId);
    events.push({ type: 'released', playerId, item: itemId, at: it.at });
  }
}

// ---------- intents ----------

const GAME_VERBS = new Set(['grab', 'place', 'press', 'talk', 'handoff']);

export function applyIntent(state, playerId, intent, now = Date.now()) {
  const events = [];
  try {
    const ctx = ctxOf(state);
    const s = clone(state);
    const t = intent?.t;

    if (t === 'join') {
      join(s, playerId, intent, now, events);
      return { state: s, events };
    }
    const p = s.players[playerId];
    if (!p) {
      deny(events, playerId, 'not joined');
      return { state, events };
    }
    p.lastSeen = now;
    if (GAME_VERBS.has(t) && s.phase !== 'play') {
      deny(events, playerId, 'shift over');
      return { state: s, events };
    }

    switch (t) {
      case 'ping':
        break;
      case 'pose':
        pose(p, intent);
        break;
      case 'grab':
        grab(s, ctx, playerId, p, intent, now, events);
        break;
      case 'place':
        place(s, ctx, playerId, p, intent, now, events);
        break;
      case 'press':
        press(s, ctx, playerId, intent, now, events);
        break;
      case 'talk':
        talk(s, ctx, playerId, intent, now, events);
        break;
      case 'handoff':
        handoff(s, ctx, playerId, p, intent, now, events);
        break;
      case 'leave':
        release(s, ctx, playerId, events);
        delete s.players[playerId];
        events.push({ type: 'left', playerId });
        break;
      default:
        deny(events, playerId, `unknown intent ${String(t)}`);
    }
    return { state: s, events };
  } catch (err) {
    return { state, events: [{ type: 'denied', playerId, reason: `error: ${err?.message ?? err}` }] };
  }
}

function join(s, playerId, intent, now, events) {
  const name = String(intent.name ?? '').trim().slice(0, 24) || 'Player';
  const existing = s.players[playerId];
  if (existing) {
    existing.name = name;
    existing.lastSeen = now;
    events.push({ type: 'joined', playerId, name, rejoin: true });
    return;
  }
  if (Object.keys(s.players).length >= MAX_PLAYERS) {
    deny(events, playerId, 'room full');
    return;
  }
  const idx = Object.keys(s.players).length;
  const offsets = [0, 0.8, -0.8, 1.6];
  s.players[playerId] = {
    name,
    pos: [SPAWN[0] + offsets[idx], SPAWN[1], SPAWN[2]],
    yaw: 0,
    pitch: 0,
    held: null,
    lastSeen: now,
  };
  events.push({ type: 'joined', playerId, name });
}

function pose(p, intent) {
  if (Array.isArray(intent.pos) && intent.pos.length === 3 && intent.pos.every(isNum)) {
    p.pos = [clamp(intent.pos[0], -ROOM.W / 2, ROOM.W / 2), clamp(intent.pos[1], 0, ROOM.H), clamp(intent.pos[2], -ROOM.D / 2, ROOM.D / 2)];
  }
  if (isNum(intent.yaw)) p.yaw = intent.yaw;
  if (isNum(intent.pitch)) p.pitch = clamp(intent.pitch, -Math.PI / 2, Math.PI / 2);
}

function grab(s, ctx, playerId, p, intent, now, events) {
  const id = intent.item;
  const it = s.items[id];
  if (!it) return deny(events, playerId, `no item ${id}`);
  if (it.holder === playerId) return;
  if (it.in) return deny(events, playerId, `part of ${it.in}`);
  if (it.holder) return deny(events, playerId, 'held by someone else');
  if (p.held) return deny(events, playerId, 'hands full');
  const st = stationOfLocation(it.at);
  if (st && s.closed.includes(st)) return deny(events, playerId, 'closed');
  it.holder = playerId;
  it.at = null;
  p.held = id;
  events.push({ type: 'grabbed', playerId, item: id });
  progress(s, ctx, (o) => o.verb === 'grab' && o.target === id, intent.skillScore, now, events);
}

function place(s, ctx, playerId, p, intent, now, events) {
  const id = intent.item ?? p.held;
  const target = intent.target;
  const it = s.items[id];
  if (!it || p.held !== id) return deny(events, playerId, `not holding ${id}`);
  const [stId, slotId] = splitTarget(target);
  if (slotId === null) {
    if (!SURFACES.includes(stId)) return deny(events, playerId, `no place ${target}`);
  } else {
    const st = ctx.stations.get(stId);
    if (!st) return deny(events, playerId, `no station ${stId}`);
    if (s.closed.includes(stId)) return deny(events, playerId, 'closed');
    const slot = st.slots.get(slotId);
    if (!slot) return deny(events, playerId, `no slot ${target}`);
    if (!fits(it.tags, slot)) return deny(events, playerId, `${id} does not fit ${slotId}`);
  }
  if (!isFree(s, target)) return deny(events, playerId, 'occupied');
  it.holder = null;
  it.at = target;
  p.held = null;
  events.push({ type: 'placed', playerId, item: id, target });
  progress(s, ctx, (o) => o.verb === 'place' && o.target === target && (!o.item || o.item === id), intent.skillScore, now, events);
}

function press(s, ctx, playerId, intent, now, events) {
  const target = intent.target;
  const [stId, ctrlId] = splitTarget(target);
  const st = ctx.stations.get(stId);
  if (!st) return deny(events, playerId, `no station ${stId}`);
  if (s.closed.includes(stId)) return deny(events, playerId, 'closed');
  const ctrl = st.controls.get(ctrlId);
  if (!ctrl) return deny(events, playerId, `no control ${target}`);
  let first = null;
  for (const slotId of ctrl.requires ?? []) {
    const here = itemAt(s, `${stId}.${slotId}`);
    if (!here) return deny(events, playerId, `needs ${slotId}`);
    first ??= here;
  }
  if (ctrl.sets && first && !s.items[first].tags.includes(ctrl.sets)) s.items[first].tags.push(ctrl.sets);
  // combine: the items in the other required slots become part of the first one (assembling a set of materials).
  const combined = [];
  if (ctrl.combine && first) {
    for (const slotId of (ctrl.requires ?? []).slice(1)) {
      const id = itemAt(s, `${stId}.${slotId}`);
      if (!id || id === first) continue;
      const part = s.items[id];
      part.at = null;
      part.in = first;
      s.items[first].contains = [...(s.items[first].contains ?? []), id, ...(part.contains ?? [])];
      combined.push(id);
    }
  }
  events.push({ type: 'pressed', playerId, target, ...(ctrl.sets && first ? { item: first, sets: ctrl.sets } : {}), ...(combined.length ? { combined } : {}) });
  progress(s, ctx, (o) => o.verb === 'press' && o.target === target, intent.skillScore, now, events);
}

function talk(s, ctx, playerId, intent, now, events) {
  const npc = ctx.npcs.get(intent.npc);
  if (!npc) return deny(events, playerId, `no npc ${intent.npc}`);
  const obj = s.objectives[s.cur];
  if (obj && obj.verb === 'talk' && obj.target === npc.id) {
    if (!obj.say) events.push({ type: 'say', npc: npc.id, text: npc.lines?.intro ?? obj.label });
    progress(s, ctx, (o) => o === obj, intent.skillScore, now, events);
    return;
  }
  // Not a talk step: the NPC points the player at the current task.
  events.push({ type: 'say', npc: npc.id, text: instruction(s, ctx, obj, npc) });
}

function handoff(s, ctx, playerId, p, intent, now, events) {
  const to = intent.to;
  const q = s.players[to];
  if (!p.held) return deny(events, playerId, 'nothing to hand off');
  if (!q || to === playerId) return deny(events, playerId, `no player ${to}`);
  if (q.held) return deny(events, playerId, 'their hands are full');
  const id = p.held;
  p.held = null;
  q.held = id;
  s.items[id].holder = to;
  events.push({ type: 'handoff', from: playerId, to, item: id });
  // A grab step for this item stays satisfied; nothing else to progress.
}

// ---------- tick ----------

export function tick(state, now = Date.now()) {
  const events = [];
  try {
    const ctx = ctxOf(state);
    let s = null;
    const w = () => (s ??= clone(state));

    // Event director.
    if (ctx.event && !state.event.fired && state.event.at !== null && now >= state.event.at && state.phase === 'play') {
      fireEvent(w(), ctx, now, events);
    }

    // NPC goals and movement (F6): runs every tick while there is a shift or someone still walking home.
    if (state.npcs && (state.phase === 'play' || Object.values(state.npcs).some((n) => n.path?.length))) {
      const t = w();
      npcThink(t, ctx, now, events);
      moveNpcs(t, now);
    }

    // Stale players: release holds after STALE_MS, forget after DROP_MS.
    for (const [id, p] of Object.entries(state.players)) {
      const age = now - p.lastSeen;
      if (age > STALE_MS && p.held) release(w(), ctx, id, events);
      if (age > DROP_MS) {
        delete w().players[id];
        events.push({ type: 'left', playerId: id });
      }
    }
    return { state: s ?? state, events };
  } catch (err) {
    return { state, events: [{ type: 'error', reason: String(err?.message ?? err) }] };
  }
}

function fireEvent(s, ctx, now, events) {
  const ev = ctx.event;
  s.event.fired = true;
  s.event.at = now;
  events.push({ type: 'eventFired', announce: ev.announce });
  events.push({ type: 'say', npc: ev.announce.npc, text: ev.announce.text });
  if (ev.close && !s.closed.includes(ev.close)) s.closed.push(ev.close);
  const afterIdx = s.objectives.findIndex((o) => o.id === ev.after);
  const keep = afterIdx >= 0 ? afterIdx + 1 : s.cur;
  const kept = s.objectives.slice(0, keep);
  s.objectives = kept.concat(JSON.parse(JSON.stringify(ev.replaceRemaining ?? [])));
  s.cur = Math.min(s.cur, keep);
  const keptIds = new Set(kept.map((o) => o.id));
  s.done = s.done.filter((id) => keptIds.has(id));
  for (const id of Object.keys(s.score.skills)) if (!keptIds.has(id)) delete s.score.skills[id];
  s.stepSince = now;
  // NPC goals change with the event: the announcer goes to deal with the closed station (or points the crew
  // at the revised task when nothing closed); everyone else drops what they were doing.
  for (const n of Object.values(s.npcs ?? {})) if (n.goal === 'guide') setGoal(s, ctx, n, 'post', null);
  const lead = s.npcs?.[ev.announce.npc];
  if (lead) {
    if (ev.close && ctx.stations.has(ev.close)) setGoal(s, ctx, lead, 'repair', ev.close);
    else {
      const spot = objectiveSpot(s, ctx, s.objectives[s.cur]);
      if (spot) setGoal(s, ctx, lead, 'guide', spot);
    }
  }
  // Items held inside the closed station stay there; the validator proves the revised task never needs them.
  settle(s, ctx, now, events);
}

/** The objective the players are currently on, or null. */
export function currentObjective(state) {
  return state.objectives[state.cur] ?? null;
}

// ---------- NPCs (goal-based state machines, F6) ----------
// Goals: post (stand at the home spot and face the crew), guide (walk to the station of the current step and
// point at it), repair (work at a station the event closed). Paths come from the nav grid; positions are XZ.

/** Station id or anchor id where the given objective happens, or null (talk steps happen at the NPC). */
export function objectiveSpot(state, ctx, obj) {
  if (!obj) return null;
  const loc = (at) => (at ? (at.includes('.') ? splitTarget(at)[0] : at) : null);
  if (obj.verb === 'grab') return loc(state.items[obj.target]?.at);
  if (obj.verb === 'place') {
    const it = state.items[obj.item];
    if (it && !it.holder && it.at !== obj.target) return loc(it.at); // fetch it first
    return loc(obj.target);
  }
  if (obj.verb === 'press') return splitTarget(obj.target)[0];
  return null;
}

function setGoal(state, ctx, npc, goal, target) {
  npc.goal = goal;
  npc.target = target;
  const a = ANCHORS[npc.home];
  const dest = goal === 'post' ? (a ? [a.pos[0], a.pos[2]] : null) : ctx.nav ? standPoint(ctx.nav, target) : null;
  if (!dest) { npc.path = []; return; }
  const path = ctx.nav ? findPath(ctx.nav, npc.pos, dest) : null;
  npc.path = path ? path.slice(1) : [dest];
  npc.dest = dest;
}

function npcThink(s, ctx, now, events) {
  if (s.phase !== 'play') return;
  const obj = s.objectives[s.cur];
  const anyGuide = Object.values(s.npcs).some((n) => n.goal === 'guide');
  if (!anyGuide && obj && obj.verb !== 'talk' && now - (s.stepSince ?? now) > STUCK_MS) {
    const id = Object.keys(s.npcs).find((k) => s.npcs[k].goal === 'post');
    const spot = objectiveSpot(s, ctx, obj);
    if (id && spot) {
      setGoal(s, ctx, s.npcs[id], 'guide', spot);
      s.stepSince = now; // do not re-trigger until the next stall
      const where = ctx.stations.get(spot)?.label ?? 'the counter';
      events.push({ type: 'say', npc: id, text: `Over here at the ${where.toLowerCase()}. ${obj.label}.` });
    }
  }
}

function moveNpcs(s, now) {
  const dt = Math.min(0.25, Math.max(0, (now - (s.npcTick ?? now)) / 1000));
  s.npcTick = now;
  for (const n of Object.values(s.npcs)) {
    let budget = NPC_SPEED * dt;
    while (budget > 0 && n.path?.length) {
      const [tx, tz] = n.path[0];
      const dx = tx - n.pos[0], dz = tz - n.pos[1];
      const d = Math.hypot(dx, dz);
      if (d > 1e-3) n.yaw = Math.atan2(dx, dz);
      if (d <= budget) { n.pos = [tx, tz]; n.path.shift(); budget -= d; }
      else { n.pos = [n.pos[0] + (dx / d) * budget, n.pos[1] + (dz / d) * budget]; budget = 0; }
    }
    n.pos = [Math.round(n.pos[0] * 1000) / 1000, Math.round(n.pos[1] * 1000) / 1000];
    n.moving = !!n.path?.length;
  }
}

const lower = (t) => (t ? t.charAt(0).toLowerCase() + t.slice(1) : t);

/** What an NPC tells a player who talks to them outside a talk step, given the live task state. */
function instruction(s, ctx, obj, npc) {
  if (!obj) return npc.lines?.done ?? 'Nice work.';
  const closed = s.closed.map((id) => ctx.stations.get(id)?.label).filter(Boolean);
  const now = `${obj.label}.`;
  if (closed.length) return `${closed[0]} is out of action, so we work around it. ${now}`;
  return `Next up: ${lower(now)}`;
}
