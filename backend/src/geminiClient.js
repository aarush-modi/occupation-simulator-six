// Gemini Interactions API over plain fetch: JSON text generation (scenarios, NPC direction, NPC dialogue) and
// speech (NPC voices). Keys stay on the backend.
export const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const API_REVISION = '2026-05-20';

export const MODELS = {
  scenario: 'gemini-4-neon',
  npc: 'gemini-4-hydrogen', // one tier below Neon: faster and cheaper for frequent NPC calls
  speech: 'gemini-3.8-flash-tts',
};

export class GeminiError extends Error {}

// Bounds make constrained decoding too large for Gemini ("too many states"). The semantic validator checks them
// after generation instead.
const BOUND_KEYS = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'format']);

/** JSON schema as Gemini serves it: no bounds, and `const` (which Gemini ignores) pinned as a one-value enum. */
export function geminiSchema(node, inProperties = false) {
  if (Array.isArray(node)) return node.map((n) => geminiSchema(n));
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (inProperties) { out[key] = geminiSchema(value); continue; } // keys here are field names, not keywords
    if (key === '$schema' || BOUND_KEYS.has(key)) continue;
    if (key === 'const') out.enum = [value];
    else out[key] = geminiSchema(value, key === 'properties' || key === '$defs');
  }
  return out;
}

async function interact({ apiKey, body, signal, fetcher = fetch }) {
  if (!apiKey) throw new GeminiError('GEMINI_API_KEY is not set');
  let response;
  try {
    response = await fetcher(INTERACTIONS_URL, {
      method: 'POST', signal,
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json', 'api-revision': API_REVISION },
      body: JSON.stringify({ store: false, ...body }),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new GeminiError('Could not reach the Gemini API.');
  }
  if (response.status === 401 || response.status === 403) throw new GeminiError('Gemini rejected the API key.');
  if (response.status === 402) throw new GeminiError('Gemini needs billing enabled for the configured model.');
  if (response.status === 404) throw new GeminiError('Check that your Gemini API key has access to the configured model.');
  if (response.status === 429) throw new GeminiError('Gemini returned a quota or rate limit error.');
  if (!response.ok) throw new GeminiError(`Gemini request failed (HTTP ${response.status}).`);
  const result = await response.json();
  if (result.status && result.status !== 'completed') throw new GeminiError(`Gemini did not complete the response (${result.status}).`);
  return result;
}

const outputParts = (result) => (result.steps ?? []).filter(step => step.type === 'model_output').flatMap(step => step.content ?? []);

/** Text (JSON when `schema` is given). Returns { text, usage }. */
export async function geminiText({ apiKey, model, system, input, schema, thinking = 'low', maxTokens, signal, fetcher }) {
  const body = {
    model, input,
    ...(system ? { system_instruction: system } : {}),
    generation_config: { thinking_level: thinking, ...(maxTokens ? { max_output_tokens: maxTokens } : {}) },
    ...(schema ? { response_format: { type: 'text', mime_type: 'application/json', schema: geminiSchema(schema) } } : {}),
  };
  const result = await interact({ apiKey, body, signal, fetcher });
  const text = outputParts(result).filter(part => part.type === 'text').map(part => part.text).join('');
  if (!text) throw new GeminiError('Gemini returned an empty response.');
  return { text, usage: result.usage };
}

/** Speech for one line. Returns a WAV file (24 kHz, mono, 16-bit PCM) as a Buffer. */
export async function geminiSpeech({ apiKey, model = MODELS.speech, text, voice, style, signal, fetcher }) {
  const body = {
    model,
    input: [{ type: 'user_input', content: [{ type: 'text', text, ...(style ? { annotations: [{ type: 'speech_metadata', style }] } : {}) }] }],
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice }] },
  };
  const result = await interact({ apiKey, body, signal, fetcher });
  const audio = outputParts(result).find(part => part.type === 'audio' && part.data);
  if (!audio) throw new GeminiError('Gemini returned no audio.');
  return Buffer.from(audio.data, 'base64');
}

/** Usage in the generation log's shape. */
export const usageOf = (u) => u ? {
  prompt: u.total_input_tokens ?? 0,
  output: u.total_output_tokens ?? 0,
  thoughts: u.total_thought_tokens ?? 0,
  total: u.total_tokens ?? 0,
} : null;
