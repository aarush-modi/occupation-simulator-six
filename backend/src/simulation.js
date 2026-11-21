import RAPIER from '@dimforge/rapier3d-compat';
import { z } from 'zod';

await RAPIER.init();

const FIXED_STEP = 1 / 60;
const MISSING_TRACKING = 350;
const RELEASE_AFTER = 1150;
const range = (low, high) => z.number().min(low).max(high);
const hand = z.object({ x: range(-0.9, 0.9), y: range(0.08, 2.2), z: range(0.12, 1.26) });

export const motionMessage = z.object({
  type: z.literal('motion'), seq: z.int().nonnegative(), tracked: z.boolean(),
  move: range(0, 1), turn: range(-1, 1), look: range(-1, 1),
  right: hand, left: hand,
  action: z.enum(['grab', 'release', 'press', 'inspect']).optional(),
  side: z.enum(['right', 'left']).optional(),
});

const palette = ['#47ded2', '#ae94ff', '#fec878', '#f287a9'];
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const flatDistance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const initialHand = { x: 0.26, y: 0.99, z: 0.48 };

function handPosition(player, side) {
  const hand = player[side];
  const sin = Math.sin(player.yaw);
  const cos = Math.cos(player.yaw);
  return { x: player.x + sin * hand.z + cos * hand.x, y: hand.y, z: player.z - cos * hand.z + sin * hand.x };
}

function addBox(world, x, y, z, width, height, depth) {
  world.createCollider(RAPIER.ColliderDesc.cuboid(width / 2, height / 2, depth / 2).setTranslation(x, y, z));
}

