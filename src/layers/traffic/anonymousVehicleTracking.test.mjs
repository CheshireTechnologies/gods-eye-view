// src/layers/traffic/anonymousVehicleTracking.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createAnonymousVehicleTracking } from './anonymousVehicleTracking.js';
import { ANON_VEHICLE_SESSION_TTL_MS, ANON_VEHICLE_MAX_RANGE_M } from './policy.js';

const ORIGIN = Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 0); // Austin, TX

function makeDot({ lon, lat, mps = 10, direction = 1 } = {}) {
  const waypoints = [
    Cesium.Cartesian3.fromDegrees(lon, lat, 0),
    Cesium.Cartesian3.fromDegrees(lon + 0.001, lat + 0.001, 0),
  ];
  return {
    point: { position: waypoints[0] },
    road: { type: 'residential', coords: [], waypoints: [] }, // never read by the module
    waypoints,
    segmentDist: [1],
    numSegments: 1,
    segIdx: 0,
    t: 0,
    mps,
    direction,
  };
}

function makeLayerState(dots) {
  return { _dots: dots };
}

test('returns dots within range with the documented fields, excludes out-of-range dots', () => {
  const near = makeDot({ lon: -97.743, lat: 30.2673 }); // ~15 m away
  const far = makeDot({ lon: -97.9, lat: 30.5 }); // far outside any sane radius
  const { methods } = createAnonymousVehicleTracking({ state: makeLayerState([near, far]) });

  const result = methods.getAnonymousVehiclesInRange(ORIGIN, 1000);
  assert.equal(result.length, 1);
  const record = result[0];
  assert.ok(Number.isFinite(record.latitude));
  assert.ok(Number.isFinite(record.longitude));
  assert.ok(Number.isFinite(record.headingDeg));
  assert.equal(record.speedMps, 10);
  assert.equal(typeof record.token, 'string');
  assert.ok(record.token.length > 0);
});

test('the same in-range dot keeps the same token across queries within the TTL', () => {
  const dot = makeDot({ lon: -97.743, lat: 30.2673 });
  const { methods } = createAnonymousVehicleTracking({ state: makeLayerState([dot]) });

  const now = 1_000_000;
  const first = methods.getAnonymousVehiclesInRange(ORIGIN, 1000, { now })[0];
  const second = methods.getAnonymousVehiclesInRange(ORIGIN, 1000, { now: now + 5000 })[0];
  assert.equal(first.token, second.token);
});

test('a token rotates once its TTL lapses — short retention, automatic expiry', () => {
  const dot = makeDot({ lon: -97.743, lat: 30.2673 });
  const { methods } = createAnonymousVehicleTracking({ state: makeLayerState([dot]) });

  const now = 1_000_000;
  const first = methods.getAnonymousVehiclesInRange(ORIGIN, 1000, { now })[0];
  const later = now + ANON_VEHICLE_SESSION_TTL_MS + 1;
  const second = methods.getAnonymousVehiclesInRange(ORIGIN, 1000, { now: later })[0];
  assert.notEqual(first.token, second.token);
});

test('PII-absence contract: a record carries EXACTLY the documented fields, nothing more', () => {
  const dot = makeDot({ lon: -97.743, lat: 30.2673 });
  const { methods } = createAnonymousVehicleTracking({ state: makeLayerState([dot]) });
  const [record] = methods.getAnonymousVehiclesInRange(ORIGIN, 1000);
  assert.deepEqual(
    Object.keys(record).sort(),
    ['headingDeg', 'latitude', 'longitude', 'speedMps', 'token'],
    'a road name/OSM id/persistent id field would fail this exact-key-set check',
  );
});

test('PII-absence contract: nothing here touches storage or logs across a mint→query→expire cycle', () => {
  const dot = makeDot({ lon: -97.743, lat: 30.2673 });
  const { methods } = createAnonymousVehicleTracking({ state: makeLayerState([dot]) });

  const calls = { log: 0, warn: 0, error: 0, setItem: 0 };
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = () => { calls.log += 1; };
  console.warn = () => { calls.warn += 1; };
  console.error = () => { calls.error += 1; };
  let originalSetItem = null;
  const hasStorage = typeof Storage !== 'undefined';
  if (hasStorage) {
    originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function patched(...args) {
      calls.setItem += 1;
      return originalSetItem.apply(this, args);
    };
  }

  try {
    const now = 2_000_000;
    methods.getAnonymousVehiclesInRange(ORIGIN, 1000, { now }); // mint
    methods.getAnonymousVehiclesInRange(ORIGIN, 1000, { now: now + 1000 }); // query
    methods.getAnonymousVehiclesInRange(ORIGIN, 1000, { now: now + ANON_VEHICLE_SESSION_TTL_MS + 1 }); // expire
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    if (hasStorage) Storage.prototype.setItem = originalSetItem;
  }

  assert.equal(calls.log, 0);
  assert.equal(calls.warn, 0);
  assert.equal(calls.error, 0);
  assert.equal(calls.setItem, 0);
});

test('clearAnonymousVehicleSessions wipes all sessions — a later query mints a brand-new token', () => {
  const dot = makeDot({ lon: -97.743, lat: 30.2673 });
  const { methods } = createAnonymousVehicleTracking({ state: makeLayerState([dot]) });

  const now = 3_000_000;
  const before = methods.getAnonymousVehiclesInRange(ORIGIN, 1000, { now })[0];
  methods.clearAnonymousVehicleSessions();
  const after = methods.getAnonymousVehiclesInRange(ORIGIN, 1000, { now: now + 1 })[0];
  assert.notEqual(before.token, after.token);
});

