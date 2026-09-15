// src/layers/vessels/selection.test.mjs
//
// Tracking persistence for vessels (see trackingPersistence.js /
// refreshTrackingRestore.js): disable() arms a restore for the selected
// vessel instead of forgetting it; the next enable() either re-selects it
// (still present — vesselMap is untouched by disable()) or, if it's
// genuinely gone, reports confirmed disappearance. These tests drive the
// real arm/attempt functions via testing.js's passthroughs rather than the
// full enable()/disable() lifecycle, which needs a real Cesium
// ScreenSpaceEventHandler/canvas that isn't worth mocking here — the
// lifecycle.js wiring itself (disable() calls _armRefreshSelectionRestore
// before clearing, enable() calls _attemptRefreshSelectionRestore on the
// OFF→ON transition) is a thin, directly-readable call, not exercised twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVesselLayer } from './index.js';
import {
  setTrackingPersistenceEnabled,
  _resetTrackingPersistenceForTest,
} from '../../data/trackingPersistence.js';
import {
  registerEntityContext,
  selectEntityContext,
  clearSelectedEntityContextForLayer,
} from '../../data/contextStore.js';

const noop = () => {};
function services() {
  return {
    // The REAL contextStore functions (not no-ops): this suite specifically
    // verifies the gev:entity-selected / gev:entity-selection-cleared events
    // they dispatch, which is the UI-feedback signal for restore/expiry.
    context: {
      clearSelectedEntityContextForLayer,
      registerEntityContext,
      selectEntityContext,
    },
    trails: {
      createTrail: () => ({ setPositions: noop, clear: noop, destroy: noop }),
    },
    labels: {},
    picking: { unregisterPickOwner: noop },
    overlay: {
      setOverlayEntries: noop,
      setOverlaySourceVisible: noop,
      clearOverlaySource: noop,
    },
    geoid: {},
    sprites: {},
    focus: {
      focusNowMs: (now) => now,
      getFocusTarget: () => null,
      focusPassIsNeeded: () => false,
      forgetSpriteFocus: noop,
    },
    worldFocus: { requestWorldFocus: noop },
    render: { releaseContinuousRender: noop },
  };
}

function vessel(mmsi) {
  return {
    mmsi,
    name: `VESSEL-${mmsi}`,
    lat: 51.9,
    lon: 4.1,
    speed: 12,
    course: 90,
    type: 'cargo',
    destination: '',
    missedRefreshes: 0,
    billboard: null,
  };
}

function setup({ selectedMmsi = null, records = [] } = {}) {
  const source = { async getSnapshot() { return { records: [], source: 'fixture', complete: true }; } };
  const layer = createVesselLayer({ source, services: services() });
  const vessels = records.length ? records : (selectedMmsi ? [vessel(selectedMmsi)] : []);
  layer.testing._setVesselStateForTest({
    viewer: {},
    records: vessels,
    selectedRecord: selectedMmsi ? vessels.find((v) => v.mmsi === selectedMmsi) : null,
  });
  return layer;
}

test('disable-arming requires both persistence enabled and an active selection', () => {
  _resetTrackingPersistenceForTest();
  const nothingSelected = setup({ selectedMmsi: null });
  nothingSelected.testing._armRefreshSelectionRestoreForTest();
  assert.equal(nothingSelected.testing._getVesselStateForTest().pendingSelectionRestore, null);

  const selected = setup({ selectedMmsi: '111222333' });
  selected.testing._armRefreshSelectionRestoreForTest();
  const pending = selected.testing._getVesselStateForTest().pendingSelectionRestore;
  assert.equal(pending.mmsi, '111222333');
  assert.equal(pending.reason, 'refresh');
});

test('persistence disabled never arms a restore, even with an active selection', () => {
  _resetTrackingPersistenceForTest();
  setTrackingPersistenceEnabled(false);
  const layer = setup({ selectedMmsi: '111222333' });
  layer.testing._armRefreshSelectionRestoreForTest();
  assert.equal(layer.testing._getVesselStateForTest().pendingSelectionRestore, null);
  setTrackingPersistenceEnabled(true);
});

test('re-enable re-selects a still-present vessel with origin refresh-restore', (t) => {
  const originalDocument = globalThis.document;
  globalThis.document = { getElementById: () => null };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
  _resetTrackingPersistenceForTest();
  const layer = setup({ selectedMmsi: '111222333' });
  layer.testing._armRefreshSelectionRestoreForTest();
  assert.ok(layer.testing._getVesselStateForTest().pendingSelectionRestore);

  const originalWindow = globalThis.window;
  const events = [];
  globalThis.window = { dispatchEvent: (event) => { events.push(event); return true; } };
  let restored;
  try {
    // Mirror disable()'s real sequence (arm, THEN clear) — arming alone does
    // not touch state.selectedRecord.
    layer.clearSelection();
    assert.equal(layer.getSelectedInfo(), null);
    restored = layer.testing._attemptRefreshSelectionRestoreForTest();
  } finally {
    globalThis.window = originalWindow;
  }
  assert.equal(restored, true);
  assert.equal(layer.getSelectedInfo()?.mmsi, '111222333');
  assert.equal(layer.testing._getVesselStateForTest().pendingSelectionRestore, null);
  const selectedEvent = events.find((event) => event.type === 'gev:entity-selected');
  assert.equal(selectedEvent?.detail?.origin, 'refresh-restore');
});

test('re-enable with the vessel gone reports confirmed disappearance', (t) => {
  const originalDocument = globalThis.document;
  globalThis.document = { getElementById: () => null };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
  _resetTrackingPersistenceForTest();
  const layer = setup({ selectedMmsi: '111222333' });
  layer.testing._armRefreshSelectionRestoreForTest();
  assert.ok(layer.testing._getVesselStateForTest().pendingSelectionRestore);

  const originalWindow = globalThis.window;
  const events = [];
  globalThis.window = { dispatchEvent: (event) => { events.push(event); return true; } };
  try {
    layer.clearSelection();
    // disable() never touches vesselMap — the only realistic way the pending
    // target is gone by the time enable() checks is if it was never really
    // there to begin with (defensive branch), simulated here directly.
    layer.testing._deleteVesselFromMapForTest('111222333');
    const restored = layer.testing._attemptRefreshSelectionRestoreForTest();
    assert.equal(restored, false);
  } finally {
    globalThis.window = originalWindow;
  }
  assert.equal(layer.getSelectedInfo(), null);
  assert.equal(layer.testing._getVesselStateForTest().pendingSelectionRestore, null);
  const expiredEvent = events.find((event) => event.type === 'gev:entity-selection-cleared');
  assert.deepEqual(expiredEvent?.detail, { layerId: 'ais-live-vessels', reason: 'refresh-expired' });
});

test('a restore attempt with nothing armed is a no-op', () => {
  _resetTrackingPersistenceForTest();
  const layer = setup({ selectedMmsi: null });
  const restored = layer.testing._attemptRefreshSelectionRestoreForTest();
  assert.equal(restored, false);
  assert.equal(layer.getSelectedInfo(), null);
});
