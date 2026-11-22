// Pure world math for a blueprint: where every station, slot, control, item and NPC is in world space,
// and which things the local player can interact with right now. No React, no three.
import { ANCHORS, ROOM } from '../shared/layout.js';
import { playerStep } from '../shared/sim.js';
import { CATALOG } from '../shared/catalog/catalog.generated.js';

import { backendUrl, BACKEND } from './config.js';

export { backendUrl, BACKEND };
export const WS_BASE = BACKEND.replace(/^http/, 'ws');

export const RECIPES = Object.fromEntries(CATALOG.map((r) => [r.id, r]));

// Placeholder so a blueprint that names a recipe the catalog lacks still renders and stays playable.
const PLACEHOLDER = {
  station: { id: '_station', name: 'Station', kind: 'station', shells: ['cafe'], tags: ['station'], size: [1.4, 1, 0.8], slots: [], controls: [], parts: [{ t: 'box', s: [1.4, 0.92, 0.8], p: [0, 0.46, 0], m: 'plasticGrey', round: 0.03 }] },
  item: { id: '_item', name: 'Item', kind: 'item', shells: ['cafe'], tags: ['item'], size: [0.2, 0.2, 0.2], slots: [], controls: [], parts: [{ t: 'box', s: [0.2, 0.2, 0.2], p: [0, 0.1, 0], m: 'cardboard', round: 0.02 }] },
};

export function recipeOf(id, kind = 'station') {
  return RECIPES[id] ?? PLACEHOLDER[kind === 'item' ? 'item' : 'station'];
}

export function anchorFrame(anchorId) {
  const a = ANCHORS[anchorId];
  if (!a) return { pos: [0, 0, 0], rotY: 0 };
  return { pos: [...a.pos], rotY: a.rotY ?? 0 };
}

// three.js Y rotation of a local point, then translate.
export function toWorld(frame, local) {
  const c = Math.cos(frame.rotY), s = Math.sin(frame.rotY);
  const [x, y, z] = local;
  return [frame.pos[0] + x * c + z * s, frame.pos[1] + y, frame.pos[2] - x * s + z * c];
}

export function splitTarget(target) {
  const i = typeof target === 'string' ? target.indexOf('.') : -1;
  return i < 0 ? [target, null] : [target.slice(0, i), target.slice(i + 1)];
}

// Static lookups derived once per blueprint.
export function indexBlueprint(bp) {
  const stations = {};
  for (const st of bp.stations) {
    const recipe = recipeOf(st.prop, 'station');
    stations[st.id] = { ...st, recipe, frame: anchorFrame(st.anchor) };
  }
  const items = {};
  for (const it of bp.items) items[it.id] = { ...it, recipe: recipeOf(it.prop, 'item') };
  const npcs = {};
  for (const n of bp.npcs) npcs[n.id] = { ...n, frame: anchorFrame(n.anchor) };
  return { bp, stations, items, npcs };
}

// World frame where an item rests when it sits at `at` (surface anchor or "station.slot").
export function restFrame(idx, at) {
  if (!at) return null;
  const [stId, slotId] = splitTarget(at);
  if (slotId == null) return ANCHORS[stId] ? anchorFrame(stId) : null;
  const st = idx.stations[stId];
  const slot = st?.recipe.slots.find((s) => s.id === slotId);
  if (!slot) return null;
  return { pos: toWorld(st.frame, slot.pos), rotY: st.frame.rotY };
}

export function controlPos(idx, target) {
  const [stId, cId] = splitTarget(target);
  const st = idx.stations[stId];
  const c = st?.recipe.controls.find((x) => x.id === cId);
  return c ? toWorld(st.frame, c.pos) : null;
}

export function npcHead(idx, id, people) {
  const n = idx.npcs[id];
  if (people?.[id]) return [people[id].pos[0], 1.55, people[id].pos[2]];
  return n ? [n.frame.pos[0], 1.55, n.frame.pos[2]] : null;
}

export function itemTags(idx, state, id) {
  return [...new Set([...(idx.items[id]?.recipe.tags ?? []), ...(state.items[id]?.tags ?? [])])];
}

function occupied(state, at) {
  for (const it of Object.values(state.items)) if (it.at === at && !it.holder) return true;
  return false;
}

const SURFACES = Object.keys(ANCHORS).filter((id) => ANCHORS[id].kind === 'surface');

