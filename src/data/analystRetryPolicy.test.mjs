// src/data/analystRetryPolicy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isNearestOriginFlightQuery,
  historicalNearestOriginMatches,
} from './analystRetryPolicy.js';

const NEAREST_FROM_AUSTIN = {
  layers: ['flights'],
  scope: { kind: 'view' },
  filters: [{ field: 'routeOrigin', op: 'eq', value: 'AUS' }],
  sortBy: 'distance',
};

test('matches the canonical "nearest flight from <origin>" shape', () => {
  assert.equal(isNearestOriginFlightQuery(NEAREST_FROM_AUSTIN), true);
});

test('scope.kind defaulting to view (unspecified) still matches', () => {
  const spec = { ...NEAREST_FROM_AUSTIN, scope: undefined };
  assert.equal(isNearestOriginFlightQuery(spec), true);
});

test('rejects a plain count with no sort/filter', () => {
  assert.equal(isNearestOriginFlightQuery({ layers: ['flights'] }), false);
});

test('rejects when not sorted by distance', () => {
  assert.equal(
    isNearestOriginFlightQuery({ ...NEAREST_FROM_AUSTIN, sortBy: 'altitudeM' }),
    false,
  );
});

test('rejects when the filter is not on routeOrigin', () => {
  const spec = {
    ...NEAREST_FROM_AUSTIN,
    filters: [{ field: 'operator', op: 'eq', value: 'Delta' }],
  };
  assert.equal(isNearestOriginFlightQuery(spec), false);
});

test('rejects a region scope — zoom cannot widen a resolved boundary', () => {
  const spec = { ...NEAREST_FROM_AUSTIN, scope: { kind: 'region', name: 'Texas' } };
  assert.equal(isNearestOriginFlightQuery(spec), false);
});

test('rejects an explicit radius scope — its km is fixed, independent of camera altitude', () => {
  const spec = { ...NEAREST_FROM_AUSTIN, scope: { kind: 'radius', km: 200 } };
  assert.equal(isNearestOriginFlightQuery(spec), false);
});

test('rejects multi-layer queries', () => {
  const spec = { ...NEAREST_FROM_AUSTIN, layers: ['flights', 'military'] };
  assert.equal(isNearestOriginFlightQuery(spec), false);
});

test('rejects a non-flights layer', () => {
  const spec = { ...NEAREST_FROM_AUSTIN, layers: ['military'] };
  assert.equal(isNearestOriginFlightQuery(spec), false);
});

test('rejects a follow-up — it re-filters the remembered set, which a zoom cannot grow', () => {
  const spec = { ...NEAREST_FROM_AUSTIN, followUp: true };
  assert.equal(isNearestOriginFlightQuery(spec), false);
});

test('historicalNearestOriginMatches filters by the spec and sorts nearest-first', () => {
  const reference = { lat: 30.2672, lon: -97.7431 };
  const sightings = [
    { icao24: 'a1', routeOrigin: 'AUS', lat: 30.27, lon: -97.75, staleSecondsAgo: 400 },
    { icao24: 'a2', routeOrigin: 'DFW', lat: 30.2, lon: -97.2, staleSecondsAgo: 200 },
    { icao24: 'a3', routeOrigin: 'AUS', lat: 30.1, lon: -97.1, staleSecondsAgo: 100 },
  ];
  const matches = historicalNearestOriginMatches(
    sightings,
    NEAREST_FROM_AUSTIN,
    reference,
  );
  // Only the two AUS-origin sightings match the filter; a2 (DFW) is excluded
  // regardless of distance. a1 sits essentially at the reference point, so it
  // sorts first.
  assert.deepEqual(matches.map((m) => m.icao24), ['a1', 'a3']);
  assert.ok(matches[0].distanceKm < matches[1].distanceKm);
});

test('historicalNearestOriginMatches respects the spec limit', () => {
  const sightings = Array.from({ length: 5 }, (_, i) => ({
    icao24: `a${i}`,
    routeOrigin: 'AUS',
    lat: 30 + i * 0.01,
    lon: -97,
  }));
  const matches = historicalNearestOriginMatches(
    sightings,
    { ...NEAREST_FROM_AUSTIN, limit: 2 },
    { lat: 30, lon: -97 },
  );
  assert.equal(matches.length, 2);
});

test('historicalNearestOriginMatches returns nothing without a usable reference centre', () => {
  const sightings = [{ icao24: 'a1', routeOrigin: 'AUS', lat: 30, lon: -97 }];
  assert.deepEqual(
    historicalNearestOriginMatches(sightings, NEAREST_FROM_AUSTIN, null),
    [],
  );
});
