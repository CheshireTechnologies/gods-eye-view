/**
 * Session-wide switch for whether an active track survives a layer
 * disable→re-enable cycle (a manual layer toggle, or an auto-disable/recover
 * from a feed outage) instead of being dropped outright. Defaults to ON.
 *
 * Read by every trackable layer's disable() path (flights/military/
 * satellites/vessels); written by the `set_tracking_persistence` voice
 * action. Persisted to localStorage so the choice survives a reload, same
 * storage tier layerState.js already uses for durable layer state.
 * @module data/trackingPersistence
 */

const STORAGE_KEY = 'gev:tracking-persistence';

// Same "best effort, never throw" shape as layerState.js's safeStorage() —
// storage can be absent (SSR, Node test runner, privacy mode), in which case
// the preference simply lives for the session instead of surviving reload.
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
    if (raw === '0') return false;
    if (raw === '1') return true;
    return null; // unset — caller falls back to the default
  } catch {
    return null;
  }
}

let _enabled = readStoredPreference() ?? true;

/** Whether a tracked entity should be remembered across a layer refresh. */
export function isTrackingPersistenceEnabled() {
  return _enabled;
}

/** Set the persistence preference and best-effort save it for next session. */
export function setTrackingPersistenceEnabled(enabled) {
  _enabled = enabled === true;
  try {
    _storage?.setItem?.(STORAGE_KEY, _enabled ? '1' : '0');
  } catch {
    /* storage unavailable — the in-memory value still applies this session */
  }
  return _enabled;
}

/** Test-only: reset to the default and inject a fake storage (a real
 *  environment has no `localStorage` under the Node test runner). */
export function _resetTrackingPersistenceForTest(storage = safeStorage()) {
  _storage = storage;
  _enabled = readStoredPreference() ?? true;
}
