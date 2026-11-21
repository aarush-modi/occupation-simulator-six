// Scenario generation with Gemini (F1, N1, N2).
// One bounded request per uncached occupation; if the answer fails validation, one retry with the errors appended.
// The whole job (both attempts) must finish inside the budget (default 8 s), otherwise it fails and the host picks a demo.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { GoogleGenAI } from '@google/genai';
import { Blueprint } from '../../frontend/src/shared/schema.js';
import { SHELLS, SHELL_IDS, ANCHORS } from '../../frontend/src/shared/layout.js';
import { checkBlueprint } from '../../frontend/src/shared/validate.js';
import { normalise } from './demos.js';

const logFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '../logs/generation.jsonl');
const anchorsOf = (...kinds) => Object.keys(ANCHORS).filter((id) => kinds.includes(ANCHORS[id].kind));

// ---------- catalog menu ----------

// Rough occupation -> shell hints, used only to trim the menu when the catalog gets large.
const SHELL_HINTS = {
  cafe: /barista|cafe|coffee|cook|chef|bak|kitchen|restaurant|bar|food|pizza|sushi|butcher|waiter|server|dish/,
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
  s.required = [...new Set([...(s.required ?? []), 'decor'])].filter((k) => k !== 'version');
  const P = s.properties;
  // Gemini rejects schemas whose constraint automaton gets too large ("too many states"), so keep it lean:
  // anchor enums are small and worth it; prop-id enums over a large catalog are not (validation catches bad ids).
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
  const strip = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const k of ['default', 'minItems', 'maxItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) delete node[k];
    for (const v of Object.values(node)) if (v && typeof v === 'object') strip(v);
  };
  strip(s);
  // Array caps are cheap for the constraint engine and the model otherwise overshoots them.
  P.objectives.maxItems = 10;
  P.event.properties.replaceRemaining.maxItems = 6;
  return s;
}

// ---------- prompt ----------

