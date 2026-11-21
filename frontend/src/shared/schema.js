// Zod contracts shared by frontend and backend. See CONTRACTS.md next to this file.
import { z } from 'zod';
import { MATERIAL_KEYS } from './materialKeys.js';
import { SHELL_IDS, ANCHORS, LIMITS } from './layout.js';

const v3 = z.tuple([z.number(), z.number(), z.number()]);
const mat = z.enum(MATERIAL_KEYS);
const base = { p: v3.optional(), r: v3.optional(), m: mat, name: z.string().optional() };

// One recipe part. Units are meters. Rotations are radians (Euler XYZ). Positions are in the recipe's local frame:
// origin at floor centre of the bounding box, +Y up, +Z faces the player (front).
export const Part = z.discriminatedUnion('t', [
  z.object({ t: z.literal('box'), s: v3, round: z.number().min(0).max(0.2).optional(), ...base }),
  z.object({ t: z.literal('cyl'), rt: z.number().positive(), rb: z.number().min(0).optional(), h: z.number().positive(), seg: z.number().int().min(3).max(64).optional(), ...base }),
  z.object({ t: z.literal('sph'), rad: z.number().positive(), sy: z.number().positive().optional(), ...base }),
  z.object({ t: z.literal('cone'), rad: z.number().positive(), h: z.number().positive(), ...base }),
  z.object({ t: z.literal('torus'), R: z.number().positive(), tube: z.number().positive(), arc: z.number().positive().optional(), ...base }),
  z.object({ t: z.literal('capsule'), rad: z.number().positive(), len: z.number().min(0), ...base }),
  z.object({ t: z.literal('lathe'), pts: z.array(z.tuple([z.number().min(0), z.number()])).min(2).max(40), seg: z.number().int().optional(), ...base }),
  z.object({ t: z.literal('tube'), pts: z.array(v3).min(2).max(24), rad: z.number().positive(), ...base }),
  // Repeat a sub-part n times, offset by `step` each time (grates, shelves, ladders, books, keys).
  z.object({ t: z.literal('repeat'), n: z.number().int().min(1).max(60), step: v3, part: z.lazy(() => Part), p: v3.optional(), r: v3.optional() }),
]);

export const Recipe = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string(),
  kind: z.enum(['station', 'item', 'furniture', 'decor']),
  shells: z.array(z.enum(SHELL_IDS)).min(1),
  tags: z.array(z.string()).min(1),
  size: v3, // [w, h, d] bounding box
  // Places where an item can be put: on top of a station, inside a container, under a nozzle.
  slots: z.array(z.object({ id: z.string(), pos: v3, accepts: z.array(z.string()).min(1) })).default([]),
  // Pressable controls. `requires` lists slot ids that must be filled first (F4 prerequisite check).
  // `sets` is a state tag applied to the item in the first required slot when pressed (e.g. "brewed").
  controls: z.array(z.object({ id: z.string(), pos: v3, label: z.string(), requires: z.array(z.string()).default([]), sets: z.string().optional() })).default([]),
  parts: z.array(Part).min(1).max(120),
});

const anchor = z.enum(Object.keys(ANCHORS));
const npcRef = z.string();

export const Objective = z.object({
  id: z.string(),
  verb: z.enum(['grab', 'place', 'press', 'talk']),
  // grab: item id. place: "<stationId>.<slotId>" or a surface anchor S1..S8. press: "<stationId>.<controlId>". talk: npc id.
  target: z.string(),
  item: z.string().optional(), // place: the item being placed
  label: z.string(),
  skill: z.enum(['none', 'timing', 'steady', 'hold']).default('none'),
  say: z.object({ npc: npcRef, text: z.string() }).optional(), // NPC line when this objective is completed
});

const GeneratedGame = z.union([
  z.object({
    kind: z.literal('sparring'),
    arena: z.object({
      sides: z.int().min(4).max(8),
      radius: z.number().min(2.8).max(4.3),
      mat: z.enum(['blue', 'red', 'charcoal', 'sand']),
    }),
    opponent: npcRef,
    style: z.enum(['pressure', 'counter', 'steady']),
    rounds: z.int().min(1).max(3),
    roundSeconds: z.int().min(15).max(75),
    pointsToWin: z.int().min(3).max(10),
  }),
  z.object({
    kind: z.literal('challenge'),
    partner: npcRef,
    role: z.enum(['ally', 'rival']),
    seconds: z.int().min(25).max(180),
    pointsPerTask: z.int().min(1).max(8),
    goal: z.int().min(2).max(60),
    rivalEverySeconds: z.int().min(4).max(30),
  }),
]);

export const Blueprint = z.object({
  version: z.literal(1).default(1),
  occupation: z.string(),
  title: z.string(),
  briefing: z.string(),
  shell: z.enum(SHELL_IDS),
  venue: z.object({
    name: z.string().trim().min(1).max(40),
    enclosure: z.enum(['interior', 'open_front', 'outdoor']),
    floor: z.enum(['native', 'timber', 'tile', 'rubber', 'concrete', 'gravel', 'grass']),
    palette: z.enum(['native', 'warm', 'coastal', 'forest', 'industrial', 'clinical', 'bold']),
    lighting: z.enum(['native', 'daylight', 'warm', 'task', 'dusk']),
  }).optional(),
  game: GeneratedGame.optional(),
  stations: z.array(z.object({ id: z.string(), prop: z.string(), anchor, label: z.string() })).max(9),
  items: z.array(z.object({ id: z.string(), prop: z.string(), anchor: z.string(), label: z.string() })).max(12),
  decor: z.array(z.object({ prop: z.string(), anchor })).max(8).default([]),
  npcs: z.array(z.object({
    id: z.string(), name: z.string(), role: z.string(), anchor,
    outfit: z.enum(['scrubs', 'labCoat', 'apron', 'coverall', 'suit', 'casual', 'hivis']).default('casual'),
    lines: z.object({ intro: z.string(), done: z.string() }),
  })).min(1).max(3),
  objectives: z.array(Objective).max(10),
  event: z.object({
    after: z.string(), // objective id
    delaySec: z.number().min(0).max(20).default(3),
    announce: z.object({ npc: npcRef, text: z.string() }),
    close: z.string().optional(), // station id that becomes unusable
    replaceRemaining: z.array(Objective).min(1).max(6), // new objectives that replace everything after `after`
  }).optional(),
  facts: z.array(z.string()).min(2).max(6),
});

export { LIMITS };
