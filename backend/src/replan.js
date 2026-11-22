// Mid-shift re-planning: when a conversation changes the work (a customer changes their order, the lead reassigns a
// task), the smaller Gemini model rewrites the rest of the shift from the live state. A plan is only applied after a
// bot plays it to the end from that state, so a changed shift can always still be finished.
import { replanRemaining } from '../../frontend/src/shared/sim.js';
import { driveBot } from '../../frontend/src/shared/validate.js';
import { geminiText, MODELS } from './geminiClient.js';

const instructions = [
  'You re-plan the rest of a shift in a first-person job simulator after something changed in a conversation.',
  'The change is an ordinary part of a normal working day; keep the work realistic and calm, the way the job really goes, with no emergencies or drama added.',
  'Write the remaining steps, in play order, so the shift now delivers what was asked, using only the stations, slots, controls, items and people listed. Keep what still makes sense from the old remaining steps.',
  'Verbs: grab (target = item id), place (target = "station.slot" or a free surface S1-S8, item = item id; it must be held, so grab it first), press (target = "station.control"; every slot it requires must hold an item), use (the trade action with the held item: item = held item, target = "station.slot" with an item in it or "station", action = one real verb, motion = tilt | scrub | strike | apply, sets = tag the item in the slot gains or null), talk (target = npc id).',
  'An item fits a slot when one of its tags is in the slot accepts. Closed stations cannot be used. The player holds one item at a time; grabbing another item puts the held one back automatically, so never add steps that only set something down or put a tool away. 2-7 steps, short imperative labels in the job\'s own words, skill always "none", new unique ids.',
  'Also write `tip` (one real technique for the step, under 14 words) and `real` (what the step stands for in the real job, under 16 words) for each step.',
].join(' ');

const stepSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'verb', 'target', 'item', 'action', 'motion', 'sets', 'label', 'skill', 'tip', 'real'],
  properties: {
    id: { type: 'string' }, verb: { type: 'string', enum: ['grab', 'place', 'press', 'use', 'talk'] }, target: { type: 'string' },
    item: { type: ['string', 'null'] }, action: { type: ['string', 'null'] },
    motion: { anyOf: [{ type: 'string', enum: ['tilt', 'scrub', 'strike', 'apply'] }, { type: 'null' }] },
    sets: { type: ['string', 'null'] }, label: { type: 'string' }, skill: { type: 'string', enum: ['none'] },
    tip: { type: 'string' }, real: { type: 'string' },
  },
};
const planSchema = { type: 'object', additionalProperties: false, required: ['steps'], properties: { steps: { type: 'array', items: stepSchema } } };

/** What the model can work with: the room as it is right now. */
export function replanContext({ blueprint, catalog, state, playerId, change }) {
  const recipes = new Map(catalog.map((r) => [r.id, r]));
  const done = new Set(state.done);
  return {
    occupation: blueprint.occupation,
    change,
    done_steps: state.objectives.filter((o) => done.has(o.id)).map((o) => o.label),
    old_remaining_steps: state.objectives.filter((o) => !done.has(o.id)),
    used_ids: state.objectives.map((o) => o.id),
    stations: blueprint.stations.filter((s) => !state.closed.includes(s.id)).map((s) => {
      const r = recipes.get(s.prop);
      return {
        id: s.id, label: s.label,
        slots: (r?.slots ?? []).map((x) => ({ id: x.id, accepts: x.accepts })),
        controls: (r?.controls ?? []).map((c) => ({ id: c.id, label: c.label, requires: c.requires ?? [], sets: c.sets ?? null })),
      };
    }),
    items: Object.entries(state.items).map(([id, it]) => ({
      id, label: blueprint.items.find((x) => x.id === id)?.label ?? id, tags: it.tags,
      where: it.holder ? (it.holder === playerId ? 'in the player\'s hand' : 'held by a teammate') : it.at ?? 'nowhere',
    })),
    free_surfaces: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'].filter((sp) => !Object.values(state.items).some((it) => it.at === sp && !it.holder)),
    people: blueprint.npcs.map((n) => ({ id: n.id, name: n.name, role: n.role })),
  };
}

/** Drop nulls and give `use` steps a gesture, so the steps match the game schema. */
export function tidySteps(steps, usedIds) {
  const seen = new Set(usedIds);
  return steps.map((raw, i) => {
    const o = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null && v !== ''));
    let id = String(o.id || `r${i + 1}`).replace(/[^a-z0-9_]/gi, '_');
    while (seen.has(id)) id = `${id}_x`;
    seen.add(id);
    if (o.verb === 'use') { o.motion ??= 'apply'; o.action ??= 'use'; }
    if (o.verb !== 'place' && o.verb !== 'use') delete o.item;
    if (o.verb !== 'use') { delete o.action; delete o.motion; delete o.sets; }
    return { ...o, id, skill: 'none', label: String(o.label).slice(0, 48) };
  });
}

/** Check a plan by playing it from the live state. Returns { state, events } to apply, or { error }. */
export function tryPlan(state, steps, playerId, now = Date.now()) {
  if (!steps.length) return { error: 'the plan has no steps' };
  const applied = replanRemaining(state, steps, now);
  if (applied.error) return { error: applied.error };
  const why = driveBot(applied.state, playerId, { withEvent: false, now });
  return why ? { error: why } : applied;
}

/**
 * Returns `async ({ blueprint, catalog, state, playerId, change }) => steps | null` (null when no valid plan was
 * found in two tries), or null without a key.
 */
export function createReplanner({ apiKey, model = MODELS.npc, fetcher = fetch, timeoutMs = 12000 } = {}) {
  if (!apiKey) return null;
  return async ({ blueprint, catalog, state, playerId, change }) => {
    const context = replanContext({ blueprint, catalog, state, playerId, change });
    let feedback = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const { text } = await geminiText({
        apiKey, model, fetcher, system: instructions, schema: planSchema, thinking: 'low', maxTokens: 3000,
        input: JSON.stringify(feedback ? { ...context, previous_plan_failed_because: feedback } : context),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const steps = tidySteps(JSON.parse(text).steps ?? [], context.used_ids);
      const check = tryPlan(state, steps, playerId);
      if (!check.error) return steps;
      feedback = check.error.slice(0, 300);
    }
    return null;
  };
}
