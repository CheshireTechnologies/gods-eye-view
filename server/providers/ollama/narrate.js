import { readRequestBody } from '../common/request.js';
import { createOllamaCache } from './cache.js';
import {
  OLLAMA_BASE_URL_DEFAULT,
  OLLAMA_CHAT_MODEL_DEFAULT,
  OLLAMA_NARRATIVE_CACHE_MS,
  OLLAMA_NARRATIVE_DISK_DIR,
  OLLAMA_NARRATIVE_CACHE_MAX_ENTRIES,
  OLLAMA_REQUEST_TIMEOUT_MS,
} from './constants.js';

const NARRATE_SYSTEM_PROMPT = [
  "You summarize semantic search matches for God's Eye View, a live geospatial intelligence app.",
  "Given the operator's question and a short list of matched item descriptions, write ONE or TWO short plain sentences synthesizing what was found.",
  'Only use facts present in the descriptions — never invent details, counts, or locations not given.',
  'If the match list is empty, say plainly that nothing matched.',
  'No markdown, no preamble, no restating the question.',
].join(' ');

const narrativeCache = createOllamaCache({
  diskDir: OLLAMA_NARRATIVE_DISK_DIR,
  memoryTtlMs: OLLAMA_NARRATIVE_CACHE_MS,
  maxEntries: OLLAMA_NARRATIVE_CACHE_MAX_ENTRIES,
});

/** One chat completion against Ollama's OpenAI-compatible endpoint. */
async function narrateOnce(query, matches, { baseUrl, model }) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(OLLAMA_REQUEST_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: NARRATE_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ query, matches }) },
      ],
      stream: false,
      temperature: 0.2,
    }),
  });
  if (!response.ok) {
    throw new Error(`Ollama chat request failed (${response.status})`);
  }
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Ollama returned no narrative text');
  }
  return text.trim();
}

/**
 * Node middleware factory: POST /api/ollama/narrate.
 * Body: { query: string, matches: [{summary, score}] }. Response:
 * { narrative: string, model }. Cached briefly (matches change fast) so an
 * immediate repeat/follow-up question over an unchanged result set is instant.
 */
function createNarrateHandler({
  baseUrl = process.env.OLLAMA_BASE_URL || OLLAMA_BASE_URL_DEFAULT,
  model = process.env.OLLAMA_CHAT_MODEL || OLLAMA_CHAT_MODEL_DEFAULT,
} = {}) {
  return async function handleOllamaNarrate(req, res) {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    try {
      const body = await readRequestBody(req, 32 * 1024);
      const { query, matches } = JSON.parse(body || '{}');
      const safeQuery = String(query ?? '').slice(0, 300);
      const safeMatches = Array.isArray(matches)
        ? matches.slice(0, 12).map((m) => ({
            summary: String(m?.summary ?? '').slice(0, 300),
            score: Number.isFinite(m?.score) ? Number(m.score) : null,
          }))
        : [];
      const cacheKey = `${model}\n${safeQuery}\n${safeMatches
        .map((m) => m.summary)
        .join('|')}`;
      const narrative = await narrativeCache.getOrCompute(cacheKey, () =>
        narrateOnce(safeQuery, safeMatches, { baseUrl, model }),
      );
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ narrative, model }));
    } catch (error) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: error?.message || 'Ollama narrate request failed',
        }),
      );
    }
  };
}

export { createNarrateHandler };
