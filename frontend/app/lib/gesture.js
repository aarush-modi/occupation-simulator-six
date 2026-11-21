const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const mix = (from, to, weight) => from + (to - from) * weight;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const flatDistance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const sides = { right: { wrist: 16, shoulder: 12, sign: 1 }, left: { wrist: 15, shoulder: 11, sign: -1 } };
const required = [11, 12, 15, 16, 23, 24, 25, 26, 27, 28];
export const neutral = { x: 0.25, y: 1.01, z: 0.4 };

function inFrame(point) {
  return point && (point.visibility ?? 0) > 0.43 && point.x > -0.02 && point.x < 1.02 && point.y > -0.02 && point.y < 1.02;
}

export function toWorld(player, hand) {
  const sin = Math.sin(player.yaw);
  const cos = Math.cos(player.yaw);
  return { x: player.x + sin * hand.z + cos * hand.x, y: hand.y, z: player.z - cos * hand.z + sin * hand.x };
}

function nearbyTarget(position, player, snapshot, blueprint) {
  const objective = snapshot?.objective;
  for (const prop of snapshot?.props ?? []) {
    if (prop.owner || flatDistance(player, prop.position) > 1.48) continue;
    if (objective?.verb === 'inspect' && objective.item === prop.id && distance(position, prop.position) < 0.35) return { action: 'inspect', id: prop.id };
  }
  const station = blueprint?.stations.find(station => station.id === objective?.station);
  if (objective?.verb === 'press' && station && distance(position, station.control) < 0.37) return { action: 'press', id: station.id };
  const nearby = (snapshot?.props ?? []).filter(prop => !prop.owner && flatDistance(player, prop.position) < 1.48)
    .sort((a, b) => distance(a.position, position) - distance(b.position, position))[0];
  return nearby && distance(nearby.position, position) < 0.40 ? { action: 'grab', id: nearby.id } : null;
}

export class GestureTracker {
  constructor() {
    this.samples = [];
    this.calibration = null;
    this.right = { ...neutral };
    this.left = { ...neutral, x: -neutral.x };
    this.knee = 0;
    this.steps = [];
    this.motion = 0;
    this.turn = 0;
    this.look = 0;
    this.active = { right: null, left: null };
    this.holding = null;
    this.lastAction = -Infinity;
  }

  update(points, world, now, { player, snapshot, blueprint }) {
    if (!required.every(index => inFrame(points?.[index])) || !world?.length) {
      if (!this.calibration) this.samples = [];
      this.active = { right: null, left: null };
      this.steps = [];
      this.motion = 0;
      this.knee = 0;
      return { tracked: false, stage: 'Step back so your shoulders, hands, and feet are visible.' };
    }

    const shoulder = { x: (points[11].x + points[12].x) / 2, y: (points[11].y + points[12].y) / 2 };
    const hip = { x: (points[23].x + points[24].x) / 2, y: (points[23].y + points[24].y) / 2 };
    const span = Math.max(0.045, Math.abs(points[11].x - points[12].x));
    const depthTurn = clamp((world[12].z - world[11].z) / 0.34, -1, 1);
    const knee = (points[25].y - points[26].y) / span;
    const torso = Math.max(0.06, hip.y - shoulder.y);
    const headGap = points[0] ? (shoulder.y - points[0].y) / torso : 0;
    if (!this.calibration) {
      if (Math.abs(knee) > 0.24) this.samples = [];
      else this.samples.push({ depthTurn, knee, span, headGap });
      if (this.samples.length < 19) return { tracked: false, stage: 'Stand still with your arms relaxed for calibration.' };
      this.calibration = Object.fromEntries(['depthTurn', 'knee', 'span', 'headGap'].map(key =>
        [key, this.samples.reduce((sum, frame) => sum + frame[key], 0) / this.samples.length]));
    }

    const base = this.calibration;
    const lean = (shoulder.x - hip.x) / base.span;
    const steer = clamp(1.3 * (depthTurn - base.depthTurn) + lean * 0.20, -1, 1);
    this.turn = mix(this.turn, Math.abs(steer) > 0.14 ? steer : 0, 0.30);
    const looking = clamp((headGap - base.headGap) * 3.1, -1, 1);
    this.look = mix(this.look, looking, 0.25);
    const kneeDelta = knee - base.knee;
    const lifted = Math.abs(kneeDelta) > 0.24 ? Math.sign(kneeDelta) : 0;
    if (lifted && lifted !== this.knee) {
      const last = this.steps.at(-1);
      if (!last || (last.side !== lifted && now - last.time > 140)) this.steps.push({ side: lifted, time: now });
      this.knee = lifted;
    }
    this.steps = this.steps.filter(step => now - step.time < 850);
    const elapsed = this.steps.length >= 2 ? this.steps.at(-1).time - this.steps.at(-2).time : Infinity;
    const moving = now - (this.steps.at(-1)?.time ?? -Infinity) < 430 && elapsed < 700;
    this.motion = mix(this.motion, moving ? clamp(0.34 + (530 - elapsed) / 720, 0.34, 1) : 0, 0.42);

    const mirror = Math.sign(points[12].x - points[11].x) || -1;
    for (const [side, ids] of Object.entries(sides)) {
      const wrist = points[ids.wrist];
      const delta = world[ids.shoulder].z - world[ids.wrist].z;
      const reaching = clamp(delta, -0.1, 0.75);
      const target = {
        x: clamp((wrist.x - shoulder.x) / base.span * mirror * 0.50, -0.87, 0.87),
        y: clamp(1.44 + (shoulder.y - wrist.y) / base.span * 0.54, 0.08, 2.18),
        z: clamp(0.30 + reaching * 1.65, 0.12, 1.25),
      };
      this[side] = Object.fromEntries(Object.keys(target).map(key => [key, mix(this[side][key], target[key], 0.57)]));
    }
    const gesture = player ? this.action(now, player, snapshot, blueprint) : {};
    return {
      tracked: true, stage: 'Tracking live',
      move: Math.abs(this.motion) > 0.06 ? this.motion : 0,
      turn: Math.abs(this.turn) > 0.04 ? this.turn : 0,
      look: this.look, right: this.right, left: this.left,
      ...gesture,
    };
  }

