import assert from 'node:assert/strict';
import test from 'node:test';
import { createGenerator } from '../src/generate.js';
import { CATALOG as FULL_CATALOG } from '../src/catalog.js';
import { CATALOG, blueprint } from './fixtures.js';

const quiet = { log() {} };

function checkStrict(schema) {
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required.toSorted(), Object.keys(schema.properties).sort());
    Object.values(schema.properties).forEach(checkStrict);
  }
  assert.equal(Object.hasOwn(schema, 'default'), false);
  if (schema.items) checkStrict(schema.items);
  schema.anyOf?.forEach(checkStrict);
}

test('OpenAI Responses requests a strict blueprint, and optional nulls round-trip into the game schema', async () => {
  let requests = 0;
  const raw = blueprint();
  delete raw.version;
  raw.venue = { name: 'Espresso at the Market', enclosure: 'open_front', floor: 'tile', palette: 'coastal', lighting: 'daylight' };
  for (const objective of [...raw.objectives, ...raw.event.replaceRemaining]) {
    objective.item ??= null;
    objective.say ??= null;
  }
  const generator = createGenerator({
    catalog: CATALOG, apiKey: 'test-key', log: quiet,
    fetcher: async (url, request) => {
      requests++;
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(request.headers.authorization, 'Bearer test-key');
      assert.ok(request.signal);
      const body = JSON.parse(request.body);
      assert.equal(body.store, false);
      assert.match(body.input, /barista/);
      assert.equal(body.text.format.type, 'json_schema');
      assert.equal(body.text.format.strict, true);
      checkStrict(body.text.format.schema);
      assert.equal(body.text.format.schema.properties.objectives.items.properties.say.anyOf[1].type, 'null');
      return Response.json({
        status: 'completed',
        output: [
          { type: 'reasoning', summary: [] },
          { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(raw) }] },
        ],
        usage: { input_tokens: 700, output_tokens: 400, output_tokens_details: { reasoning_tokens: 70 }, total_tokens: 1100 },
      });
    },
  });
  const result = await generator.generate('barista');
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.blueprint, { ...blueprint(), venue: raw.venue });
  assert.deepEqual(result.meta.tokens, { prompt: 700, output: 330, thoughts: 70, total: 1100 });
  assert.equal((await generator.generate(' barista ')).meta.cacheHit, true);
  assert.equal(requests, 1);
});

test('authentication errors produce a clear message and do not log credentials', async () => {
  const generator = createGenerator({
    catalog: CATALOG, apiKey: 'test-key', log: quiet,
    fetcher: async () => Response.json({ error: { message: 'Rejected: test-key' } }, { status: 401 }),
  });
  const result = await generator.generate('barista');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'OpenAI rejected the API key.');
  assert.ok(!JSON.stringify(result).includes('test-key'));
});

test('a generated sushi job has a sushi venue and can serve a plated order at an alternate counter', async () => {
  const step = (id, verb, target, label, item) => ({ id, verb, target, label, ...(item ? { item } : {}) });
  const venue = { name: 'Evening Nigiri', enclosure: 'interior', floor: 'timber', palette: 'warm', lighting: 'dusk' };
  const raw = {
    occupation: 'sushi chef', title: 'Nigiri for Two', briefing: 'Prepare salmon and plate the order.', shell: 'sushi', venue,
    stations: [
      { id: 'prep', anchor: 'N2', prop: 'sushi_prep_board', label: 'Nigiri prep' },
      { id: 'pass', anchor: 'I2', prop: 'sushi_service_counter', label: 'Guest counter' },
      { id: 'backup', anchor: 'I4', prop: 'sushi_service_counter', label: 'Takeout counter' },
    ],
    items: [
      { id: 'fish', anchor: 'S1', prop: 'salmon_fillet', label: 'Fresh salmon' },
      { id: 'plate', anchor: 'S2', prop: 'sushi_serving_plate', label: 'Serving board' },
    ],
    npcs: [{ id: 'lead', name: 'Aki', role: 'Chef', anchor: 'P1', lines: { intro: 'Prepare the salmon order.', done: 'Nice work.' } }],
    objectives: [
      step('o1', 'grab', 'fish', 'Get the salmon'),
      step('o2', 'place', 'prep.board', 'Set salmon on the board', 'fish'),
      step('o3', 'press', 'prep.slice', 'Slice the salmon'),
      step('o4', 'grab', 'plate', 'Pick up the serving board'),
      step('o5', 'place', 'prep.plate', 'Set the board at prep', 'plate'),
      step('o6', 'press', 'prep.plate_up', 'Plate the order'),
      step('o7', 'grab', 'plate', 'Carry the plated order'),
      step('o8', 'place', 'pass.serve', 'Serve the order', 'plate'),
    ],
    event: {
      after: 'o6', delaySec: 2, announce: { npc: 'lead', text: 'This order is now takeout.' }, close: 'pass',
      replaceRemaining: [
        step('r1', 'grab', 'plate', 'Carry the plated order'),
        step('r2', 'place', 'backup.serve', 'Serve at takeout', 'plate'),
      ],
    },
    facts: ['Nigiri is served over formed rice.', 'Individual orders are plated for service.'],
  };
  const generator = createGenerator({
    catalog: FULL_CATALOG, log: quiet,
    callModel: async ({ schema, system }) => {
      assert.deepEqual(schema.properties.shell.enum, ['sushi']);
      assert.match(system, /sushi_service_counter/);
      return { text: JSON.stringify(raw) };
    },
  });
  const result = await generator.generate('sushi restaurant chef');
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.blueprint.venue, venue);
});
