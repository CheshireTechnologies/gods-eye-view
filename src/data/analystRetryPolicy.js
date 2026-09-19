/**
 * Pure decision logic for the analyst zoom-retry feature (see
 * analystZoomRetry.js for the user setting and flightSightingHistory.js for
 * the historical fallback store). Kept separate from analystEngine.js
 * itself — that engine is documented as pure client-side query logic with no
 * side effects, and the camera zoom-out this feature performs is a wiring
 * concern that belongs in src/voice/gevActions.js's runAnalystQuery.
 * @module data/analystRetryPolicy
 */

import { applyFilter, haversineKm } from './analystEngine.js';

/**
 * Whether an analyst_query spec is a "relevant search" for auto-retry: a
 * single-layer flights query, sorted nearest-first, scoped to the current
 * VIEW, filtering on a specific departure/arrival airport. Scope is
 * restricted to 'view' (the default) rather than also allowing 'radius'
 * because a zoom-out only widens what analystEngine.js treats as "in view" —
 * an explicit radius query carries its own fixed km value, independent of
 * camera altitude, so zooming the camera cannot widen it at all. This also
 * intentionally excludes plain counts, unfiltered "how many flights"
 * questions, and non-flights layers — retrying those would just re-answer
 * the same non-empty result or burn a zoom on a question the camera can't
 * help.
 * @param {object} spec - The same spec passed to analystEngine's query().
 * @returns {boolean}
 */
export function isNearestOriginFlightQuery(spec) {
  // A follow-up re-filters the ENGINE's remembered result set instead of a
  // fresh layer snapshot (see analystEngine.js's query()) — a camera zoom
  // cannot add anything to an already-fixed remembered set, so retrying one
  // would just re-run the identical filter over identical data.
  if (spec?.followUp) return false;
  const layers =
    Array.isArray(spec?.layers) && spec.layers.length
      ? spec.layers
      : ['flights'];
  if (layers.length !== 1 || layers[0] !== 'flights') return false;
  if (spec?.sortBy !== 'distance') return false;
  const scopeKind = spec?.scope?.kind || 'view';
  if (scopeKind !== 'view') return false;
  const filters = Array.isArray(spec?.filters) ? spec.filters : [];
  return filters.some(
    (f) => f?.field === 'routeOrigin' && (f.op === 'eq' || f.op === 'contains'),
  );
}

/**
 * Apply the same filters/sort/limit an empty live query used, against the
 * recent-sightings history instead — the fallback used once zoom-retry (or
 * the plain live query, if zoom-retry is off) still comes back empty. Each
 * returned record already carries `staleSecondsAgo` from the history store;
 * callers are responsible for labeling it as such in the response.
 * @param {Array<object>} sightings - flightSightingHistory.recentSightings() output.
 * @param {object} spec - The original query spec (filters/limit reused).
 * @param {{lat:number, lon:number}} referenceCenter - Distance reference point.
 * @returns {Array<object>} Up to `spec.limit` (default 10) nearest matches.
 */
export function historicalNearestOriginMatches(
  sightings,
  spec,
  referenceCenter,
) {
  let items = sightings.slice();
  for (const filter of spec?.filters || []) items = applyFilter(items, filter);
  if (
    !Number.isFinite(referenceCenter?.lat) ||
    !Number.isFinite(referenceCenter?.lon)
  ) {
    return [];
  }
  for (const item of items) {
    item.distanceKm =
      Number.isFinite(item.lat) && Number.isFinite(item.lon)
        ? Math.round(
            haversineKm(
              referenceCenter.lat,
              referenceCenter.lon,
              item.lat,
              item.lon,
            ) * 10,
          ) / 10
        : null;
  }
  items.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
  const limit = Math.max(1, Math.min(50, Number(spec?.limit) || 10));
  return items.slice(0, limit);
}
