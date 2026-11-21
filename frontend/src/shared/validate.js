// Semantic blueprint validation. Shared by the backend (Gemini output, demo shifts) and dev tools.
//   validateBlueprint(bp, catalog) -> string[] errors            (empty = playable)
//   checkBlueprint(bp, catalog) -> { errors, warnings, blueprint } (blueprint = zod-parsed with defaults)
// Besides reference checks it plays the whole shift with sim.js, with and without the event, to prove it can be finished.
import { Blueprint } from './schema.js';
import { ANCHORS } from './layout.js';
import { createRoom, applyIntent, tick, fits } from './sim.js';
import { buildNav, standPoint, findPath, spawnPoint } from './nav.js';

const SURFACES = Object.keys(ANCHORS).filter((id) => ANCHORS[id].kind === 'surface');
const STATION_KINDS = ['station', 'furniture'];
const DECOR_KINDS = ['decor', 'furniture'];
const PLACE_KINDS = ['wall', 'island'];
const listIds = (arr) => (arr?.length ? arr.map((x) => x.id).join(', ') : 'none');

export function validateBlueprint(bp, catalog) {
  return checkBlueprint(bp, catalog).errors;
}

export function checkBlueprint(input, catalog) {
  const errors = [];
  const warnings = [];
  const parsed = Blueprint.safeParse(input);
  if (!parsed.success) {
    for (const i of parsed.error.issues.slice(0, 12)) errors.push(`schema ${i.path.join('.') || '(root)'}: ${i.message}`);
    return { errors, warnings, blueprint: null };
  }
  const bp = parsed.data;
  const recipes = new Map((catalog ?? []).map((r) => [r.id, r]));

  // ---- ids and anchors ----
  const ids = new Set();
  const uniqueId = (id, what) => {
    if (ids.has(id)) errors.push(`duplicate id "${id}" (${what})`);
    ids.add(id);
  };
  const usedAnchors = new Map();
  const useAnchor = (anchor, who) => {
    if (usedAnchors.has(anchor)) errors.push(`anchor ${anchor} used by both ${usedAnchors.get(anchor)} and ${who}`);
    usedAnchors.set(anchor, who);
  };
  const recipeFor = (prop, kinds, who) => {
    const rec = recipes.get(prop);
    if (!rec) {
      errors.push(`${who}: prop "${prop}" is not in the catalog`);
      return null;
    }
    if (!kinds.includes(rec.kind)) errors.push(`${who}: prop "${prop}" is a ${rec.kind}, expected ${kinds.join(' or ')}`);
    if (!rec.shells.includes(bp.shell) && !prop.startsWith('gen_')) warnings.push(`${who}: prop "${prop}" is not designed for shell ${bp.shell}`);
    return rec;
  };

  const stations = new Map();
  for (const st of bp.stations) {
    const who = `station ${st.id}`;
    uniqueId(st.id, 'station');
    const rec = recipeFor(st.prop, STATION_KINDS, who);
    if (!PLACE_KINDS.includes(ANCHORS[st.anchor]?.kind)) errors.push(`${who}: anchor ${st.anchor} must be a wall or island anchor`);
    useAnchor(st.anchor, who);
    stations.set(st.id, rec ?? { slots: [], controls: [] });
  }
  for (const [i, d] of bp.decor.entries()) {
    const who = `decor[${i}] ${d.prop}`;
    recipeFor(d.prop, DECOR_KINDS, who);
    if (!PLACE_KINDS.includes(ANCHORS[d.anchor]?.kind)) errors.push(`${who}: anchor ${d.anchor} must be a wall or island anchor`);
    useAnchor(d.anchor, who);
  }
  const slotOf = (target) => {
    const [stId, slotId] = target.split('.');
    return stations.get(stId)?.slots?.find((s) => s.id === slotId) ?? null;
  };
  const items = new Map();
  for (const it of bp.items) {
    const who = `item ${it.id}`;
    uniqueId(it.id, 'item');
    const rec = recipeFor(it.prop, ['item'], who);
    items.set(it.id, rec);
    if (SURFACES.includes(it.anchor)) {
      useAnchor(it.anchor, who);
    } else if (it.anchor.includes('.')) {
      const [stId] = it.anchor.split('.');
      const slot = slotOf(it.anchor);
      if (!stations.has(stId)) errors.push(`${who}: anchor ${it.anchor} refers to unknown station ${stId}`);
      else if (!slot) errors.push(`${who}: anchor ${it.anchor} is not a slot of ${stId}`);
      else if (rec && !fits(rec.tags, slot)) errors.push(`${who}: does not fit ${it.anchor} (item tags ${rec.tags.join(',')}; accepts ${slot.accepts.join(',')})`);
      useAnchor(it.anchor, who);
    } else {
      errors.push(`${who}: anchor ${it.anchor} must be a surface anchor S1-S8 or "station.slot"`);
    }
  }
  const npcs = new Set();
  for (const n of bp.npcs) {
    uniqueId(n.id, 'npc');
    npcs.add(n.id);
    if (ANCHORS[n.anchor]?.kind !== 'spot') errors.push(`npc ${n.id}: anchor ${n.anchor} must be a spot anchor P1-P3`);
    useAnchor(n.anchor, `npc ${n.id}`);
  }

  // ---- objectives ----
  const objIds = new Set();
  const closed = bp.event.close;
  if (closed && !stations.has(closed)) errors.push(`event.close: unknown station ${closed}`);
  if (!npcs.has(bp.event.announce.npc)) errors.push(`event.announce: unknown npc ${bp.event.announce.npc}`);
  const afterIdx = bp.objectives.findIndex((o) => o.id === bp.event.after);
  if (afterIdx < 0) errors.push(`event.after: unknown objective ${bp.event.after}`);

  const checkObjective = (o, where, isReplacement) => {
    const who = `${where} ${o.id}`;
    if (objIds.has(o.id)) errors.push(`duplicate objective id ${o.id}`);
    objIds.add(o.id);
    if (o.say && !npcs.has(o.say.npc)) errors.push(`${who}: say.npc ${o.say.npc} is not an npc`);
    const [stId, sub] = o.target.split('.');
    if (isReplacement && closed && stId === closed) errors.push(`${who}: uses ${closed}, which the event closes`);
    switch (o.verb) {
      case 'grab':
        if (!items.has(o.target)) errors.push(`${who}: grab target ${o.target} is not an item`);
        break;
      case 'place':
        if (!o.item) errors.push(`${who}: place needs "item"`);
        else if (!items.has(o.item)) errors.push(`${who}: item ${o.item} is not an item`);
        if (SURFACES.includes(o.target)) break;
        if (!stations.has(stId) || sub === undefined) errors.push(`${who}: place target ${o.target} must be S1-S8 or "station.slot"`);
        else if (!slotOf(o.target)) errors.push(`${who}: ${stId} has no slot ${sub} (its slots: ${listIds(stations.get(stId).slots)})`);
        break;
      case 'press': {
        const ctrl = stations.get(stId)?.controls?.find((c) => c.id === sub);
        if (!stations.has(stId) || sub === undefined) errors.push(`${who}: press target ${o.target} must be "station.control"`);
        else if (!ctrl) errors.push(`${who}: ${stId} has no control ${sub} (its controls: ${listIds(stations.get(stId).controls)})`);
        break;
      }
      case 'talk':
        if (!npcs.has(o.target)) errors.push(`${who}: talk target ${o.target} is not an npc`);
        break;
    }
  };
  bp.objectives.forEach((o) => checkObjective(o, 'objective', false));
  bp.event.replaceRemaining.forEach((o) => checkObjective(o, 'event objective', true));
  if (errors.length) return { errors, warnings, blueprint: bp };

  // ---- static tag flow: do place targets accept the item, given tags set by earlier presses? ----
  const tagFlow = (list, label) => {
    const tags = new Map([...items].map(([id, rec]) => [id, new Set(rec?.tags ?? [])]));
    const loc = new Map(bp.items.map((it) => [it.id, it.anchor]));
    for (const o of list) {
      if (o.verb === 'place') {
        loc.set(o.item, o.target);
        const slot = o.target.includes('.') ? slotOf(o.target) : null;
        if (slot && !fits([...tags.get(o.item)], slot)) {
          errors.push(`${label} ${o.id}: ${o.item} (tags ${[...tags.get(o.item)].join(',')}) does not fit ${o.target} (accepts ${slot.accepts.join(',')})`);
        }
      } else if (o.verb === 'press') {
        const [stId, ctrlId] = o.target.split('.');
        const ctrl = stations.get(stId).controls.find((c) => c.id === ctrlId);
        const first = ctrl.requires?.[0];
        const holder = first && [...loc].find(([, at]) => at === `${stId}.${first}`)?.[0];
        if (ctrl.sets && holder) tags.get(holder).add(ctrl.sets);
      }
    }
  };
  tagFlow(bp.objectives, 'objective');
  if (afterIdx >= 0) tagFlow([...bp.objectives.slice(0, afterIdx + 1), ...bp.event.replaceRemaining], 'event objective');

  // ---- reachability (F2): players can walk from the spawn to every station, item spot and NPC ----
  if (!errors.length) {
    const nav = buildNav(bp, recipes);
    const from = spawnPoint();
    const check = (target, who) => {
      const to = standPoint(nav, target);
      if (!to || !findPath(nav, from, to)) errors.push(`${who} is not reachable from the entrance (blocked by other props)`);
    };
    for (const st of bp.stations) check(st.id, `station ${st.id}`);
    for (const it of bp.items) if (SURFACES.includes(it.anchor)) check(it.anchor, `item ${it.id} at ${it.anchor}`);
    for (const n of bp.npcs) check(n.anchor, `npc ${n.id}`);
  }

  // ---- play it: the full list without the event, then with the event ----
  if (!errors.length) {
    const r1 = playthrough({ ...bp, event: undefined }, catalog, false);
    if (r1) errors.push(`not completable without the event: ${r1}`);
    const r2 = playthrough(bp, catalog, true);
    if (r2) errors.push(`not completable with the event: ${r2}`);
  }
  return { errors, warnings, blueprint: bp };
}

