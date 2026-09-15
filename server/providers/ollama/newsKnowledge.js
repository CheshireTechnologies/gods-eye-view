import { readRequestBody } from '../common/request.js';
import { createOllamaCache } from './cache.js';
import {
  OLLAMA_BASE_URL_DEFAULT,
  OLLAMA_CHAT_MODEL_DEFAULT,
  OLLAMA_REQUEST_TIMEOUT_MS,
} from './constants.js';
import { gevCacheDir } from '../common/cache-root.js';

const NEWS_KNOWLEDGE_CACHE_MS = 10 * 60_000;
const NEWS_KNOWLEDGE_DISK_DIR = gevCacheDir('ollama', 'news-knowledge');
const NEWS_KNOWLEDGE_CACHE_MAX_ENTRIES = 500;

const NEWS_KNOWLEDGE_SYSTEM_PROMPT = [
  "Live news search (Google News / GDELT) found nothing for the operator's query in God's Eye View — the event may predate the index or be too obscure for it.",
  'Answer from your own training knowledge ONLY if you are reasonably confident you know the specific real event being asked about.',
  'Two or three short plain sentences: what happened, roughly when, and where. No markdown, no preamble.',
  "If you do not have reliable, specific knowledge of this exact event, say plainly that you don't know rather than guessing or inventing details.",
  'Never claim this is current, verified, or sourced — the caller labels it as unverified local-model knowledge.',
].join(' ');

/** One chat completion against Ollama's OpenAI-compatible endpoint. */
async function askOnce(query, { baseUrl, model }) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(OLLAMA_REQUEST_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: NEWS_KNOWLEDGE_SYSTEM_PROMPT },
        { role: 'user', content: query },
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
    throw new Error('Ollama returned no answer text');
  }
  return text.trim();
}

const newsKnowledgeCache = createOllamaCache({
  diskDir: NEWS_KNOWLEDGE_DISK_DIR,
  memoryTtlMs: NEWS_KNOWLEDGE_CACHE_MS,
  maxEntries: NEWS_KNOWLEDGE_CACHE_MAX_ENTRIES,
});

/**
 * Node middleware factory: POST /api/ollama/news-knowledge.
 * Body: { query: string }. Response: { answer: string, model }. Only meant
 * to be called after a live news search comes back empty — a free, local,
 * clearly-unverified fallback for events too old or too small for the live
 * index, using whatever knowledge the local model already carries.
 */
function createNewsKnowledgeHandler({
  baseUrl = process.env.OLLAMA_BASE_URL || OLLAMA_BASE_URL_DEFAULT,
  model = process.env.OLLAMA_CHAT_MODEL || OLLAMA_CHAT_MODEL_DEFAULT,
} = {}) {
  return async function handleNewsKnowledge(req, res) {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    try {
      const body = await readRequestBody(req, 4 * 1024);
      const { query } = JSON.parse(body || '{}');
      const safeQuery = String(query ?? '').trim().slice(0, 300);
      if (!safeQuery) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'query is required' }));
        return;
      }
      const cacheKey = `${model}\n${safeQuery}`;
      const answer = await newsKnowledgeCache.getOrCompute(cacheKey, () =>
        askOnce(safeQuery, { baseUrl, model }),
      );
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ answer, model }));
    } catch (error) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: error?.message || 'Ollama news-knowledge request failed',
        }),
      );
    }
  };
}

export { createNewsKnowledgeHandler };
