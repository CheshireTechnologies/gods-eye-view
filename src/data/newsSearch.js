import { applicationServices } from '../services/application.js';

/**
 * Free-text news search through the same-origin dev/preview proxy — unlike
 * the cockpit's regional brief, this takes an arbitrary place/topic query
 * rather than the camera-tracked subject's coordinates.
 */
export async function searchNews(query, { signal } = {}) {
  const cleanQuery = String(query ?? '').trim();
  if (!cleanQuery) throw new Error('A non-empty query is required');
  return applicationServices.newsSearch.search(cleanQuery, { signal });
}
