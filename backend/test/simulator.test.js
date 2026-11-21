import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { Duplex, Readable } from 'node:stream';
import WebSocket from 'ws';
import test from 'node:test';
import { propCatalog, stationCatalog } from '../src/catalog.js';
import { createGenerator } from '../src/gemini.js';
import { RoomRegistry } from '../src/rooms.js';
import { compileScenario } from '../src/scenario.js';
import { createWorkshiftServer } from '../src/server.js';
import { Simulation } from '../src/simulation.js';

const raw = {
  title: 'Training café', occupation: 'Barista', theme: 'cafe',
  briefing: 'Brew an espresso and serve the customer.',
  takeaway: 'An order moves from preparation through handoff.',
  stations: [
    { id: 'cups', label: 'Cup shelf', slot: 'left-front', asset: 'cup-shelf' },
    { id: 'brew', label: 'Brewer', slot: 'left-middle', asset: 'espresso-machine' },
    { id: 'pickup', label: 'Pickup counter', slot: 'right-middle', asset: 'pickup-counter' },
    { id: 'window', label: 'Service window', slot: 'right-back', asset: 'service-window' },
  ],
  props: [{ id: 'cup', label: 'Espresso cup', station: 'cups', asset: 'espresso-cup', color: 'gold' }],
  objectives: [
    { verb: 'place', item: 'cup', station: 'brew', instruction: 'Seat the cup.', feedback: 'Ready to brew.' },
    { verb: 'press', item: 'cup', station: 'brew', instruction: 'Brew the espresso.', feedback: 'Espresso ready.' },
    { verb: 'place', item: 'cup', station: 'pickup', instruction: 'Serve the cup.', feedback: 'Order served.' },
  ],
  npcs: [{ name: 'Robin', role: 'Customer', goal: 'requester', greeting: 'One espresso, please.', waiting: 'I can wait here.', closing: 'Thank you!' }],
  events: [{ afterObjective: 2, type: 'redirect', station: 'window', message: 'Pickup is closed. Please use the service window.' }],
};

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  messages = [];
  send(message) { this.messages.push(JSON.parse(message)); }
  close(code, reason) { this.code = code; this.reason = reason; this.readyState = 3; this.emit('close'); }
  message(message) { this.emit('message', Buffer.from(JSON.stringify(message)), false); }
}

function moveHand(player, position, side = 'right') {
  player.x = position.x;
  player.z = position.z + 0.85;
  player.yaw = 0;
  player[side] = { x: 0, y: position.y, z: 0.85 };
}

function at(room, player, item, station) {
  const entry = room.stations.get(station);
  const prop = room.props.get(item);
  const position = { x: entry.x, y: entry.y + prop.size[1] / 2 + 0.02, z: entry.z };
  prop.body.setTranslation(position, true);
  moveHand(player, position);
}

test('compiler resolves catalog assets and rejects unknown assets, collisions, and impossible objectives', () => {
  const spec = compileScenario(raw);
  assert.equal(spec.props[0].shape, 'cup');
  assert.equal(spec.stations.find(station => station.id === 'brew').kind, 'machine');
  assert.ok(Object.keys(propCatalog).length + Object.keys(stationCatalog).length >= 100);
  for (const mutate of [
    input => { input.props[0].asset = 'imaginary-asset'; },
    input => { input.stations[1].slot = input.stations[0].slot; },
    input => { input.objectives.reverse(); },
    input => { input.events[0].station = 'pickup'; },
    input => { input.objectives[1].station = 'cups'; },
  ]) {
    const input = structuredClone(raw);
    mutate(input);
    assert.throws(() => compileScenario(input));
  }
});

