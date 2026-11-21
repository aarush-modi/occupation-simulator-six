// Small self-contained catalog + blueprint so the rule tests do not depend on which props other agents have added.
const box = { t: 'box', s: [0.2, 0.2, 0.2], m: 'stainless' };

export const CATALOG = [
  {
    id: 'espresso_machine', name: 'Espresso machine', kind: 'station', shells: ['cafe'], tags: ['coffee', 'machine'], size: [1.6, 1.45, 0.8],
    slots: [{ id: 'cup', pos: [0, 1, 0.24], accepts: ['cup'] }],
    controls: [{ id: 'brew', pos: [0.3, 1.32, 0.3], label: 'Pull a shot', requires: ['cup'], sets: 'brewed' }],
    parts: [box],
  },
  {
    id: 'pickup_shelf', name: 'Pickup shelf', kind: 'station', shells: ['cafe'], tags: ['counter'], size: [1.2, 1, 0.6],
    slots: [{ id: 'drink', pos: [0, 1, 0], accepts: ['brewed'] }],
    controls: [{ id: 'bell', pos: [0.4, 1, 0.2], label: 'Ring bell', requires: [] }],
    parts: [box],
  },
  { id: 'cup', name: 'Cup', kind: 'item', shells: ['cafe'], tags: ['cup', 'ceramic'], size: [0.1, 0.1, 0.1], slots: [], controls: [], parts: [box] },
  { id: 'plant', name: 'Plant', kind: 'decor', shells: ['cafe', 'office'], tags: ['plant'], size: [0.5, 1, 0.5], slots: [], controls: [], parts: [box] },
];

export const blueprint = () => ({
  version: 1,
  occupation: 'barista',
  title: 'Morning rush',
  briefing: 'Pull an espresso and hand it out.',
  shell: 'cafe',
  stations: [
    { id: 'main', prop: 'espresso_machine', anchor: 'N2', label: 'Main machine' },
    { id: 'backup', prop: 'espresso_machine', anchor: 'N4', label: 'Backup machine' },
    { id: 'shelf', prop: 'pickup_shelf', anchor: 'I2', label: 'Pickup shelf' },
  ],
  items: [
    { id: 'cup1', prop: 'cup', anchor: 'S1', label: 'Cup' },
    { id: 'cup2', prop: 'cup', anchor: 'S2', label: 'Spare cup' },
  ],
  decor: [{ prop: 'plant', anchor: 'W1' }],
  npcs: [{ id: 'mgr', name: 'Sam', role: 'Shift lead', anchor: 'P1', outfit: 'apron', lines: { intro: 'Grab a cup and pull a shot.', done: 'Great shift!' } }],
  objectives: [
    { id: 'o1', verb: 'talk', target: 'mgr', label: 'Check in with Sam', skill: 'none' },
    { id: 'o2', verb: 'grab', target: 'cup1', label: 'Grab a cup', skill: 'none' },
    { id: 'o3', verb: 'place', target: 'main.cup', item: 'cup1', label: 'Seat the cup', skill: 'steady', say: { npc: 'mgr', text: 'Nice and level.' } },
    { id: 'o4', verb: 'press', target: 'main.brew', label: 'Pull the shot', skill: 'timing' },
    { id: 'o5', verb: 'grab', target: 'cup1', label: 'Take the drink', skill: 'none' },
    { id: 'o6', verb: 'place', target: 'shelf.drink', item: 'cup1', label: 'Serve it', skill: 'none' },
  ],
  event: {
    after: 'o3',
    delaySec: 2,
    announce: { npc: 'mgr', text: 'The main machine just died, use the backup!' },
    close: 'main',
    replaceRemaining: [
      { id: 'r1', verb: 'grab', target: 'cup2', label: 'Grab the spare cup', skill: 'none' },
      { id: 'r2', verb: 'place', target: 'backup.cup', item: 'cup2', label: 'Seat it in the backup', skill: 'none' },
      { id: 'r3', verb: 'press', target: 'backup.brew', label: 'Pull the shot', skill: 'timing' },
      { id: 'r4', verb: 'grab', target: 'cup2', label: 'Take the drink', skill: 'none' },
      { id: 'r5', verb: 'place', target: 'shelf.drink', item: 'cup2', label: 'Serve it', skill: 'none' },
    ],
  },
  facts: ['A shot takes about 25 seconds.', 'Baristas dial in the grind every morning.'],
});