export class Simulation {
  constructor(blueprint) {
    this.blueprint = blueprint;
    this.physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.physics.timestep = FIXED_STEP;
    this.players = new Map();
    this.props = new Map();
    this.stations = new Map(blueprint.stations.map(station => [station.id, { ...station, closed: false, cycles: 0 }]));
    this.npcs = blueprint.npcs.map((npc, index) => ({
      ...npc, id: `npc-${index}`, x: -1.35 + index * 1.2, z: -1.4, yaw: Math.PI,
      line: npc.greeting, state: 'requesting',
    }));
    this.feed = [];
    this.completed = 0;
    this.redirect = null;
    this.elapsed = 0;
    this.rush = false;
    this.serial = 0;

    addBox(this.physics, 0, -0.12, 0, 10, 0.24, 10);
    addBox(this.physics, -5.05, 1.25, 0, 0.1, 2.5, 10);
    addBox(this.physics, 5.05, 1.25, 0, 0.1, 2.5, 10);
    addBox(this.physics, 0, 1.25, -5.05, 10, 2.5, 0.1);
    addBox(this.physics, 0, 1.25, 5.05, 10, 2.5, 0.1);
    for (const station of blueprint.stations) {
      addBox(this.physics, station.x, station.y / 2, station.z, station.width, station.y, station.depth);
    }
    for (const prop of blueprint.props) {
      const [width, height, depth] = prop.size;
      const body = this.physics.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(prop.spawn.x, prop.spawn.y, prop.spawn.z).setLinearDamping(0.8).setAngularDamping(3).setCcdEnabled(true));
      const collider = prop.shape === 'cup' || prop.shape === 'bottle'
        ? RAPIER.ColliderDesc.cylinder(height / 2, width / 2)
        : RAPIER.ColliderDesc.cuboid(width / 2, height / 2, depth / 2);
      this.physics.createCollider(collider.setFriction(0.8).setRestitution(0.1), body);
      this.props.set(prop.id, { ...prop, body, owner: null, processed: false });
    }
  }

  dispose() { this.physics.free(); }

  addPlayer(id, slot) {
    const player = {
      id, slot, x: [-0.72, 0.72, -1.65, 1.65][slot], z: 3.55, yaw: slot % 2 ? 0 : -1.12, pitch: -0.20,
      color: palette[slot], right: { ...initialHand }, left: { ...initialHand, x: -0.26 },
      move: 0, turn: 0, look: 0, seq: -1, lastInput: 0, lastTracked: 0, lastAction: -Infinity,
      tracked: false, held: null, side: 'right', hint: '',
    };
    this.players.set(id, player);
    return player;
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (!player) return;
    this.drop(player);
    this.players.delete(id);
  }

  get objective() {
    const objective = this.blueprint.objectives[this.completed];
    return objective && {
      ...objective,
      station: this.redirect ?? objective.station,
      instruction: this.redirect ? `Bring ${this.props.get(objective.item).label} to ${this.stations.get(this.redirect).label}.` : objective.instruction,
    };
  }

  accept(id, message, now = Date.now()) {
    const player = this.players.get(id);
    const result = motionMessage.safeParse(message);
    if (!player || !result.success || result.data.seq <= player.seq) return;
    const input = result.data;
    Object.assign(player, {
      lastInput: now, seq: input.seq, tracked: input.tracked,
      move: input.move, turn: input.turn, look: input.look,
      left: input.left, right: input.right,
    });
    if (input.tracked) player.lastTracked = now;
    if (!input.tracked || !input.action || now - player.lastAction < 170) return;
    player.lastAction = now;
    this.interact(player, input.action, input.side ?? 'right');
  }

  interact(player, action, side) {
    const hand = handPosition(player, side);
    const objective = this.objective;
    if (action === 'grab' && !player.held) {
      const target = this.nearestProp(hand, player);
      if (!target) return;
      target.owner = player.id;
      target.body.setGravityScale(0, true);
      player.held = target.id;
      player.side = side;
      return;
    }
    if (action === 'release' && player.held && player.side === side) {
      const prop = this.props.get(player.held);
      const position = prop.body.translation();
      const receiver = this.nearestReceiver(player, hand);
      if (receiver) {
        player.held = null;
        receiver.player.held = prop.id;
        receiver.player.side = receiver.side;
        prop.owner = receiver.player.id;
        this.publish(`${prop.label} passed to Player ${receiver.player.slot + 1}.`, 'progress');
        return;
      }
      const station = this.nearestPlacement(hand, position, prop.id);
      this.drop(player);
      if (!station) return;
      const spot = this.placementSpot(station, position, prop.id);
      if (!spot) return;
      prop.body.setTranslation({ ...spot, y: station.y + prop.size[1] / 2 + 0.025 }, true);
      prop.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      if (objective?.verb === 'place' && objective.item === prop.id && objective.station === station.id) this.advance();
      return;
    }
    if (player.held || !objective || objective.verb !== action) return;
    const station = this.stations.get(objective.station);
    const prop = this.props.get(objective.item);
    const target = action === 'press' ? station.control : prop.body.translation();
    if (station.closed || prop.owner || !this.onStation(prop.body.translation(), station) || distance(target, hand) > 0.48) return;
    if (action === 'press') {
      station.cycles++;
      prop.processed = true;
    }
    this.advance();
  }

  nearestReceiver(player, position) {
    let selected = null;
    let closest = 0.29;
    for (const other of this.players.values()) {
      if (other === player || !other.active || other.held) continue;
      for (const side of ['left', 'right']) {
        const hand = handPosition(other, side);
        const gap = distance(position, hand);
        if (other[side].z >= 0.57 && gap < closest) {
          selected = { player: other, side };
          closest = gap;
        }
      }
    }
    return selected;
  }

  nearestProp(hand, player) {
    let selected = null;
    let closest = 0.44;
    for (const prop of this.props.values()) {
      const position = prop.body.translation();
      if (prop.owner || flatDistance(position, player) > 1.48) continue;
      const gap = distance(position, hand);
      if (gap < closest) {
        selected = prop;
        closest = gap;
      }
    }
    return selected;
  }

  onStation(position, station) {
    return Math.abs(position.x - station.x) <= station.width / 2 + 0.04 &&
      Math.abs(position.z - station.z) <= station.depth / 2 + 0.04 &&
      position.y > station.y - 0.08 && position.y < station.y + 0.42;
  }

  nearestPlacement(hand, position, item) {
    return [...this.stations.values()].find(station => !station.closed &&
      hand.y <= station.y + 0.49 && hand.y >= station.y - 0.28 &&
      Math.min(flatDistance(hand, station), flatDistance(position, station)) < 0.79 &&
      this.placementSpot(station, position, item));
  }

  placementSpot(station, position, item) {
    const spots = [-0.49, 0, 0.49].map(offset => ({
      x: station.x + Math.abs(station.inward.z) * offset,
      z: station.z + Math.abs(station.inward.x) * offset,
    }));
    return spots.sort((a, b) => flatDistance(a, position) - flatDistance(b, position)).find(spot =>
      [...this.props.values()].every(prop => prop.id === item || prop.owner ||
        !this.onStation(prop.body.translation(), station) || flatDistance(prop.body.translation(), spot) > 0.49));
  }

  drop(player) {
    if (!player.held) return;
    const prop = this.props.get(player.held);
    prop.owner = null;
    prop.body.setGravityScale(1, true);
    prop.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    player.held = null;
  }

  publish(text, type) {
    this.feed.push({ id: ++this.serial, text, type });
    if (this.feed.length > 8) this.feed.shift();
  }

  advance() {
    const last = this.objective;
    this.completed++;
    this.redirect = null;
    this.publish(last.feedback, 'progress');
    const next = this.objective;
    if (!next) {
      this.npcs.forEach(npc => { npc.state = 'satisfied'; npc.line = npc.closing; });
      return;
    }
    for (const event of this.blueprint.events.filter(event => event.afterObjective === this.completed)) {
      this.publish(event.message, 'event');
      if (event.type === 'redirect') {
        this.stations.get(next.station).closed = true;
        this.redirect = event.station;
      }
      if (event.type === 'rush') this.rush = true;
      this.npcs[0].line = event.message;
      this.npcs[0].state = 'responding';
    }
  }

  clearPosition(x, z) {
    return Math.abs(x) <= 4.56 && Math.abs(z) <= 4.56 && [...this.stations.values()].every(station =>
      Math.abs(x - station.x) > station.width / 2 + 0.27 || Math.abs(z - station.z) > station.depth / 2 + 0.27);
  }

  tick(now = Date.now()) {
    this.elapsed += FIXED_STEP;
    for (const player of this.players.values()) {
      const active = player.tracked && now - player.lastInput < MISSING_TRACKING;
      if (active) {
        player.yaw = Math.atan2(Math.sin(player.yaw + player.turn * 1.7 * FIXED_STEP), Math.cos(player.yaw + player.turn * 1.7 * FIXED_STEP));
        player.pitch += ((-0.23 + player.look * 0.52) - player.pitch) * 0.13;
        const step = player.move * 2.45 * FIXED_STEP;
        const x = player.x + Math.sin(player.yaw) * step;
        const z = player.z - Math.cos(player.yaw) * step;
        if (this.clearPosition(x, player.z)) player.x = x;
        if (this.clearPosition(player.x, z)) player.z = z;
      } else if (now - player.lastTracked > RELEASE_AFTER) {
        this.drop(player);
      }

      if (player.held) {
        const prop = this.props.get(player.held);
        const target = handPosition(player, player.side);
        const position = prop.body.translation();
        const gripY = Math.max(prop.size[1] / 2 + 0.025, target.y);
        prop.body.setLinvel({
          x: clamp((target.x - position.x) * 16, -5, 5),
          y: clamp((gripY - position.y) * 16, -5, 5),
          z: clamp((target.z - position.z) * 16, -5, 5),
        }, true);
        prop.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }
      const candidates = [handPosition(player, 'left'), handPosition(player, 'right')];
      const target = active && candidates.map(candidate => this.nearestProp(candidate, player)).find(Boolean);
      player.hint = active ? (player.held || target?.id || '') : '';
      player.active = active;
    }
    this.physics.step();
    for (const prop of this.props.values()) {
      if (prop.body.translation().y < -0.8) {
        if (prop.owner) this.drop(this.players.get(prop.owner));
        prop.body.setTranslation(prop.spawn, true);
        prop.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      }
    }
    this.updateNpcs();
  }

  updateNpcs() {
    if (this.elapsed >= 12) {
      this.npcs.forEach(npc => {
        if (npc.state === 'requesting') { npc.state = 'waiting'; npc.line = npc.waiting; }
      });
    }
    const objective = this.objective;
    const station = objective && this.stations.get(objective.station);
    if (!station) { this.npcs.forEach(npc => { npc.moving = false; }); return; }
    const prop = this.props.get(objective.item).body.translation();
    for (const [index, npc] of this.npcs.entries()) {
      const dest = npc.goal === 'helper'
        ? { x: clamp(prop.x * 0.57, -1.95, 1.95), z: prop.z * 0.70 }
        : npc.goal === 'supervisor'
          ? { x: index * 0.62 - 0.6, z: -2.45 }
          : { x: station.x * 0.46, z: station.z * 0.75 };
      const gap = flatDistance(npc, dest);
      npc.moving = gap > 0.16;
      if (!npc.moving) continue;
      npc.yaw = Math.atan2(dest.x - npc.x, npc.z - dest.z);
      const speed = (this.rush ? 0.98 : 0.6) * FIXED_STEP;
      npc.x += (dest.x - npc.x) / gap * speed;
      npc.z += (dest.z - npc.z) / gap * speed;
    }
  }

  snapshot(now = Date.now()) {
    return {
      type: 'snapshot', time: now, objective: this.objective ?? null, completed: this.completed, total: this.blueprint.objectives.length, feed: this.feed,
      players: [...this.players.values()].map(p => ({
        id: p.id, slot: p.slot, color: p.color, x: p.x, z: p.z, yaw: p.yaw, pitch: p.pitch,
        left: p.left, right: p.right, tracked: p.active ?? false,
        moving: p.active ? p.move : 0, hint: p.hint, held: p.held, heldSide: p.side,
      })),
      props: [...this.props.values()].map(p => ({ id: p.id, position: p.body.translation(), rotation: p.body.rotation(), owner: p.owner, processed: p.processed })),
      stations: [...this.stations.values()].map(s => ({ id: s.id, closed: s.closed, cycles: s.cycles })),
      npcs: this.npcs.map(({ id, name, role, line, state, x, z, yaw, moving }) => ({ id, name, role, line, state, x, z, yaw, moving: moving ? 0.65 : 0 })),
    };
  }
}
