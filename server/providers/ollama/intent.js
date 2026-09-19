import { readRequestBody } from '../common/request.js';
import {
  OLLAMA_BASE_URL_DEFAULT,
  OLLAMA_CHAT_MODEL_DEFAULT,
  OLLAMA_REQUEST_TIMEOUT_MS,
} from './constants.js';

// Validated against qwen2.5:3b-instruct on genuinely messy phrasing (filler
// words, false starts, self-corrections) before shipping — this prompt
// measurably improved tool selection over a plainer version on the same
// model, closing most of the gap to a 7B model at a fraction of the latency.
const INTENT_SYSTEM_PROMPT = [
  "You are the voice command router for God's Eye View, a live geospatial intelligence map app.",
  "The operator's words come from speech recognition and are often fuzzy: filler words (um, like, so), false starts, mid-sentence corrections, or casual/indirect phrasing rather than precise commands.",
  'Interpret charitably: infer the underlying GOAL, not just literal wording, and call the tool whose purpose best matches that goal — even if their phrasing is loose, indirect, or uses different words than the tool description.',
  'Ignore filler, hedging, and self-corrections; resolve to the final intent (e.g. "turn it off, no wait, on" means ON).',
  'If they ask for two or three separate things in one breath ("fly to Paris and turn on satellites"), call one tool for each.',
  'A short follow-up ("more", "a bit closer", "and the ships?", "that one", "turn them off") refers to the RECENT CONVERSATION included with the request — resolve it against that instead of guessing.',
  'Only skip calling a tool when the request plainly needs a capability not in this list, or is unrelated to the map (small talk, unrelated topics). Then reply in one short, friendly sentence; if they ask for something you cannot do, say so plainly and mention one thing you can do.',
  'Never invent argument values not stated or clearly implied.',
].join(' ');

const MAX_CALLS = 3;
const MAX_HISTORY_TURNS = 4;
const MAX_REPLY_CHARS = 200;

/** Clamp untrusted client history to short plain strings. */
export function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .map((turn) => ({
      said: String(turn?.said ?? '').slice(0, 160),
      did: String(turn?.did ?? '').slice(0, 160),
      outcome: String(turn?.outcome ?? '').slice(0, 160),
    }))
    .filter((turn) => turn.said)
    .slice(-MAX_HISTORY_TURNS);
}

/**
 * The system prompt (and the tool list that follows it) is byte-identical on
 * every request, so Ollama can reuse its cached evaluation of that ~1,800-token
 * prefix. Anything that varies per turn — the recent conversation, the
 * utterance — goes in the USER message. Putting history in the system prompt
 * invalidated the whole cache and cost ~10 s per turn instead of ~1 s.
 */
export function buildIntentMessages(text, history = []) {
  const turns = sanitizeHistory(history);
  const content = turns.length
    ? `RECENT CONVERSATION (oldest first):\n${turns
        .map(
          (turn) =>
            `- "${turn.said}" → ${turn.did || 'no action'}${turn.outcome ? ` (${turn.outcome})` : ''}`,
        )
        .join('\n')}\n\nOPERATOR NOW SAYS: ${text}`
    : text;
  return [
    { role: 'system', content: INTENT_SYSTEM_PROMPT },
    { role: 'user', content },
  ];
}

/**
 * Plain one-line text safe to speak, or null. A reply that is too long, or that
 * talks ABOUT the conversation in the third person ("the operator is asking…",
 * "not within the provided tools") is a model narrating its own reasoning, not
 * an answer — it is dropped rather than truncated into a spoken half-sentence.
 */
