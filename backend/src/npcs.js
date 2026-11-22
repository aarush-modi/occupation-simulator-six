import { ANCHORS, ROOM, SUPPLY_COUNTERS } from '../../frontend/src/shared/layout.js';
import { geminiText, MODELS } from './geminiClient.js';

const actions = ['prepare', 'stock', 'inspect', 'serve'];
const verbs = { prepare: 'Preparing the station', stock: 'Restocking', inspect: 'Checking equipment', serve: 'Working the service counter' };
const spacing = 0.45;
const CALLOUT_GAP_MS = 20000; // at most one coworker call-out ("Behind!") this often across the room
const REPLAN_GAP_MS = 6000; // coworkers are re-directed when the players' steps change, at most this often
const countX = Math.floor((ROOM.W - 0.8) / spacing);
const countZ = Math.floor((ROOM.D - 0.8) / spacing);
const distance = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const yawToward = (from, to) => Math.atan2(to[0] - from[0], to[2] - from[2]);

function makeFloor(blueprint, catalog) {
  const recipes = new Map(catalog.map(recipe => [recipe.id, recipe]));
  const obstacles = [...SUPPLY_COUNTERS.map(({ pos, size }) => [pos, size, 0])];
  for (const thing of [...blueprint.stations, ...(blueprint.decor ?? [])]) {
    const anchor = ANCHORS[thing.anchor];
    const recipe = recipes.get(thing.prop);
    if (anchor && recipe) obstacles.push([anchor.pos, recipe.size, anchor.rotY]);
  }
  const free = ([x, , z]) => obstacles.every(([pos, size, yaw]) => {
    const dx = x - pos[0], dz = z - pos[2];
    const localX = dx * Math.cos(yaw) - dz * Math.sin(yaw);
    const localZ = dx * Math.sin(yaw) + dz * Math.cos(yaw);
    return Math.abs(localX) > size[0] / 2 + 0.36 || Math.abs(localZ) > size[2] / 2 + 0.36;
  });
  const cells = [];
  for (let z = 0; z <= countZ; z++) {
    for (let x = 0; x <= countX; x++) {
      const pos = [(x - countX / 2) * spacing, 0, (z - countZ / 2) * spacing];
      if (free(pos)) cells.push({ key: `${x}:${z}`, x, z, pos });
    }
  }
  const index = new Map(cells.map(cell => [cell.key, cell]));
  const nearest = pos => cells.reduce((best, cell) => !best || distance(pos, cell.pos) < distance(pos, best.pos) ? cell : best, null);
  return {
    snap: pos => nearest(pos)?.pos ?? pos,
    path(from, target) {
      const start = nearest(from), end = nearest(target);
      if (!start || !end) return [];
      const queue = [start];
      const prev = new Map([[start.key, null]]);
      for (let i = 0; i < queue.length && !prev.has(end.key); i++) {
        const cell = queue[i];
        for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const next = index.get(`${cell.x + x}:${cell.z + z}`);
          if (!next || prev.has(next.key)) continue;
          prev.set(next.key, cell);
          queue.push(next);
        }
      }
      if (!prev.has(end.key)) return [];
      const path = [];
      for (let cell = end; cell; cell = prev.get(cell.key)) path.unshift(cell.pos);
      // Keep the nearest grid cell if the live position is between cells.
      return path.filter((p, i) => i > 0 || distance(p, from) > 0.04);
    },
  };
}

// Stations the player's current and next objectives use. Coworkers keep away from them so the player's work spot
// stays clear. A grab counts at the station the item is sitting in.
export function playerStations(state) {
  const reserved = new Set();
  // Each player's own step (roles split the work) and the step after it, else the shift's first unfinished steps.
  const starts = Object.values(state.players ?? {}).map(p => p.step).filter(i => Number.isInteger(i));
  const near = (starts.length ? starts : [state.cur]).flatMap(i => (state.objectives ?? []).slice(i, i + 2));
  for (const obj of near) {
    const at = obj.verb === 'grab' ? state.items?.[obj.target]?.at : obj.verb === 'place' || obj.verb === 'press' ? obj.target : null;
    if (typeof at === 'string' && at.includes('.')) reserved.add(at.slice(0, at.indexOf('.')));
  }
  return reserved;
}

