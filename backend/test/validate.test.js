import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBlueprint, checkBlueprint } from '../../frontend/src/shared/validate.js';
import { CATALOG as REAL_CATALOG } from '../src/catalog.js';
import { loadDemos } from '../src/demos.js';
import { CATALOG, blueprint } from './fixtures.js';

const quiet = { error() {}, warn() {}, log() {} };

test('fixture blueprint is valid and completable with and without the event', () => {
  assert.deepEqual(validateBlueprint(blueprint(), CATALOG), []);
});

test('every demo blueprint validates against the real catalog, and barista exists', () => {
  const errors = [];
  const demos = loadDemos(REAL_CATALOG, { log: { error: (m) => errors.push(m), warn() {}, log() {} } });
  assert.deepEqual(errors, []);
  assert.ok(demos.find((d) => d.id === 'barista'), 'barista demo is present');
  for (const d of demos) assert.deepEqual(validateBlueprint(d.blueprint, REAL_CATALOG), [], d.id);
});

test('schema errors are reported', () => {
  const bp = blueprint();
  delete bp.title;
  assert.match(validateBlueprint(bp, CATALOG)[0], /^schema title/);
});

test('unknown props, wrong kinds and wrong anchors are reported', () => {
  const bp = blueprint();
  bp.stations[0].prop = 'flux_capacitor';
  bp.stations[1].anchor = 'S5';
  bp.items[0].prop = 'espresso_machine';
  bp.decor[0].anchor = 'N2';
  bp.npcs[0].anchor = 'N1';
  const e = validateBlueprint(bp, CATALOG).join('\n');
  assert.match(e, /station main: prop "flux_capacitor" is not in the catalog/);
  assert.match(e, /station backup: anchor S5 must be a wall or island anchor/);
  assert.match(e, /item cup1: prop "espresso_machine" is a station, expected item/);
  assert.match(e, /anchor N2 used by both/);
  assert.match(e, /npc mgr: anchor N1 must be a spot anchor/);
});

test('duplicate ids and bad references are reported', () => {
  const bp = blueprint();
  bp.items[1].id = 'cup1';
  bp.objectives[3].target = 'main.steam';
  bp.objectives[0].target = 'nobody';
  bp.event.after = 'zzz';
  const e = validateBlueprint(bp, CATALOG).join('\n');
  assert.match(e, /duplicate id "cup1"/);
  assert.match(e, /main has no control steam/);
  assert.match(e, /talk target nobody is not an npc/);
  assert.match(e, /event.after: unknown objective zzz/);
});

test('place targets must accept the item tags at that point (sets tags count)', () => {
  const bp = blueprint();
  bp.objectives.splice(3, 1); // remove the brew press: the cup is never "brewed"
  const e = validateBlueprint(bp, CATALOG).join('\n');
  assert.match(e, /objective o6: cup1 \(tags cup,ceramic\) does not fit shelf.drink/);
});

test('replacement objectives may not use the closed station', () => {
  const bp = blueprint();
  bp.event.replaceRemaining[1].target = 'main.cup';
  assert.match(validateBlueprint(bp, CATALOG).join('\n'), /event objective r2: uses main, which the event closes/);
});

test('an unfinishable shift is caught by the playthrough', () => {
  const bp = blueprint();
  // Place the spare cup on S1, which cup1 already occupies (cup1 never leaves S1 before then in this order).
  bp.objectives = [
    { id: 'o1', verb: 'grab', target: 'cup2', label: 'Grab', skill: 'none' },
    { id: 'o2', verb: 'place', target: 'S1', item: 'cup2', label: 'Put it on S1', skill: 'none' },
    { id: 'o3', verb: 'talk', target: 'mgr', label: 'Talk', skill: 'none' },
  ];
  bp.event.after = 'o3';
  const e = validateBlueprint(bp, CATALOG).join('\n');
  assert.match(e, /not completable without the event: objective o2 \("Put it on S1"\): occupied/);
});

test('shell mismatch is only a warning', () => {
  const bp = blueprint();
  bp.shell = 'office';
  const r = checkBlueprint(bp, CATALOG);
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => /not designed for shell office/.test(w)));
});