// Gestures (webcam) that trigger each interaction kind.
export const KIND_GESTURES = {
  grab: ['pinch', 'fist'],
  place: ['unpinch', 'pushDown', 'release'],
  handoff: ['unpinch', 'pushDown', 'release'],
  press: ['palmPush', 'pinch'],
  talk: ['wave'],
};

// A trade action (use) is one natural gesture chosen by its motion, never a mini-game.
export const MOTION_GESTURES = {
  tilt: ['tilt', 'palmPush'],
  scrub: ['wave', 'rub', 'palmPush'],
  strike: ['strike', 'pushDown', 'fist'],
  apply: ['palmPush', 'pinch'],
};
const MOTION_HINT = {
  tilt: 'Tilt your hand',
  scrub: 'Move your hand side to side',
  strike: 'Bring your fist down',
  apply: 'Push your palm forward',
};

/** Gestures that act on an interactable. */
export function gesturesFor(it) {
  return it?.kind === 'use' ? MOTION_GESTURES[it.motion] ?? MOTION_GESTURES.apply : KIND_GESTURES[it?.kind] ?? [];
}

/** One short line saying how to do it. */
export function gestureHint(it) {
  if (it?.kind === 'use') return `${MOTION_HINT[it.motion] ?? MOTION_HINT.apply} to ${it.action ?? 'use it'}`;
  return null;
}

/**
 * Everything the local player could interact with given the authoritative state. Teammates (handoff) are added
 * per frame by the player because they move. Each entry: { id, kind, pos, r, label, intent, station? }.
 */
export function staticInteractables(idx, state, you) {
  const out = [];
  if (!state || state.phase !== 'play') return out;
  const held = state.players[you]?.held ?? null;
  const closed = new Set(state.closed);
  if (!held) {
    for (const [id, it] of Object.entries(state.items)) {
      if (it.holder || !it.at) continue;
      const f = restFrame(idx, it.at);
      if (!f) continue;
      const h = idx.items[id]?.recipe.size[1] ?? 0.2;
      out.push({ id: `grab:${id}`, kind: 'grab', pos: [f.pos[0], f.pos[1] + h * 0.5, f.pos[2]], r: 0.3, label: `Pick up ${idx.items[id]?.label ?? id}`, intent: { t: 'grab', item: id }, station: splitTarget(it.at)[1] != null ? splitTarget(it.at)[0] : null, item: id });
    }
  } else {
    const tags = itemTags(idx, state, held);
    const heldLabel = idx.items[held]?.label ?? held;
    for (const st of Object.values(idx.stations)) {
      for (const slot of st.recipe.slots) {
        const at = `${st.id}.${slot.id}`;
        if (!tags.some((t) => slot.accepts.includes(t)) || occupied(state, at)) continue;
        out.push({ id: `place:${at}`, kind: 'place', pos: toWorld(st.frame, [slot.pos[0], slot.pos[1] + 0.08, slot.pos[2]]), r: 0.35, label: `Place ${heldLabel} on ${st.label}`, intent: { t: 'place', item: held, target: at }, station: st.id, target: at });
      }
    }
    for (const s of SURFACES) {
      if (occupied(state, s)) continue;
      const f = anchorFrame(s);
      out.push({ id: `place:${s}`, kind: 'place', pos: [f.pos[0], f.pos[1] + 0.05, f.pos[2]], r: 0.4, label: `Put ${heldLabel} down`, intent: { t: 'place', item: held, target: s }, target: s });
    }
  }
  // The trade action of the player's current step, once the right thing is in hand.
  const obj = myObjective(state, you);
  if (obj?.verb === 'use' && held && (!obj.item || obj.item === held) && !closed.has(splitTarget(obj.target)[0])) {
    const pos = usePos(idx, obj.target);
    if (pos) out.push({ id: `use:${obj.target}`, kind: 'use', pos, r: 0.45, label: obj.label, action: obj.action, motion: obj.motion ?? 'apply', intent: { t: 'use', target: obj.target }, station: splitTarget(obj.target)[0], target: obj.target });
  }
  for (const st of Object.values(idx.stations)) {
    for (const c of st.recipe.controls) {
      const target = `${st.id}.${c.id}`;
      out.push({ id: `press:${target}`, kind: 'press', pos: toWorld(st.frame, c.pos), r: 0.25, label: `${c.label}${closed.has(st.id) ? ' (closed)' : ''}`, intent: { t: 'press', target }, station: st.id, target, requires: c.requires ?? [] });
    }
  }
  return out;
}