test('authoritative physics arbitrates grabs, hands off props, and completes a redirected shift', () => {
  const room = new Simulation(compileScenario(raw));
  try {
    const host = room.addPlayer('host', 0);
    const guest = room.addPlayer('guest', 1);
    const cup = room.props.get('cup');
    moveHand(host, cup.body.translation());
    moveHand(guest, cup.body.translation());
    room.interact(host, 'grab', 'right');
    room.interact(guest, 'grab', 'right');
    assert.equal(cup.owner, 'host');
    assert.equal(guest.held, null);
    guest.active = true;
    room.interact(host, 'release', 'right');
    assert.equal(cup.owner, 'guest');
    assert.equal(host.held, null);
    guest.active = false;

    at(room, guest, 'cup', 'brew');
    room.interact(guest, 'release', 'right');
    assert.equal(room.completed, 1);
    moveHand(guest, room.stations.get('brew').control);
    room.interact(guest, 'press', 'right');
    assert.equal(room.stations.get('brew').cycles, 1);
    assert.equal(cup.processed, true);
    assert.equal(room.stations.get('pickup').closed, true);
    assert.equal(room.objective.station, 'window');

    moveHand(guest, cup.body.translation());
    room.interact(guest, 'grab', 'right');
    at(room, guest, 'cup', 'pickup');
    room.interact(guest, 'release', 'right');
    assert.equal(room.completed, 2);
    moveHand(guest, cup.body.translation());
    room.interact(guest, 'grab', 'right');
    at(room, guest, 'cup', 'window');
    room.interact(guest, 'release', 'right');
    assert.equal(room.snapshot().objective, null);
    assert.equal(room.snapshot().completed, 3);
    assert.equal(room.snapshot().npcs[0].state, 'satisfied');
  } finally { room.dispose(); }
});

test('tracking loss stops locomotion and releases the held object after the grace period', () => {
  const room = new Simulation(compileScenario(raw));
  try {
    const player = room.addPlayer('host', 0);
    const prop = room.props.get('cup');
    moveHand(player, prop.body.translation());
    const motion = { type: 'motion', seq: 1, tracked: true, move: 0.5, turn: 0, look: 0, right: player.right, left: player.left, action: 'grab' };
    room.accept(player.id, motion, 5000);
    assert.equal(prop.owner, player.id);
    room.accept(player.id, { ...motion, seq: 2, tracked: false }, 5100);
    room.tick(5300);
    assert.equal(room.snapshot().players[0].moving, 0);
    assert.equal(prop.owner, player.id);
    room.tick(6200);
    assert.equal(prop.owner, null);
    assert.equal(player.held, null);
  } finally { room.dispose(); }
});

test('room admits a guest during generation and gives both players the same world and reconnect identity', async () => {
  const registry = new RoomRegistry({ generate: async () => compileScenario(raw) });
  try {
    const room = registry.create({ prompt: 'barista' });
    const first = new Socket();
    const guest = new Socket();
    registry.join(room, first);
    registry.join(room, guest);
    assert.ok(first.messages.some(message => message.status === 'generating'));
    await new Promise(resolve => setImmediate(resolve));
    registry.tick(Date.now(), true);
    assert.deepEqual(first.messages.find(message => message.type === 'world'), guest.messages.find(message => message.type === 'world'));
    assert.equal(guest.messages.at(-1).players.length, 2);
    const identity = first.messages.find(message => message.type === 'welcome');
    first.close();
    const reconnection = new Socket();
    registry.join(room, reconnection, identity.token);
    assert.equal(reconnection.messages[0].playerId, identity.playerId);
    assert.equal(reconnection.messages.at(-1).players.length, 2);
  } finally { registry.dispose(); }
});

test('Gemini generation sends catalog and repairs an invalid blueprint once before caching it', async () => {
  const requests = [];
  const generate = createGenerator({
    apiKey: 'test-key', timeout: 3000,
    fetcher: async (url, config) => {
      const payload = JSON.parse(config.body);
      requests.push(payload);
      assert.match(url, /interactions$/);
      return Response.json({ steps: [{ type: 'model_output', content: [
        { type: 'text', text: JSON.stringify(requests.length === 1 ? {} : raw) },
      ] }] });
    },
  });
  const a = await generate({ prompt: ' Barista ' });
  const b = await generate({ prompt: 'barista' });
  assert.equal(a, b);
  assert.equal(requests.length, 2);
  assert.match(requests[0].system_instruction, /espresso-cup/);
  assert.match(requests[1].system_instruction, /validation error/);
  assert.equal(requests[0].response_format.mime_type, 'application/json');
});

