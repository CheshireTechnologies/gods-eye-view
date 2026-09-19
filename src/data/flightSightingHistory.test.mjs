// src/data/flightSightingHistory.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFlightSightingHistory } from './flightSightingHistory.js';

test('recordSightings then recentSightings returns the recorded records with staleness', () => {
  let now = 1_000_000;
  const history = createFlightSightingHistory({ now: () => now });
  history.recordSightings([{ icao24: 'a1', lat: 30, lon: -97 }]);
  now += 5_000;
  const [sighting] = history.recentSightings();
  assert.equal(sighting.icao24, 'a1');
  assert.equal(sighting.staleSecondsAgo, 5);
});

test('a later sighting of the same aircraft replaces the earlier one', () => {
  let now = 1_000_000;
  const history = createFlightSightingHistory({ now: () => now });
  history.recordSightings([{ icao24: 'a1', lat: 30, lon: -97 }]);
  now += 60_000;
  history.recordSightings([{ icao24: 'a1', lat: 31, lon: -98 }]);
  const sightings = history.recentSightings();
  assert.equal(sightings.length, 1);
  assert.equal(sightings[0].lat, 31);
  assert.equal(sightings[0].staleSecondsAgo, 0);
});

test('sightings older than maxAgeMs are excluded', () => {
  let now = 1_000_000;
  const history = createFlightSightingHistory({ maxAgeMs: 10_000, now: () => now });
  history.recordSightings([{ icao24: 'a1', lat: 30, lon: -97 }]);
  now += 10_001;
  assert.deepEqual(history.recentSightings(), []);
});

test('prune removes stale entries so size() reflects only fresh ones', () => {
  let now = 1_000_000;
  const history = createFlightSightingHistory({ maxAgeMs: 10_000, now: () => now });
  history.recordSightings([{ icao24: 'a1', lat: 30, lon: -97 }]);
  now += 10_001;
  history.recordSightings([{ icao24: 'a2', lat: 31, lon: -98 }]);
  history.prune();
  assert.equal(history.size(), 1);
});

test('records without an icao24 are ignored', () => {
  const history = createFlightSightingHistory();
  history.recordSightings([{ lat: 30, lon: -97 }]);
  assert.equal(history.size(), 0);
});

test('evicts the oldest entries once maxEntries is exceeded', () => {
  let now = 1_000_000;
  const history = createFlightSightingHistory({ maxEntries: 2, now: () => now });
  history.recordSightings([{ icao24: 'a1', lat: 30, lon: -97 }]);
  now += 1_000;
  history.recordSightings([{ icao24: 'a2', lat: 30, lon: -97 }]);
  now += 1_000;
  history.recordSightings([{ icao24: 'a3', lat: 30, lon: -97 }]);
  assert.equal(history.size(), 2);
  const ids = history.recentSightings().map((s) => s.icao24).sort();
  assert.deepEqual(ids, ['a2', 'a3']);
});
