import { ANCHORS, ROOM, SUPPLY_COUNTERS } from '../../frontend/src/shared/layout.js';
import { geminiText, MODELS } from './geminiClient.js';

const actions = ['prepare', 'stock', 'inspect', 'serve'];
const verbs = { prepare: 'Preparing the station', stock: 'Restocking', inspect: 'Checking equipment', serve: 'Working the service counter' };
const spacing = 0.45;
const REPLAN_GAP_MS = 6000; // coworkers are re-directed when the players' steps change, at most this often
// Client-facing shifts have a line of customers behind the one the player serves. More arrive while the shift
// runs, and someone who waits too long gives up and leaves, like a real queue.
const LINE_GAP = 0.8; // metres between people in line
const LINE_MAX = 4;
const ARRIVE_EVERY_MS = 45000;
const LINE_PATIENCE_MS = [110000, 150000];
const DOOR = [0, 0, 5.05];
const WALK = 1.55; // m/s
const PASSERS = ['Priya', 'Marcus', 'Elena', 'Tom', 'Aisha', 'Ken', 'Sofia', 'Omar', 'Grace', 'Luca', 'Nadia', 'Ben'];
const countX = Math.floor((ROOM.W - 0.8) / spacing);
const countZ = Math.floor((ROOM.D - 0.8) / spacing);
const distance = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const yawToward = (from, to) => Math.atan2(to[0] - from[0], to[2] - from[2]);
// People the workplace serves. They wait to be served and never do the job themselves.
const SERVED = /\b(customer|guest|client|patient|diner|patron|shopper|passenger|visitor|buyer|caller|tenant|resident|homeowner|travell?er|student|pupil|member of the public)s?\b/i;

/** 'customer' for the people being served (the order's customer, or a customer-like role), 'rival', else 'staff'. */
export function npcKind(npc, blueprint) {
  if (npc.side === 'rival') return 'rival';
  if (npc.id === blueprint.order?.npc || SERVED.test(npc.role ?? '')) return 'customer';
  return 'staff';
}

// Customers keep to the public side by the entrance: in front of the front-most counter, never behind counters,
// among the machines or in the stock area. This is where that public floor starts (metres along z, door at +z).
const PUBLIC_MIN_Z = 2.7, PUBLIC_MAX_Z = 3.6;
const SERVICE_TAGS = ['pickup', 'serve', 'service', 'register', 'checkout', 'till', 'reception', 'desk', 'counter'];

/** Where the public floor starts for this room: just in front of whatever stands furthest toward the door. */
export function publicLine(blueprint, catalog) {
  const recipes = new Map(catalog.map(recipe => [recipe.id, recipe]));
  let front = -Infinity;
  for (const thing of [...blueprint.stations, ...(blueprint.decor ?? [])]) {
    const anchor = ANCHORS[thing.anchor];
    const size = recipes.get(thing.prop)?.size;
    if (!anchor || !size || anchor.kind === 'surface') continue;
    const c = Math.abs(Math.cos(anchor.rotY)), sn = Math.abs(Math.sin(anchor.rotY));
    front = Math.max(front, anchor.pos[2] + c * size[2] / 2 + sn * size[0] / 2);
  }
  return Math.min(PUBLIC_MAX_Z, Math.max(PUBLIC_MIN_Z, front + 0.45));
}

