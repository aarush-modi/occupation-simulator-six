# Workshift contracts (read this before writing code)

Repo: `C:\Users\jiami\local_workspace\hackwestern\occupation-simulator-six`. Product spec: `REQUIREMENTS.md`.
Frontend: Next.js 16 app in `frontend/` (JS/JSX, React 19, React Three Fiber 9, drei 10, three r187, zod 4, zustand).
Backend: Node 22 ESM in `backend/src/` (`ws`, `@google/genai`, `zod`). Backend imports shared code by relative path from `../../frontend/src/shared/`.
Shared, pure, framework-free code lives in `frontend/src/shared/` (ESM, no React, no three).

## Flow
1. Lobby: player types an occupation (or picks a suggested job). Frontend `POST {BACKEND}/api/rooms { occupation }`.
2. Backend creates a room immediately, returns `{ roomId, inviteUrl }`, and generates a blueprint with one OpenAI Responses API call (model from `OPENAI_MODEL`, default `gpt-6.2-astra`) using the catalog + layout as the menu. Validate with `Blueprint` (schema.js) plus `validateBlueprint` (semantic). One retry with the errors if invalid. Cache by normalised occupation. On failure or when the generation budget expires, room status is `failed` and the host can pick a demo shift. The lobby also offers demos after eight seconds.
3. Clients connect `ws://{BACKEND}/room/{roomId}`; server is authoritative for task state (N3); 20 snapshots/s.
4. The frontend builds the scene from `blueprint.shell` and `blueprint.venue`, then places recipes at anchors and NPCs at spots. Players spawn at `SPAWN`. The venue can be enclosed, open-front, or outdoors with boundary rails. It also specifies a floor material, palette, lighting, and venue sign.
5. Play: verbs grab / place / press / talk, with optional skill checks. Event director fires once. Review screen at the end.

## Files
- `layout.js`: `ROOM`, `SHELLS`, `ANCHORS`, `SUPPLY_COUNTERS`, `LIMITS`. Anchor kinds: wall (N1-N5, E1-E2, W1-W2), island (I1-I4), surface (S1-S8, y = 0.92, built-in supply counters), spot (P1-P3 NPCs), SPAWN.
- `schema.js`: `Part`, `Recipe`, `Objective`, `Blueprint` (zod v4).
- `materialKeys.js`: allowed material keys (`m` on every part). Rendered by `frontend/src/game/materials.js` `M[key]`.
- `catalog/props/<id>.json`: one recipe per file. Build + validate: `cd frontend && node scripts/catalog.mjs` → `catalog/catalog.generated.js` exporting `CATALOG` (array of recipes).
- `sim.js` (backend agent owns): pure reducer, see below.
- `validate.js` (backend agent owns): `validateBlueprint(bp, catalog) -> string[]` errors.

## Recipe rules
- Units meters. Local frame: origin at the floor centre of the bounding box, +Y up, **+Z is the front, facing the player**. `size` = [w, h, d] must contain all parts.
- kind `station`: interactive workplace machine or bench placed at a wall/island anchor (≤ 2.2 w × 1.3 d × 2.6 h). Stations that sit on a counter should INCLUDE their own counter/bench/cabinet base so they stand on the floor (see `espresso_machine.json`).
- kind `item`: small thing the player carries (≤ 0.7 × 0.7 × 0.6). Placed on surface anchors S1-S8 or in station slots. Its origin is its base.
- kind `furniture` / `decor`: non-interactive dressing placed at wall/island anchors (shelves, plants, chairs, bins, signs on a stand).
- `slots[].pos` is where an item's base sits (local coords). An item fits a slot when ANY of the item's `tags` is in the slot's `accepts`.
- `controls[].pos` is the pressable spot. `requires` = slot ids that must hold an item first (the server rejects the press otherwise and the UI says why). `sets` = tag added to the item in the first required slot (e.g. `brewed`, `cut`, `scanned`, `repaired`).
- Use glow materials (`screen`, `lamp`, `green_glow`, `red_glow`, `amber_glow`) for buttons, screens and indicator lights.
- Quality bar: realistic, recognisable silhouettes with real detail (bevels via `round`, handles, knobs, vents, feet, labels as thin boxes, cables as `tube`). 6-60 parts per recipe. Use `repeat` for rows (keys, books, grate bars, vials).

## Blueprint
See `Blueprint` in schema.js. Objective targets: grab → item id; place → `"<stationId>.<slotId>"` or surface anchor `S1`-`S8`; press → `"<stationId>.<controlId>"`; talk → npc id. `item` is required for place. The event fires `delaySec` after objective `after` completes, can `close` a station, and replaces all remaining objectives with `replaceRemaining`.

## Sim (sim.js, pure, used by the server)
```
createRoom(blueprint, catalog) -> state
applyIntent(state, playerId, intent, now) -> { state, events: [] }   // never throws; denied intents produce { type:'denied', playerId, reason }
tick(state, now) -> { state, events }                                  // event director timing, stale-player hold release
```
State (JSON-serialisable, this is exactly what snapshots carry):
```
{ phase: 'play'|'review', startedAt, players: { [id]: { name, pos:[x,y,z], yaw, pitch, held: itemId|null, lastSeen } },
  items: { [itemId]: { at: anchorId|'stationId.slotId'|null, holder: playerId|null, tags: string[] } },
  objectives: Objective[], cur: number, done: string[], closed: string[], event: { fired: bool, at: number|null },
  score: { startedAt, finishedAt, skills: { [objectiveId]: number } } }
```
Intents (client → server, JSON): `{t:'join',name}`, `{t:'pose',pos,yaw,pitch}`, `{t:'grab',item}`, `{t:'place',item,target}`, `{t:'press',target,skillScore?}`, `{t:'talk',npc}`, `{t:'handoff',to}`, `{t:'demo',occupation}`.
Rules: an item has at most one holder (first valid intent wins). A player holds at most one item. Objectives complete only in order (`cur`). Pressing a control whose `requires` slots are empty is denied with reason `needs <slot>`. Closed stations deny everything with reason `closed`.
Server → client messages: `{type:'status', status:'generating'|'ready'|'failed', blueprint?, error?}`, `{type:'welcome', you, state, blueprint}`, `{type:'snapshot', state}` (20 Hz), `{type:'events', events}` where events include `{type:'say', npc, text}`, `{type:'objective', id}`, `{type:'eventFired', announce}`, `{type:'denied', playerId, reason}`, `{type:'review'}`.

## Frontend modules (names other agents import)
- `frontend/src/scene/Prop.jsx`: `export default function Prop({ recipe, ...groupProps })` renders a recipe with materials `M`; `export function placeAt(anchorId) -> { position, rotationY }`.
- `frontend/src/scene/Shell.jsx`: `export default function Shell({ id })` renders room `id` (floor, walls, ceiling, lights, windows, door, the two supply counters, built-in dressing). `export const shellColliders` (AABBs on XZ for walls and counters).
- `frontend/app/dev/props/page.js`: gallery of every recipe (grid, labels, orbit camera).
