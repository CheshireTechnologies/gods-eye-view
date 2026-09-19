/**
 * User preference: whether a "nearest X from a specified origin"-style
 * analyst_query that comes back with zero results (e.g. no matching flights
 * currently in view) should automatically pull the camera back a little and
 * re-run the query once, then — if still empty — fall back to the most
 * recently seen matching flight(s) from src/data/flightSightingHistory.js,
 * clearly labeled as stale. Defaults to ON — the goal is an assistant that
 * automatically does what it takes to answer the question rather than
 * flatly reporting "nothing found" when a small, bounded retry would help.
 * An operator who wants the strict literal "what's in view right now"
 * answer can turn it off.
 *
 * Read by runAnalystQuery's retry wiring in src/voice/gevActions.js; written
 * by the "auto-retry nearest search" UI toggle. Persisted to localStorage,
 * same storage tier as trackingPersistence.js.
 * @module data/analystZoomRetry
 */

const STORAGE_KEY = 'gev:analyst-zoom-retry';

function safeStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

let _storage = safeStorage();

function readStoredPreference() {
  try {
    const raw = _storage?.getItem?.(STORAGE_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return null; // unset — caller falls back to the default
  } catch {
    return null;
  }
}

let _enabled = readStoredPreference() ?? true;

/** Whether an empty nearest-origin query should auto zoom-out-and-retry. */
export function isAnalystZoomRetryEnabled() {
  return _enabled;
}

/** Set the preference and best-effort save it for next session. */
export function setAnalystZoomRetryEnabled(enabled) {
  _enabled = enabled === true;
  try {
    _storage?.setItem?.(STORAGE_KEY, _enabled ? '1' : '0');
  } catch {
    /* storage unavailable — the in-memory value still applies this session */
  }
  return _enabled;
}

/** Test-only: reset to the default and inject a fake storage. */
export function _resetAnalystZoomRetryForTest(storage = safeStorage()) {
  _storage = storage;
  _enabled = readStoredPreference() ?? true;
}
