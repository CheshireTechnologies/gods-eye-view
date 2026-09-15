// src/data/trackingPersistence.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTrackingPersistenceEnabled,
  setTrackingPersistenceEnabled,
  _resetTrackingPersistenceForTest,
} from './trackingPersistence.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, value); },
  };
}

test('defaults to enabled', () => {
  _resetTrackingPersistenceForTest(memoryStorage());
  assert.equal(isTrackingPersistenceEnabled(), true);
});

test('setTrackingPersistenceEnabled updates the live value', () => {
  _resetTrackingPersistenceForTest(memoryStorage());
  setTrackingPersistenceEnabled(false);
  assert.equal(isTrackingPersistenceEnabled(), false);
  setTrackingPersistenceEnabled(true);
  assert.equal(isTrackingPersistenceEnabled(), true);
});

test('setTrackingPersistenceEnabled coerces to a strict boolean', () => {
  _resetTrackingPersistenceForTest(memoryStorage());
  assert.equal(setTrackingPersistenceEnabled('nope'), false);
  assert.equal(setTrackingPersistenceEnabled(1), false);
  assert.equal(setTrackingPersistenceEnabled(true), true);
});

test('persists the preference to the injected storage across reads', () => {
  const storage = memoryStorage();
  _resetTrackingPersistenceForTest(storage);
  setTrackingPersistenceEnabled(false);
  assert.equal(storage.getItem('gev:tracking-persistence'), '0');
  setTrackingPersistenceEnabled(true);
  assert.equal(storage.getItem('gev:tracking-persistence'), '1');
});

test('reads a preference already present in storage', () => {
  const storage = memoryStorage();
  storage.setItem('gev:tracking-persistence', '0');
  _resetTrackingPersistenceForTest(storage);
  assert.equal(isTrackingPersistenceEnabled(), false);
});
