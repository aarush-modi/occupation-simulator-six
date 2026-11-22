// Scenario generation with Gemini (F1, N1, N2).
// One bounded request per uncached occupation; if the answer fails validation, one retry with the errors appended.
// The whole job (both attempts) must finish inside the budget (default 60 s), otherwise it fails and the host picks a demo.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Blueprint } from '../../frontend/src/shared/schema.js';
import { SHELLS, SHELL_IDS, ANCHORS } from '../../frontend/src/shared/layout.js';
import { checkBlueprint } from '../../frontend/src/shared/validate.js';
import { normalise } from './demos.js';
import { geminiText, MODELS, usageOf } from './geminiClient.js';
import { refusal } from './safety.js';

const logFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '../logs/generation.jsonl');
const anchorsOf = (...kinds) => Object.keys(ANCHORS).filter((id) => kinds.includes(ANCHORS[id].kind));

// ---------- catalog menu ----------

// Rough occupation -> shell hints, used only to trim the menu when the catalog gets large.
const isBoxing = (occupation) => /\b(boxer|boxing|kickboxer|kickboxing|sparring)\b/i.test(occupation);

const SHELL_HINTS = {
  sushi: /\b(sushi|itamae|nigiri|sashimi|omakase|maki)\b/,
  cafe: /barista|cafe|coffee|cook|chef|bak|kitchen|restaurant|bar|food|pizza|butcher|waiter|server|dish/,
  warehouse: /warehouse|picker|pack|ship|logistic|forklift|courier|stock|deliver|mail|post|loading|freight/,
  shop: /shop|store|retail|florist|flower|cashier|pharmac|book|clerk|grocer|tailor|jewel|sales/,
  clinic: /nurse|doctor|clinic|hospital|vet|dent|medic|physio|paramedic|surgeon|therap|care/,
  lab: /lab|scien|chemist|biolog|research|technician|analyst|forensic|pathol/,
  workshop: /mechanic|repair|carpent|weld|plumb|electric|factory|assembl|machin|garage|smith|build|engineer|bee|farm/,
  office: /office|account|clerk|journal|editor|design|developer|program|manager|lawyer|secretar|studio|news|analyst/,
  salon: /salon|barber|hair|stylist|nail|spa|massage|beaut|makeup|tattoo/,
};

export function guessShells(occupation) {
  const o = normalise(occupation);
  if (SHELL_HINTS.sushi.test(o)) return ['sushi'];
  return SHELL_IDS.filter((s) => SHELL_HINTS[s]?.test(o));
}

const compact = (r) => {
  const e = { id: r.id, kind: r.kind, shells: r.shells, tags: r.tags };
  if (r.slots?.length) e.slots = r.slots.map((s) => ({ id: s.id, accepts: s.accepts }));
  if (r.controls?.length) e.controls = r.controls.map((c) => ({ id: c.id, label: c.label, requires: c.requires ?? [], ...(c.sets ? { sets: c.sets } : {}) }));
  return e;
};

/** Recipes offered to the model: everything when the catalog is small, else the guessed shells + generic gen_* props. */
export function menuFor(catalog, occupation, maxAll = 60) {
  if (catalog.length <= maxAll) return catalog;
  const shells = guessShells(occupation);
  const pick = catalog.filter((r) => r.id.startsWith('gen_') || r.shells.some((s) => shells.includes(s)));
  return pick.length >= 6 ? pick : catalog;
}

// ---------- response schema ----------

export function responseSchema(menu, { propEnums = false } = {}) {
  const s = z.toJSONSchema(Blueprint, { io: 'input' });
  delete s.$schema;
  delete s.properties.version;
  // The realism fields (mentor, career) are optional for stored shifts but always written for new ones.
  s.required = [...s.required.filter(key => key !== 'version'), 'venue', 'mentor', 'career'];
  const P = s.properties;
  // Multiplayer roles are hand-authored in demo shifts for now; the model does not write them.
  delete P.roles;
  for (const list of [P.objectives, P.event?.properties?.replaceRemaining]) {
    const props = list?.items?.properties;
    if (props) {
      delete props.role; delete props.after;
      props.skill = { type: 'string', enum: ['none'] }; // no mini-games: every step is a plain action
    }
  }
  s.required = s.required.filter(key => key !== 'roles');
  // Anchor enums are small. The semantic validator checks catalog IDs against the full catalog.
  if (propEnums) {
    const ids = (...kinds) => menu.filter((r) => kinds.includes(r.kind)).map((r) => r.id);
    P.stations.items.properties.prop.enum = ids('station', 'furniture');
    P.items.items.properties.prop.enum = ids('item');
    P.decor.items.properties.prop.enum = ids('decor', 'furniture');
  }
  P.stations.items.properties.anchor.enum = anchorsOf('wall', 'island');
  P.decor.items.properties.anchor.enum = anchorsOf('wall', 'island');
  P.npcs.items.properties.anchor.enum = anchorsOf('spot');
  P.items.items.properties.anchor.description = 'S1-S8, or "<stationId>.<slotId>" of a slot that accepts one of the item tags';
  return strictSchema(s);
}

