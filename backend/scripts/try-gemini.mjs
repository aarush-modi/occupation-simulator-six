// Manual check: node --env-file-if-exists=.env scripts/try-gemini.mjs barista beekeeper
import { CATALOG } from '../src/catalog.js';
import { loadDemos, pickDemo } from '../src/demos.js';
import { createGenerator } from '../src/generate.js';

const demos = loadDemos(CATALOG);
const gen = createGenerator({ catalog: CATALOG, example: process.env.GEN_EXAMPLE === '1' ? pickDemo(demos, 'barista')?.blueprint : null });
for (const occ of process.argv.slice(2)) {
  const r = await gen.generate(occ);
  console.log(`\n=== ${occ}: ok=${r.ok} ms=${r.meta.ms} firstPassValid=${r.meta.firstPassValid} tokens=${JSON.stringify(r.meta.tokens)}`);
  for (const a of r.meta.attempts ?? []) console.log(`  attempt ${a.attempt}: ${a.ms} ms valid=${a.valid} ${a.error ?? ''}\n    ${(a.errors ?? []).join('\n    ')}`);
  if (r.ok) {
    const b = r.blueprint;
    console.log(`  "${b.title}" shell=${b.shell}`);
    console.log(`  stations: ${b.stations.map((s) => `${s.id}(${s.prop}@${s.anchor})`).join(', ')}`);
    console.log(`  items: ${b.items.map((s) => `${s.id}(${s.prop}@${s.anchor})`).join(', ')}`);
    console.log(`  objectives: ${b.objectives.map((o) => `${o.verb} ${o.target}`).join(' -> ')}`);
    console.log(`  event after ${b.event.after}: "${b.event.announce.text}" close=${b.event.close} -> ${b.event.replaceRemaining.map((o) => `${o.verb} ${o.target}`).join(' -> ')}`);
  } else console.log(`  error: ${r.error}`);
}
