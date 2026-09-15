// src/layers/traffic/controls.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createControls } from './controls.js';
import { createAnonymousVehicleTracking } from './anonymousVehicleTracking.js';

function makeDot({ lon, lat, bucket } = {}) {
  return {
    point: { position: Cesium.Cartesian3.fromDegrees(lon, lat, 0) },
    bucket,
  };
}

function makeLayerState(dots, { liveMode = false } = {}) {
  return { _enabled: true, _dots: dots, _liveMode: liveMode };
}

const source = { getFlowSessionStats: () => ({ tilesFetched: 0 }) };

test('getDetectableObjects labels are the VEH- prefix plus a 4-char code sliced from the rotating token', () => {
  const dots = [makeDot({ lon: -97.743, lat: 30.2673 }), makeDot({ lon: -97.744, lat: 30.2674 })];
  const state = makeLayerState(dots);
  const parts = { anonymousVehicleTracking: createAnonymousVehicleTracking({ state }) };
  const { methods } = createControls({ state, services: {}, parts, source });

  const objects = methods.getDetectableObjects();
  assert.equal(objects.length, 2);
  for (const obj of objects) {
    assert.match(obj.id, /^VEH-[0-9A-F]{4}$/);
    assert.equal(obj.type, 'VEH');
  }
});

test('getDetectableObjects keeps the same label for the same dot across calls within the token TTL', () => {
  const dots = [makeDot({ lon: -97.743, lat: 30.2673 })];
  const state = makeLayerState(dots);
  const parts = { anonymousVehicleTracking: createAnonymousVehicleTracking({ state }) };
  const { methods } = createControls({ state, services: {}, parts, source });

  const first = methods.getDetectableObjects()[0].id;
  const second = methods.getDetectableObjects()[0].id;
  assert.equal(first, second);
});

test('getDetectableObjects falls back to the sequential index label when anonymous tracking yields no token', () => {
  const dots = [makeDot({ lon: -97.743, lat: 30.2673 }), makeDot({ lon: -97.744, lat: 30.2674 })];
  const state = makeLayerState(dots);
  const parts = {
    anonymousVehicleTracking: { methods: { getVehicleLabelTokens: () => new Map() } },
  };
  const { methods } = createControls({ state, services: {}, parts, source });

  const objects = methods.getDetectableObjects();
  assert.deepEqual(objects.map((o) => o.id), ['VEH-0000', 'VEH-0001']);
});

test('getDetectableObjects gives each dot a stable sourceId independent of its rotating label', () => {
  const dots = [makeDot({ lon: -97.743, lat: 30.2673 }), makeDot({ lon: -97.744, lat: 30.2674 })];
  const state = makeLayerState(dots);
  const parts = { anonymousVehicleTracking: createAnonymousVehicleTracking({ state }) };
  const { methods } = createControls({ state, services: {}, parts, source });

  const first = methods.getDetectableObjects();
  const second = methods.getDetectableObjects();
  assert.equal(first[0].sourceId, second[0].sourceId);
  assert.equal(first[1].sourceId, second[1].sourceId);
  assert.notEqual(first[0].sourceId, first[1].sourceId);
});

test('sourceId stays put even when the display token rotates', () => {
  const dot = makeDot({ lon: -97.743, lat: 30.2673 });
  const state = makeLayerState([dot]);
  // Stub tokens so the label changes between calls without touching the
  // real TTL clock — sourceId must not move regardless.
  let call = 0;
  const parts = {
    anonymousVehicleTracking: {
      methods: {
        getVehicleLabelTokens: () => new Map([[dot, call++ === 0 ? 'aaaa-1111' : 'bbbb-2222']]),
      },
    },
  };
  const { methods } = createControls({ state, services: {}, parts, source });

  const first = methods.getDetectableObjects()[0];
  const second = methods.getDetectableObjects()[0];
  assert.notEqual(first.id, second.id);
  assert.equal(first.sourceId, second.sourceId);
});

test('getDetectableObjects still attaches a congestion tier in live mode only', () => {
  const dots = [makeDot({ lon: -97.743, lat: 30.2673, bucket: 'jam' })];
  const state = makeLayerState(dots, { liveMode: true });
  const parts = { anonymousVehicleTracking: createAnonymousVehicleTracking({ state }) };
  const { methods } = createControls({ state, services: {}, parts, source });

  const [object] = methods.getDetectableObjects();
  assert.equal(object.tier, 'veh_jam');
});