  action(now, player, snapshot, blueprint) {
    if (now - this.lastAction < 380) return {};
    if (player.held) {
      const side = player.heldSide || 'right';
      const hand = this[side];
      if (this.holding?.item !== player.held) {
        this.holding = { item: player.held, highest: hand.y, started: now, placed: null };
      }
      const state = this.holding;
      state.highest = Math.max(state.highest, hand.y);
      const position = toWorld(player, hand);
      const mayPlace = (blueprint?.stations ?? []).some(station =>
        !snapshot?.stations.find(item => item.id === station.id)?.closed &&
        flatDistance(station, position) < 0.80 && hand.y > station.y - 0.27 && hand.y < station.y + 0.41);
      const mayPass = snapshot?.players.some(other => other.id !== player.id && other.tracked && !other.held &&
        ['left', 'right'].some(side => other[side].z >= 0.57 && distance(position, toWorld(other, other[side])) < 0.25));
      const mayDrop = hand.y < 0.57;
      if ((mayPlace || mayDrop || mayPass) && now - state.started > 360 && state.highest - hand.y > 0.14) {
        state.placed ??= now;
        if (now - state.placed > 210) return this.fire(now, 'release', side);
      } else state.placed = null;
      return {};
    }

    this.holding = null;
    for (const side of Object.keys(sides)) {
      const hand = this[side];
      const target = nearbyTarget(toWorld(player, hand), player, snapshot, blueprint);
      let state = this.active[side];
      if (target && (!state || target.id !== state.id || target.action !== state.action)) {
        state = { ...target, time: now, y: hand.y, depth: hand.z, lastSeen: now };
        this.active[side] = state;
      }
      if (!state) continue;
      if (target?.id === state.id) state.lastSeen = now;
      if (state.action === 'grab' && now - state.time > 75 && now - state.lastSeen < 185 && hand.y - state.y > 0.105) {
        return this.fire(now, 'grab', side);
      }
      if (target && state.action === 'press' && now - state.time > 90 && (hand.z - state.depth > 0.09 || now - state.time > 520)) {
        return this.fire(now, 'press', side);
      }
      if (target && state.action === 'inspect' && now - state.time > 680) return this.fire(now, 'inspect', side);
      if (now - state.lastSeen > 185) this.active[side] = null;
      else if (state.action === 'grab') state.y = Math.min(state.y, hand.y);
    }
    return {};
  }

  fire(now, action, side) {
    this.lastAction = now;
    this.active = { right: null, left: null };
    return { action, side };
  }
}
