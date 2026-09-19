// src/voice/localVoicePhrases.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INFORMATIONAL_TOOLS,
  clarifyingQuestion,
  createPhrasebook,
  describeResult,
  joinSteps,
  situationPhrase,
  spokenNumber,
} from './localVoicePhrases.js';

/** Deterministic phrasebook: always tries the first eligible variant. */
const first = () => createPhrasebook({ random: () => 0 });

test('spokenNumber uses words up to ten and digits beyond', () => {
  assert.equal(spokenNumber(0), 'zero');
  assert.equal(spokenNumber(3), 'three');
  assert.equal(spokenNumber(10), 'ten');
  assert.equal(spokenNumber(42), '42');
  assert.equal(spokenNumber(1234), '1,234');
  assert.equal(spokenNumber('x'), '');
});

test('the phrasebook never repeats a phrase twice in a row for one situation', () => {
  for (const seed of [0, 0.3, 0.6, 0.99]) {
    const pb = createPhrasebook({ random: () => seed });
    const variants = ['a', 'b', 'c'];
    let previous = null;
    for (let i = 0; i < 12; i += 1) {
      const picked = pb.pick('k', variants);
      assert.notEqual(picked, previous, `repeated at seed ${seed}, pick ${i}`);
      previous = picked;
    }
  }
});

test('the phrasebook tracks repeats per situation independently', () => {
  const pb = first();
  const a1 = pb.pick('one', ['x', 'y']);
  const b1 = pb.pick('two', ['x', 'y']);
  assert.equal(a1, b1);
});

test('a lone variant is returned as-is', () => {
  assert.equal(first().pick('k', ['only']), 'only');
});

test('fly_to_location names the destination', () => {
  const said = describeResult(first(), 'fly_to_location', { ok: true, label: 'Tokyo' });
  assert.match(said, /Tokyo/);
  assert.match(
    describeResult(first(), 'fly_to_location', { ok: true, label: 'Tokyo', arrived: true }),
    /over Tokyo/,
  );
});

test('layer changes say which layer and which direction', () => {
  const on = describeResult(first(), 'set_layer_visibility', { ok: true, label: 'Satellites' }, { enabled: true });
  const off = describeResult(first(), 'set_layer_visibility', { ok: true, label: 'Satellites' }, { enabled: false });
  assert.match(on, /Satellites/);
  assert.match(off, /Satellites/);
  assert.notEqual(on, off);
  assert.match(off, /off|hiding/i);
});

test('zoom direction is spoken from the arguments', () => {
  assert.match(describeResult(first(), 'adjust_camera_zoom', { ok: true }, { direction: 'in' }), /in|closer/i);
  assert.match(describeResult(first(), 'adjust_camera_zoom', { ok: true }, { direction: 'out' }), /out|back/i);
});

test('the nearest aircraft is described with distance and altitude in plain units', () => {
  const said = describeResult(first(), 'select_nearest_aircraft', {
    ok: true,
    label: 'UAL123',
    aircraft: { distanceKm: 12.4, altitudeM: 10668 },
  });
  assert.match(said, /UAL123/);
  assert.match(said, /12 kilometers/);
  assert.match(said, /35,000 feet/);
});

test('analyst counts are spoken in words with their scope and nearest contact', () => {
  const said = describeResult(first(), 'analyst_query', {
    ok: true,
    count: 3,
    scopeLabel: 'in view',
    items: [{ callsign: 'DAL9', distanceKm: 4.6 }],
  });
  assert.match(said, /three in view/);
  assert.match(said, /DAL9/);
  assert.match(said, /5 kilometers/);
});

test('analyst zero and one are phrased as a person would', () => {
  assert.match(describeResult(first(), 'analyst_query', { ok: true, count: 0 }), /not seeing|Nothing|nothing/);
  assert.match(describeResult(first(), 'analyst_query', { ok: true, count: 1, items: [{ callsign: 'X1' }] }), /one.*X1/i);
});

test('a widened view is disclosed, never presented as an ordinary result', () => {
  const said = describeResult(first(), 'analyst_query', {
    ok: true,
    count: 2,
    zoomRetried: true,
    items: [],
  });
  assert.match(said, /widened|pulled the camera back/i);
});

test('a historical fallback is stated as last-known, not live', () => {
  const said = describeResult(first(), 'analyst_query', {
    ok: true,
    count: 1,
    usedHistoricalFallback: true,
    items: [{ callsign: 'SWA77', staleSecondsAgo: 180 }],
  });
  assert.match(said, /SWA77/);
  assert.match(said, /three minutes ago/);
  assert.match(said, /not live/i);
});

