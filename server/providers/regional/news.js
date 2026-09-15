import { fetchRegionalText, fetchRegionalJson } from './http.js';
import { normalizeRegionalArticles } from '../../../src/data/regionalModel.js';

function decodeRssText(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rssTag(block, tag) {
  return decodeRssText(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(
      block,
    )?.[1] || '',
  );
}

function normalizeRssArticles(xml, limit = 5) {
  const seen = new Set();
  const articles = [];
  for (const match of String(xml || '').matchAll(
    /<item>([\s\S]*?)<\/item>/gi,
  )) {
    const item = match[1];
    const title = rssTag(item, 'title').slice(0, 180);
    const url = rssTag(item, 'link');
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      continue;
    }
    if (!title || !['http:', 'https:'].includes(parsedUrl.protocol)) continue;
    const source = rssTag(item, 'source');
    const signature = `${title.toLowerCase()}|${source.toLowerCase() || parsedUrl.hostname}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    const rawDate = rssTag(item, 'pubDate');
    articles.push({
      title,
      url: parsedUrl.href,
      domain: source || parsedUrl.hostname.replace(/^www\./, ''),
      publishedAt: Number.isNaN(Date.parse(rawDate))
        ? null
        : new Date(rawDate).toISOString(),
      sourceCountry: null,
    });
    if (articles.length >= limit) break;
  }
  return articles;
}

async function fetchNewsRss(query, limit) {
  const rssParams = new URLSearchParams({
    q: String(query).replace(/["\\]/g, ' ').trim(),
    hl: 'en-US',
    gl: 'US',
    ceid: 'US:en',
  });
  const xml = await fetchRegionalText(
    `https://news.google.com/rss/search?${rssParams}`,
    {
      headers: { 'User-Agent': 'GodsEyeView/0.1' },
      timeoutMs: 12_000,
    },
  );
  return normalizeRssArticles(xml, limit);
}

async function fetchNewsGdelt(query, limit, timespan) {
  const params = new URLSearchParams({
    query: `"${String(query).replace(/["\\]/g, ' ').trim()}"`,
    mode: 'artlist',
    format: 'json',
    maxrecords: String(limit),
    sort: 'datedesc',
    timespan,
  });
  const payload = await fetchRegionalJson(
    `https://api.gdeltproject.org/api/v2/doc/doc?${params}`,
    {
      headers: { 'User-Agent': 'GodsEyeView/0.1' },
      timeoutMs: 12_000,
    },
  );
  return normalizeRegionalArticles(payload, limit);
}

async function fetchRegionalNews(place) {
  const query = place?.locality || place?.region || place?.country;
  if (!query)
    return { status: 'unavailable', query: null, articles: [], source: null };
  try {
    const articles = await fetchNewsRss(query, 5);
    if (articles.length)
      return { status: 'ready', query, articles, source: 'Google News RSS' };
  } catch {
    /* fall through to the existing free index */
  }
  try {
    const articles = await fetchNewsGdelt(query, 5, '48h');
    return {
      status: articles.length ? 'ready' : 'empty',
      query,
      articles,
      source: 'GDELT fallback',
    };
  } catch {
    return { status: 'unavailable', query, articles: [], source: null };
  }
}

// Progressively wider GDELT lookback windows for a free-text search that
// isn't tied to the camera position. A quiet or slightly older story (last
// week's landslide, not just today's) still turns up something before this
// gives up, while a hot story still resolves on the first, narrowest pass.
const NEWS_SEARCH_TIMESPANS = ['48h', '7d', '1m', '3m'];

/**
 * Free-text news search for an arbitrary place/topic — unlike
 * fetchRegionalNews, this isn't anchored to the camera-tracked subject's
 * position, so it's what powers "what happened in <place>" voice queries.
 * Tries Google News RSS first, then GDELT with widening time windows.
 */
async function fetchNewsForQuery(query, { limit = 6 } = {}) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery)
    return {
      status: 'unavailable',
      query: null,
      articles: [],
      source: null,
      timespan: null,
    };
  try {
    const articles = await fetchNewsRss(cleanQuery, limit);
    if (articles.length)
      return {
        status: 'ready',
        query: cleanQuery,
        articles,
        source: 'Google News RSS',
        timespan: null,
      };
  } catch {
    /* fall through to GDELT */
  }
  for (const timespan of NEWS_SEARCH_TIMESPANS) {
    try {
      const articles = await fetchNewsGdelt(cleanQuery, limit, timespan);
      if (articles.length)
        return {
          status: 'ready',
          query: cleanQuery,
          articles,
          source: 'GDELT fallback',
          timespan,
        };
    } catch {
      /* try the next, wider window */
    }
  }
  return {
    status: 'empty',
    query: cleanQuery,
    articles: [],
    source: null,
    timespan: null,
  };
}

export { fetchRegionalNews, fetchNewsForQuery };
