// Authoritative shift simulation. Pure reducer shared by the backend room server and the blueprint validator.
// See CONTRACTS.md "Sim". The state is JSON-serialisable and is exactly what snapshots carry; the blueprint and catalog
// lookups ride along on a Symbol key, which JSON.stringify ignores.
//
//   createRoom(blueprint, catalog, now?) -> state
//   applyIntent(state, playerId, intent, now) -> { state, events }   never throws
//   tick(state, now) -> { state, events }                            event director + stale-player hold release
import { ANCHORS, ROOM } from './layout.js';
import { clampToArena, finishChallenge, gameSpawn, newGame, scoreTask, sparringStrike, tickGeneratedGame } from './gameRules.js';

export const MAX_PLAYERS = 4;
export const STALE_MS = 5000; // release held items of players unseen for longer than this
export const DROP_MS = 30000; // forget players unseen for longer than this (frees one of the 4 seats)
export const STANDING_START = 100;
export const MISTAKE_COST = 6; // a fumbled action (wrong spot, closed station, item that does not fit)
const MISTAKE_GAP_MS = 2000; // one gesture misfire is not three mistakes
const WAIT_COST = 2; // per WAIT_STEP_MS that a customer waits past their patience
const WAIT_STEP_MS = 5000;
// Denials that are the player's mistake (not lag, a teammate, or the room).
const MISTAKES = [/^occupied$/, /does not fit/, /^closed$/, /^needs /, /^hands full$/, /^not holding/, /^not now$/];

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
  return { bp, recipes, stations, items, npcs, event: bp.event ?? null };
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
    ...(blueprint.game ? { game: newGame(blueprint.game) } : {}),
    items,
    objectives: JSON.parse(JSON.stringify(blueprint.objectives ?? [])),
    cur: 0,
    done: [],
    closed: [],
    event: { fired: false, at: null },
    score: { startedAt: now, finishedAt: null, skills: {} },
    // How the shift is going for the boss. Mistakes, a customer kept waiting and bad conduct lower it; at 0 the
    // player loses the job. Sparring matches are scored by the match instead.
    ...(blueprint.game?.kind === 'sparring' ? {} : { standing: { value: STANDING_START, failed: null, last: null } }),
  };
  Object.defineProperty(state, CTX, { value: ctx, enumerable: false });
  refresh(state, ctx);
  return state;
}

// ---------- roles and lanes ----------
// A shift may split its steps into roles (e.g. register and bar). Each player has one role. A player's lane is
// their own role plus every role nobody holds, so a solo player works every step in list order (as before roles
// existed). A player's current step is the first unfinished step in their lane. It waits while the step named by
// its `after` is unfinished (that step usually belongs to the other role: a handoff).

function roleIds(ctx) {
  return (ctx.bp.roles ?? []).map((r) => r.id);
}

function laneOf(state, ctx, playerId) {
  const roles = roleIds(ctx);
  if (!roles.length) return null; // no roles: every step is everyone's
  const held = new Set(Object.values(state.players).map((p) => p.role).filter(Boolean));
  const mine = state.players[playerId]?.role;
  return new Set(roles.filter((r) => r === mine || !held.has(r)));
}

const inLane = (lane, o) => !lane || !o.role || lane.has(o.role);

/** Recompute the global first-unfinished index and each player's lane, current step and waiting flag. */
function refresh(state, ctx) {
  const done = new Set(state.done);
  const first = state.objectives.findIndex((o) => !done.has(o.id));
  state.cur = first < 0 ? state.objectives.length : first;
  for (const [id, p] of Object.entries(state.players)) {
    const lane = laneOf(state, ctx, id);
    p.lane = lane ? [...lane] : null;
    const i = state.objectives.findIndex((o) => !done.has(o.id) && inLane(lane, o));
    p.step = i < 0 ? null : i;
    const o = i < 0 ? null : state.objectives[i];
    p.waiting = Boolean(o?.after && !done.has(o.after) && state.objectives.some((x) => x.id === o.after));
  }
}

/** The step a player can act on now (not waiting), or null. */
function actionableStep(state, playerId) {
  const p = state.players[playerId];
  return p && p.step !== null && p.step !== undefined && !p.waiting ? p.step : null;
}

