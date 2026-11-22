import { z } from 'zod';
import { propCatalog, stationCatalog } from './catalog.js';

const label = z.string().trim().min(1).max(90);
const copy = z.string().trim().min(1).max(280);
const id = z.string().regex(/^[a-z][a-z0-9-]{0,23}$/);
const themes = ['cafe', 'warehouse', 'garden', 'studio', 'clinic', 'workshop'];
const slots = ['left-back', 'left-middle', 'left-front', 'right-back', 'right-middle', 'right-front', 'back-left', 'back-right'];
export const scenarioSchema = z.object({
  occupation: label, title: label, briefing: copy, takeaway: copy,
  theme: z.enum(themes),
  stations: z.array(z.object({ id, label, slot: z.enum(slots), asset: id })).min(2).max(8),
  props: z.array(z.object({ id, label, station: id, asset: id, color: z.enum(['mint', 'gold', 'rose', 'blue', 'violet', 'neutral']) })).min(1).max(12),
  objectives: z.array(z.object({
    verb: z.enum(['place', 'press', 'inspect']), item: id, station: id,
    instruction: label, feedback: label,
  })).min(2).max(8),
  npcs: z.array(z.object({ name: label, role: label, goal: z.enum(['requester', 'helper', 'supervisor']), greeting: label, waiting: label, closing: label })).min(1).max(3),
  events: z.array(z.object({
    afterObjective: z.int().min(1).max(7),
    type: z.enum(['redirect', 'rush', 'message']),
    station: z.union([id, z.literal('')]),
    message: copy,
  })).max(4),
});

const anchors = {
  'left-back': [-3.55, -2.7], 'left-middle': [-3.55, -0.1], 'left-front': [-3.55, 2.5],
  'right-back': [3.55, -2.7], 'right-middle': [3.55, -0.1], 'right-front': [3.55, 2.5],
  'back-left': [-1.35, -4.15], 'back-right': [1.35, -4.15],
};

export function compileScenario(input) {
  const plan = scenarioSchema.parse(input);
  const stations = plan.stations.map(station => {
    const [x, z] = anchors[station.slot];
    const back = station.slot.startsWith('back-');
    const inward = back ? { x: 0, z: 1 } : { x: -Math.sign(x), z: 0 };
    const asset = Object.hasOwn(stationCatalog, station.asset) ? stationCatalog[station.asset] : null;
    if (!asset) throw new Error(`Unknown station asset: ${station.asset}.`);
    const { kind, height: y } = asset;
    return {
      ...station, kind, x, z, y, width: back ? 1.8 : 1.1, depth: back ? 1.1 : 1.8,
      control: { x: x + inward.x * 0.58, y: y + 0.43, z: z + inward.z * 0.58 },
      inward,
    };
  });
  const byStation = new Map(stations.map(station => [station.id, station]));
  if (byStation.size !== stations.length || new Set(stations.map(s => s.slot)).size !== stations.length) {
    throw new Error('Stations need unique IDs and distinct layout slots.');
  }
  const itemLocations = new Map();
  const props = plan.props.map(prop => {
    if (itemLocations.has(prop.id)) throw new Error('Prop IDs must be unique.');
    const station = byStation.get(prop.station);
    const count = [...itemLocations.values()].filter(id => id === prop.station).length;
    if (!station || count >= 2) throw new Error('Props need a valid station with at most two props.');
    itemLocations.set(prop.id, prop.station);
    const asset = Object.hasOwn(propCatalog, prop.asset) ? propCatalog[prop.asset] : null;
    if (!asset) throw new Error(`Unknown prop asset: ${prop.asset}.`);
    const { size, shape } = asset;
    const offset = count ? 0.42 : -0.22;
    return {
      ...prop, shape, size,
      spawn: {
        x: station.x + Math.abs(station.inward.z) * offset,
        y: station.y + size[1] / 2 + 0.025,
        z: station.z + Math.abs(station.inward.x) * offset,
      },
    };
  });

  const redirects = new Map();
  for (const event of plan.events) {
    const next = plan.objectives[event.afterObjective];
    if (!next) throw new Error('An event must occur before the shift ends.');
    if (event.type !== 'redirect') continue;
    const station = byStation.get(event.station);
    if (redirects.has(event.afterObjective) || next.verb !== 'place' ||
        !station || !['dropoff', 'counter', 'bin'].includes(station.kind) || next.station === event.station) {
      throw new Error('A redirect must change the next placement to a different drop-off, counter, or bin.');
    }
    redirects.set(event.afterObjective, event.station);
  }

  const closed = new Set();
  for (const [index, objective] of plan.objectives.entries()) {
    const redirect = redirects.get(index);
    if (redirect) closed.add(objective.station);
    const station = byStation.get(redirect || objective.station);
    if (!station || !byStation.has(objective.station) || closed.has(station.id) || !itemLocations.has(objective.item)) {
      throw new Error('An objective refers to an unavailable station or missing prop.');
    }
    const location = itemLocations.get(objective.item);
    if (objective.verb === 'place') {
      if (location === station.id || [...itemLocations.values()].filter(id => id === station.id).length >= 2) {
        throw new Error('A placement needs a different destination with room for the prop.');
      }
      itemLocations.set(objective.item, station.id);
    } else if (location !== station.id || (objective.verb === 'press' && station.kind !== 'machine')) {
      throw new Error('Inspection and machine operation require the listed item at the station.');
    }
  }
  return { ...plan, version: 1, bounds: { x: 5, z: 5 }, stations, props };
}
