// WebSocket client for one room: lobby status, welcome, 20 Hz snapshots, events, and intents.
// Keeps a short snapshot buffer so remote players can be rendered ~100 ms in the past and interpolated.
import { useShift } from './store';
import { WS_BASE, BACKEND } from './world';
import { blip, contactSound, playAlarm, stopAlarm } from '../game/audio';
import { lockTalk } from './talkLock';

export const INTERP_MS = 110;
const snaps = []; // { t, players, people }
// Local pose, written by the first-person player every frame, sent at 20 Hz.
export const localPose = { pos: [0, 0, 0], yaw: 0, pitch: 0, guard: false, ready: false };
// Set when the server puts us somewhere far from where we think we are (respawn, clamp); the player snaps to it.
export const reconcile = { pos: null };

const sentPoses = []; // { t, pos } recent poses we sent, to tell server lag from a server-side correction
let ws = null, roomId = null, name = 'Player', retry = 0, closedByUs = false, poseTimer = null, rejoinTimer = null;
const listeners = new Set(); // raw event listeners (debug, tests)
export function onEvents(cb) { listeners.add(cb); return () => listeners.delete(cb); }

export function connect(id, playerName) {
  roomId = id; name = playerName; closedByUs = false;
  snaps.length = 0;
  open();
  clearInterval(poseTimer);
  poseTimer = setInterval(sendPose, 50);
  return disconnect;
}

export function disconnect() {
  closedByUs = true;
  clearInterval(poseTimer); clearTimeout(rejoinTimer);
  try { ws?.close(); } catch {}
  ws = null;
}

function open() {
  const set = useShift.getState().set;
  set({ conn: retry ? 'reconnecting' : 'connecting' });
  const sock = new WebSocket(`${WS_BASE}/room/${encodeURIComponent(roomId)}`);
  ws = sock;
  sock.onopen = () => {
    retry = 0;
    set({ conn: 'open' });
    sendJoin();
  };
  sock.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handle(msg);
  };
  sock.onclose = () => {
    if (ws !== sock || closedByUs) return;
    retry++;
    set({ conn: 'reconnecting' });
    // A room that the server no longer knows (restart, expiry) will never come back: say so instead of spinning.
    if (retry === 3 || retry % 8 === 0) {
      fetchRoom(roomId).catch((e) => { if (e.gone) { closedByUs = true; clearInterval(poseTimer); set({ status: 'gone', conn: 'closed' }); } });
    }
    setTimeout(() => { if (!closedByUs) open(); }, Math.min(4000, 400 * 2 ** Math.min(retry, 4)));
  };
  sock.onerror = () => {};
}

// Rejoin with our previous player id so a reconnect resumes the same avatar (and held item).
const pidKey = () => `workshift.pid.${roomId}`;
function sendJoin() {
  let you = useShift.getState().you;
  if (!you) { try { you = sessionStorage.getItem(pidKey()); } catch {} }
  send({ t: 'join', name, ...(you ? { id: you } : {}) });
}

export function send(intent) {
  if (ws?.readyState === 1) { ws.send(JSON.stringify(intent)); return true; }
  return false;
}

function sendPose() {
  const s = useShift.getState();
  if (!localPose.ready || !s.you || s.status !== 'ready') return;
  const pos = localPose.pos.map((v) => Math.round(v * 1000) / 1000);
  sentPoses.push({ t: performance.now(), pos });
  while (sentPoses.length && performance.now() - sentPoses[0].t > 1500) sentPoses.shift();
  send({ t: 'pose', pos, yaw: Math.round(localPose.yaw * 1000) / 1000, pitch: Math.round(localPose.pitch * 1000) / 1000, active: Boolean(s.started), guard: localPose.guard });
}

function pushSnap(state) {
  if (!state?.players) return;
  snaps.push({ t: performance.now(), players: state.players, people: state.people });
  while (snaps.length > 30) snaps.shift();
}

