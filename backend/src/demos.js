// Prevalidated demo shifts (F7). Every backend/src/demos/*.json is validated against the catalog at startup;
// invalid ones are logged and left out so the host can only pick shifts that are known to be playable.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBlueprint } from '../../frontend/src/shared/validate.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'demos');

export const normalise = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function loadDemos(catalog, { log = console } = {}) {
  const demos = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const id = f.replace(/\.json$/, '');
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch (e) {
      log.error(`[demo] ${f}: invalid JSON: ${e.message}`);
      continue;
    }
    const { errors, warnings, blueprint } = checkBlueprint(raw, catalog);
    if (errors.length) {
      log.error(`[demo] ${f}: ${errors.length} error(s), skipped:\n  - ${errors.join('\n  - ')}`);
      continue;
    }
    if (warnings.length) log.warn(`[demo] ${f}: ${warnings.join('; ')}`);
    demos.push({ id, occupation: blueprint.occupation, title: blueprint.title, blueprint });
  }
  return demos;
}

/** Pick the demo matching an occupation (by id or occupation name), else the first one. */
export function pickDemo(demos, occupation) {
  if (!demos.length) return null;
  const want = normalise(occupation);
  if (want) {
    const hit =
      demos.find((d) => normalise(d.id) === want || normalise(d.occupation) === want) ??
      demos.find((d) => want.includes(normalise(d.occupation)) || normalise(d.occupation).includes(want));
    if (hit) return hit;
  }
  return demos[0];
}
