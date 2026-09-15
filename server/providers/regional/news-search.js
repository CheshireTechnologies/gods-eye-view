import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
import { fetchNewsForQuery } from './news.js';
import { coalesceProxyRequest } from '../common/http.js';
import {
  OLLAMA_BASE_URL_DEFAULT,
  OLLAMA_CHAT_MODEL_DEFAULT,
} from '../ollama/constants.js';

// ---------------------------------------------------------------------------
// Free-text news search proxy — powers the search_news voice tool. Unlike the
// cockpit's regional-brief proxy (anchored to the camera-tracked subject's
// position), this takes an arbitrary place/topic query, e.g. "Nepal
// landslide", so it answers "what happened in <place>"-style questions.
// ---------------------------------------------------------------------------
const NEWS_SEARCH_QUERY_MAX_LENGTH = 120;

const NEWS_SEARCH_CACHE_MS = 5 * 60_000;

const NEWS_SEARCH_STALE_MS = 60 * 60_000;

const NEWS_SEARCH_MAX_CACHE = 200;

function normalizedNewsSearchQuery(rawQuery) {
  return String(rawQuery || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, NEWS_SEARCH_QUERY_MAX_LENGTH);
}

/**
 * Best-effort local-model fallback when live search truly found nothing —
 * optional and silent about failure, since Ollama running locally is not a
 * given. Returns null rather than throwing when Ollama is unavailable.
 */
async function fetchNewsModelKnowledge(
  query,
  {
    baseUrl = process.env.OLLAMA_BASE_URL || OLLAMA_BASE_URL_DEFAULT,
    model = process.env.OLLAMA_CHAT_MODEL || OLLAMA_CHAT_MODEL_DEFAULT,
  } = {},
) {
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: [
              "Live news search found nothing for this God's Eye View query — the event may predate the index or be too obscure for it.",
              'Answer from your own training knowledge ONLY if reasonably confident of the specific real event.',
              'Two or three short plain sentences: what happened, roughly when, where. No markdown, no preamble.',
              "If you don't have reliable, specific knowledge of this exact event, say plainly that you don't know.",
            ].join(' '),
          },
          { role: 'user', content: query },
        ],
        stream: false,
        temperature: 0.2,
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    return typeof text === 'string' && text.trim()
      ? { answer: text.trim(), model }
      : null;
  } catch {
    return null;
  }
}

function newsSearchProxy() {
  const _newsSearchCache = new Map();

  const _newsSearchInFlight = new Map();

  const _newsSearchRateLimiter = makeRateLimiter({
    windowMs: 60_000,
    max: 20,
    globalMax: 60,
  });

  function trimNewsSearchCache() {
    while (_newsSearchCache.size > NEWS_SEARCH_MAX_CACHE) {
      const oldest = _newsSearchCache.keys().next().value;
      if (oldest === undefined) break;
      _newsSearchCache.delete(oldest);
    }
  }

  async function refresh(query, key) {
    const news = await fetchNewsForQuery(query);
    const modelKnowledge =
      news.status === 'empty' ? await fetchNewsModelKnowledge(query) : null;
    const payload = {
      status: news.status,
      retrievedAt: new Date().toISOString(),
      query: news.query,
      source: news.source,
      timespan: news.timespan,
      articles: news.articles,
      modelKnowledge,
    };
    _newsSearchCache.set(key, { payload, cachedAt: Date.now() });
    trimNewsSearchCache();
    return payload;
  }

  function install(middlewares) {
    middlewares.use('/api/news-search', async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }
      if (!_newsSearchRateLimiter(clientKey(req))) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': '10',
        });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
      }
      const url = new URL(req.url || '', 'http://localhost');
      const query = normalizedNewsSearchQuery(url.searchParams.get('q'));
      if (!query) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'A non-empty q is required' }));
        return;
      }
      const key = query.toLowerCase();
      const now = Date.now();
      const cached = _newsSearchCache.get(key);
      if (cached && now - cached.cachedAt <= NEWS_SEARCH_CACHE_MS) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
          'X-News-Search': 'HIT',
        });
        res.end(JSON.stringify({ ...cached.payload, status: 'cached' }));
        return;
      }
      const request = coalesceProxyRequest(_newsSearchInFlight, key, () =>
        refresh(query, key),
      );
      try {
        const payload = await request.promise;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
          'X-News-Search': request.shared ? 'INFLIGHT' : 'MISS',
        });
        res.end(JSON.stringify(payload));
      } catch {
        if (cached && now - cached.cachedAt <= NEWS_SEARCH_STALE_MS) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-News-Search': 'STALE',
          });
          res.end(JSON.stringify({ ...cached.payload, status: 'stale' }));
          return;
        }
        res.writeHead(503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({ error: 'News search is temporarily unavailable' }),
        );
      }
    });
  }

  return {
    name: 'news-search-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export { newsSearchProxy };
