import { readRequestBody } from '../common/request.js';
import {
  OLLAMA_BASE_URL_DEFAULT,
  OLLAMA_CHAT_MODEL_DEFAULT,
} from './constants.js';

// ---------------------------------------------------------------------------
// Spoken replies for informational tool results — "how many flights", "what's
// that ship", "any news". A template can say "Done." but it cannot say what a
// result actually contains, and reading raw counts off a card sounds robotic.
// A small local model can phrase the answer the way a person would, but it can
// also invent a number, so every digit it produces is checked against the data
// it was given; a reply that cannot be traced back to the result is discarded
// and the caller falls back to its own template. Wrong-but-fluent is the
// failure this module exists to prevent.
// ---------------------------------------------------------------------------

/** Tighter than the intent call: the user is waiting on a spoken answer. */
const REPLY_TIMEOUT_MS = 4_000;
const MAX_RESULT_JSON_CHARS = 2_000;
const MAX_REPLY_CHARS = 260;

const REPLY_SYSTEM_PROMPT = [
  "You are the voice of God's Eye View, a live geospatial map. You just carried out the operator's request; now say the outcome out loud.",
  'Reply in one or two short, natural sentences (under 35 words), the way a calm, friendly colleague would. Lead with the answer.',
  'Use ONLY facts that appear in RESULT. Write numbers as digits, exactly as given or rounded — never compute new numbers, never guess.',
  'If RESULT says the request failed, say plainly and briefly what went wrong and, if obvious, what they could try instead.',
  'No markdown, lists, emoji, or quotation marks. Never mention "result", "JSON", "tool", "field", or code names.',
].join(' ');

const NUMBER_WORDS = new Map(
  Object.entries({
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90,
    hundred: 100,
    thousand: 1000,
  }),
);

function numbersIn(text) {
  return [...String(text).matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) =>
    Number(m[0].replace(/,/g, '')),
  );
}

/** A reply number is grounded if the source has it, or a value that rounds to it. */
function isGrounded(value, sourceNumbers) {
  return sourceNumbers.some(
    (source) =>
      source === value ||
      Math.round(source) === value ||
      Math.abs(source - value) <= 0.05 ||
      // "about 12 thousand" style rounding of a large figure.
      (source >= 1000 && Math.abs(Math.round(source / 1000) - value) < 1e-9),
  );
}

/**
 * Accept a model reply only if it is speakable and every figure in it is
 * traceable to the request or the result. Returns the cleaned reply or null.
 */
export function validateReply(reply, sourceText) {
  const text = String(reply ?? '')
    .replace(/[*_`#>"]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text.length > MAX_REPLY_CHARS) return null;
  if (/\b(json|result|tool call|field|null|undefined)\b/i.test(text)) {
    return null;
  }
  const source = numbersIn(sourceText);
  if (!numbersIn(text).every((value) => isGrounded(value, source))) {
    return null;
  }
  for (const word of text.toLowerCase().match(/[a-z]+/g) || []) {
    const value = NUMBER_WORDS.get(word);
    if (value !== undefined && !isGrounded(value, source)) return null;
  }
  return text;
}

/** Bound the payload the model sees; long item lists add latency, not meaning. */
export function compactResult(result) {
  let json = JSON.stringify(result ?? {});
  if (json.length <= MAX_RESULT_JSON_CHARS) return json;
  const trimmed = { ...result };
  for (const [key, value] of Object.entries(trimmed)) {
    if (Array.isArray(value)) trimmed[key] = value.slice(0, 5);
  }
  json = JSON.stringify(trimmed);
  return json.slice(0, MAX_RESULT_JSON_CHARS);
}

export function buildReplyMessages(request, result) {
  return [
    { role: 'system', content: REPLY_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `OPERATOR SAID: "${request}"\nRESULT: ${compactResult(result)}`,
    },
  ];
}

async function composeReply(request, result, { baseUrl, model }) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(REPLY_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: buildReplyMessages(request, result),
      stream: false,
      temperature: 0.5,
      max_tokens: 90,
    }),
  });
  if (!response.ok) {
    throw new Error(`Ollama chat request failed (${response.status})`);
  }
  const data = await response.json();
  return validateReply(
    data?.choices?.[0]?.message?.content,
    `${request} ${compactResult(result)}`,
  );
}

/**
 * Node middleware factory: POST /api/ollama/reply.
 * Body: { request: string, result: object }.
 * Response: { ok:true, reply: string|null } — `reply:null` means "the model
 * answered but it failed the grounding check; use your own template" — or
 * { ok:false, error }.
 */
export function createReplyHandler({
  baseUrl = process.env.OLLAMA_BASE_URL || OLLAMA_BASE_URL_DEFAULT,
  model = process.env.OLLAMA_CHAT_MODEL || OLLAMA_CHAT_MODEL_DEFAULT,
} = {}) {
  return async function handleOllamaReply(req, res) {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    try {
      const body = await readRequestBody(req, 32 * 1024);
      const { request, result } = JSON.parse(body || '{}');
      const safeRequest = String(request ?? '')
        .trim()
        .slice(0, 300);
      if (!safeRequest || !result || typeof result !== 'object') {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            ok: false,
            error: 'request and result are required',
          }),
        );
        return;
      }
      const reply = await composeReply(safeRequest, result, {
        baseUrl,
        model,
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: true, reply }));
    } catch (error) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          ok: false,
          error: error?.message || 'Ollama reply request failed',
        }),
      );
    }
  };
}
