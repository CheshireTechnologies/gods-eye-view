// src/data/refreshTrackingRestore.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldArmRefreshRestore,
  buildRefreshRestoreRecord,
  isRefreshRestoreExpired,
} from './refreshTrackingRestore.js';

test('shouldArmRefreshRestore requires both persistence on and an active track', () => {
  assert.equal(shouldArmRefreshRestore({ persistenceEnabled: true, trackedId: 'abc123' }), true);
  assert.equal(shouldArmRefreshRestore({ persistenceEnabled: false, trackedId: 'abc123' }), false);
  assert.equal(shouldArmRefreshRestore({ persistenceEnabled: true, trackedId: null }), false);
  assert.equal(shouldArmRefreshRestore({ persistenceEnabled: true, trackedId: '' }), false);
});

test('buildRefreshRestoreRecord stamps the refresh reason and origin', () => {
  const record = buildRefreshRestoreRecord({ id: 'abc123', label: 'UAL123', generation: 4, nowMs: 1000 });
  assert.deepEqual(record, {
    id: 'abc123',
    label: 'UAL123',
    generation: 4,
    origin: 'refresh-restore',
    armedAtMs: 1000,
    reason: 'refresh',
  });
});

test('buildRefreshRestoreRecord falls back to the id when no label is known', () => {
  const record = buildRefreshRestoreRecord({ id: 'abc123', label: '', generation: 1, nowMs: 0 });
  assert.equal(record.label, 'abc123');
});

test('isRefreshRestoreExpired is false before the expiry window elapses', () => {
  const pending = buildRefreshRestoreRecord({ id: 'x', label: 'x', generation: 1, nowMs: 1000 });
  assert.equal(isRefreshRestoreExpired(pending, 1000, 90_000), false);
  assert.equal(isRefreshRestoreExpired(pending, 1000 + 89_999, 90_000), false);
});

test('isRefreshRestoreExpired is true once the expiry window elapses', () => {
  const pending = buildRefreshRestoreRecord({ id: 'x', label: 'x', generation: 1, nowMs: 1000 });
  assert.equal(isRefreshRestoreExpired(pending, 1000 + 90_001, 90_000), true);
});

test('isRefreshRestoreExpired ignores non-refresh latches (share/session restore owns those)', () => {
  const shareLatch = { id: 'x', generation: 1, origin: 'share-restore', reason: undefined, armedAtMs: 0 };
  assert.equal(isRefreshRestoreExpired(shareLatch, 10_000_000, 90_000), false);
});

test('isRefreshRestoreExpired handles a missing/malformed pending record', () => {
  assert.equal(isRefreshRestoreExpired(null, 1000, 90_000), false);
  assert.equal(isRefreshRestoreExpired({ reason: 'refresh' }, 1000, 90_000), false); // no armedAtMs
});