function cleanReply(content) {
  const text = String(content ?? '')
    .replace(/[*`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text.length > MAX_REPLY_CHARS) return null;
  if (
    /\b(the operator|the user|this request|the request|provided tools|tool list|capabilities of)\b/i.test(
      text,
    )
  ) {
    return null;
  }
  return text;
}

function parseArguments(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** "trackentity" / "Track-Entity" → "track_entity"; unknown names → null. */
function resolveToolName(name, allowedNames) {
  if (allowedNames.has(name)) return name;
  const squash = (text) =>
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  const wanted = squash(name);
  for (const candidate of allowedNames) {
    if (squash(candidate) === wanted) return candidate;
  }
  return null;
}

/**
 * Small models frequently write the tool call into the message TEXT instead of
 * the structured field — `adjust_camera_zoom {"direction":"out"}`,
 * `trackentity({"layerId":"flights"})`, or a `{"name":…,"arguments":…}` blob.
 * Recover those into real calls; anything else returns [].
 */
function rescueTextCalls(content, allowedNames) {
  const text = String(content ?? '').trim();
  if (!text) return [];
  const asCall = (name, args) => {
    const resolved = resolveToolName(name, allowedNames);
    return resolved
      ? { function: { name: resolved, arguments: args ?? {} } }
      : null;
  };
  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const calls = list
      .map((item) => asCall(item?.name, item?.arguments ?? item?.parameters))
      .filter(Boolean);
    if (calls.length) return calls;
  } catch {
    // Not JSON — fall through to the `name {args}` / `name({args})` shapes.
  }
  const match =
    /^`*([A-Za-z][A-Za-z_-]{2,40})`*\s*\(?\s*(\{[\s\S]*\})?\s*\)?$/.exec(text);
  const call = match ? asCall(match[1], match[2]) : null;
  return call ? [call] : [];
}

/**
 * True when a "reply" is really leaked code, not something to say aloud: braces,
 * a call like `name(`, a snake_case identifier, or tool-calling vocabulary.
 * Checked on the RAW text — cleaning first would mangle the identifiers.
 */
function looksLikeCode(text) {
  return /[{}]|\w\(|\b[a-z]+_[a-z_]+\b|\bfunction\b|\btool\b/i.test(text);
}

/**
 * Reduce an Ollama chat completion to what the client needs. Tool names are
 * repaired when unambiguous and dropped when they are not in the supplied list,
 * so the client never dispatches a hallucinated action; a call written into the
 * message text is recovered; and a reply that is really leaked code is never
 * offered for speech.
 * @returns {{calls: {name: string, arguments: object}[], reply: string|null}}
 */
export function parseIntentResponse(data, allowedNames) {
  const message = data?.choices?.[0]?.message;
  const structured = message?.tool_calls?.length
    ? message.tool_calls
    : rescueTextCalls(message?.content, allowedNames);
  const seen = new Set();
  const calls = [];
  for (const call of structured) {
    const name = resolveToolName(call?.function?.name ?? '', allowedNames);
    if (!name) continue;
    const args = parseArguments(call.function.arguments);
    const key = `${name}:${JSON.stringify(args)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    calls.push({ name, arguments: args });
    if (calls.length >= MAX_CALLS) break;
  }
  const raw = String(message?.content ?? '');
  const reply = calls.length || looksLikeCode(raw) ? null : cleanReply(raw);
  return { calls, reply };
}

/** One tool-call request against Ollama's OpenAI-compatible endpoint. */
async function pickToolsOnce(text, tools, history, { baseUrl, model }) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(OLLAMA_REQUEST_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: buildIntentMessages(text, history),
      tools: tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.parameters || { type: 'object', properties: {} },
        },
      })),
      stream: false,
      temperature: 0,
    }),
  });
  if (!response.ok) {
    throw new Error(`Ollama chat request failed (${response.status})`);
  }
  return parseIntentResponse(
    await response.json(),
    new Set(tools.map((tool) => tool.name)),
  );
}

/**
 * Node middleware factory: POST /api/ollama/intent.
 * Body: { text, tools: [{name, description, parameters}], history?: [{said,
 * did, outcome}] }.
 * Response: { ok:true, calls:[{name,arguments}], name, arguments, reply } —
 * `calls` holds up to three tools in spoken order (`name`/`arguments` mirror
 * the first for older callers); `reply` is a short conversational answer
 * when no tool fit — | { ok:false, error }. Used only by the local voice fallback
 * (src/voice/localVoiceFallback.js) — the caller supplies a small, curated
 * tool subset rather than the full ~30-tool Realtime schema, since a 3B
 * local model's function-calling reliability drops sharply with a large
 * tool list.
 */
function createIntentHandler({
  baseUrl = process.env.OLLAMA_BASE_URL || OLLAMA_BASE_URL_DEFAULT,
  model = process.env.OLLAMA_CHAT_MODEL || OLLAMA_CHAT_MODEL_DEFAULT,
} = {}) {
  return async function handleOllamaIntent(req, res) {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    try {
      const body = await readRequestBody(req, 32 * 1024);
      const { text, tools, history } = JSON.parse(body || '{}');
      const safeText = String(text ?? '')
        .trim()
        .slice(0, 300);
      const safeTools = Array.isArray(tools) ? tools.slice(0, 20) : [];
      if (!safeText || !safeTools.length) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({ ok: false, error: 'text and tools are required' }),
        );
        return;
      }
      const { calls, reply } = await pickToolsOnce(
        safeText,
        safeTools,
        history,
        { baseUrl, model },
      );
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          ok: true,
          calls,
          name: calls[0]?.name ?? null,
          arguments: calls[0]?.arguments ?? {},
          reply,
        }),
      );
    } catch (error) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          ok: false,
          error: error?.message || 'Ollama intent request failed',
        }),
      );
    }
  };
}

export { createIntentHandler };