/**
 * Drive a one-player bot through the shift using only legal intents. Returns null when the shift reaches review,
 * otherwise a reason string. The bot frees its hands on a spare surface when the next step needs a different item.
 */
export function playthrough(bp, catalog, withEvent) {
  let now = 1_000_000;
  let state = createRoom(bp, catalog, now);
  const me = 'bot';
  const step = (intent) => {
    const r = applyIntent(state, me, intent, now);
    state = r.state;
    return r.events.find((e) => e.type === 'denied')?.reason ?? null;
  };
  step({ t: 'join', name: 'Validator' });
  const targeted = new Set([...bp.objectives, ...(bp.event?.replaceRemaining ?? [])].map((o) => o.target));
  const spare = [...SURFACES.filter((s) => !targeted.has(s)), ...SURFACES.filter((s) => targeted.has(s))];
  const freeSurface = () => spare.find((s) => !Object.values(state.items).some((it) => it.at === s && !it.holder));
  const holdOnly = (item) => {
    const held = state.players[me].held;
    if (held === item) return null;
    if (held) {
      const spot = freeSurface();
      if (!spot) return `no free surface to set down ${held}`;
      const why = step({ t: 'place', item: held, target: spot });
      if (why) return `setting down ${held}: ${why}`;
    }
    const why = step({ t: 'grab', item });
    return why ? `grab ${item}: ${why}` : null;
  };

  for (let guard = 0; guard < 64; guard++) {
    if (state.phase === 'review') return null;
    // Let the event director run between steps.
    now += 250;
    if (withEvent && state.event.at !== null && !state.event.fired) {
      now = Math.max(now, state.event.at);
      state = tick(state, now).state;
      continue;
    }
    const o = state.objectives[state.cur];
    if (!o) return state.phase === 'review' ? null : 'all objectives done but the shift did not end';
    const before = state.cur;
    const beforeLen = state.objectives.length;
    let why = null;
    if (o.verb === 'grab') why = holdOnly(o.target);
    else if (o.verb === 'place') why = holdOnly(o.item) ?? step({ t: 'place', item: o.item, target: o.target });
    else if (o.verb === 'press') why = step({ t: 'press', target: o.target });
    else if (o.verb === 'talk') why = step({ t: 'talk', npc: o.target });
    if (why) return `objective ${o.id} ("${o.label}"): ${why}`;
    if (state.cur === before && state.objectives.length === beforeLen && state.phase === 'play') {
      return `objective ${o.id} ("${o.label}") did not complete`;
    }
  }
  return 'too many steps';
}
