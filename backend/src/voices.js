// NPC voices with Gemini TTS. Every NPC keeps one prebuilt voice (picked from their name) and speaks in the
// "patient teacher" style. Audio is cached per voice and line, so lines the room prepares ahead play instantly.
import { geminiSpeech, MODELS } from './geminiClient.js';

// Warm, clear prebuilt voices that suit a patient teacher.
export const VOICES = ['Sulafat', 'Achird', 'Vindemiatrix', 'Gacrux', 'Charon', 'Sadaltager', 'Callirrhoe', 'Iapetus'];
export const TEACHER_STYLE = 'like a patient teacher: calm, warm, clear and encouraging, at an unhurried pace';
const CACHE_LINES = 400;
const PARALLEL = 2;
const RETRY_429_MS = 2500;

export function voiceFor(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return VOICES[h % VOICES.length];
}

/**
 * Returns { speak(who, text) -> Promise<Buffer wav>, warm(who, text) } or null without a key. `speak` is someone
 * waiting to hear the line, so it jumps ahead of lines that are only being prepared (`warm`).
 */
export function createVoices({ apiKey, model = MODELS.speech, style = TEACHER_STYLE, fetcher = fetch, log = console, retryMs = RETRY_429_MS } = {}) {
  if (!apiKey) return null;
  const cache = new Map(); // `${voice}|${text}` -> Promise<Buffer>
  const queue = []; // jobs not started yet
  let running = 0;

  const synth = async (job) => {
    const once = () => geminiSpeech({ apiKey, model, text: job.text, voice: job.voice, style, fetcher, signal: AbortSignal.timeout(20000) });
    try {
      return await once();
    } catch (err) {
      if (!/rate limit/.test(err?.message ?? '')) throw err;
      await new Promise(resolve => setTimeout(resolve, retryMs)); // one retry after a rate limit
      return once();
    }
  };

  const pump = () => {
    while (running < PARALLEL && queue.length) {
      const job = queue.shift();
      running++;
      synth(job).then(job.resolve, job.reject).finally(() => { running--; pump(); });
    }
  };

  function request(who, text, urgent) {
    const voice = voiceFor(who);
    const key = `${voice}|${text}`;
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key); cache.set(key, hit); // keep recently used lines
      const waiting = queue.findIndex(job => job.key === key);
      if (urgent && waiting > 0) queue.unshift(...queue.splice(waiting, 1));
      return hit;
    }
    let job;
    const pending = new Promise((resolve, reject) => { job = { key, voice, text, resolve, reject }; });
    if (urgent) queue.unshift(job); else queue.push(job);
    cache.set(key, pending);
    while (cache.size > CACHE_LINES) cache.delete(cache.keys().next().value);
    pending.catch((err) => {
      if (cache.get(key) === pending) cache.delete(key);
      log.warn?.(`[voice] ${voice}: ${err?.message ?? err}`);
    });
    pump();
    return pending;
  }

  return {
    speak: (who, text) => request(who, text, true),
    warm: (who, text) => { request(who, text, false).catch(() => {}); },
    voiceFor,
  };
}