function handle(msg) {
  const st = useShift.getState();
  const set = st.set;
  switch (msg.type) {
    case 'status': {
      const patch = { status: msg.status, error: msg.error ?? null };
      if (msg.status === 'generating' && st.status !== 'generating') patch.generatingSince = performance.now();
      if (msg.blueprint) patch.blueprint = msg.blueprint;
      if (msg.occupation) patch.occupation = msg.occupation;
      set(patch);
      // Ready but no welcome yet: (re)join so the server seats us in the new simulation.
      if (msg.status === 'ready' && !useShift.getState().state) {
        clearTimeout(rejoinTimer);
        rejoinTimer = setTimeout(() => { if (!useShift.getState().state) sendJoin(); }, 1500);
      }
      break;
    }
    case 'welcome': {
      clearTimeout(rejoinTimer);
      try { if (msg.you) sessionStorage.setItem(pidKey(), msg.you); } catch {}
      const first = !st.state;
      set({ you: msg.you, state: msg.state ?? st.state, blueprint: msg.blueprint ?? st.blueprint, status: msg.blueprint || st.blueprint ? 'ready' : st.status });
      pushSnap(msg.state);
      const me = msg.state?.players?.[msg.you];
      if (me && (first || !localPose.ready)) reconcile.pos = me.pos;
      break;
    }
    case 'snapshot': {
      if (!msg.state) break;
      const prev = st.state;
      pushSnap(msg.state);
      set({ state: msg.state, status: 'ready' });
      const me = msg.state.players?.[st.you];
      if (me && localPose.ready) {
        // The server only moves us by clamping our poses, so correct only when its position matches none of the
        // poses we sent recently (it is not just lagging behind us) and is far from where we are.
        const far = (p) => Math.hypot(me.pos[0] - p[0], me.pos[2] - p[2]) > 0.75;
        if (sentPoses.length && far(localPose.pos) && sentPoses.every((sp) => far(sp.pos))) reconcile.pos = me.pos;
      }
      if (prev && prev.phase !== 'review' && msg.state.phase === 'review') onReview();
      break;
    }
    case 'events':
      for (const ev of msg.events ?? []) onEvent(ev);
      for (const cb of listeners) cb(msg.events ?? []);
      break;
    case 'error':
      useShift.getState().toastMsg(msg.error ?? 'Server error');
      break;
    default:
  }
}

function npcName(id) {
  const bp = useShift.getState().blueprint;
  return useShift.getState().state?.people?.[id]?.name ?? bp?.npcs?.find((n) => n.id === id)?.name ?? id;
}

let alarmTimer = null;
function onEvent(ev) {
  const s = useShift.getState();
  switch (ev.type) {
    case 'gameCue':
      if (!ev.playerId || ev.playerId === s.you) s.toastMsg(ev.text, 'info', 1500);
      if (ev.sound === 'bell') blip(860, 0.38, 0.10, 'triangle');
      if (ev.sound === 'point') blip(520, 0.09, 0.08);
      break;
    case 'say':
      if (!ev.playerId || ev.playerId === s.you) s.say(npcName(ev.npc), ev.text);
      if (ev.playerId && ev.playerId === s.you) lockTalk(ev.npc, 5000); // addressed to us: face them
      break;
    case 'objective': {
      const obj = s.state?.objectives?.find((o) => o.id === ev.id);
      blip(880, 0.08, 0.08); setTimeout(() => blip(1320, 0.1, 0.08), 90);
      s.set({ lastObjective: { label: obj?.label ?? 'Done', id: Math.random() } });
      break;
    }
    case 'eventFired':
      s.showBanner(ev.announce?.text ?? 'Something changed', npcName(ev.announce?.npc));
      playAlarm();
      clearTimeout(alarmTimer);
      alarmTimer = setTimeout(stopAlarm, 3500);
      break;
    case 'denied':
      if (ev.playerId === s.you) deniedHandler?.(ev.reason);
      break;
    case 'used':
      if (ev.playerId === s.you) contactSound('pressed', s.state?.items?.[ev.item]?.tags);
      break;
    case 'standing':
      // The whole team shares a shift's standing.
      s.set({ standingFlash: { delta: ev.delta, reason: ev.reason, id: Math.random(), at: Date.now() } });
      if (ev.delta < 0) blip(220, 0.12, 0.07, 'square'); else blip(990, 0.08, 0.06);
      break;
    case 'replanned':
      s.showBanner(ev.change, null, 6500, true);
      blip(660, 0.1, 0.07, 'triangle'); setTimeout(() => blip(880, 0.1, 0.07, 'triangle'), 110);
      break;
    case 'fired':
      stopAlarm();
      blip(300, 0.25, 0.08, 'square'); setTimeout(() => blip(200, 0.4, 0.08, 'square'), 220);
      break;
    case 'grabbed': case 'placed': case 'handoff': case 'pressed':
      if (ev.playerId === s.you || ev.from === s.you || ev.to === s.you) contactSound(ev.type, s.state?.items?.[ev.item]?.tags);
      if (ev.type === 'handoff' && ev.to === s.you) s.toastMsg(`${s.state?.players?.[ev.from]?.name ?? 'Teammate'} handed you ${labelOfItem(ev.item)}`, 'info');
      break;
    case 'review':
      onReview();
      break;
    default:
  }
}

