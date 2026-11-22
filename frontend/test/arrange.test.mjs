import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { arrangeLayout } from '../src/shared/arrange.js';
import { ANCHORS } from '../src/shared/layout.js';
import { checkBlueprint } from '../src/shared/validate.js';
import { CATALOG } from '../src/shared/catalog/catalog.generated.js';

const demo = (name) => checkBlueprint(JSON.parse(fs.readFileSync(new URL(`../../backend/src/demos/${name}.json`, import.meta.url), 'utf8')), CATALOG).blueprint;
const kindOf = (anchor) => ANCHORS[anchor].kind;

test('a messy generated layout is put back the way a real cafe is laid out', () => {
  const bp = demo('barista');
  // What a generator might do: machines dumped on the islands, the pickup counter on the back wall, a table among them.
  const messy = {
    ...bp,
    stations: bp.stations.map((s, i) => ({ ...s, anchor: ['I1', 'I2', 'N3', 'W1', 'N5'][i] })),
    decor: [{ prop: 'cafe_bistro_table', anchor: 'I3' }, { prop: 'gen_storage_cabinet', anchor: 'I4' }, { prop: 'cafe_menu_board_stand', anchor: 'E1' }],
  };
  const out = arrangeLayout(messy, CATALOG);
  const at = Object.fromEntries(out.stations.map((s) => [s.id, s.anchor]));
  assert.equal(kindOf(at.pickup), 'counter', 'the pickup counter is at the front, worked from behind');
  for (const id of ['grinder', 'espresso', 'steamer', 'backup']) assert.equal(kindOf(at[id]), 'wall', `${id} stands against a wall`);
  assert.equal(Math.abs(Number(at.espresso.slice(1)) - Number(at.backup.slice(1))), 1, 'main and backup machines sit side by side');
  assert.ok(Number(at.grinder.slice(1)) < Number(at.espresso.slice(1)), 'the grinder comes before the machine, as the work flows');
  assert.ok(out.decor.every((d) => kindOf(d.anchor) !== 'island' || ['I3', 'I4'].includes(d.anchor)), 'nothing left in the middle');
  assert.ok(out.decor.some((d) => d.prop === 'gen_storage_cabinet' && kindOf(d.anchor) === 'wall'), 'storage goes against a wall');
  const anchors = [...out.stations, ...out.decor].map((x) => x.anchor);
  assert.equal(new Set(anchors).size, anchors.length, 'one thing per anchor');
  const front = anchors.filter((a) => ['I3', 'C2'].includes(a));
  assert.ok(front.length <= 1, 'a front spot holds one thing (its counter or its island)');
  assert.deepEqual(arrangeLayout(out, CATALOG), out, 'arranging twice changes nothing');
});

test('free-standing work like a patient bed keeps the middle of the room', () => {
  const bp = demo('barista');
  const ward = { ...bp, stations: [...bp.stations.slice(0, 2), { id: 'bed', prop: 'clinic_patient_bed', anchor: 'N5', label: 'Bed' }], decor: [] };
  const out = arrangeLayout(ward, CATALOG);
  assert.equal(out.stations.find((s) => s.id === 'bed').anchor, 'I1');
});

test('arranged demo shifts still validate and play through', () => {
  for (const name of ['barista', 'bartender']) {
    const arranged = arrangeLayout(demo(name), CATALOG);
    const r = checkBlueprint(arranged, CATALOG);
    assert.deepEqual(r.errors, [], name);
  }
});
