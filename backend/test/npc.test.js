// NPC goals (F6), the nav grid (F2 reachability) and the combine capability (assembling a set of materials).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, applyIntent, tick, STUCK_MS } from '../../frontend/src/shared/sim.js';
import { buildNav, findPath, standPoint, spawnPoint } from '../../frontend/src/shared/nav.js';
import { CATALOG, blueprint } from './fixtures.js';

const T0 = 1_000_000;

function run(bp = blueprint(), catalog = CATALOG) {
  let state = createRoom(bp, catalog, T0);
  let now = T0;
  const events = [];
  const act = (pid, intent) => { const r = applyIntent(state, pid, intent, now); state = r.state; events.push(...r.events); return r.events; };
  const advance = (ms, step = 50) => {
    for (let t = 0; t < ms; t += step) {
      now += step;
      for (const pid of Object.keys(state.players)) state = applyIntent(state, pid, { t: 'ping' }, now).state; // players stay connected
      const r = tick(state, now); state = r.state; events.push(...r.events);
    }
  };
  act('a', { t: 'join', name: 'Ana' });
  return { get state() { return state; }, act, advance, events };
}

test('nav: every station, surface and NPC spot of the fixture is reachable from the spawn', () => {
  const nav = buildNav(blueprint(), CATALOG);
  for (const target of ['main', 'backup', 'shelf', 'S1', 'S2', 'P1']) {
    const to = standPoint(nav, target);
    assert.ok(to, target);
    assert.ok(findPath(nav, spawnPoint(), to), `path to ${target}`);
  }
});

test('nav: paths go around placed stations instead of through them', () => {
  const nav = buildNav(blueprint(), CATALOG);
  const shelf = nav.placed.get('shelf').box; // island I2
  const path = findPath(nav, [2.6, -3], [2.6, 0.2]); // straight line would cross the shelf
  assert.ok(path && path.length >= 3, 'needs a detour');
  for (let i = 1; i < path.length; i++) {
    const [ax, az] = path[i - 1], [bx, bz] = path[i];
    for (let k = 0; k <= 20; k++) {
      const x = ax + ((bx - ax) * k) / 20, z = az + ((bz - az) * k) / 20;
      assert.ok(!(x > shelf.minX && x < shelf.maxX && z > shelf.minZ && z < shelf.maxZ), `segment ${i} enters the shelf`);
    }
  }
});

test('npcs start at their spot and are part of the snapshot', () => {
  const r = run();
  const n = r.state.npcs.mgr;
  assert.deepEqual(n.pos, [-1.2, 3.4]);
  assert.equal(n.goal, 'post');
  assert.ok(JSON.parse(JSON.stringify(r.state)).npcs.mgr);
});

test('event: the announcing NPC walks to the closed station; talking explains the closure', () => {
  const r = run();
  r.act('a', { t: 'talk', npc: 'mgr' });
  r.act('a', { t: 'grab', item: 'cup1' });
  r.act('a', { t: 'place', item: 'cup1', target: 'main.cup' });
  r.advance(2100); // event fires after 2 s
  const n = r.state.npcs.mgr;
  assert.equal(n.goal, 'repair');
  assert.equal(n.target, 'main');
  r.advance(15000);
  const nav = buildNav(blueprint(), CATALOG);
  const [sx, sz] = standPoint(nav, 'main');
  assert.ok(Math.hypot(r.state.npcs.mgr.pos[0] - sx, r.state.npcs.mgr.pos[1] - sz) < 0.3, 'arrived at the main machine');
  assert.equal(r.state.npcs.mgr.moving, false);
  const said = r.act('a', { t: 'talk', npc: 'mgr' }).find((e) => e.type === 'say');
  assert.match(said.text, /Main machine is out of action/);
  assert.match(said.text, /Grab the spare cup/);
});

test('a stuck crew gets an NPC walking over to the current station, who returns when it is done', () => {
  const r = run();
  r.act('a', { t: 'talk', npc: 'mgr' });
  r.act('a', { t: 'grab', item: 'cup1' }); // now on "Seat the cup"
  r.advance(STUCK_MS + 200, 100);
  assert.equal(r.state.npcs.mgr.goal, 'guide');
  assert.equal(r.state.npcs.mgr.target, 'main');
  assert.ok(r.events.some((e) => e.type === 'say' && /main machine/i.test(e.text)));
  r.act('a', { t: 'place', item: 'cup1', target: 'main.cup' });
  assert.equal(r.state.npcs.mgr.goal, 'post');
});

test('combine: pressing merges the other required items into the first, which can then be carried', () => {
  const catalog = [
    ...CATALOG,
    {
      id: 'bench', name: 'Bench', kind: 'station', shells: ['shop'], tags: ['bench'], size: [1.6, 1, 0.8],
      slots: [{ id: 'wrap', pos: [0, 0.9, 0], accepts: ['wrap'] }, { id: 'stems', pos: [0.3, 0.9, 0], accepts: ['flower'] }],
      controls: [{ id: 'tie', pos: [-0.5, 0.95, 0.3], label: 'Tie', requires: ['wrap', 'stems'], sets: 'bouquet', combine: true }],
      parts: [{ t: 'box', s: [1, 1, 1], m: 'wood' }],
    },
    { id: 'wrap', name: 'Wrap', kind: 'item', shells: ['shop'], tags: ['wrap'], size: [0.2, 0.3, 0.2], slots: [], controls: [], parts: [{ t: 'box', s: [0.1, 0.1, 0.1], m: 'paper' }] },
    { id: 'roses', name: 'Roses', kind: 'item', shells: ['shop'], tags: ['flower'], size: [0.2, 0.5, 0.2], slots: [], controls: [], parts: [{ t: 'box', s: [0.1, 0.1, 0.1], m: 'flowerRed' }] },
  ];
  const bp = blueprint();
  bp.stations.push({ id: 'bench', prop: 'bench', anchor: 'N1', label: 'Bench' });
  bp.items.push({ id: 'w', prop: 'wrap', anchor: 'bench.wrap', label: 'Wrap' }, { id: 'r', prop: 'roses', anchor: 'bench.stems', label: 'Roses' });
  const r = run(bp, catalog);
  const ev = r.act('a', { t: 'press', target: 'bench.tie' });
  assert.deepEqual(ev.find((e) => e.type === 'pressed').combined, ['r']);
  assert.deepEqual(r.state.items.w.contains, ['r']);
  assert.ok(r.state.items.w.tags.includes('bouquet'));
  assert.equal(r.state.items.r.at, null);
  assert.equal(r.state.items.r.in, 'w');
  assert.match(r.act('a', { t: 'grab', item: 'r' }).find((e) => e.type === 'denied').reason, /part of w/);
  assert.equal(r.act('a', { t: 'grab', item: 'w' }).find((e) => e.type === 'denied'), undefined);
  assert.equal(r.state.players.a.held, 'w');
});
