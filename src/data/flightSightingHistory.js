/**
 * A small in-memory, session-only rolling cache of recently-seen flight
 * records, keyed by icao24. Feeds the analyst zoom-retry fallback (see
 * analystZoomRetry.js / runAnalystQuery in src/voice/gevActions.js): when a
 * "nearest flight from X" query is empty even after widening the search, the
 * most recent sighting of a matching aircraft — however many minutes old —
 * is still a more useful answer than nothing, as long as it's clearly
 * labeled as stale.
 *
 * Deliberately NOT persisted to localStorage. Aircraft positions are stale
 * within seconds; carrying them across a reload would present old data as
 * fresh with no live feed backing it. Session-only memory keeps the
 * staleness honest and avoids accumulating real-world position history
 * beyond the current tab's lifetime.
 *
 * Populated opportunistically — every analyst_query against the flights
 * layer records what it just saw (analystProviders.getRecords in
 * gevActions.js) — not by a dedicated poller, matching getAnalystRecords'
 * own "zero per-frame cost, no listeners" design (see
 * src/layers/flights/queries.js).
 * @module data/flightSightingHistory
 */

const DEFAULT_MAX_AGE_MS = 20 * 60 * 1000; // 20 minutes — a plane can move far, but "gone" beats "wrong"
const DEFAULT_MAX_ENTRIES = 4000; // generous headroom over a realistic in-view count

export function createFlightSightingHistory({
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, {record: object, lastSeenAtMs: number}>} icao24 → sighting */
  const byIcao24 = new Map();

  /** Record the current sightings of one query's live results. */
  function recordSightings(records) {
    const nowMs = now();
    for (const record of records || []) {
      const key = record?.icao24;
      if (!key) continue;
      byIcao24.set(key, { record, lastSeenAtMs: nowMs });
    }
    if (byIcao24.size > maxEntries) _evictOldest(byIcao24.size - maxEntries);
  }

  function _evictOldest(count) {
    const oldest = [...byIcao24.entries()]
      .sort((a, b) => a[1].lastSeenAtMs - b[1].lastSeenAtMs)
      .slice(0, count);
    for (const [key] of oldest) byIcao24.delete(key);
  }

  /**
   * Sightings still within maxAgeMs, each carrying how long ago it was last
   * seen — never presented as a live position.
   * @returns {Array<object>} Records with `staleSecondsAgo` added.
   */
  function recentSightings() {
    const nowMs = now();
    const out = [];
    for (const { record, lastSeenAtMs } of byIcao24.values()) {
      const ageMs = nowMs - lastSeenAtMs;
      if (ageMs > maxAgeMs) continue;
      out.push({ ...record, staleSecondsAgo: Math.round(ageMs / 1000) });
    }
    return out;
  }

  /** Drop sightings older than maxAgeMs. Call opportunistically; not scheduled. */
  function prune() {
    const nowMs = now();
    for (const [key, { lastSeenAtMs }] of byIcao24) {
      if (nowMs - lastSeenAtMs > maxAgeMs) byIcao24.delete(key);
    }
  }

  return {
    recordSightings,
    recentSightings,
    prune,
    size: () => byIcao24.size,
  };
}

/** Shared instance used by production wiring (runAnalystQuery). */
export const flightSightingHistory = createFlightSightingHistory();
