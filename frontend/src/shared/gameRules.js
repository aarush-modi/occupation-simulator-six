// Server-owned rules for generated games. Blueprint values configure the game. Clients send intents.
const REST_MS = 2200;
const STALED_POSE_MS = 2000;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

export function arenaPoints(arena, radius = arena.radius) {
  return Array.from({ length: arena.sides }, (_, i) => {
    const angle = Math.PI / 2 + 2 * Math.PI * i / arena.sides;
    return [Math.cos(angle) * radius, 0, Math.sin(angle) * radius];
  });
}

export function clampToArena(pos, arena, padding = 0.33) {
  const apothem = arena.radius * Math.cos(Math.PI / arena.sides) - padding;
  let scale = 1;
  for (let i = 0; i < arena.sides; i++) {
    const angle = Math.PI / 2 + (2 * i + 1) * Math.PI / arena.sides;
    const projected = pos[0] * Math.cos(angle) + pos[2] * Math.sin(angle);
    if (projected > apothem) scale = Math.min(scale, apothem / projected);
  }
  return scale === 1 ? pos : [pos[0] * scale, pos[1], pos[2] * scale];
}

export function newGame(rules) {
  if (!rules) return undefined;
  const common = { kind: rules.kind, status: 'waiting', deadline: null, points: 0, rivalPoints: 0, result: null, clock: null };
  if (rules.kind === 'challenge') return { ...common, nextNpc: null, lastBonus: 0 };
  return {
    ...common, round: 1, wins: 0, rivalWins: 0, lastTick: null, signalAt: null,
    opponent: { pos: [0, 0, -rules.arena.radius * 0.38], yaw: 0, action: 'ready', speed: 0 },
  };
}

export function gameSpawn(rules, index) {
  return rules?.kind === 'sparring' ? [(index % 2 ? 1 : -1) * (index < 2 ? 0.48 : 1.14), 0, rules.arena.radius * 0.47] : null;
}

function finish(state, result, now, events) {
  const game = state.game;
  game.result = result;
  game.status = 'finished';
  game.clock = now;
  if (game.opponent) {
    game.opponent.action = 'ready';
    game.opponent.speed = 0;
  }
  state.phase = 'review';
  state.score.finishedAt = now;
  events.push({ type: 'review' });
}

export function finishChallenge(state, rules, now, events) {
  const game = state.game;
  finish(state, game.points >= rules.goal && (rules.role === 'ally' || game.points > game.rivalPoints) ? 'win' : 'loss', now, events);
}

export function scoreTask(state, rules, now, events) {
  if (rules?.kind !== 'challenge') return;
  const game = state.game;
  const bonus = rules.role === 'ally' ? Math.floor(state.done.length / 2) : 0;
  if (bonus > game.lastBonus) {
    events.push({ type: 'say', npc: rules.partner, text: 'Nice work. I picked up the next task on my side.' });
  }
  game.lastBonus = bonus;
  game.points = state.done.length * rules.pointsPerTask + bonus;
  // An early win still waits for a scheduled complication to resolve.
  const eventPending = state.event.at !== null && !state.event.fired;
  if (game.status === 'live' && game.points >= rules.goal && !eventPending &&
      (rules.role === 'ally' || game.points > game.rivalPoints)) finish(state, 'win', now, events);
}

function closeRound(state, rules, now, events) {
  const game = state.game;
  if (game.points > game.rivalPoints) game.wins++;
  if (game.points < game.rivalPoints) game.rivalWins++;
  if (game.round >= rules.rounds || game.wins > rules.rounds / 2 || game.rivalWins > rules.rounds / 2) {
    const result = game.wins === game.rivalWins ? 'draw' : game.wins > game.rivalWins ? 'win' : 'loss';
    finish(state, result, now, events);
    return;
  }
  game.status = 'rest';
  game.deadline = now + REST_MS;
  game.opponent.action = 'ready';
  game.opponent.speed = 0;
  events.push({ type: 'gameCue', text: 'Round complete. Next round in a moment.', sound: 'bell' });
}

