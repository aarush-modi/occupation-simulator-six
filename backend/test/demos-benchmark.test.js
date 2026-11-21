// The REQUIREMENTS benchmark occupations (barista, warehouse picker, florist) ship as prevalidated demo shifts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG } from '../src/catalog.js';
import { loadDemos } from '../src/demos.js';
import { createRoom, applyIntent, tick } from '../../frontend/src/shared/sim.js';

const T0 = 1_000_000;
const quiet = { error: (m) => assert.fail(m), warn: () => {} };
const demos = loadDemos(CATALOG, { log: quiet });
const demo = (id) => demos.find((d) => d.id === id)?.blueprint;

function room(bp) {
  let state = createRoom(bp, CATALOG, T0);
  let clock = T0;
  const act = (intent, now = clock) => {
    const r = applyIntent(state, 'p1', intent, now);
    state = r.state;
    return r.events;
  };
  act({ t: 'join', name: 'Tester' });
  return { act, get state() { return state; }, advance: (ms) => { clock += ms; state = tick(state, clock).state; } };
}

test('benchmark demos load without errors', () => {
  for (const id of ['barista', 'warehouse_picker', 'florist']) assert.ok(demo(id), `${id} demo missing`);
});

test('warehouse: an unscanned item does not fit an order bin', () => {
  const r = room(demo('warehouse_picker'));
  r.act({ t: 'grab', item: 'box' });
  const ev = r.act({ t: 'place', item: 'box', target: 'sort.bin_1' });
  assert.match(ev.find((e) => e.type === 'denied').reason, /does not fit/);
  r.act({ t: 'place', item: 'box', target: 'rackA.shelf_a' });
  r.act({ t: 'press', target: 'rackA.scan_a' });
  assert.ok(r.state.items.box.tags.includes('scanned'));
});

test('warehouse: the forklift event closes rack A and reroutes to bin 4', () => {
  const bp = demo('warehouse_picker');
  const r = room(bp);
  r.act({ t: 'talk', npc: 'dana' });
  for (const [scan, item, bin] of [['scan_a', 'box', 'bin_1'], ['scan_b', 'mailer', 'bin_2']]) {
    r.act({ t: 'press', target: `rackA.${scan}` });
    r.act({ t: 'grab', item });
    r.act({ t: 'place', item, target: `sort.${bin}` });
  }
  r.advance(4_500);
  assert.ok(r.state.event.fired);
  assert.ok(r.state.closed.includes('rackA'));
  assert.match(r.act({ t: 'press', target: 'rackA.scan_c' }).find((e) => e.type === 'denied').reason, /closed/);
  assert.equal(r.state.objectives[r.state.cur].target, 'rackB.scan_c');
  assert.ok(r.state.objectives.some((o) => o.target === 'sort.bin_4'));
});

test('florist: tying combines the stems into the wrap, which becomes the bouquet', () => {
  const r = room(demo('florist'));
  r.act({ t: 'talk', npc: 'rosa' });
  r.act({ t: 'grab', item: 'roses' });
  r.act({ t: 'place', item: 'roses', target: 'bench.stems' });
  r.act({ t: 'grab', item: 'greens' });
  r.act({ t: 'place', item: 'greens', target: 'bench.greens' });
  const ev = r.act({ t: 'press', target: 'bench.tie' });
  assert.deepEqual(ev.find((e) => e.type === 'pressed').combined, ['roses', 'greens']);
  const { wrap, roses } = r.state.items;
  assert.ok(wrap.tags.includes('bouquet'));
  assert.deepEqual(wrap.contains, ['roses', 'greens']);
  assert.equal(roses.in, 'wrap');
  assert.equal(roses.at, null);
  assert.match(r.act({ t: 'grab', item: 'roses' }).find((e) => e.type === 'denied').reason, /part of wrap/);
  r.act({ t: 'grab', item: 'wrap' });
  r.act({ t: 'place', item: 'wrap', target: 'counter.pickup' });
  assert.equal(r.state.items.wrap.at, 'counter.pickup');
});

test('florist: the card reader event closes the counter and sends the bouquet to delivery', () => {
  const r = room(demo('florist'));
  r.act({ t: 'talk', npc: 'rosa' });
  r.act({ t: 'grab', item: 'roses' });
  r.act({ t: 'place', item: 'roses', target: 'bench.stems' });
  r.act({ t: 'grab', item: 'greens' });
  r.act({ t: 'place', item: 'greens', target: 'bench.greens' });
  r.act({ t: 'press', target: 'bench.tie' });
  r.advance(4_500);
  assert.ok(r.state.closed.includes('counter'));
  r.act({ t: 'grab', item: 'wrap' });
  assert.match(r.act({ t: 'place', item: 'wrap', target: 'counter.pickup' }).find((e) => e.type === 'denied').reason, /closed/);
  r.act({ t: 'place', item: 'wrap', target: 'delivery.crate' });
  r.act({ t: 'press', target: 'delivery.dispatch' });
  assert.equal(r.state.phase, 'review');
});