const planSchema = {
  type: 'object', additionalProperties: false, required: ['cast'],
  properties: { cast: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['npc', 'station', 'action', 'activity', 'line'],
    properties: {
      npc: { type: 'string' }, station: { type: 'string' },
      action: { type: 'string', enum: actions }, activity: { type: 'string' }, line: { type: 'string' },
    },
  } } },
};

const planInstructions = [
  'Direct the coworker NPCs in a 3D job simulator so the workplace feels like the real job happening around the player.',
  'For each given NPC choose a listed station and one of the work animations, and write `activity`: what that NPC is visibly doing right now in the real trade terms of this occupation, at most 6 words, e.g. "Steaming milk for the flat white" or "Logging the sample temperatures".',
  'Make each activity a real task that fits around what the player is doing now (player.current_task and player.just_did): an ally supports or prepares the next part of that work, a rival works toward their own score, a coworker keeps the venue running, and a customer waits or reacts as a customer would.',
  'Write `line`: one short thing the NPC would say to the player about the work at this moment (at most 16 words).',
  'Avoid real-world instructions for dangerous work. Use exact NPC and station IDs.',
].join(' ');

/** Returns `async (context) => cast[]` or null without a key. Uses the smaller, faster Gemini model. */
export function createNpcPlanner({ apiKey, model = MODELS.npc, fetcher = fetch } = {}) {
  if (!apiKey) return null;
  return async (context) => {
    const { text } = await geminiText({
      apiKey, model, fetcher, system: planInstructions, input: JSON.stringify(context), schema: planSchema,
      thinking: 'low', maxTokens: 1500, signal: AbortSignal.timeout(8000),
    });
    const cast = JSON.parse(text).cast;
    return Array.isArray(cast) ? cast : [];
  };
}

export class RoomCrowd {
  constructor(blueprint, catalog, planner) {
    this.blueprint = blueprint;
    this.planner = planner;
    this.floor = makeFloor(blueprint, catalog);
    this.stations = new Map(blueprint.stations.map(station => [station.id, station]));
    this.depths = new Map(catalog.map(recipe => [recipe.id, recipe.size[2]]));
    const challenge = blueprint.game?.kind === 'challenge' ? blueprint.game : null;
    const npcs = [...blueprint.npcs];
    const used = new Set(npcs.map(npc => npc.anchor));
    if (npcs.length === 1) {
      const anchor = ['P3', 'P2', 'P1'].find(id => !used.has(id));
      let id = 'coworker';
      while (npcs.some(npc => npc.id === id)) id += '_';
      npcs.push({ id, name: 'Casey', role: 'Coworker', outfit: npcs[0].outfit, anchor });
    }
    this.actors = npcs.map((npc, index) => ({
      ...npc, index, pos: this.floor.snap(ANCHORS[npc.anchor].pos), yaw: ANCHORS[npc.anchor].rotY,
      side: npc.id === challenge?.partner ? challenge.role : undefined,
      speed: 0, mode: 'idle', activity: '', until: 0, path: [], talkTo: null, greeted: new Set(), visits: 0,
    }));
    this.lastTime = null;
    this.lastCallout = -Infinity;
    this.lastPlan = null;
    this.lastPlanAt = -Infinity;
    this.activePlan = false;
    this.plans = new Map();
  }

