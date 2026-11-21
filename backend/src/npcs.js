import { ANCHORS, ROOM, SUPPLY_COUNTERS } from '../../frontend/src/shared/layout.js';

const actions = ['prepare', 'stock', 'inspect', 'serve'];
const verbs = { prepare: 'Preparing the station', stock: 'Restocking', inspect: 'Checking equipment', serve: 'Working the service counter' };
const spacing = 0.45;
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

const DEFAULT_NPC_MODEL = 'gpt-5-mini';

export function createNpcPlanner({ apiKey, model = DEFAULT_NPC_MODEL, fetcher = fetch } = {}) {
  if (!apiKey) return null;
  return async (context) => {
    const response = await fetcher('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(6800),
      body: JSON.stringify({
        model, store: false, reasoning: { effort: 'minimal' }, max_output_tokens: 900,
        instructions: 'Direct coworkers in a 3D job simulator. For each given NPC choose a listed station and work animation that fit their occupation and their relationship to the player. An ally supports the team, a rival works toward their own score, and a coworker maintains the venue. Write a brief line the NPC can say about this shift. Avoid real-world instructions for dangerous work. Use exact NPC and station IDs.',
        input: JSON.stringify(context),
        text: { format: { type: 'json_schema', name: 'coworker_plan', strict: true, schema: {
          type: 'object', additionalProperties: false, required: ['cast'],
          properties: { cast: { type: 'array', items: {
            type: 'object', additionalProperties: false, required: ['npc', 'station', 'action', 'line'],
            properties: {
              npc: { type: 'string' }, station: { type: 'string' },
              action: { type: 'string', enum: actions }, line: { type: 'string' },
            },
          } } },
        } } },
      }),
    });
    if (!response.ok) return [];
    const body = await response.json();
    if (body.status !== 'completed') return [];
    const text = (body.output ?? []).filter(item => item.type === 'message')
      .flatMap(item => item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text).join('');
    const cast = text ? JSON.parse(text).cast : [];
    return Array.isArray(cast) ? cast : [];
  };
}

export class RoomCrowd {
  constructor(blueprint, catalog, planner) {
    this.blueprint = blueprint;
    this.planner = planner;
    this.floor = makeFloor(blueprint, catalog);
    this.stations = new Map(blueprint.stations.map(station => [station.id, station]));
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
    this.lastPlan = null;
    this.activePlan = false;
    this.plans = new Map();
  }

  plan(state) {
    const stage = state.event?.fired ? 'changed' : 'opening';
    if (!this.planner || this.activePlan || this.lastPlan === stage) return;
    this.lastPlan = stage;
    this.activePlan = true;
    const context = {
      occupation: this.blueprint.occupation, title: this.blueprint.title, objective: state.objectives[state.cur]?.label,
      stations: [...this.stations.values()].filter(s => !state.closed.includes(s.id)).map(({ id, label }) => ({ id, label })),
      npcs: this.actors.map(({ id, role, side }) => ({ id, role, side: side ?? 'coworker' })), activities: actions,
    };
    Promise.resolve().then(() => this.planner(context)).then((plans) => {
      this.plans.clear();
      for (const plan of plans.slice(0, this.actors.length)) {
        if (!this.actors.some(actor => actor.id === plan?.npc) || !context.stations.some(station => station.id === plan.station) ||
            !actions.includes(plan.action) || typeof plan.line !== 'string') continue;
        this.plans.set(plan.npc, { ...plan, line: plan.line.trim().slice(0, 125) });
      }
    }).catch(() => {}).finally(() => { this.activePlan = false; });
  }

  smallTalk(id, player) {
    const actor = this.actors.find(npc => npc.id === id);
    if (!actor || !player || distance(actor.pos, player.pos) > 3) return null;
    actor.mode = 'talk';
    actor.yaw = yawToward(actor.pos, player.pos);
    actor.activity = 'Talking';
    actor.talkTo = null;
    actor.path = [];
    actor.speed = 0;
    actor.station = null;
    actor.until = (this.lastTime ?? Date.now()) + 2500;
    return this.plans.get(id)?.line || 'I’m getting the next station ready. How is your shift going?';
  }

  snapshot() {
    return Object.fromEntries(this.actors.map(({ id, name, role, side, outfit, pos, yaw, speed, mode, activity, action }) =>
      [id, { id, name, role, side, outfit, pos: [...pos], yaw, speed, mode, activity, action }]));
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
    this.plan(state);
    const events = [];
    for (const actor of this.actors) {
      actor.speed = 0;
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
      }
      if (actor.until > now || actor.talkTo) continue;

      const open = [...this.stations.values()].filter(s => !state.closed.includes(s.id));
      const plan = this.plans.get(actor.id);
      const work = (actor.visits++ % 2 === 0 && open.find(s => s.id === plan?.station)) || open[(actor.visits + actor.index) % open.length];
      const action = plan?.action ?? actions[(actor.visits + actor.index) % actions.length];
      const spot = work && ANCHORS[work.anchor];
      const target = spot
        ? [spot.pos[0] + Math.sin(spot.rotY) * 1.27 + (actor.index - 0.5) * 0.25, 0, spot.pos[2] + Math.cos(spot.rotY) * 1.27]
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
      actor.activity = verbs[action];
      actor.action = action;
      actor.until = 0;
    }
    return events;
  }
}
