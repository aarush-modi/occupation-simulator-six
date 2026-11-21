// Shift logic: what each interaction does at each step.
import { useGame, live } from './store';
import { playAlarm, stopAlarm, blip } from './audio';

const g = () => useGame.getState();

export function talkRhodes() {
  const s = g();
  if (s.step === 'report') {
    s.say('Rhodes', "Morning, greenhand. We're drilling at eleven thousand feet, so no heroics.", 4200);
    setTimeout(() => g().say('Rhodes', 'Hard hat and gloves from the locker. Nobody touches my floor without PPE.', 4200), 4300);
    s.advance('ppe');
  } else if (s.step === 'judgment') {
    s.openSkill({
      type: 'choice',
      title: 'Rhodes',
      prompt: "We're six hours behind on this well. Company man wants pipe moving. Skip the flow check and start tripping out?",
      options: ['Run the 30 minute flow check first', 'Skip it and start tripping pipe'],
      onDone: (i) => {
        g().set({ choice: i });
        g().say('Rhodes', i === 0 ? 'Good call. Well is dead. That is how you get to go home.' : "...Your call. Hope that well is as dead as you think.", 4000);
        setTimeout(() => g().set({ phase: 'review' }), 4200);
        document.exitPointerLock?.();
      },
    });
  } else if (s.step === 'done') {
    s.say('Rhodes', 'Go get some sleep.', 2500);
  } else {
    const nag = {
      ppe: 'Locker. Hard hat. Gloves. Now.',
      pipeGrab: 'Pipe rack is starboard. Move.',
      pipePlace: 'Stab that joint in the mousehole by the rotary.',
      torque: 'Roughneck control stand. Make it up to spec.',
    }[s.step];
    s.say('Rhodes', nag ?? 'Stay on task.', 2500);
  }
}

export function useLocker() {
  const s = g();
  if (s.step !== 'ppe') return;
  if (!s.hat) {
    blip(520, 0.08);
    s.set({ hat: true });
    return;
  }
  blip(520, 0.08); blip(780, 0.08);
  s.set({ gloves: true, ppe: true });
  s.advance('pipeGrab');
  s.say('Rhodes', 'Now you look like a hand. Grab a joint off the pipe rack.', 3500);
}

export function useRack() {
  const s = g();
  if (s.step !== 'pipeGrab') return;
  blip(300, 0.12, 0.1, 'triangle');
  s.set({ held: 'pipe' });
  s.advance('pipePlace');
  s.say('Dez', "Heavy, right? Thirty feet of steel. Walk it to the mousehole.", 3500);
}

export function useMousehole() {
  const s = g();
  if (s.step !== 'pipePlace' || s.held !== 'pipe') return;
  blip(200, 0.2, 0.14, 'triangle');
  s.set({ held: null, pipeInHole: true });
  s.advance('torque');
  s.say('Okafor', 'Joint in the hole. Make up the connection on the roughneck stand.', 3500);
}

export function useControlStand() {
  const s = g();
  if (s.step !== 'torque') return;
  s.openSkill({
    type: 'timing',
    title: 'Make-up torque',
    help: 'Press SPACE to stop the torque needle in the green band. 3 attempts.',
    band: [0.66, 0.79],
    attempts: 3,
    onDone: (score) => {
      g().set({ scores: { ...g().scores, torque: score } });
      g().advance('gauge');
      g().say('Okafor', score > 0.6 ? 'Torque good. Nice.' : 'Torque is off spec but it will hold. Go check mud pump one.', 3200);
      if (score > 0.6) setTimeout(() => g().say('Okafor', 'Go read the gauge on mud pump one.', 2800), 3300);
    },
  });
}

export function usePump1() {
  const s = g();
  if (s.step !== 'gauge') return;
  blip(990, 0.05);
  s.say('Radio', 'Pump one reading 3,850 psi. Running high. Trim it on the choke manifold.', 3800);
  s.advance('choke');
}

export function useChoke() {
  const s = g();
  if (s.step === 'choke') {
    s.openSkill({
      type: 'steady',
      title: 'Choke manifold',
      help: 'Hold A / D (or scroll) to turn the handwheel. Keep the pressure needle in the green for 5 seconds.',
      band: [0.42, 0.58],
      hold: 5,
      drift: 0.22,
      onDone: (score) => {
        g().set({ scores: { ...g().scores, choke: score } });
        g().advance('wait');
        g().say('Okafor', 'Pressure is steady. Stand by, circulating bottoms up.', 3500);
        setTimeout(triggerKick, 7000);
      },
    });
  } else if (s.step === 'kickChoke') {
    s.openSkill({
      type: 'steady',
      title: 'Bleed off through pump 2 line',
      help: 'Pressure is surging. Hold A / D to fight it. Keep it in the green for 6 seconds.',
      band: [0.4, 0.55],
      hold: 6,
      drift: 0.5,
      start: 0.9,
      onDone: (score) => {
        g().set({ scores: { ...g().scores, kickChoke: score }, alarm: false });
        stopAlarm();
        live.pressure = 0.48;
        g().advance('judgment');
        g().say('Okafor', 'Pressure is coming down. Well is under control. Breathe.', 3500);
        setTimeout(() => g().say('Rhodes', 'Floorhand. Over here. Now.', 2600), 3600);
      },
    });
  }
}

export function triggerKick() {
  const s = g();
  if (s.step !== 'wait') return;
  s.set({ alarm: true, pump1Closed: true, alarmAt: performance.now() });
  playAlarm();
  s.advance('kickGuard');
  s.say('Okafor', "KICK! We're taking a kick! Pit gain twenty barrels! Close the annular, NOW!", 5000);
}

export function useBopGuard() {
  const s = g();
  if (s.step !== 'kickGuard') return;
  blip(400, 0.1, 0.12, 'square');
  s.set({ guardOpen: true });
  s.advance('kickButton');
}

export function useBopButton() {
  const s = g();
  if (s.step !== 'kickButton') return;
  s.openSkill({
    type: 'presshold',
    title: 'Annular preventer',
    help: 'Hold E for 2 seconds. Do not let go.',
    duration: 2,
    onDone: () => {
      g().set({ annularAt: performance.now() });
      g().advance('kickChoke');
      g().say('Okafor', 'Annular closed! Pump one is down. Bleed it off through pump two on the choke!', 4200);
    },
  });
}