  plan(state, now = Date.now()) {
    // Re-plan when the event fires or any player moves on to another step, so coworkers react to the work.
    const steps = Object.values(state.players ?? {}).map(p => p.step ?? state.cur).sort().join(',');
    const stage = `${state.event?.fired ? 'changed' : 'opening'}:${steps}`;
    if (!this.planner || this.activePlan || this.lastPlan === stage || now - this.lastPlanAt < REPLAN_GAP_MS) return;
    this.lastPlan = stage;
    this.lastPlanAt = now;
    this.activePlan = true;
    const step = Object.values(state.players ?? {}).find(p => Number.isInteger(p.step))?.step ?? state.cur;
    const current = state.objectives[step];
    const previous = state.objectives.filter(o => state.done.includes(o.id)).at(-1);
    const context = {
      occupation: this.blueprint.occupation, title: this.blueprint.title, briefing: this.blueprint.briefing,
      player: { current_task: current?.label ?? 'Shift complete', why_it_matters: current?.real ?? current?.tip, just_did: previous?.label ?? null },
      change_of_plan: state.event?.fired ? this.blueprint.event?.announce?.text : null,
      stations: [...this.stations.values()].filter(s => !state.closed.includes(s.id) && !playerStations(state).has(s.id)).map(({ id, label }) => ({ id, label })),
      npcs: this.actors.map(({ id, name, role, side }) => ({ id, name, role, side: side ?? (id === this.blueprint.order?.npc ? 'customer' : 'coworker') })),
      animations: actions,
    };
    Promise.resolve().then(() => this.planner(context)).then((plans) => {
      this.plans.clear();
      for (const plan of plans.slice(0, this.actors.length)) {
        if (!this.actors.some(actor => actor.id === plan?.npc) || !context.stations.some(station => station.id === plan.station) ||
            !actions.includes(plan.action) || typeof plan.line !== 'string') continue;
        const activity = typeof plan.activity === 'string' ? plan.activity.replace(/\s+/g, ' ').trim().slice(0, 48) : '';
        this.plans.set(plan.npc, { ...plan, activity, line: plan.line.trim().slice(0, 125) });
        // Someone already working shows the new activity straight away.
        const actor = this.actors.find(a => a.id === plan.npc);
        if (actor && activity && actor.station === plan.station && (actor.mode === 'work' || actor.mode === 'travel')) actor.activity = activity;
      }
    }).catch(() => {}).finally(() => { this.activePlan = false; });
  }

  smallTalk(id, player, playerId = null) {
    if (!this.holdTalk(id, player, playerId, 2500, 3)) return null;
    return this.plans.get(id)?.line || 'I’m getting the next station ready. How is your shift going?';
  }

  /** Stop, turn to the player and keep facing them for `ms` (the length of what is being said). */
  holdTalk(id, player, playerId, ms, range = 4.4) {
    const actor = this.actors.find(npc => npc.id === id);
    if (!actor || !player || distance(actor.pos, player.pos) > range) return false;
    actor.mode = 'talk';
    actor.yaw = yawToward(actor.pos, player.pos);
    actor.activity = 'Talking';
    actor.talkTo = null;
    actor.audience = playerId;
    actor.path = [];
    actor.speed = 0;
    actor.station = null;
    actor.until = Math.max(actor.until, (this.lastTime ?? Date.now()) + ms);
    return true;
  }

  snapshot() {
    return Object.fromEntries(this.actors.map(({ id, name, role, side, outfit, pos, yaw, speed, mode, activity, action, station }) =>
      [id, { id, name, role, side, outfit, pos: [...pos], yaw, speed, mode, activity, action, station }]));
  }

  rivalStation() {
    return this.actors.find(actor => actor.side === 'rival' && actor.mode === 'work')?.station;
  }