export function systemPrompt(menu, example) {
  const lines = [
    'You design one short, playable first-person work shift for "Workshift", a co-op 3D job simulator.',
    'One or two players act out a REPRESENTATIVE task of the occupation with body motion. Engine verbs: grab, place, press, talk (walking is free).',
    'Output ONE JSON object matching the response schema. Use ONLY prop ids from the catalog menu below.',
    '',
    'ROOM: one indoor room, 14 m x 11 m, fixed anchors. Pick the best `shell`:',
    ...Object.entries(SHELLS).map(([id, d]) => `- ${id}: ${d}`),
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
    '- 2-5 stations, 2-6 items, 0-5 decor, 1-2 npcs. Ids are short snake_case and unique across stations, items and npcs. Keep every string short.',
    '- objectives: 5-8 steps (never more than 10) in play order, forming the real task of the job, e.g. grab cup -> place cup in espresso.cup -> press espresso.brew -> grab cup -> place cup in pickup.pickup.',
    '  Only stations with slots can receive items (furniture and decor have none); place targets use exactly the slot ids listed in the menu.',
    '  grab: target = item id. place: target = "<stationId>.<slotId>" or a surface anchor, `item` = the item id. press: target = "<stationId>.<controlId>". talk: target = npc id.',
    '  A player holds ONE item at a time, so every place is directly preceded by a grab of that same item. Every place target must be empty and must accept the item tags at that moment (tags set by earlier presses count). A press needs every `requires` slot of that station filled.',
    '  labels <= 6 words, imperative ("Seat the cup"). skill: "timing" for rhythmic presses, "steady" for careful placing, "hold" for sustained presses, else "none". Add `say` (<= 10 words) to 2-3 objectives only.',
    '- event: an occupation-relevant complication, fired `delaySec` (2-5) seconds after objective `after`. replaceRemaining (2-6 objectives, NEW unique ids) replaces EVERY objective after `after` and must finish the job.',
    '  A closed station rejects everything, including taking items OUT of it: an item sitting in the closed station is lost. replaceRemaining must never use the closed station or an item inside it.',
    '  Proven pattern: put two stations of the same prop in the room (main + backup) and a spare item on a surface. after = the objective that places the item into the main station; close = the main station; replaceRemaining = grab the spare item -> place it in the backup -> press backup control -> grab it -> deliver it.',
    '  An event without `close` is also fine (e.g. a customer changes the order or the delivery spot).',
    '- npcs: realistic co-workers / customers. lines.intro briefs the task (<= 16 words), lines.done congratulates (<= 8 words).',
    '- briefing: 1-2 short sentences, second person. title: <= 5 words. facts: 2-3 true, interesting facts about the real job.',
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
 * @param {object} [o.example] blueprint used as a format example in the prompt
 * @param {(req:{system:string, user:string, schema:object, signal:AbortSignal}) => Promise<{text:string, usage?:object}>} [o.callModel]
 */
export function createGenerator({ catalog, apiKey = process.env.GEMINI_API_KEY, model = process.env.GEMINI_MODEL || 'gemini-3.5-flash', budgetMs = Number(process.env.GEMINI_BUDGET_MS) || 8000, example = null, callModel = null, log = console } = {}) {
  const cache = new Map(); // normalised occupation -> blueprint
  const inflight = new Map();
  // MINIMAL thinking keeps latency down; some models reject it, then we drop thinkingConfig for that model.
  const thinking = process.env.GEMINI_THINKING || 'MINIMAL';
  const noThinking = new Set();
  let ai = null;

  const call =
    callModel ??
    (async ({ system, user, schema, signal }) => {
      if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
      ai ??= new GoogleGenAI({ apiKey });
      const request = (withThinking) =>
        ai.models.generateContent({
          model,
          contents: [{ role: 'user', parts: [{ text: user }] }],
          config: {
            systemInstruction: system,
            responseMimeType: 'application/json',
            responseJsonSchema: schema,
            temperature: 0.7,
            ...(withThinking ? { thinkingConfig: { thinkingLevel: thinking } } : {}),
            abortSignal: signal,
          },
        });
      const useThinking = thinking && thinking !== 'none' && !noThinking.has(model);
      let res;
      try {
        res = await request(useThinking);
      } catch (err) {
        if (!useThinking || !/thinking/i.test(String(err?.message))) throw err;
        noThinking.add(model);
        res = await request(false);
      }
      return { text: res.text, usage: res.usageMetadata };
    });

  async function run(occupation) {
    const t0 = Date.now();
    const menu = menuFor(catalog, occupation);
    const system = systemPrompt(menu, example);
    const schema = responseSchema(menu);
    const attempts = [];
    let user = `Occupation: ${occupation}`;
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
        raw = JSON.parse(text);
        ({ errors, warnings, blueprint } = checkBlueprint(raw, catalog));
      } catch (err) {
        errors = [`response is not JSON: ${err.message}`];
      }
      attempts.push({ attempt, ms: Date.now() - ta, usage: usageOf(usage), valid: errors.length === 0, errors: errors.slice(0, 8), warnings: warnings.slice(0, 5) });
      if (!errors.length) return finish({ ok: true, blueprint, occupation, t0, attempts, menu });
      lastErrors = errors;
      user =
        `Occupation: ${occupation}\n\nYour previous answer was:\n${text}\n\n` +
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

  /** Generate (or fetch from cache) a validated blueprint for an occupation. Never throws. */
  async function generate(occupation) {
    const key = normalise(occupation);
    if (cache.has(key)) {
      const meta = { at: new Date().toISOString(), occupation, model, ok: true, ms: 0, cacheHit: true };
      log.log(`[gemini] ${JSON.stringify(meta)}`);
      return { ok: true, blueprint: cache.get(key), meta };
    }
    if (inflight.has(key)) return inflight.get(key);
    const p = run(occupation)
      .catch((err) => ({ ok: false, error: String(err?.message ?? err), meta: { occupation, model } }))
      .then((r) => {
        inflight.delete(key);
        if (r.ok) cache.set(key, r.blueprint);
        return r;
      });
    inflight.set(key, p);
    return p;
  }

  return { generate, cache, model };
}

const usageOf = (u) =>
  u ? { prompt: u.promptTokenCount ?? 0, output: u.candidatesTokenCount ?? 0, thoughts: u.thoughtsTokenCount ?? 0, total: u.totalTokenCount ?? 0 } : null;

const sumUsage = (attempts) =>
  attempts.reduce(
    (acc, a) => {
      if (a.usage) for (const k of Object.keys(acc)) acc[k] += a.usage[k] ?? 0;
      return acc;
    },
    { prompt: 0, output: 0, thoughts: 0, total: 0 },
  );
