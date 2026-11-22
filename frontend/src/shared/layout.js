// Room shells and their named anchors. Shared by the backend (Gemini prompt + validation) and the frontend (rendering).
// All shells share one 14 m x 11 m layout so every anchor is reachable by construction. Origin = room centre, floor y = 0.
// Player spawns at the door (front wall, +z) facing -z (into the room). Recipes face +z (toward the player).

export const ROOM = { W: 14, D: 11, H: 3.4 };

export const SHELLS = {
  sushi: 'Neighborhood sushi bar with timber floors, indigo noren, paper lanterns, a sushi prep line and a guest counter',
  cafe: 'Cafe or restaurant kitchen: tiled floor, warm lights, counters',
  warehouse: 'Warehouse or distribution centre: concrete floor, high racks, loading door',
  shop: 'Retail shop or florist or pharmacy: wood floor, display counters, shopfront window',
  clinic: 'Clinic, hospital room, vet or dental office: vinyl floor, clean white walls',
  lab: 'Science or testing laboratory: epoxy floor, fume hoods, benches',
  workshop: 'Garage, workshop or factory floor: stained concrete, tool walls',
  office: 'Office, studio or newsroom: carpet, desks, glass partitions',
  salon: 'Salon, barbershop or spa: polished floor, mirrors, warm lighting',
};
export const SHELL_IDS = Object.keys(SHELLS);

const r = Math.PI;
// kind: wall (station against a wall, facing into the room), island (freestanding), surface (small item on a built-in counter top),
// spot (where an NPC stands), spawn.
export const ANCHORS = {
  N1: { kind: 'wall', pos: [-5, 0, -4.7], rotY: 0 },
  N2: { kind: 'wall', pos: [-2.5, 0, -4.7], rotY: 0 },
  N3: { kind: 'wall', pos: [0, 0, -4.7], rotY: 0 },
  N4: { kind: 'wall', pos: [2.5, 0, -4.7], rotY: 0 },
  N5: { kind: 'wall', pos: [5, 0, -4.7], rotY: 0 },
  E1: { kind: 'wall', pos: [6.2, 0, -2.4], rotY: -r / 2 },
  E2: { kind: 'wall', pos: [6.2, 0, 0.2], rotY: -r / 2 },
  W1: { kind: 'wall', pos: [-6.2, 0, -2.4], rotY: r / 2 },
  W2: { kind: 'wall', pos: [-6.2, 0, 0.2], rotY: r / 2 },
  I1: { kind: 'island', pos: [-2.6, 0, -1.4], rotY: 0 },
  I2: { kind: 'island', pos: [2.6, 0, -1.4], rotY: 0 },
  I3: { kind: 'island', pos: [-2.6, 0, 1.6], rotY: 0 },
  I4: { kind: 'island', pos: [2.6, 0, 1.6], rotY: 0 },
  // Front service counters: the same spots as I4 / I3, turned to face the back, so staff work them from behind and
  // customers stand in front. Only the layout pass (arrange.js) uses them, and never together with that island.
  C1: { kind: 'counter', pos: [2.6, 0, 1.6], rotY: r, island: 'I4' },
  C2: { kind: 'counter', pos: [-2.6, 0, 1.6], rotY: r, island: 'I3' },
  // Built-in supply counters along the front wall, either side of the door. Top surface at y = 0.92.
  S1: { kind: 'surface', pos: [-6.0, 0.92, 4.75], rotY: r },
  S2: { kind: 'surface', pos: [-5.0, 0.92, 4.75], rotY: r },
  S3: { kind: 'surface', pos: [-4.0, 0.92, 4.75], rotY: r },
  S4: { kind: 'surface', pos: [-3.0, 0.92, 4.75], rotY: r },
  S5: { kind: 'surface', pos: [3.0, 0.92, 4.75], rotY: r },
  S6: { kind: 'surface', pos: [4.0, 0.92, 4.75], rotY: r },
  S7: { kind: 'surface', pos: [5.0, 0.92, 4.75], rotY: r },
  S8: { kind: 'surface', pos: [6.0, 0.92, 4.75], rotY: r },
  P1: { kind: 'spot', pos: [-1.2, 0, 3.4], rotY: r },
  P2: { kind: 'spot', pos: [0.0, 0, 0.1], rotY: r },
  P3: { kind: 'spot', pos: [-4.6, 0, 0.0], rotY: r / 2 },
  SPAWN: { kind: 'spawn', pos: [0, 0, 4.3], rotY: 0 },
};
export const SUPPLY_COUNTERS = [
  { pos: [-4.5, 0, 4.75], size: [3.6, 0.9, 0.7] },
  { pos: [4.5, 0, 4.75], size: [3.6, 0.9, 0.7] },
];

// Footprint limits (meters) for recipes by kind, so placed items never overlap geometry.
export const LIMITS = {
  station: { w: 2.2, d: 1.3, h: 2.6 }, // fits a wall or island anchor
  furniture: { w: 2.2, d: 1.3, h: 2.6 },
  item: { w: 0.7, d: 0.6, h: 0.7 }, // fits a 1 m surface slot or a station slot
  decor: { w: 2.2, d: 1.3, h: 2.6 },
};

export const anchorIds = (kind) => Object.entries(ANCHORS).filter(([, a]) => a.kind === kind).map(([id]) => id);