test('a dot dropped from _dots (recycled by a road reload) loses its session on the next sweep', () => {
  const dot = makeDot({ lon: -97.743, lat: 30.2673 });
  const layerState = makeLayerState([dot]);
  const { methods } = createAnonymousVehicleTracking({ state: layerState });

  const now = 4_000_000;
  const before = methods.getAnonymousVehiclesInRange(ORIGIN, 1000, { now })[0];
  layerState._dots = []; // road-data reload recycled the dot
  methods.getAnonymousVehiclesInRange(ORIGIN, 1000, { now: now + 1 }); // sweeps stale sessions
  layerState._dots = [dot]; // same object identity reappears (would not happen in practice, but proves no stale reuse)
  const after = methods.getAnonymousVehiclesInRange(ORIGIN, 1000, { now: now + 2 })[0];
  assert.notEqual(before.token, after.token);
});

test('respects the query radius cap and the caller-supplied limit', () => {
  const dots = [
    makeDot({ lon: -97.743, lat: 30.2673 }),
    makeDot({ lon: -97.7432, lat: 30.2674 }),
    makeDot({ lon: -97.7434, lat: 30.2675 }),
  ];
  const { methods } = createAnonymousVehicleTracking({ state: makeLayerState(dots) });

  const capped = methods.getAnonymousVehiclesInRange(ORIGIN, ANON_VEHICLE_MAX_RANGE_M * 10, { limit: 2 });
  assert.equal(capped.length, 2);
});

test('ANON_VEHICLE_TRACKING_ENABLED = false disables the capability entirely', () => {
  const dot = makeDot({ lon: -97.743, lat: 30.2673 });
  const { methods } = createAnonymousVehicleTracking({
    state: makeLayerState([dot]),
    trackingEnabled: false,
  });
  assert.deepEqual(methods.getAnonymousVehiclesInRange(ORIGIN, 1000), []);
});

test('an invalid/missing center returns an empty roster without throwing', () => {
  const dot = makeDot({ lon: -97.743, lat: 30.2673 });
  const { methods } = createAnonymousVehicleTracking({ state: makeLayerState([dot]) });
  assert.deepEqual(methods.getAnonymousVehiclesInRange(null, 1000), []);
});

test('getVehicleLabelTokens mints a token per dot, independent of proximity', () => {
  const near = makeDot({ lon: -97.743, lat: 30.2673 });
  const far = makeDot({ lon: -97.9, lat: 30.5 }); // outside any query radius
  const { methods } = createAnonymousVehicleTracking({ state: makeLayerState([near, far]) });

  const tokens = methods.getVehicleLabelTokens([near, far]);
  assert.equal(tokens.size, 2);
  assert.equal(typeof tokens.get(near), 'string');
  assert.equal(typeof tokens.get(far), 'string');
  assert.notEqual(tokens.get(near), tokens.get(far));
});

test('getVehicleLabelTokens shares one identity with the proximity roster within the TTL', () => {
  const dot = makeDot({ lon: -97.743, lat: 30.2673 });
  const { methods } = createAnonymousVehicleTracking({ state: makeLayerState([dot]) });

  const now = 5_000_000;
  const fromRange = methods.getAnonymousVehiclesInRange(ORIGIN, 1000, { now })[0];
  const fromLabels = methods.getVehicleLabelTokens([dot], { now: now + 1000 });
  assert.equal(fromLabels.get(dot), fromRange.token);
});

test('getVehicleLabelTokens rotates the token once its TTL lapses', () => {
  const dot = makeDot({ lon: -97.743, lat: 30.2673 });
  const { methods } = createAnonymousVehicleTracking({ state: makeLayerState([dot]) });

  const now = 6_000_000;
  const first = methods.getVehicleLabelTokens([dot], { now }).get(dot);
  const later = now + ANON_VEHICLE_SESSION_TTL_MS + 1;
  const second = methods.getVehicleLabelTokens([dot], { now: later }).get(dot);
  assert.notEqual(first, second);
});

test('getVehicleLabelTokens returns an empty map when tracking is disabled', () => {
  const dot = makeDot({ lon: -97.743, lat: 30.2673 });
  const { methods } = createAnonymousVehicleTracking({
    state: makeLayerState([dot]),
    trackingEnabled: false,
  });
  assert.equal(methods.getVehicleLabelTokens([dot]).size, 0);
});

test('getVehicleLabelTokens still sweeps sessions for dots recycled off _dots', () => {
  const dot = makeDot({ lon: -97.743, lat: 30.2673 });
  const layerState = makeLayerState([dot]);
  const { methods } = createAnonymousVehicleTracking({ state: layerState });

  const now = 7_000_000;
  const before = methods.getVehicleLabelTokens([dot], { now }).get(dot);
  layerState._dots = []; // road-data reload recycled the dot
  methods.getVehicleLabelTokens([], { now: now + 1 }); // sweeps stale sessions
  layerState._dots = [dot]; // same identity reappears — proves no stale reuse
  const after = methods.getVehicleLabelTokens([dot], { now: now + 2 }).get(dot);
  assert.notEqual(before, after);
});
