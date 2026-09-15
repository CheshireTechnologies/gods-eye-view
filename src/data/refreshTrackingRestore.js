/**
 * Pure decision logic behind tracking persistence (configurable via
 * trackingPersistence.js): whether a layer disable() should ARM a restore
 * for whatever is currently tracked (instead of forgetting it outright), and
 * whether an armed restore has aged past its layer's expiry window into
 * CONFIRMED DISAPPEARANCE. Kept side-effect-free and Cesium-free so the
 * state machine is unit-testable without a viewer/DOM — each layer's
 * tracking.js does the actual arming/applying against its own live state.
 * @module data/refreshTrackingRestore
 */

/** Whether disable() should arm a refresh restore right now. */
export function shouldArmRefreshRestore({ persistenceEnabled, trackedId }) {
  return persistenceEnabled === true && Boolean(trackedId);
}

/** Build the pending-restore record disable() stores, given a fresh generation. */
export function buildRefreshRestoreRecord({ id, label, generation, nowMs }) {
  return {
    id,
    label: label || String(id),
    generation,
    origin: 'refresh-restore',
    armedAtMs: nowMs,
    reason: 'refresh',
  };
}

/**
 * Whether a pending restore is a refresh-persistence latch (as opposed to
 * the pre-existing share/session-restore latch, which never expires here —
 * its own coordinator owns that lifecycle) that has aged past its layer's
 * expiry window: confirmed disappearance, not "still mid-refresh."
 */
export function isRefreshRestoreExpired(pending, nowMs, expiryMs) {
  return (
    pending?.reason === 'refresh' &&
    Number.isFinite(pending.armedAtMs) &&
    nowMs - pending.armedAtMs > expiryMs
  );
}