/** Where a use step happens: on the slot's item, or on top of the station. */
export function usePos(idx, target) {
  const [stId, slotId] = splitTarget(target);
  const st = idx.stations[stId];
  if (!st) return null;
  if (slotId != null) {
    const slot = st.recipe.slots.find((x) => x.id === slotId);
    return slot ? toWorld(st.frame, [slot.pos[0], slot.pos[1] + 0.12, slot.pos[2]]) : null;
  }
  const [, h, d] = st.recipe.size;
  return toWorld(st.frame, [0, h + 0.05, d * 0.25]);
}

/** Does this interactable fulfil the current objective? */
export function matchesObjective(obj, it) {
  if (!obj || obj.verb !== it.kind) return false;
  if (obj.verb === 'grab') return it.intent.item === obj.target;
  if (obj.verb === 'place') return it.intent.target === obj.target && (!obj.item || obj.item === it.intent.item);
  if (obj.verb === 'press') return it.intent.target === obj.target;
  if (obj.verb === 'use') return it.intent.target === obj.target;
  if (obj.verb === 'talk') return it.intent.npc === obj.target;
  return false;
}

/** The step this player can act on now (their role's current step), or null while it waits on a teammate. */
export function myObjective(state, you) {
  const step = state ? playerStep(state, you) : null;
  return step && !step.waiting ? step.obj : null;
}

/** World point to mark for the current objective (falls back to the item when it still has to be fetched). */
export function objectiveMarker(idx, state, you, itemPosOf) {
  const obj = myObjective(state, you);
  if (!obj || state.phase !== 'play') return null;
  const itemPos = (id) => {
    const it = state.items[id];
    if (!it) return null;
    if (it.holder) return it.holder === you ? null : itemPosOf?.(id) ?? null;
    const f = restFrame(idx, it.at);
    return f ? [f.pos[0], f.pos[1] + (idx.items[id]?.recipe.size[1] ?? 0.2), f.pos[2]] : null;
  };
  if (obj.verb === 'grab') return itemPos(obj.target);
  if (obj.verb === 'place') {
    const it = state.items[obj.item];
    if (it && it.holder !== you && obj.item) return itemPos(obj.item); // go fetch it first
    const f = restFrame(idx, obj.target);
    return f ? [f.pos[0], f.pos[1] + 0.1, f.pos[2]] : null;
  }
  if (obj.verb === 'press') return controlPos(idx, obj.target);
  if (obj.verb === 'use') {
    const it = state.items[obj.item];
    if (it && it.holder !== you && obj.item) return itemPos(obj.item); // pick up the tool first
    return usePos(idx, obj.target);
  }
  if (obj.verb === 'talk') return npcHead(idx, obj.target, state.people);
  return null;
}

/** Human-readable text for a server denial reason. */
export function denialText(idx, reason, it) {
  if (!reason) return 'Not allowed';
  if (reason === 'closed') {
    const st = it?.station && idx.stations[it.station];
    return st ? `${st.label} is closed` : 'Station closed';
  }
  const needs = /^needs (.+)$/.exec(reason);
  if (needs) {
    const slotId = needs[1];
    const st = it?.station && idx.stations[it.station];
    const slot = st?.recipe.slots.find((s) => s.id === slotId);
    const what = slot?.accepts?.[0] ?? slotId;
    return `Needs a ${what.replace(/_/g, ' ')} in the ${st ? st.label.toLowerCase() : 'machine'}`;
  }
  if (reason === 'hands full') return 'Your hands are full';
  if (reason === 'not now') return 'Not yet';
  if (reason === 'held by someone else') return 'Someone else is holding that';
  if (reason === 'occupied') return 'Something is already there';
  if (reason === 'their hands are full') return 'Their hands are full';
  if (/does not fit/.test(reason)) return "That doesn't go there";
  return reason.charAt(0).toUpperCase() + reason.slice(1);
}

export const BOUNDS = { minX: -ROOM.W / 2, maxX: ROOM.W / 2, minZ: -ROOM.D / 2, maxZ: ROOM.D / 2 };