test('HTTP routes accept only prompt generation and reject unsupported origins', async () => {
  const { server } = createWorkshiftServer({ origins: ['https://frontend.test'], generate: async () => compileScenario(raw) });
  async function request(method, url, body, origin) {
    const input = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(input, { method, url, headers: { origin }, socket: { remoteAddress: 'local' } });
    const response = new EventEmitter();
    response.writeHead = (status, headers) => Object.assign(response, { status, headers });
    response.end = value => response.emit('result', value);
    const pending = once(response, 'result');
    server.emit('request', input, response);
    const [value] = await pending;
    return { status: response.status, headers: response.headers, body: value ? JSON.parse(value) : undefined };
  }
  try {
    assert.equal((await request('GET', '/health')).status, 200);
    assert.equal((await request('POST', '/api/rooms', { demo: 'barista' })).status, 400);
    assert.equal((await request('POST', '/api/rooms', { prompt: 'barista' }, 'https://bad.test')).status, 403);
    const result = await request('POST', '/api/rooms', { prompt: 'barista' }, 'https://frontend.test');
    assert.equal(result.status, 201);
    assert.match(result.body.roomId, /^[\w-]+$/);
    assert.equal(result.headers['access-control-allow-origin'], 'https://frontend.test');
  } finally { server.emit('close'); }
});

test('body pose calibration starts still, detects alternating steps, and stops after tracking loss', async () => {
  const { GestureTracker } = await import('../../frontend/app/lib/gesture.js');
  const tracker = new GestureTracker();
  const points = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
  Object.assign(points[11], { x: 0.6, y: 0.28 });
  Object.assign(points[12], { x: 0.4, y: 0.28 });
  Object.assign(points[23], { x: 0.55, y: 0.52 });
  Object.assign(points[24], { x: 0.45, y: 0.52 });
  Object.assign(points[15], { x: 0.64, y: 0.47 });
  Object.assign(points[16], { x: 0.36, y: 0.47 });
  points[25].y = points[26].y = 0.72;
  points[27].y = points[28].y = 0.92;
  points[0].y = 0.19;
  const world = structuredClone(points);
  const context = { player: { x: 0, z: 0, yaw: 0 }, snapshot: { props: [], players: [], stations: [] }, blueprint: { stations: [] } };
  const sample = time => tracker.update(points, world, time, context);
  for (let frame = 0; frame < 18; frame++) assert.equal(sample(frame * 40).tracked, false);
  assert.equal(sample(720).move, 0);
  points[16].y = 0.2;
  assert.equal(sample(760).action, undefined);
  points[25].y = 0.61;
  sample(1000);
  points[25].y = 0.72;
  points[26].y = 0.61;
  assert.ok(sample(1250).move > 0.15);
  points[27].visibility = 0;
  assert.equal(sample(1290).tracked, false);
  points[27].visibility = 1;
  points[26].y = 0.72;
  assert.equal(sample(1330).move, 0);
});

test('WebSocket transport upgrades two clients and sends a common generated world', { timeout: 2000 }, async () => {
  const { server, registry } = createWorkshiftServer({ generate: async () => compileScenario(raw) });
  const room = registry.create({ prompt: 'barista' });
  function openClient() {
    const peers = [];
    for (let i = 0; i < 2; i++) {
      peers.push(new Duplex({
        read() {},
        write(chunk, encoding, callback) {
          peers[1 - i].push(Buffer.from(chunk));
          callback();
        },
        final(callback) { peers[1 - i].push(null); callback(); },
      }));
    }
    const [browser, connection] = peers;
    let head = Buffer.alloc(0);
    function upgrade(chunk) {
      head = Buffer.concat([head, chunk]);
      const delimiter = head.indexOf('\r\n\r\n');
      if (delimiter < 0) return;
      connection.off('data', upgrade);
      const [request, ...lines] = head.subarray(0, delimiter).toString().split('\r\n');
      const [method, url] = request.split(' ');
      const headers = Object.fromEntries(lines.map(line => {
        const colon = line.indexOf(':');
        return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
      }));
      server.emit('upgrade', { method, url, headers }, connection, head.subarray(delimiter + 4));
    }
    connection.on('data', upgrade);
    const socket = new WebSocket(`ws://localhost/room/${room.id}`, { createConnection: () => browser });
    const world = new Promise((resolve, reject) => {
      socket.on('error', reject);
      socket.on('message', bytes => {
        const message = JSON.parse(bytes.toString());
        if (message.type === 'world') resolve(message);
      });
    });
    return { socket, world };
  }
  const host = openClient();
  const guest = openClient();
  try {
    const worlds = await Promise.all([host.world, guest.world]);
    assert.deepEqual(worlds[0], worlds[1]);
    assert.equal(registry.rooms.get(room.id).sim.players.size, 2);
  } finally {
    host.socket.terminate();
    guest.socket.terminate();
    server.emit('close');
  }
});