function strictSchema(node) {
  delete node.default;
  if (node.type === 'object') {
    const required = new Set(node.required);
    for (const [name, property] of Object.entries(node.properties)) {
      strictSchema(property);
      if (!required.has(name)) node.properties[name] = { anyOf: [...(property.anyOf ?? [property]), { type: 'null' }] };
    }
    node.required = Object.keys(node.properties);
    node.additionalProperties = false;
  }
  if (node.items) strictSchema(node.items);
  node.anyOf?.forEach(strictSchema);
  return node;
}

// Null is the wire representation of fields omitted from the existing blueprint.
function omitNullFields(value) {
  if (Array.isArray(value)) return value.map(omitNullFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, field]) => field !== null)
    .map(([key, field]) => [key, omitNullFields(field)]));
}

// ---------- prompt ----------

export function systemPrompt(menu, example) {
  const lines = [
    'You are the scenario director for Workshift, a first-person multiplayer occupation simulator. A player names a job (sometimes with a venue, situation or style) because they are curious whether it could be their career. Turn it into a short, vivid shift that feels like a real day in that job: a specific place, real people, a real task done in its real order, and a reason it matters today.',
    'Make it engaging: open with someone who needs something (a customer, a patient, a deadline, a supervisor), let the work build toward delivering it, and put a believable complication in the middle. Every physical action must stand for a real piece of the job (fetching the right material, setting it in the right equipment, running the machine, handing over the result). Talking is part of the work: taking an order, confirming details, briefing a colleague, reassuring a customer, reporting back. NPCs answer the player out loud and in character, so give them a personality and things worth asking about.',
    'Decide what players do repeatedly and what makes them succeed, then cast NPCs who fit that loop and write the briefing around those rules. Treat any reference to an existing game as a genre cue. Invent the venue, cast, dialogue, and visual identity.',
    'Available mechanics: set game to null for an occupation workflow with a mid-shift complication. Set game.kind to challenge for a timed workflow with a cooperating or competing NPC. Set game.kind to sparring for a first-person arcade sports match with rounds, scoring, and a reactive rival.',
    'Arcade boxing example: a local rival calls you into a five-sided ring, a coach can brief your corner, and a bell starts each round. Pick a venue and mat, points target, round count, round duration, and an opponent from the cast. A pressure rival closes in faster, a counter rival covers after player attacks, and a steady rival uses a regular rhythm. The player scores by landing virtual strikes within reach and can guard when the rival winds up. Use abstract scoring and non-graphic feedback. Leave stations, items, decor and objectives empty and event null for this mode.',
    'Timed challenges use the workflow tasks and event. Set a goal that uses most of the task path and can still be reached on the shortest path. An ally earns a small bonus on every second completed task. A rival gains points while working at open stations, at the configured pace, and wins by reaching the target first. Give players time to walk between stations. Give the partner a job-specific reason to help or compete, such as a coworker rushing the last shipment or a rival cook trying to plate first.',
    'Players use upper-body webcam gestures and their voice. Raising shoulders moves forward, head motion turns, closing a hand or pinching grabs, opening the hand places, an open palm presses, and waving at or speaking to a person talks to them. There are NO mini-games: never ask for timing, aiming, turning a wheel, holding steady or rhythm. Every step is one plain grab, place, press or talk. Sparring uses a virtual strike and a two-open-palm guard. Write instructions only for supported actions. All players share round or shift progress.',
    'Output one JSON object matching the response schema. Use null for unused fields that allow null. Use only prop IDs from the catalog menu below.',
    '',
    'WORKPLACE: one compact 14 m x 11 m work area with fixed anchors. Pick the closest equipment and architecture family using `shell`:',
    ...Object.entries(SHELLS).map(([id, d]) => `- ${id}: ${d}`),
    '- Design a specific venue for the request. Give it a short sign name, enclosure, floor, palette, and lighting. Consider an uncovered garden work area for a nursery, a tiled market stall with an open front for a fishmonger, or a warmly lit timber interior for a small sushi bar. Outdoor sites have low boundary rails, no roof, and no wall-mounted decorations.',
    '- Use native styling when the shell already fits. Only choose concrete where the occupation actually calls for it. Name stations and select decor for their purpose in the venue. Keep aisles open and make the important station easy to find from the entrance.',
    '- For sushi shifts, use the sushi prep counter and sushi service counter. Let the player prep and plate a salmon order. The service counter accepts a plated sushi serving board.',
    '',
    'ANCHORS:',
    '- wall: N1 N2 N3 N4 N5 (back wall), E1 E2 (right wall), W1 W2 (left wall). island: I1 I2 I3 I4 (free-standing). Stations, furniture and decor go here; each anchor holds one thing.',
    '- surface: S1-S8, small item spots on two built-in supply counters by the entrance (S1-S4 left, S5-S8 right). Items start here or inside a station slot. Use a free S anchor as a hand-in / pickup / shipping spot.',
    '- spot: P1 P2 P3, where NPCs stand (one NPC per spot).',
    '',
    'CATALOG MENU (JSON lines). kind station = interactive (slots hold items, controls are pressed); item = carried; furniture/decor = dressing.',
    'An item fits a slot when ANY item tag is in the slot `accepts`. A control with `requires` can only be pressed when those slots of the SAME station hold an item; `sets` adds that tag to the item in the first required slot (e.g. brewed), which later slots may accept.',
    ...menu.map((r) => JSON.stringify(compact(r))),
    '',
    'RULES (the result is machine-checked; a broken shift is thrown away):',
    '- For workflows and timed challenges use 2-5 stations, 2-6 items, 0-5 decor, 2-3 NPCs with a mix of coworkers and people the role serves. Ids are short snake_case and unique across stations, items and npcs. Keep every string short.',
    '- objectives: 6-9 steps (never more than 10) in play order, forming the real task of the job, e.g. take the order -> grab the cup -> seat it under the espresso machine -> pull the shot -> grab the milk jug -> pour the milk into the cup -> serve it.',
    '  The heart of every shift is 2-4 use steps: the hands-on craft of the job done with a tool or ingredient in hand (a barista pours and tamps, a cook seasons and flips, a nurse swabs and checks, a mechanic tightens, a florist trims). Fetching and placing only connects the craft steps; never make a shift that is mostly carrying things around.',
    '  Only stations with slots can receive items (furniture and decor have none); place targets use exactly the slot ids listed in the menu.',
    '  grab: target = item id. place: target = "<stationId>.<slotId>" or a surface anchor, `item` = the item id. press: target = "<stationId>.<controlId>". talk: target = npc id.',
    '  use: the player does the trade action with the item they hold. `item` = the held tool or ingredient (it must be held: grab it first, or it is still in hand from an earlier step). target = "<stationId>.<slotId>" to work on the item sitting in that slot (it must be there by then), or "<stationId>" to work on the station itself (wipe the counter). action = the real verb in one word (pour, steam, tamp, wipe, chop, season, scan, swab, tighten, trim, stir). motion = the one gesture that does it: tilt (pour, drizzle, sprinkle, water, season), scrub (wipe, stir, mix, sand, brush, polish, sweep), strike (tamp, chop, hammer, knead, stamp, staple), apply (scan, swab, check, inject, spray, measure). sets = a tag the item in the slot gains (e.g. "latte"), only when a later place needs it, else null.',
    '  A player holds ONE item at a time, so every place is directly preceded by a grab of that same item. Every place target must be empty and must accept the item tags at that moment (tags set by earlier presses count). A press needs every `requires` slot of that station filled.',
    '  labels <= 6 words, imperative, in the job\'s own words ("Seat the portafilter", not "Place item"). skill is always "none". Add `say` (<= 12 words, a natural spoken reaction) to 2-3 objectives and set it to null on the rest.',
    '  Include 1-2 talk objectives where real communication happens in this job (take or confirm the order, check in with the lead, explain the result to the customer), spaced through the shift, not only at the start.',
    '- event: an occupation-relevant complication, fired `delaySec` (2-5) seconds after objective `after`. replaceRemaining (2-6 objectives, NEW unique ids) replaces EVERY objective after `after` and must finish the job.',
    '  A closed station rejects everything, including taking items OUT of it: an item sitting in the closed station is lost. replaceRemaining must never use the closed station or an item inside it.',
    '  Proven pattern: put two stations of the same prop in the room (main + backup) and a spare item on a surface. after = the objective that places the item into the main station; close = the main station; replaceRemaining = grab the spare item -> place it in the backup -> press backup control -> grab it -> deliver it.',
    '  An event with a null `close` is also fine (e.g. a customer changes the order or the delivery spot).',
    '- npcs: realistic co-workers / customers with a name, a role and a distinct personality. lines.intro is what they say when the player talks to them at the start, spoken and specific (<= 20 words, e.g. "Morning! Table four wants two flat whites, extra hot. Can you grab the milk?"), lines.done congratulates in character (<= 10 words).',
    '- occupation: just the short job name. briefing: 1-2 short sentences, second person. title: <= 5 words. facts: 2-3 true, interesting facts about the real job.',
    '',
    'REALISM (the player is deciding whether this could be their career, so show the real job honestly):',
    '- Make the task path the real sequence a worker follows, with the real names of tools, materials and checks. Cast people the job actually serves and works beside.',
    '- tip on EVERY objective, including replaceRemaining: one real technique, standard or reason a professional uses for that step (<= 16 words), e.g. "Tamp level and firm so the water flows evenly." Never give instructions that would be dangerous to try without training.',
    '- real on EVERY objective, including replaceRemaining: what this simulated gesture stands for in the real job and why it matters to the work (<= 18 words), in second person, e.g. "Seating the portafilter locks the puck in, so pressure builds evenly for a balanced shot." Describe the real work, not the webcam gesture.',
    '- mentor: id of the experienced coworker who coaches (says each tip). Not a customer.',
    '- npcs[].lines.ambient: 1-3 short call-outs a coworker really says on shift, in the trade jargon (<= 6 words, e.g. "Behind!", "Two flat whites on bar"). Empty for customers.',
    '- order (workflow and challenge shifts; null for sparring): the person waiting on the finished work. npc = that NPC, text = exactly what they asked for in real terms (<= 10 words), patienceSec = how long they wait happily in this game (60-240), waiting = what they say once the wait runs long (<= 10 words). The last objectives deliver it.',
    '- career: how the real job feels, honestly, including the hard parts. dayInLife (<= 40 words, a typical real shift beyond this scene), schedule (<= 12 words: typical hours, shifts, weekends), physical / people / pressure each { level 1-5, note <= 12 words }, loves (2-3 things people in the job value, <= 10 words each), hard (2-3 real downsides, <= 10 words each), start (<= 25 words: common training, certification or entry route). No pay figures.',
  ];
  if (example) lines.push('', 'EXAMPLE OUTPUT (format reference only, design your own for the requested occupation):', JSON.stringify(example));
  return lines.join('\n');
}