export function sparringStrike(state, rules, playerId, now, events) {
  const game = state.game;
  const player = state.players[playerId];
  if (rules?.kind !== 'sparring' || game.status !== 'live' || now >= game.deadline || !player.active) return;
  if (now - (player.strikeAt ?? -Infinity) < 460) return;
  player.strikeAt = now;
  player.guard = false;
  const target = game.opponent.pos;
  const gap = distance(player.pos, target);
  const dot = (-Math.sin(player.yaw) * (target[0] - player.pos[0]) - Math.cos(player.yaw) * (target[2] - player.pos[2])) / Math.max(0.1, gap);
  if (gap > 2.35 || dot < 0.53) {
    events.push({ type: 'gameCue', playerId, text: 'Face your opponent and close the distance.' });
    return;
  }
  if (game.opponent.action === 'cover') {
    game.opponent.action = 'ready';
    game.signalAt = now + 480;
    events.push({ type: 'gameCue', text: 'Opponent blocked. Look for an opening.' });
    return;
  }
  game.points++;
  game.opponent.action = 'recoil';
  game.signalAt = now + (rules.style === 'counter' ? 420 : 740);
  events.push({ type: 'gameCue', text: 'Point for your corner.', sound: 'point' });
  if (game.points >= rules.pointsToWin) closeRound(state, rules, now, events);
}

function startRound(game, rules, now, events) {
  game.status = 'live';
  game.deadline = now + rules.roundSeconds * 1000;
  game.points = game.rivalPoints = 0;
  game.opponent.action = 'ready';
  game.opponent.pos = [0, 0, -rules.arena.radius * 0.38];
  game.signalAt = now + 1250;
  events.push({ type: 'gameCue', text: `Round ${game.round}`, sound: 'bell' });
}

export function tickGeneratedGame(state, rules, now, events, rivalStation) {
  const game = state.game;
  if (!game || state.phase !== 'play') return;
  if (game.status === 'waiting') {
    if (!Object.values(state.players).some(p => p.active && now - p.lastSeen < STALED_POSE_MS)) return;
    state.score.startedAt = now;
    if (game.kind === 'sparring') startRound(game, rules, now, events);
    else {
      game.status = 'live';
      game.deadline = now + rules.seconds * 1000;
      game.nextNpc = now + rules.rivalEverySeconds * 1000;
    }
  }
  game.clock = now;
  if (game.kind === 'challenge') {
    if (now >= game.deadline) return finishChallenge(state, rules, now, events);
    if (rules.role === 'rival' && rivalStation && !state.closed.includes(rivalStation) && now >= game.nextNpc) {
      game.rivalPoints += rules.pointsPerTask;
      game.nextNpc = now + rules.rivalEverySeconds * 1000;
      events.push({ type: 'gameCue', text: 'Your rival completed another task.', sound: 'point' });
      if (game.rivalPoints >= rules.goal) finish(state, 'loss', now, events);
    }
    return;
  }

  if (game.status === 'rest') {
    if (now >= game.deadline) {
      game.round++;
      startRound(game, rules, now, events);
    }
    return;
  }
  if (now >= game.deadline) return closeRound(state, rules, now, events);
  const dt = Math.min(0.1, Math.max(0, (now - (game.lastTick ?? now)) / 1000));
  game.lastTick = now;
  const rival = game.opponent;
  const near = Object.entries(state.players).filter(([, p]) => p.active && now - p.lastSeen < STALED_POSE_MS)
    .sort((a, b) => distance(rival.pos, a[1].pos) - distance(rival.pos, b[1].pos))[0];
  rival.speed = 0;
  if (!near) return;
  const [playerId, player] = near;
  const gap = distance(rival.pos, player.pos);
  rival.yaw = Math.atan2(player.pos[0] - rival.pos[0], player.pos[2] - rival.pos[2]);
  if (gap > 1.62 && rival.action !== 'windup') {
    const step = Math.min(gap - 1.55, dt * (rules.style === 'pressure' ? 1.65 : 1.16));
    rival.pos = clampToArena([rival.pos[0] + Math.sin(rival.yaw) * step, 0, rival.pos[2] + Math.cos(rival.yaw) * step], rules.arena);
    rival.speed = 0.75;
  }
  if (now < game.signalAt) return;
  if (rival.action === 'windup') {
    if (gap <= 2.05 && !player.guard) {
      game.rivalPoints++;
      events.push({ type: 'gameCue', playerId, text: 'Opponent scored a point.', sound: 'point' });
      if (game.rivalPoints >= rules.pointsToWin) return closeRound(state, rules, now, events);
    } else events.push({ type: 'gameCue', playerId, text: player.guard ? 'Guard held.' : 'You stepped out of reach.' });
    rival.action = 'strike';
    game.signalAt = now + 370;
  } else if (rival.action === 'cover' || rival.action === 'strike') {
    rival.action = 'ready';
    game.signalAt = now + 680;
  } else if (gap < 1.98) {
    const counter = rules.style === 'counter' && now - (player.strikeAt ?? -Infinity) < 630;
    rival.action = counter ? 'cover' : 'windup';
    game.signalAt = now + (counter ? 620 : rules.style === 'pressure' ? 560 : 760);
    if (!counter) events.push({ type: 'gameCue', playerId, text: 'Opponent winding up. Raise both open palms to guard.' });
  }
}