  step(state, now) {
    const dt = Math.min(0.1, Math.max(0, (now - (this.lastTime ?? now)) / 1000));
    this.lastTime = now;
    const players = Object.entries(state.players).filter(([, p]) => p.active && now - p.lastSeen < 1800);
    if (state.phase !== 'play' || !players.length) {
      this.actors.forEach(actor => { actor.speed = 0; });
      return [];
    }
    this.plan(state, now);
    const events = [];
    const reserved = playerStations(state);
    for (const actor of this.actors) {
      actor.speed = 0;
      // A coworker heading to or working at the player's station moves on (rivals still contest stations).
      const keepClear = actor.side !== 'rival';
      if (keepClear && actor.station && reserved.has(actor.station) && (actor.mode === 'work' || actor.mode === 'travel')) {
        actor.path = [];
        actor.until = 0;
        actor.station = null;
        actor.mode = 'idle';
      }
      if (actor.mode === 'talk' && actor.audience) {
        const listener = state.players[actor.audience];
        if (listener && distance(listener.pos, actor.pos) < 3) actor.yaw = yawToward(actor.pos, listener.pos);
      }
      if (actor.station && state.closed.includes(actor.station)) {
        actor.path = [];
        actor.until = 0;
        actor.station = null;
        actor.mode = 'idle';
      }
      const guest = players.find(([id, player]) => !actor.greeted.has(id) && distance(actor.pos, player.pos) <= 3);
      if (actor.side !== 'rival' && !actor.talkTo && actor.mode !== 'talk' && guest && !this.actors.some(other => other.talkTo === guest[0] || other.mode === 'talk')) {
        const [id, player] = guest;
        actor.station = null;
        actor.talkTo = id;
        actor.activity = 'Coming to talk';
        actor.mode = 'approach';
        actor.until = now + 3600;
        const gap = Math.max(0.01, distance(actor.pos, player.pos));
        const target = [player.pos[0] + (actor.pos[0] - player.pos[0]) * 1.25 / gap, 0, player.pos[2] + (actor.pos[2] - player.pos[2]) * 1.25 / gap];
        actor.path = this.floor.path(actor.pos, target);
      }
      if (actor.talkTo) {
        const player = state.players[actor.talkTo];
        const gap = player ? distance(actor.pos, player.pos) : Infinity;
        if (!player?.active || now >= actor.until || gap > 4.4) {
          actor.talkTo = null; actor.path = []; actor.mode = 'idle'; actor.until = 0;
        } else if (gap < 1.95) {
          actor.yaw = yawToward(actor.pos, player.pos);
          actor.greeted.add(actor.talkTo);
          const line = this.plans.get(actor.id)?.line || actor.lines?.intro || 'Hi! Let me know if you need a hand.';
          events.push({ type: 'say', npc: actor.id, playerId: actor.talkTo, text: line });
          actor.audience = actor.talkTo;
          actor.talkTo = null; actor.path = []; actor.mode = 'talk'; actor.activity = 'Talking'; actor.until = now + 3500;
        }
      }

      const next = actor.path[0];
      if (next) {
        const gap = distance(actor.pos, next);
        if (gap <= 0.028) {
          actor.path.shift();
          continue;
        }
        const stride = Math.min(gap, dt * 1.55);
        const candidate = [actor.pos[0] + (next[0] - actor.pos[0]) * stride / gap, 0, actor.pos[2] + (next[2] - actor.pos[2]) * stride / gap];
        if (players.some(([, p]) => distance(p.pos, candidate) < 0.65)) {
          actor.path = [];
          if (actor.mode === 'travel') {
            actor.station = null;
            actor.mode = 'idle';
          }
          actor.until = now + (actor.talkTo ? 750 : 400);
          continue;
        }
        actor.yaw = yawToward(actor.pos, next);
        actor.pos = candidate;
        actor.speed = 1;
        continue;
      }
      if (actor.mode === 'travel') {
        actor.mode = 'work'; actor.until = now + 2900 + actor.index * 450;
        if (actor.station) actor.yaw = yawToward(actor.pos, ANCHORS[this.stations.get(actor.station).anchor].pos);
        const callouts = actor.lines?.ambient ?? [];
        if (callouts.length && now - this.lastCallout >= CALLOUT_GAP_MS) {
          this.lastCallout = now;
          events.push({ type: 'say', npc: actor.id, text: callouts[actor.visits % callouts.length] });
        }
      }
      if (actor.until > now || actor.talkTo) continue;
      actor.audience = null;

      const open = [...this.stations.values()].filter(s => !state.closed.includes(s.id) && !(keepClear && reserved.has(s.id)));
      const plan = this.plans.get(actor.id);
      const work = (actor.visits++ % 3 !== 2 && open.find(s => s.id === plan?.station)) || open[(actor.visits + actor.index) % open.length];
      const action = plan?.action ?? actions[(actor.visits + actor.index) % actions.length];
      const spot = work && ANCHORS[work.anchor];
      const offset = (this.depths.get(work?.prop) ?? 0.9) / 2 + 0.58;
      const target = spot
        ? [spot.pos[0] + Math.sin(spot.rotY) * offset + Math.cos(spot.rotY) * (actor.index - 0.5) * 0.22, 0, spot.pos[2] + Math.cos(spot.rotY) * offset - Math.sin(spot.rotY) * (actor.index - 0.5) * 0.22]
        : ANCHORS[actor.anchor].pos;
      const destination = this.floor.snap(target);
      actor.path = this.floor.path(actor.pos, destination);
      if (!actor.path.length && distance(actor.pos, destination) > 0.06) {
        actor.mode = 'idle';
        actor.station = null;
        actor.until = now + 400;
        continue;
      }
      actor.station = work?.id;
      actor.mode = 'travel';
      actor.activity = (plan?.station === work?.id && plan?.activity) || verbs[action];
      actor.action = action;
      actor.until = 0;
    }
    return events;
  }
}