test('failures are plain and carry the real reason', () => {
  const said = describeResult(first(), 'set_layer_visibility', {
    ok: false,
    error: 'Unknown data layer: cheese',
  });
  assert.match(said, /unknown data layer: cheese/i);
  assert.doesNotMatch(said, /\.\./);
  assert.match(describeResult(first(), 'x', { ok: false }), /didn't|couldn't/i);
});

test('a track_entity miss names what was searched for', () => {
  const said = describeResult(
    first(),
    'track_entity',
    { ok: false, error: 'Nothing matched "N123"' },
    { query: 'N123' },
  );
  assert.match(said, /N123/);
});

test('a cancelled navigation is acknowledged, not reported as an error', () => {
  const said = describeResult(first(), 'fly_to_location', { ok: false, cancelled: true });
  assert.match(said, /stopped|cancelled/i);
});

test('overhead framing speaks the noun for the target', () => {
  assert.match(describeResult(first(), 'frame_overhead', { ok: true, count: 4 }, { target: 'vessels' }), /four ships/);
  assert.match(describeResult(first(), 'frame_overhead', { ok: true, count: 1 }, { target: 'vessels' }), /one ship/);
  assert.match(describeResult(first(), 'frame_overhead', { ok: true, count: 0 }, { target: 'flights' }), /flights/);
});

test('vehicle counts convert speed to kilometers per hour', () => {
  assert.match(
    describeResult(first(), 'nearby_vehicles', { ok: true, count: 5, averageSpeedMps: 10 }),
    /Five vehicles nearby averaging 36 kilometers per hour/,
  );
});

test('news reads the top headline and how many more', () => {
  const said = describeResult(first(), 'search_news', {
    ok: true,
    articles: [{ title: 'Storm nears coast' }, { title: 'b' }, { title: 'c' }],
  });
  assert.match(said, /Storm nears coast/);
  assert.match(said, /two more/);
});

test('an unmodeled tool still answers with something human', () => {
  assert.match(describeResult(first(), 'stop_tracking', { ok: true, released: [] }), /wasn't following/);
  assert.match(describeResult(first(), 'who_knows', { ok: true }), /Done|All set|Okay/);
});

test('every spoken result is a finished sentence', () => {
  const cases = [
    ['fly_to_location', { ok: true, label: 'Rome' }, {}],
    ['zoom_to_globe', { ok: true }, {}],
    ['set_context_mode', { ok: true }, { mode: 'space-missions' }],
    ['track_entity', { ok: true, label: 'N546PC' }, {}],
    ['move_camera', { ok: true }, { motion: 'orbit', direction: 'left' }],
    ['analyst_query', { ok: true, count: 12, scopeLabel: 'in view' }, {}],
  ];
  for (const [name, result, args] of cases) {
    const said = describeResult(createPhrasebook(), name, result, args);
    assert.match(said, /[.!?]$/, `${name}: "${said}"`);
    assert.doesNotMatch(said, /undefined|null|\[object/);
  }
});

test('clarifying questions ask for exactly the missing piece', () => {
  assert.match(clarifyingQuestion(first(), 'fly_to_location', ['place']), /where|which place/i);
  assert.match(clarifyingQuestion(first(), 'track_entity', ['query']), /follow/i);
  assert.match(clarifyingQuestion(first(), 'set_layer_visibility', ['enabled']), /on or off|turn it on/i);
  assert.match(
    clarifyingQuestion(first(), 'frame_overhead', ['radiusKm']),
    /radius km/,
    'unknown parameters fall back to a readable generic question',
  );
});

test('situation phrases exist for every kind the controller uses', () => {
  for (const kind of [
    'takeover',
    'no-recognition',
    'cancel',
    'thanks',
    'greeting',
    'help',
    'nothing-to-repeat',
    'unrecognized',
    'model-down',
    'error',
  ]) {
    assert.ok(situationPhrase(first(), kind).length > 0, kind);
  }
});

test('repeated misunderstandings escalate to a different, more helpful line', () => {
  const early = situationPhrase(first(), 'unrecognized', { streak: 1 });
  const late = situationPhrase(first(), 'unrecognized', { streak: 3 });
  assert.notEqual(early, late);
  assert.match(late, /still|different way|simpler/i);
});

test('joinSteps keeps each step a separate sentence and drops blanks', () => {
  assert.equal(joinSteps(['Heading to Paris.', '', ' Satellites are on. ']), 'Heading to Paris. Satellites are on.');
});

test('informational tools are exactly the ones whose answer is data', () => {
  assert.ok(INFORMATIONAL_TOOLS.has('analyst_query'));
  assert.ok(INFORMATIONAL_TOOLS.has('search_news'));
  assert.ok(!INFORMATIONAL_TOOLS.has('fly_to_location'));
  assert.ok(!INFORMATIONAL_TOOLS.has('adjust_camera_zoom'));
});
