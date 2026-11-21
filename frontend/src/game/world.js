// Static collision boxes (XZ AABBs) and interactable registry for the rig.
export const DECK = { minX: -15, maxX: 15, minZ: -12, maxZ: 12 };

export const colliders = [];
export function box(x, z, w, d) {
  colliders.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
}

// Layout anchors (meters). Deck is y=0.
export const A = {
  spawn: [-2, 0, 8],
  rotary: [0, 0, -2],
  mousehole: [1.9, 0, -0.6],
  doghouse: [-9.5, 0, -7.5],
  rhodes: [-6.4, 0, -4.6],
  okafor: [-9.5, 0, -7.2],
  locker: [-12.6, 0, -2.5],
  pipeRack: [8.5, 0, 6.5],
  controlStand: [-2.8, 0, 0.6],
  pump1: [10.5, 0, -6.5],
  pump2: [10.5, 0, -2.2],
  choke: [4.8, 0, -9.6],
  bop: [-5.2, 0, -10.6],
  containers: [-12, 0, 8],
  crane: [12, 0, 9.5],
};

// Interactables: { id, pos:[x,y,z], r, label: () => string|null, use: () => void, hold?: bool }
export const interactables = new Map();
export function registerInteractable(it) {
  interactables.set(it.id, it);
  return () => interactables.delete(it.id);
}

// Static colliders for the layout (kept in one place so props and physics agree).
box(A.doghouse[0], A.doghouse[2], 5.2, 4.2);
box(A.locker[0], A.locker[2], 1.0, 2.2);
box(A.pipeRack[0], A.pipeRack[2], 8.4, 2.6);
box(A.controlStand[0], A.controlStand[2], 0.9, 0.7);
box(A.pump1[0], A.pump1[2], 3.4, 1.8);
box(A.pump2[0], A.pump2[2], 3.4, 1.8);
box(A.choke[0], A.choke[2], 4.2, 1.0);
box(A.bop[0], A.bop[2], 1.8, 0.8);
box(A.containers[0], A.containers[2], 2.6, 6.2);
box(A.containers[0] + 0.2, A.containers[2] - 6.6, 2.6, 6.2);
box(A.crane[0], A.crane[2], 2.2, 2.2);
box(A.rotary[0], A.rotary[2], 2.2, 2.2);
// derrick legs
for (const sx of [-3.2, 3.2]) for (const sz of [-3.2, 3.2]) box(A.rotary[0] + sx, A.rotary[2] + sz, 0.7, 0.7);
// drawworks
box(-4.6, -2, 2.0, 3.0);
