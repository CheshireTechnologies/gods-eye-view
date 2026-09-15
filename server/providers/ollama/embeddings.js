import { readRequestBody } from '../common/request.js';
import { createOllamaCache } from './cache.js';
import {
  OLLAMA_BASE_URL_DEFAULT,
  OLLAMA_EMBED_MODEL_DEFAULT,
  OLLAMA_EMBED_CACHE_MS,
  OLLAMA_EMBED_DISK_DIR,
  OLLAMA_EMBED_CACHE_MAX_ENTRIES,
  OLLAMA_REQUEST_TIMEOUT_MS,
  OLLAMA_MAX_TEXTS_PER_REQUEST,
  OLLAMA_MAX_TEXT_LENGTH,
} from './constants.js';

const embedCache = createOllamaCache({
  diskDir: OLLAMA_EMBED_DISK_DIR,
  memoryTtlMs: OLLAMA_EMBED_CACHE_MS,
  maxEntries: OLLAMA_EMBED_CACHE_MAX_ENTRIES,
});

/** Embed one text against Ollama's batch embeddings endpoint. */
async function embedOne(text, { baseUrl, model }) {
  const response = await fetch(`${baseUrl}/api/embed`, {
    method: 'POST',
    signal: AbortSignal.timeout(OLLAMA_REQUEST_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: text }),
  });
  if (!response.ok) {
    throw new Error(`Ollama embeddings request failed (${response.status})`);
  }
  const data = await response.json();
  const vector = Array.isArray(data?.embeddings?.[0]) ? data.embeddings[0] : null;
  if (!vector) throw new Error('Ollama returned no embedding vector');
  return vector;
}

/**
 * Node middleware factory: POST /api/ollama/embeddings.
 * Body: { texts: string[] }. Response: { vectors: number[][], model }, in
 * the same order as `texts`. Each text is cached independently (keyed on
 * model+text) so repeated record descriptions across queries are free.
 */
function createEmbeddingsHandler({
  baseUrl = process.env.OLLAMA_BASE_URL || OLLAMA_BASE_URL_DEFAULT,
  model = process.env.OLLAMA_EMBED_MODEL || OLLAMA_EMBED_MODEL_DEFAULT,
} = {}) {
  return async function handleOllamaEmbeddings(req, res) {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    try {
      const body = await readRequestBody(req, 64 * 1024);
      const { texts } = JSON.parse(body || '{}');
      if (!Array.isArray(texts) || !texts.length) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'texts must be a non-empty array' }));
        return;
      }
      const clipped = texts
        .slice(0, OLLAMA_MAX_TEXTS_PER_REQUEST)
        .map((t) => String(t ?? '').slice(0, OLLAMA_MAX_TEXT_LENGTH));

      const vectors = await Promise.all(
        clipped.map((text) =>
          embedCache.getOrCompute(`${model}\n${text}`, () =>
            embedOne(text, { baseUrl, model }),
          ),
        ),
      );
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ vectors, model }));
    } catch (error) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: error?.message || 'Ollama embeddings request failed',
        }),
      );
    }
  };
}

export { createEmbeddingsHandler };