function makeFloor(blueprint, catalog, allow = () => true) {
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
      if (free(pos) && allow(pos)) cells.push({ key: `${x}:${z}`, x, z, pos });
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
  'Every listed NPC is staff: each has a job role and only the stations of their own post (npcs[].stations). Pick one of those stations and make the activity what someone in that role really does there, fitting around what the player is doing now (player.current_task and player.just_did): an ally supports or prepares the next part of that work, a rival works toward their own score, a coworker keeps the venue running in their own role. Customers are not listed: they never do the work.',
  'Write `line`: what the NPC would answer if the player asked what they are doing (at most 16 words).',
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
    this.publicZ = publicLine(blueprint, catalog);
    this.lobby = makeFloor(blueprint, catalog, pos => pos[2] >= this.publicZ); // the only floor customers use
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
      speed: 0, mode: 'idle', activity: '', until: 0, path: [], visits: 0,
    }));
    for (const actor of this.actors) actor.kind = npcKind(actor, blueprint);
    // Each staff member has a post: their own share of the stations, so they work in their role instead of
    // drifting over every station in the room.
    const staff = this.actors.filter(actor => actor.kind !== 'customer');
    const stationIds = blueprint.stations.map(station => station.id);
    staff.forEach((actor, i) => {
      const own = stationIds.filter((_, j) => j % staff.length === i);
      actor.posts = own.length ? own : stationIds;
    });
    const service = blueprint.stations.find(st => {
      const tags = catalog.find(r => r.id === st.prop)?.tags ?? [];
      return tags.some(t => SERVICE_TAGS.includes(t)) ;
    });
    const taken = [];
    for (const actor of this.actors.filter(a => a.kind === 'customer')) {
      actor.posts = [];
      // Stand on the customer side of the service counter (or as near the generated spot as the public floor allows).
      const spot = service ? ANCHORS[service.anchor] : null;
      // A front counter is worked from behind, so customers stand on the side it does not face.
      const side = spot?.kind === 'counter' ? -1.2 : 1.2;
      const want = spot ? [spot.pos[0] + Math.sin(spot.rotY) * side, 0, Math.max(spot.pos[2] + Math.cos(spot.rotY) * side, this.publicZ + 0.3)] : actor.pos;
      actor.pos = this.lobbySpot(want, taken);
      taken.push(actor.pos);
      actor.homeYaw = spot ? yawToward(actor.pos, spot.pos) : Math.PI;
      actor.yaw = actor.homeYaw;
      actor.activity = actor.id === blueprint.order?.npc && blueprint.order?.text
        ? `Waiting for ${blueprint.order.text.replace(/^(an?|one|the)\s+/i, '').toLowerCase()}`.slice(0, 48)
        : 'Waiting to be served';
      actor.waiting = actor.activity;
    }
    this.lastTime = null;
    this.lastPlan = null;
    this.lastPlanAt = -Infinity;
    this.activePlan = false;
    this.plans = new Map();
    this.setUpLine(blueprint);
  }

  /** The free public-floor spot nearest `want`, at least a step away from people already placed. */
  lobbySpot(want, taken = []) {
    const snapped = this.lobby.snap(want);
    if (taken.every(other => distance(other, snapped) >= LINE_GAP * 0.75)) return snapped;
    for (let ring = 1; ring < 8; ring++) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [1, 1], [-1, 1]]) {
        const spot = this.lobby.snap([want[0] + dx * LINE_GAP * ring, 0, want[2] + dz * LINE_GAP * ring]);
        if (taken.every(other => distance(other, spot) >= LINE_GAP * 0.75)) return spot;
      }
    }
    return snapped;
  }

  /** The queue: spots behind the order's customer, the people already in it, and who may arrive later. */
  setUpLine(blueprint) {
    this.line = []; // queued actors, front first
    this.arrivals = [];
    const front = this.actors.find(actor => actor.id === blueprint.order?.npc);
    const wanted = (blueprint.queue ?? []).filter(q => q?.wants);
    if (!front || !wanted.length) return;
    // The line runs sideways from the counter spot, away from the room's centre aisle (where the door is).
    const side = front.pos[0] > 0.2 ? 1 : -1;
    const taken = [front.pos];
    this.lineSpots = [];
    for (let k = 1; this.lineSpots.length < LINE_MAX && k < LINE_MAX * 3; k++) {
      const spot = this.lobby.snap([front.pos[0] + side * LINE_GAP * k, 0, front.pos[2]]);
      if (taken.every(other => distance(other, spot) >= LINE_GAP * 0.75)) { this.lineSpots.push(spot); taken.push(spot); }
    }
    this.lineYaw = front.yaw;
    const names = new Set(this.actors.map(actor => actor.name));
    this.arrivals = PASSERS.filter(name => !names.has(name));
    this.wants = wanted.map(q => String(q.wants).slice(0, 40));
    wanted.slice(0, this.lineSpots.length).forEach((q, i) => {
      const name = String(q.name || this.arrivals.shift() || `Guest ${i + 1}`).slice(0, 20);
      this.arrivals = this.arrivals.filter(n => n !== name);
      this.join(this.queuer(name, this.wants[i], this.lineSpots[i]), null, i);
    });
    this.nextArrival = null;
  }

  queuer(name, wants, pos) {
    let id = `q_${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}`;
    while (this.actors.some(actor => actor.id === id)) id += '_';
    const waiting = `Waiting to order: ${wants}`.slice(0, 48);
    const actor = {
      id, name, role: 'Customer', outfit: 'casual', anchor: null, index: this.actors.length, kind: 'customer', posts: [],
      pos: [...pos], yaw: this.lineYaw, homeYaw: this.lineYaw, speed: 0, mode: 'idle', activity: waiting, waiting, wants, until: 0, path: [], visits: 0, queued: true,
    };
    this.actors.push(actor);
    return actor;
  }

  /** Join the back of the line. Patience runs from `now`, or from the first tick for people there from the start. */
  join(actor, now, place) {
    actor.patience = LINE_PATIENCE_MS[0] + (place * 17000 + actor.name.length * 3100) % (LINE_PATIENCE_MS[1] - LINE_PATIENCE_MS[0]);
    actor.leaveAt = now == null ? null : now + actor.patience;
    this.line.push(actor);
  }

  /** Arrivals, people giving up, and everyone shuffling up to their place in line. */
  updateLine(now) {
    if (!this.lineSpots?.length) return;
    this.nextArrival ??= now + ARRIVE_EVERY_MS;
    for (const actor of this.line) actor.leaveAt ??= now + actor.patience;
    for (const actor of this.line.filter(a => now >= a.leaveAt)) {
      this.line = this.line.filter(a => a !== actor);
      actor.leaving = true;
      actor.activity = 'Gave up waiting';
      actor.mode = 'travel';
      actor.path = this.lobby.path(actor.pos, this.lobby.snap(DOOR));
    }
    if (now >= this.nextArrival && this.line.length < this.lineSpots.length && this.arrivals.length) {
      this.nextArrival = now + ARRIVE_EVERY_MS;
      const actor = this.queuer(this.arrivals.shift(), this.wants[this.actors.length % this.wants.length], this.lobby.snap(DOOR));
      actor.mode = 'travel';
      actor.activity = 'Joining the line';
      this.join(actor, now, this.line.length);
    }
    this.line.forEach((actor, i) => {
      const spot = this.lineSpots[i];
      if (actor.goal && distance(actor.goal, spot) < 0.01) return;
      actor.goal = spot;
      actor.path = this.lobby.path(actor.pos, spot);
      if (actor.path.length) actor.mode = 'travel';
    });
  }

  /** People being served: they walk where the line sends them and otherwise wait. */
  customer(actor, players, now, dt) {
    if (actor.path.length) {
      const next = actor.path[0];
      const gap = distance(actor.pos, next);
      if (gap <= 0.028) { actor.path.shift(); return; }
      const stride = Math.min(gap, dt * WALK);
      const candidate = [actor.pos[0] + (next[0] - actor.pos[0]) * stride / gap, 0, actor.pos[2] + (next[2] - actor.pos[2]) * stride / gap];
      if (players.some(([, p]) => distance(p.pos, candidate) < 0.6)) return; // wait for the player to pass
      actor.yaw = yawToward(actor.pos, next);
      actor.pos = candidate;
      actor.speed = 1;
      return;
    }
    if (actor.leaving) { this.actors = this.actors.filter(a => a !== actor); return; }
    this.wait(actor, players, now);
  }

  plan(state, now = Date.now()) {
    // Re-plan when the event fires or any player moves on to another step, so coworkers react to the work.
    const steps = Object.values(state.players ?? {}).map(p => p.step ?? state.cur).sort().join(',');
    const stage = `${state.event?.fired ? 'changed' : 'opening'}:${steps}`;
    if (!this.planner || !this.actors.some(a => a.kind !== 'customer') || this.activePlan || this.lastPlan === stage || now - this.lastPlanAt < REPLAN_GAP_MS) return;
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
      npcs: this.actors.filter(a => a.kind !== 'customer').map(({ id, name, role, side, posts }) => ({ id, name, role, side: side ?? 'coworker', stations: posts })),
      animations: actions,
    };
    Promise.resolve().then(() => this.planner(context)).then((plans) => {
      this.plans.clear();
      for (const plan of plans.slice(0, this.actors.length)) {
        const who = this.actors.find(actor => actor.id === plan?.npc);
        if (!who || who.kind === 'customer' || !who.posts.includes(plan.station) || !context.stations.some(station => station.id === plan.station) ||
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
    const actor = this.actors.find(npc => npc.id === id);
    if (actor?.kind === 'customer') return actor.wants ? `Just waiting to order: ${actor.wants}.` : 'Just waiting on my order, thanks.';
    return this.plans.get(id)?.line || 'I’m getting the next station ready. How is your shift going?';
  }

  /** Stop, turn to the player and keep facing them for `ms` (the length of what is being said). */
  holdTalk(id, player, playerId, ms, range = 4.4) {
    const actor = this.actors.find(npc => npc.id === id);
    if (!actor || !player || distance(actor.pos, player.pos) > range) return false;
    actor.mode = 'talk';
    actor.yaw = yawToward(actor.pos, player.pos);
    actor.activity = 'Talking';
    actor.audience = playerId;
    actor.path = [];
    actor.speed = 0;
    actor.station = null;
    actor.until = Math.max(actor.until, (this.lastTime ?? Date.now()) + ms);
    return true;
  }

  /** A customer waits where they are, turning to face a player who comes close. */
  wait(actor, players, now) {
    actor.path = [];
    actor.station = null;
    if (actor.mode === 'talk' && actor.until > now) return;
    actor.mode = 'idle';
    actor.audience = null;
    actor.activity = actor.waiting;
    const near = players.map(([, p]) => p).filter(p => distance(p.pos, actor.pos) < 3.2)
      .sort((a, b) => distance(a.pos, actor.pos) - distance(b.pos, actor.pos))[0];
    actor.yaw = near ? yawToward(actor.pos, near.pos) : actor.homeYaw ?? actor.yaw;
  }

  snapshot() {
    return Object.fromEntries(this.actors.map(({ id, name, role, side, kind, outfit, pos, yaw, speed, mode, activity, action, station }) =>
      [id, { id, name, role, side, kind, outfit, pos: [...pos], yaw, speed, mode, activity, action, station }]));
  }

  /** Everyone who may speak in this shift, including people who have not walked in yet (for the voice cast). */
  speakers() {
    return [...this.actors.map(actor => actor.name), ...(this.arrivals ?? [])];
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
    this.updateLine(now);
    const events = [];
    const reserved = playerStations(state);
    for (const actor of [...this.actors]) {
      actor.speed = 0;
      if (actor.kind === 'customer') { this.customer(actor, players, now, dt); continue; }
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
          actor.until = now + 400;
          continue;
        }
        actor.yaw = yawToward(actor.pos, next);
        actor.pos = candidate;
        actor.speed = 1;
        continue;
      }
      if (actor.mode === 'travel' && !actor.station) actor.mode = 'idle'; // back at their spot
      if (actor.mode === 'travel') {
        actor.mode = 'work'; actor.until = now + 2900 + actor.index * 450;
        actor.yaw = yawToward(actor.pos, ANCHORS[this.stations.get(actor.station).anchor].pos);
      }
      if (actor.until > now) continue;
      actor.audience = null;

      // Work only at their own post; when the player needs all of it, wait at their spot until it frees up.
      const open = [...this.stations.values()].filter(s => actor.posts.includes(s.id) && !state.closed.includes(s.id) && !(keepClear && reserved.has(s.id)));
      const plan = this.plans.get(actor.id);
      const work = (actor.visits++ % 3 !== 2 && open.find(s => s.id === plan?.station)) || open[(actor.visits + actor.index) % (open.length || 1)];
      const action = plan?.action ?? actions[(actor.visits + actor.index) % actions.length];
      if (!work) {
        const home = this.floor.snap(ANCHORS[actor.anchor].pos);
        actor.path = distance(actor.pos, home) > 0.3 ? this.floor.path(actor.pos, home) : [];
        actor.station = null;
        actor.mode = actor.path.length ? 'travel' : 'idle';
        actor.activity = actor.path.length ? '' : 'Keeping an eye on the floor';
        actor.until = now + 2500;
        continue;
      }
      const spot = ANCHORS[work.anchor];
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