// ---------- generator ----------

/**
 * @param {object} o
 * @param {Array} o.catalog
 * @param {string} [o.apiKey]
 * @param {string} [o.model]
 * @param {number} [o.budgetMs]
 * @param {string} [o.thinking] Gemini thinking level (low, medium, high)
 * @param {typeof fetch} [o.fetcher]
 * @param {object} [o.example] blueprint used as a format example in the prompt
 * @param {(req:{system:string, user:string, schema:object, signal:AbortSignal}) => Promise<{text:string, usage?:object}>} [o.callModel]
 */
export function createGenerator({
  catalog,
  apiKey = process.env.GEMINI_API_KEY,
  model = process.env.GEMINI_MODEL || MODELS.scenario,
  budgetMs = Number(process.env.GEMINI_BUDGET_MS) || 60000, // Neon takes ~40 s for a full shift
  thinking = process.env.GEMINI_THINKING_LEVEL || 'low',
  example = null, callModel = null, fetcher = fetch, log = console,
  screen = null, // async (request) => { appropriate, reason, suggestion }, run alongside generation
} = {}) {
  const cache = new Map(); // normalised occupation -> blueprint
  const inflight = new Map();

  const call = callModel ?? (({ system, user, schema, signal }) =>
    geminiText({ apiKey, model, system, input: user, schema, thinking, signal, fetcher }));

  async function run(occupation, previousTitle) {
    const t0 = Date.now();
    const menu = menuFor(catalog, occupation);
    const system = systemPrompt(menu, example);
    const schema = responseSchema(menu);
    const [shell] = guessShells(occupation);
    if (shell === 'sushi') schema.properties.shell.enum = ['sushi'];
    if (isBoxing(occupation)) {
      const sparring = schema.properties.game.anyOf.find(option => option.properties?.kind?.const === 'sparring');
      sparring.properties.arena.properties.sides = { type: 'integer', const: 5 };
      schema.properties.game = sparring;
    }
    const attempts = [];
    const request = `Design a scenario for this request: ${JSON.stringify(occupation)}${previousTitle ? `\nThe last scenario was titled ${JSON.stringify(previousTitle)}. Give this one a different venue, cast, or gameplay setup.` : ''}`;
    let user = request;
    let lastErrors = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      const left = budgetMs - (Date.now() - t0);
      if (left < 800) {
        lastErrors = [...lastErrors, `out of time (${budgetMs} ms budget)`];
        break;
      }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), left);
      const ta = Date.now();
      let text;
      let usage;
      try {
        ({ text, usage } = await Promise.race([
          call({ system, user, schema, signal: ac.signal }),
          new Promise((_, rej) => ac.signal.addEventListener('abort', () => rej(new Error(`timed out after ${budgetMs} ms`)))),
        ]));
      } catch (err) {
        attempts.push({ attempt, ms: Date.now() - ta, error: String(err?.message ?? err).slice(0, 300) });
        lastErrors = [String(err?.message ?? err)];
        clearTimeout(timer);
        break; // network / quota / timeout: no point retrying inside the budget
      }
      clearTimeout(timer);
      let raw;
      let errors;
      let warnings = [];
      let blueprint = null;
      try {
        raw = omitNullFields(JSON.parse(text));
        ({ errors, warnings, blueprint } = checkBlueprint(raw, catalog));
        if (shell === 'sushi' && raw.shell !== 'sushi') errors.push('Use the sushi bar shell for this shift.');
        if (isBoxing(occupation) && (raw.game?.kind !== 'sparring' || raw.game.arena?.sides !== 5)) errors.push('Boxing uses the sparring game in a five-sided arena.');
      } catch (err) {
        errors = [`response is not JSON: ${err.message}`];
      }
      attempts.push({ attempt, ms: Date.now() - ta, usage: usageOf(usage), valid: errors.length === 0, errors: errors.slice(0, 8), warnings: warnings.slice(0, 5) });
      if (!errors.length) return finish({ ok: true, blueprint, occupation, t0, attempts, menu });
      lastErrors = errors;
      user =
        `${request}\n\nYour previous answer was:\n${text}\n\n` +
        `It failed validation with these errors:\n- ${errors.slice(0, 12).join('\n- ')}\n\nReturn a corrected complete JSON object.`;
    }
    return finish({ ok: false, error: lastErrors.slice(0, 6).join('; '), occupation, t0, attempts, menu });
  }

  function finish({ ok, blueprint, error, occupation, t0, attempts, menu }) {
    const meta = {
      at: new Date().toISOString(),
      occupation,
      model,
      ok,
      ms: Date.now() - t0,
      cacheHit: false,
      firstPassValid: attempts[0]?.valid === true,
      attempts,
      menuSize: menu.length,
      tokens: sumUsage(attempts),
    };
    record(meta);
    return ok ? { ok, blueprint, meta } : { ok, error, meta };
  }

  function record(meta) {
    log.log(`[gemini] ${JSON.stringify({ ...meta, attempts: meta.attempts.map(({ errors, warnings, ...a }) => ({ ...a, errors: errors?.length ?? 0 })) })}`);
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, JSON.stringify(meta) + '\n');
    } catch {}
  }

  /** Generate a validated blueprint. Fresh rooms can request a new take on a previous prompt. */
  async function generate(occupation, { fresh = false } = {}) {
    const key = normalise(occupation);
    const previous = cache.get(key);
    if (!fresh && previous) {
      const meta = { at: new Date().toISOString(), occupation, model, ok: true, ms: 0, cacheHit: true };
      log.log(`[gemini] ${JSON.stringify(meta)}`);
      return { ok: true, blueprint: previous, meta };
    }
    if (!fresh && inflight.has(key)) return inflight.get(key);
    // The appropriateness check runs alongside generation, so it adds no wait to a fine request.
    const verdict = screen ? Promise.resolve().then(() => screen(occupation)).catch(() => ({ appropriate: true })) : null;
    const p = run(occupation, previous?.title)
      .catch((err) => ({ ok: false, error: String(err?.message ?? err), meta: { occupation, model } }))
      .then(async (r) => {
        const v = await verdict;
        if (v && !v.appropriate) {
          log.log(`[gemini] ${JSON.stringify({ occupation, refused: v.reason })}`);
          return { ok: false, error: refusal(v), refused: true, meta: { occupation, model } };
        }
        return r;
      })
      .then((r) => {
        if (!fresh) inflight.delete(key);
        if (r.ok) cache.set(key, r.blueprint);
        return r;
      });
    if (!fresh) inflight.set(key, p);
    return p;
  }

  return { generate, cache, model };
}

const sumUsage = (attempts) =>
  attempts.reduce(
    (acc, a) => {
      if (a.usage) for (const k of Object.keys(acc)) acc[k] += a.usage[k] ?? 0;
      return acc;
    },
    { prompt: 0, output: 0, thoughts: 0, total: 0 },
  );
