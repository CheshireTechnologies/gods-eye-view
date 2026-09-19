// src/data/analystZoomRetry.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAnalystZoomRetryEnabled,
  setAnalystZoomRetryEnabled,
  _resetAnalystZoomRetryForTest,
} from './analystZoomRetry.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, value); },
  };
}

test('defaults to enabled', () => {
  _resetAnalystZoomRetryForTest(memoryStorage());
  assert.equal(isAnalystZoomRetryEnabled(), true);
});

test('setAnalystZoomRetryEnabled updates the live value', () => {
  _resetAnalystZoomRetryForTest(memoryStorage());
  setAnalystZoomRetryEnabled(false);
  assert.equal(isAnalystZoomRetryEnabled(), false);
  setAnalystZoomRetryEnabled(true);
  assert.equal(isAnalystZoomRetryEnabled(), true);
});

test('setAnalystZoomRetryEnabled coerces to a strict boolean', () => {
  _resetAnalystZoomRetryForTest(memoryStorage());
  assert.equal(setAnalystZoomRetryEnabled('nope'), false);
  assert.equal(setAnalystZoomRetryEnabled(1), false);
  assert.equal(setAnalystZoomRetryEnabled(true), true);
});

test('persists the preference to the injected storage across reads', () => {
  const storage = memoryStorage();
  _resetAnalystZoomRetryForTest(storage);
  setAnalystZoomRetryEnabled(false);
  assert.equal(storage.getItem('gev:analyst-zoom-retry'), '0');
  setAnalystZoomRetryEnabled(true);
  assert.equal(storage.getItem('gev:analyst-zoom-retry'), '1');
});

test('reads a preference already present in storage', () => {
  const storage = memoryStorage();
  storage.setItem('gev:analyst-zoom-retry', '0');
  _resetAnalystZoomRetryForTest(storage);
  assert.equal(isAnalystZoomRetryEnabled(), false);
});
