// Layout pass: arrange a shift's stations and decor the way a real workplace is laid out, whatever anchors the
// generator picked. Machines, fridges, ovens and storage stand along the walls in the order the work uses them (the
// back wall reads left to right like a real bar or line); the service counter sits at the front between customers
// and staff, turned so staff work it from behind; the middle of the room only holds things that really stand free
// (a patient bed, a dental chair, a stretcher). Decor that has no sensible place is dropped rather than left in
// the middle. Only anchors change, so the shift plays exactly as validated.
import { ANCHORS } from './layout.js';

const BACK = ['N1', 'N2', 'N3', 'N4', 'N5'];
const SIDE = ['W1', 'E1', 'W2', 'E2'];
const MIDDLE = ['I1', 'I2'];
const FRONT = [['C1', 'I4'], ['C2', 'I3']]; // [service counter anchor, the island at the same spot]

const SERVICE = ['pickup', 'serve', 'service', 'register', 'checkout', 'till', 'reception', 'cashier'];
const FREESTANDING = ['bed', 'stretcher', 'dental', 'exam', 'manicure', 'lift', 'island'];
const SEATING = ['seat', 'seating', 'chair', 'stool', 'table', 'armchair'];
const AT_COUNTER = ['display']; // a pastry or product case stands by the counter, facing customers
const SIGNS = ['menu', 'sign', 'board', 'poster'];
const NEAR_FRONT = ['W2', 'E2', 'W1', 'E1']; // side-wall spots closest to the entrance first
const FLAT = ['rug', 'mat'];

const has = (tags, list) => (tags ?? []).some((t) => list.includes(t));

/** First objective index that uses each station (as a target, or by taking an item out of it). */
function firstUse(bp) {
  const order = new Map();
  const steps = [...(bp.objectives ?? []), ...(bp.event?.replaceRemaining ?? [])];
  const itemHome = new Map((bp.items ?? []).map((it) => [it.id, String(it.anchor ?? '')]));
  steps.forEach((o, i) => {
    const at = o.verb === 'grab' ? itemHome.get(o.target) ?? '' : o.verb === 'talk' ? '' : String(o.target ?? '');
    const station = at.includes('.') ? at.slice(0, at.indexOf('.')) : at;
    if (station && !order.has(station)) order.set(station, i);
  });
  return order;
}

export function arrangeLayout(bp, catalog) {
  if (!bp?.stations?.length || bp.game?.kind === 'sparring') return bp;
  const recipes = new Map(catalog.map((r) => [r.id, r]));
  const tagsOf = (prop) => recipes.get(prop)?.tags ?? [];
  const used = new Set();
  const take = (list) => {
    const id = list.find((a) => !used.has(a) && ANCHORS[a]);
    if (id) used.add(id);
    return id ?? null;
  };
  // A front spot is one place: its counter anchor and its island anchor are never both used.
  const takeFront = (kind) => {
    const pair = FRONT.find(([c, i]) => !used.has(c) && !used.has(i));
    if (!pair) return null;
    used.add(pair[0]); used.add(pair[1]);
    return kind === 'counter' ? pair[0] : pair[1];
  };

  // Stations in the order the work reaches them; copies of the same equipment (main + backup) side by side.
  const order = firstUse(bp);
  const rank = (st) => order.get(st.id) ?? 999;
  const groupRank = new Map();
  for (const st of bp.stations) groupRank.set(st.prop, Math.min(groupRank.get(st.prop) ?? 999, rank(st)));
  const stations = [...bp.stations].sort((a, b) => (groupRank.get(a.prop) - groupRank.get(b.prop)) || (rank(a) - rank(b)));

  const placed = new Map();
  for (const st of stations.filter((s) => has(tagsOf(s.prop), SERVICE))) placed.set(st.id, takeFront('counter'));
  for (const st of stations.filter((s) => !placed.has(s.id) && has(tagsOf(s.prop), FREESTANDING))) placed.set(st.id, take(MIDDLE) ?? takeFront('island'));
  for (const st of stations.filter((s) => !placed.get(s.id))) placed.set(st.id, take(BACK) ?? take(SIDE) ?? take(MIDDLE) ?? takeFront('island'));

  const decor = [];
  const priority = (d) => (has(tagsOf(d.prop), AT_COUNTER) ? 0 : 1);
  for (const d of [...(bp.decor ?? [])].sort((a, b) => priority(a) - priority(b))) {
    const tags = tagsOf(d.prop);
    const kind = recipes.get(d.prop)?.kind;
    let anchor;
    if (has(tags, AT_COUNTER)) anchor = takeFront('island') ?? take(NEAR_FRONT);
    else if (has(tags, SIGNS)) anchor = take(NEAR_FRONT);
    else if (kind === 'furniture' && has(tags, SEATING)) anchor = takeFront('island'); // customer seating out front only
    else if (has(tags, FLAT)) anchor = take(MIDDLE);
    else anchor = take(SIDE) ?? take(BACK);
    if (anchor) decor.push({ ...d, anchor });
  }

  return {
    ...bp,
    stations: bp.stations.map((st) => ({ ...st, anchor: placed.get(st.id) ?? st.anchor })),
    decor,
  };
}