/** The role new players take: the one held by the fewest players, in blueprint order. */
function nextRole(state, ctx) {
  const roles = roleIds(ctx);
  if (!roles.length) return undefined;
  const count = (r) => Object.values(state.players).filter((p) => p.role === r).length;
  return roles.reduce((best, r) => (count(r) < count(best) ? r : best), roles[0]);
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
  for (const [id, it] of Object.entries(state.items)) if (it.at === at && !it.holder) return id;
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

/**
 * Change the job standing by `delta` with a reason the player sees. At 0 the shift ends: they lost the job.
 * Exported (via adjustStanding) for the room server, which applies conduct and conversation effects.
 */
function changeStanding(state, ctx, delta, reason, now, events, playerId = null) {
  const st = state.standing;
  if (!st || state.phase !== 'play' || !delta) return;
  st.value = clamp(Math.round(st.value + delta), 0, STANDING_START);
  st.last = { delta, reason, at: now };
  events.push({ type: 'standing', value: st.value, delta, reason, ...(playerId ? { playerId } : {}) });
  if (st.value > 0) return;
  st.failed = { reason, at: now };
  state.phase = 'review';
  state.score.finishedAt = now;
  const boss = ctx.npcs.get(ctx.bp.mentor) ?? [...ctx.npcs.values()].find((n) => n.id !== ctx.bp.order?.npc) ?? [...ctx.npcs.values()][0];
  if (boss) events.push({ type: 'say', npc: boss.id, text: "I'm sorry, that's not going to work today. Let's call it here." });
  events.push({ type: 'fired', reason });
  events.push({ type: 'review' });
}

/** Room-server entry point for standing changes (conduct, how a conversation went). */
export function adjustStanding(state, delta, reason, now = Date.now(), playerId = null) {
  const events = [];
  try {
    const s = clone(state);
    changeStanding(s, ctxOf(s), delta, String(reason ?? '').slice(0, 120), now, events, playerId);
    return { state: s, events };
  } catch (err) {
    return { state, events: [] };
  }
}

function maybeReview(state, ctx, now, events) {
  if (state.phase !== 'play' || ctx.bp.game?.kind === 'sparring') return;
  if (state.done.length < state.objectives.length) return;
  const pending = ctx.event && state.event.at !== null && !state.event.fired;
  if (pending) return;
  if (ctx.bp.game?.kind === 'challenge') return finishChallenge(state, ctx.bp.game, now, events);
  state.phase = 'review';
  state.score.finishedAt = now;
  const npc = ctx.bp.npcs?.[0];
  if (npc?.lines?.done) events.push({ type: 'say', npc: npc.id, text: npc.lines.done });
  events.push({ type: 'review' });
}

function completeStep(state, ctx, index, skillScore, now, events) {
  const obj = state.objectives[index];
  state.done.push(obj.id);
  refresh(state, ctx);
  state.score.skills[obj.id] = isNum(skillScore) ? clamp(skillScore, 0, 1) : 1;
  events.push({ type: 'objective', id: obj.id });
  if (obj.say) events.push({ type: 'say', npc: obj.say.npc, text: obj.say.text });
  if (ctx.event && ctx.event.after === obj.id && !state.event.fired && state.event.at === null) {
    state.event.at = now + (ctx.event.delaySec ?? 3) * 1000;
  }
  scoreTask(state, ctx.bp.game, now, events);
  settle(state, ctx, now, events);
}

/**
 * Auto-complete steps the world already satisfies: "grab X" while X is held by someone working that step's lane,
 * "place X at T" while X sits at T. With no players yet, the global first step is checked.
 */
function settle(state, ctx, now, events) {
  refresh(state, ctx);
  if (state.phase === 'play') {
    const ids = Object.keys(state.players);
    const candidates = ids.length ? ids.map((id) => [id, actionableStep(state, id)]) : [[null, state.cur]];
    for (const [id, index] of candidates) {
      const obj = index === null ? null : state.objectives[index];
      if (!obj) continue;
      const it = state.items[obj.verb === 'grab' ? obj.target : obj.item];
      const holderLane = it?.holder ? laneOf(state, ctx, it.holder) : null;
      const satisfied =
        (obj.verb === 'grab' && it && it.holder && (!id || it.holder === id || inLane(holderLane, obj))) ||
        (obj.verb === 'place' && it && !it.holder && it.at === obj.target);
      if (satisfied) return completeStep(state, ctx, index, undefined, now, events); // settles again, recursively
    }
  }
  maybeReview(state, ctx, now, events);
}

/** Complete the acting player's current step when the action matches it. */
function progress(state, ctx, playerId, match, skillScore, now, events) {
  if (state.phase !== 'play') return;
  refresh(state, ctx);
  const index = actionableStep(state, playerId);
  const obj = index === null ? null : state.objectives[index];
  if (obj && match(obj)) completeStep(state, ctx, index, skillScore, now, events);
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
  delete p.holdHand;
  if (it && it.holder === playerId) {
    it.holder = null;
    it.at = restingPlace(state, ctx, itemId);
    events.push({ type: 'released', playerId, item: itemId, at: it.at });
  }
}

// ---------- intents ----------

const GAME_VERBS = new Set(['grab', 'place', 'press', 'use', 'talk', 'handoff', 'strike']);

export function applyIntent(state, playerId, intent, now = Date.now()) {
  const events = [];
  try {
    const ctx = ctxOf(state);
    const s = clone(state);
    const t = intent?.t;

    if (t === 'join') {
      join(s, playerId, intent, now, events, ctx.bp.game);
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
        pose(p, intent, ctx.bp.game);
        break;
      case 'strike':
        sparringStrike(s, ctx.bp.game, playerId, now, events);
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
      case 'use':
        use(s, ctx, playerId, p, intent, now, events);
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
        settle(s, ctx, now, events); // their role's steps fall to the others
        break;
      default:
        deny(events, playerId, `unknown intent ${String(t)}`);
    }
    penalizeMistakes(s, ctx, playerId, t, now, events);
    return { state: s, events };
  } catch (err) {
    return { state, events: [{ type: 'denied', playerId, reason: `error: ${err?.message ?? err}` }] };
  }
}

function join(s, playerId, intent, now, events, rules) {
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
  const role = nextRole(s, ctxOf(s));
  const offsets = [0, 0.8, -0.8, 1.6];
  s.players[playerId] = {
    name,
    pos: gameSpawn(rules, idx) ?? [SPAWN[0] + offsets[idx], SPAWN[1], SPAWN[2]],
    yaw: 0,
    pitch: 0,
    held: null,
    lastSeen: now,
    ...(role ? { role } : {}),
  };
  refresh(s, ctxOf(s));
  events.push({ type: 'joined', playerId, name });
}

function pose(p, intent, rules) {
  if (rules?.kind === 'sparring') p.guard = intent.guard === true;
  if (typeof intent.active === 'boolean') p.active = intent.active;
  if (Array.isArray(intent.pos) && intent.pos.length === 3 && intent.pos.every(isNum)) {
    p.pos = [clamp(intent.pos[0], -ROOM.W / 2, ROOM.W / 2), clamp(intent.pos[1], 0, ROOM.H), clamp(intent.pos[2], -ROOM.D / 2, ROOM.D / 2)];
  }
  if (rules?.kind === 'sparring') p.pos = clampToArena(p.pos, rules.arena);
  if (isNum(intent.yaw)) p.yaw = intent.yaw;
  if (isNum(intent.pitch)) p.pitch = clamp(intent.pitch, -Math.PI / 2, Math.PI / 2);
}

function grab(s, ctx, playerId, p, intent, now, events) {
  const id = intent.item;
  const it = s.items[id];
  if (!it) return deny(events, playerId, `no item ${id}`);
  if (it.holder === playerId) return;
  if (it.holder) return deny(events, playerId, 'held by someone else');
  if (p.held) return deny(events, playerId, 'hands full');
  const st = stationOfLocation(it.at);
  if (st && s.closed.includes(st)) return deny(events, playerId, 'closed');
  it.holder = playerId;
  it.at = null;
  p.held = id;
  if (intent.hand === 'left' || intent.hand === 'right') p.holdHand = intent.hand;
  events.push({ type: 'grabbed', playerId, item: id });
  progress(s, ctx, playerId, (o) => o.verb === 'grab' && o.target === id, intent.skillScore, now, events);
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
  delete p.holdHand;
  events.push({ type: 'placed', playerId, item: id, target });
  progress(s, ctx, playerId, (o) => o.verb === 'place' && o.target === target && (!o.item || o.item === id), intent.skillScore, now, events);
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
  events.push({ type: 'pressed', playerId, target, ...(ctrl.sets && first ? { item: first, sets: ctrl.sets } : {}) });
  progress(s, ctx, playerId, (o) => o.verb === 'press' && o.target === target, intent.skillScore, now, events);
}

function talk(s, ctx, playerId, intent, now, events) {
  const npc = ctx.npcs.get(intent.npc);
  if (!npc) return deny(events, playerId, `no npc ${intent.npc}`);
  refresh(s, ctx);
  const index = actionableStep(s, playerId);
  const obj = index === null ? null : s.objectives[index];
  if (obj && obj.verb === 'talk' && obj.target === npc.id) {
    if (!obj.say) events.push({ type: 'say', npc: npc.id, text: npc.lines?.intro ?? obj.label });
    progress(s, ctx, playerId, (o) => o === obj, intent.skillScore, now, events);
    return;
  }
  // Not a talk step: the NPC points the player at the current task.
  events.push({ type: 'say', npc: npc.id, text: obj ? `Next up: ${obj.label}` : (npc.lines?.done ?? 'Nice work.') });
}

/**
 * Do the trade action of the current step with the item in hand (pour, wipe, tamp, scan...): `target` is a
 * station or "station.slot". When the step names `sets`, the item sitting in that slot gains the tag (a poured cup
 * is now a latte). Only the current step's action does something; anything else is "not now".
 */
function use(s, ctx, playerId, p, intent, now, events) {
  const target = intent.target;
  const [stId, slotId] = splitTarget(target);
  const st = ctx.stations.get(stId);
  if (!st) return deny(events, playerId, `no station ${stId}`);
  if (s.closed.includes(stId)) return deny(events, playerId, 'closed');
  refresh(s, ctx);
  const index = actionableStep(s, playerId);
  const obj = index === null ? null : s.objectives[index];
  if (!obj || obj.verb !== 'use' || obj.target !== target) return deny(events, playerId, 'not now');
  if (obj.item && p.held !== obj.item) return deny(events, playerId, `not holding ${obj.item}`);
  const there = slotId !== null ? itemAt(s, target) : null;
  if (obj.sets && slotId !== null) {
    if (!there) return deny(events, playerId, `needs ${slotId}`);
    if (!s.items[there].tags.includes(obj.sets)) s.items[there].tags.push(obj.sets);
  }
  events.push({ type: 'used', playerId, item: p.held, target, action: obj.action ?? 'use', ...(there && obj.sets ? { on: there, sets: obj.sets } : {}) });
  progress(s, ctx, playerId, (o) => o === obj, intent.skillScore, now, events);
}

/** A fumbled action costs standing (once per short window, so one misread gesture is one mistake). */
function penalizeMistakes(s, ctx, playerId, t, now, events) {
  if (!s.standing || !['grab', 'place', 'press', 'use', 'handoff'].includes(t)) return;
  const denial = events.find((e) => e.type === 'denied' && e.playerId === playerId);
  if (!denial || !MISTAKES.some((re) => re.test(denial.reason))) return;
  const p = s.players[playerId];
  if (p && now - (p.lastMistake ?? -Infinity) < MISTAKE_GAP_MS) return;
  if (p) p.lastMistake = now;
  changeStanding(s, ctx, -MISTAKE_COST, 'Fumbled a task', now, events, playerId);
}

function handoff(s, ctx, playerId, p, intent, now, events) {
  const to = intent.to;
  const q = s.players[to];
  if (!p.held) return deny(events, playerId, 'nothing to hand off');
  if (!q || to === playerId) return deny(events, playerId, `no player ${to}`);
  if (q.held) return deny(events, playerId, 'their hands are full');
  const id = p.held;
  p.held = null;
  delete p.holdHand;
  q.held = id;
  s.items[id].holder = to;
  events.push({ type: 'handoff', from: playerId, to, item: id });
  // Handing the item over passes it on, so it counts for the giver's step that puts this item down.
  progress(s, ctx, playerId, (o) => o.verb === 'place' && o.item === id, intent.skillScore, now, events);
  settle(s, ctx, now, events); // the taker's "grab it" step
}

// ---------- tick ----------

export function tick(state, now = Date.now(), { rivalStation } = {}) {
  const events = [];
  try {
    const ctx = ctxOf(state);
    let s = null;
    const w = () => (s ??= clone(state));

    // Event director.
    if (ctx.event && !state.event.fired && state.event.at !== null && now >= state.event.at && state.phase === 'play') {
      fireEvent(w(), ctx, now, events);
    }

    // Stale players: release holds after STALE_MS, forget after DROP_MS.
    for (const [id, p] of Object.entries(state.players)) {
      const age = now - p.lastSeen;
      if (age > STALE_MS && p.held) release(w(), ctx, id, events);
      if (age > DROP_MS) {
        delete w().players[id];
        events.push({ type: 'left', playerId: id });
        settle(w(), ctx, now, events); // their role's steps fall to the others
      }
    }
    if (ctx.bp.game && state.phase === 'play') tickGeneratedGame(w(), ctx.bp.game, now, events, rivalStation);
    // A customer kept waiting past their patience costs standing, a little at a time.
    const order = ctx.bp.order;
    if (order && state.standing && state.phase === 'play' && Object.keys(state.players).length) {
      const over = now - state.startedAt - order.patienceSec * 1000;
      const due = over > 0 ? Math.floor(over / WAIT_STEP_MS) + 1 : 0;
      const charged = state.standing.waits ?? 0;
      if (due > charged) {
        w().standing.waits = due;
        const who = ctx.npcs.get(order.npc)?.name ?? 'The customer';
        changeStanding(w(), ctx, -WAIT_COST * (due - charged), `${who} has been waiting too long`, now, events);
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
  const keptIds = new Set(kept.map((o) => o.id));
  s.done = s.done.filter((id) => keptIds.has(id));
  refresh(s, ctx);
  for (const id of Object.keys(s.score.skills)) if (!keptIds.has(id)) delete s.score.skills[id];
  scoreTask(s, ctx.bp.game, now, events);
  // Items held inside the closed station stay there; the validator proves the revised task never needs them.
  settle(s, ctx, now, events);
}

/**
 * Swap the unfinished part of the shift for `objectives` (a plan changed by what was said, e.g. a customer changes
 * their order). Finished steps stay; a pending scripted complication is dropped, since the change replaces it.
 */
export function replanRemaining(state, objectives, now = Date.now()) {
  const events = [];
  try {
    const ctx = ctxOf(state);
    const s = clone(state);
    const done = new Set(s.done);
    s.objectives = s.objectives.filter((o) => done.has(o.id)).concat(JSON.parse(JSON.stringify(objectives)));
    if (!s.event.fired) { s.event.fired = true; s.event.at = null; }
    settle(s, ctx, now, events);
    return { state: s, events };
  } catch (err) {
    return { state, events: [], error: String(err?.message ?? err) };
  }
}

/** The first unfinished objective of the whole shift, or null. */
export function currentObjective(state) {
  return state.objectives[state.cur] ?? null;
}

/**
 * A player's own step from a (plain) snapshot: { obj, index, waiting, waitingOn } or null when their lane is done.
 * Falls back to the global step for states without per-player steps.
 */
export function playerStep(state, playerId) {
  const p = state?.players?.[playerId];
  const index = p && 'step' in p ? p.step : state?.cur;
  const obj = index === null || index === undefined ? null : state.objectives[index] ?? null;
  if (!obj) return null;
  const waiting = Boolean(p?.waiting);
  return { obj, index, waiting, waitingOn: waiting ? state.objectives.find((o) => o.id === obj.after) ?? null : null };
}
