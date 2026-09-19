import * as Cesium from 'cesium';
import {
  ANON_VEHICLE_TRACKING_ENABLED,
  ANON_VEHICLE_SESSION_TTL_MS,
  ANON_VEHICLE_MAX_RANGE_M,
  ANON_VEHICLE_DEFAULT_LIMIT,
} from './policy.js';

/**
 * @file Privacy-preserving, ephemeral vehicle proximity roster.
 *
 * The traffic dot simulation (state.js/animation.js) already carries zero
 * real-world identity — no plate, VIN, or persistent record, just a point
 * moving along real OSM road geometry. This module formalizes that into a
 * queryable roster of anonymous "vehicle" sessions: a rotating, opaque token
 * per in-range dot instead of a raw array index, minted on first query and
 * retired automatically once its TTL lapses or the underlying dot is gone
 * (recycled by a road-data reload, or simply no longer in range). A token
 * therefore never implies "the same vehicle" beyond ANON_VEHICLE_SESSION_TTL_MS.
 *
 * By construction: nothing here reads/writes storage, nothing here logs, and
 * a returned record carries exactly {token, latitude, longitude, headingDeg,
 * speedMps} — never anything derived from `road` (name/type/OSM id) and never
 * a cross-session-stable identifier.
 *
 * @module layers/traffic/anonymousVehicleTracking
 */

function randomToken() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // Extremely defensive fallback for an environment with no Web Crypto —
  // still opaque and non-sequential, just not RFC4122.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createAnonymousVehicleTracking({
  state: layerState,
  // Overridable for tests only — production callers always get the policy
  // default (context objects that don't set this key fall through to it).
  trackingEnabled = ANON_VEHICLE_TRACKING_ENABLED,
}) {
  /** @type {Map<object, {token:string, issuedAtMs:number}>} dot → session */
  const _sessions = new Map();
  /** @type {Map<string, object>} token → dot, for symmetry/future lookups */
  const _tokenToDot = new Map();

  function _retireSession(dot, session) {
    _sessions.delete(dot);
    if (session) _tokenToDot.delete(session.token);
  }

  /** Reuse a still-fresh token for this dot, or mint (and retire the old one). */
  function _sessionToken(dot, nowMs) {
    const existing = _sessions.get(dot);
    if (
      existing &&
      nowMs - existing.issuedAtMs <= ANON_VEHICLE_SESSION_TTL_MS
    ) {
      return existing.token;
    }
    if (existing) _retireSession(dot, existing);
    const token = randomToken();
    _sessions.set(dot, { token, issuedAtMs: nowMs });
    _tokenToDot.set(token, dot);
    return token;
  }

  /** Drop sessions for dots that vanished (recycled) or aged past their TTL untouched. */
  function _pruneStaleSessions(liveDots, nowMs) {
    for (const [dot, session] of _sessions) {
      const stillLive = liveDots.has(dot);
      const expired = nowMs - session.issuedAtMs > ANON_VEHICLE_SESSION_TTL_MS;
      if (!stillLive || expired) _retireSession(dot, session);
    }
  }

  /** Geographic heading (deg, true north) along the dot's current travel leg. */
  function _dotHeadingDeg(dot) {
    const a = dot.waypoints?.[dot.segIdx];
    const b = dot.waypoints?.[dot.segIdx + 1];
    if (!a || !b) return 0;
    const [from, to] = dot.direction >= 0 ? [a, b] : [b, a];
    try {
      const geodesic = new Cesium.EllipsoidGeodesic(
        Cesium.Cartographic.fromCartesian(from),
        Cesium.Cartographic.fromCartesian(to),
      );
      const headingDeg = Cesium.Math.toDegrees(geodesic.startHeading);
      return ((headingDeg % 360) + 360) % 360;
    } catch {
      return 0; // degenerate leg (identical endpoints) — no bearing to report
    }
  }

  /**
   * Anonymous, ephemeral vehicles within `radiusM` of `center`.
   * @param {Cesium.Cartesian3} center
   * @param {number} [radiusM] - Clamped to ANON_VEHICLE_MAX_RANGE_M.
   * @param {{limit?:number, now?:number}} [options] - `now` overrides the
   *   clock for tests; production callers omit it.
   * @returns {Array<{token:string, latitude:number, longitude:number, headingDeg:number, speedMps:number}>}
   */
  function getAnonymousVehiclesInRange(center, radiusM, { limit, now } = {}) {
    const nowMs = Number.isFinite(now) ? now : Date.now();
    const liveDots = new Set(layerState._dots);
    if (!trackingEnabled || !center) {
      _pruneStaleSessions(liveDots, nowMs);
      return [];
    }
    const effectiveRadiusM = Math.min(
      Number.isFinite(radiusM)
        ? Math.max(0, radiusM)
        : ANON_VEHICLE_MAX_RANGE_M,
      ANON_VEHICLE_MAX_RANGE_M,
    );
    const effectiveLimit = Number.isFinite(limit)
      ? Math.max(1, Math.floor(limit))
      : ANON_VEHICLE_DEFAULT_LIMIT;

    const candidates = [];
    for (const dot of layerState._dots) {
      const pos = dot.point?.position;
      if (!pos) continue;
      const distanceM = Cesium.Cartesian3.distance(center, pos);
      if (distanceM > effectiveRadiusM) continue;
      candidates.push({ dot, pos, distanceM });
    }
    candidates.sort((a, b) => a.distanceM - b.distanceM);

    const records = [];
    for (const { dot, pos } of candidates) {
      if (records.length >= effectiveLimit) break;
      const carto = Cesium.Cartographic.fromCartesian(pos);
      if (!carto) continue;
      records.push({
        token: _sessionToken(dot, nowMs),
        latitude: Cesium.Math.toDegrees(carto.latitude),
        longitude: Cesium.Math.toDegrees(carto.longitude),
        headingDeg: _dotHeadingDeg(dot),
        speedMps: dot.mps,
      });
    }
    _pruneStaleSessions(liveDots, nowMs);
    return records;
  }

  /**
   * Session tokens for an arbitrary batch of dots — backs on-screen vehicle
   * labels with the same rotating, opaque token as the proximity roster.
   * Shares `_sessions` with {@link getAnonymousVehiclesInRange}, so a dot
   * keeps one identity across both call sites within the TTL. Unlike that
   * function, this does no distance filtering — the caller has already
   * chosen which dots to label.
   * @param {Array<object>} dots
   * @param {{now?: number}} [options] - `now` overrides the clock for tests.
   * @returns {Map<object, string>} dot → token; empty (not omitted-per-dot)
   *   when tracking is disabled, so callers can fall back cleanly.
   */
  function getVehicleLabelTokens(dots, { now } = {}) {
    const nowMs = Number.isFinite(now) ? now : Date.now();
    const liveDots = new Set(layerState._dots);
    const tokens = new Map();
    if (trackingEnabled) {
      for (const dot of dots) {
        tokens.set(dot, _sessionToken(dot, nowMs));
      }
    }
    _pruneStaleSessions(liveDots, nowMs);
    return tokens;
  }

  /** Wipe every anonymous session immediately (layer disable/teardown). */
  function clearAnonymousVehicleSessions() {
    _sessions.clear();
    _tokenToDot.clear();
  }

  return {
    methods: {
      getAnonymousVehiclesInRange,
      getVehicleLabelTokens,
      clearAnonymousVehicleSessions,
    },
  };
}
