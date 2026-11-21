// WebAudio-synthesized soundscape. No sample files.
let ctx, master, alarmNodes, engineGain, engineOsc;

function noiseBuffer(c, seconds = 2) {
  const b = c.createBuffer(1, c.sampleRate * seconds, c.sampleRate);
  const d = b.getChannelData(0);
  let last = 0;
  for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
  return b;
}

export function startAudio() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain(); master.gain.value = 0.55; master.connect(ctx.destination);

  // wind + ocean: brown noise through filters with slow LFO
  const buf = noiseBuffer(ctx, 4);
  for (const [freq, gain, lfoRate] of [[420, 0.35, 0.07], [160, 0.5, 0.11]]) {
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq;
    const g = ctx.createGain(); g.gain.value = gain;
    const lfo = ctx.createOscillator(); lfo.frequency.value = lfoRate;
    const lg = ctx.createGain(); lg.gain.value = gain * 0.6;
    lfo.connect(lg).connect(g.gain);
    src.connect(f).connect(g).connect(master);
    src.start(); lfo.start();
  }

  // diesel engine hum
  engineOsc = ctx.createOscillator(); engineOsc.type = 'sawtooth'; engineOsc.frequency.value = 46;
  const ef = ctx.createBiquadFilter(); ef.type = 'lowpass'; ef.frequency.value = 180;
  engineGain = ctx.createGain(); engineGain.gain.value = 0.12;
  const trem = ctx.createOscillator(); trem.frequency.value = 7.3;
  const tg = ctx.createGain(); tg.gain.value = 0.04;
  trem.connect(tg).connect(engineGain.gain);
  engineOsc.connect(ef).connect(engineGain).connect(master);
  engineOsc.start(); trem.start();
}

export function playAlarm() {
  if (!ctx || alarmNodes) return;
  const o = ctx.createOscillator(); o.type = 'square';
  const g = ctx.createGain(); g.gain.value = 0.07;
  const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 900;
  o.connect(f).connect(g).connect(master); o.start();
  let hi = false;
  const iv = setInterval(() => { hi = !hi; o.frequency.setTargetAtTime(hi ? 980 : 720, ctx.currentTime, 0.02); }, 420);
  alarmNodes = { o, iv };
  if (engineGain) engineGain.gain.setTargetAtTime(0.2, ctx.currentTime, 0.5);
}

export function stopAlarm() {
  if (!alarmNodes) return;
  clearInterval(alarmNodes.iv); alarmNodes.o.stop(); alarmNodes = null;
  if (engineGain) engineGain.gain.setTargetAtTime(0.12, ctx.currentTime, 0.8);
}

export function blip(freq = 880, dur = 0.06, vol = 0.08, type = 'sine') {
  if (!ctx) return;
  const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
  const g = ctx.createGain(); g.gain.value = vol;
  g.gain.setTargetAtTime(0, ctx.currentTime + dur * 0.6, dur * 0.3);
  o.connect(g).connect(master); o.start(); o.stop(ctx.currentTime + dur * 2);
}

let lastStep = 0;
export function footstep() {
  if (!ctx) return;
  const now = ctx.currentTime;
  if (now - lastStep < 0.05) return; lastStep = now;
  const src = ctx.createBufferSource(); src.buffer = noiseBuffer(ctx, 0.12);
  const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1400 + Math.random() * 600; f.Q.value = 2;
  const g = ctx.createGain(); g.gain.value = 0.18; g.gain.setTargetAtTime(0, now + 0.03, 0.03);
  src.connect(f).connect(g).connect(master); src.start();
  blip(180 + Math.random() * 40, 0.04, 0.05, 'triangle');
}