function labelOfItem(id) {
  return useShift.getState().blueprint?.items?.find((i) => i.id === id)?.label ?? id;
}

function onReview() {
  stopAlarm();
}

let deniedHandler = null;
export function onDenied(cb) { deniedHandler = cb; }

/** Interpolated pose of a player at render time. */
export function samplePlayer(id) { return samplePose('players', id); }
export function sampleNpc(id) { return samplePose('people', id); }

function samplePose(group, id, now = performance.now()) {
  const t = now - INTERP_MS;
  let a = null, b = null;
  for (let i = snaps.length - 1; i >= 0; i--) {
    if (snaps[i].t <= t) { a = snaps[i]; b = snaps[i + 1] ?? null; break; }
  }
  if (!a) a = snaps[0];
  const pa = a?.[group]?.[id];
  if (!pa) return null;
  const pb = b?.[group]?.[id];
  if (!pb) return pa;
  const k = Math.min(1, Math.max(0, (t - a.t) / Math.max(1, b.t - a.t)));
  let dy = pb.yaw - pa.yaw;
  while (dy > Math.PI) dy -= Math.PI * 2;
  while (dy < -Math.PI) dy += Math.PI * 2;
  return {
    ...pb,
    pos: [pa.pos[0] + (pb.pos[0] - pa.pos[0]) * k, pa.pos[1] + (pb.pos[1] - pa.pos[1]) * k, pa.pos[2] + (pb.pos[2] - pa.pos[2]) * k],
    yaw: pa.yaw + dy * k,
    pitch: (pa.pitch ?? 0) + ((pb.pitch ?? 0) - (pa.pitch ?? 0)) * k,
  };
}

// HTTP helpers
export async function createRoom(occupation) {
  const r = await fetch(`${BACKEND}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ occupation }) });
  if (!r.ok) throw new Error(`Could not create a room (${r.status})`);
  return r.json();
}

export async function chooseDemo(id, occupation) {
  const r = await fetch(`${BACKEND}/api/rooms/${encodeURIComponent(id)}/demo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ occupation }) })
    .catch(() => { throw new Error('Could not reach the shift server. Is it running?'); });
  if (r.status === 404) { useShift.getState().set({ status: 'gone' }); throw new Error('This room no longer exists'); }
  if (!r.ok) throw new Error(`Demo shift failed (${r.status})`);
  return r.json().catch(() => ({}));
}

export async function fetchRoom(id) {
  const r = await fetch(`${BACKEND}/api/rooms/${encodeURIComponent(id)}`);
  if (!r.ok) throw Object.assign(new Error(r.status === 404 ? 'This room no longer exists' : `Room lookup failed (${r.status})`), { gone: r.status === 404 });
  return r.json();
}

export async function fetchDemos() {
  const r = await fetch(`${BACKEND}/api/demos`);
  if (!r.ok) return [];
  return (await r.json()).demos ?? [];
}
