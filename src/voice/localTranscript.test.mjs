// src/voice/localTranscript.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPhatic,
  cleanTranscript,
  normalizeCall,
} from './localTranscript.js';
import { curatedTools } from './localVoiceFallback.js';

const toolsByName = new Map(curatedTools().map((tool) => [tool.name, tool]));

test('cleanTranscript strips wake words, politeness and filler', () => {
  assert.equal(
    cleanTranscript("hey god's eye view, um, could you please fly to Tokyo"),
    'fly to Tokyo',
  );
  assert.equal(cleanTranscript('okay so uh zoom out please'), 'zoom out');
  assert.equal(cleanTranscript("let's go to Paris"), 'go to Paris');
  assert.equal(cleanTranscript('show me the ships right now'), 'show me the ships');
});

test('cleanTranscript keeps only the corrected clause of a self-correction', () => {
  assert.equal(
    cleanTranscript('fly to Paris, no wait, fly to Tokyo'),
    'fly to Tokyo',
  );
  assert.equal(
    cleanTranscript('zoom in. scratch that, zoom out a lot'),
    'zoom out a lot',
  );
});

test('cleanTranscript leaves a one-word correction whole for the model to resolve', () => {
  // "on" alone is meaningless; the full sentence carries the subject.
  assert.equal(
    cleanTranscript('turn the ships off, no wait, on'),
    'turn the ships off, no wait, on',
  );
});

test('cleanTranscript never returns empty for a non-empty utterance', () => {
  assert.equal(cleanTranscript('um'), 'um');
  assert.equal(cleanTranscript(''), '');
  assert.equal(cleanTranscript(null), '');
});

test('cleanTranscript does not eat meaningful words like "right" or "make it"', () => {
  assert.equal(cleanTranscript('rotate right'), 'rotate right');
  assert.equal(cleanTranscript('make it night mode'), 'make it night mode');
});

test('classifyPhatic answers thanks, greetings, cancels and repeats without a model', () => {
  assert.equal(classifyPhatic('thanks'), 'thanks');
  assert.equal(classifyPhatic('thank you so much'), 'thanks');
  assert.equal(classifyPhatic('hello there'), 'greeting');
  assert.equal(classifyPhatic('never mind'), 'cancel');
  assert.equal(classifyPhatic('say that again'), 'repeat');
  assert.equal(classifyPhatic('what can you do'), 'help');
  assert.equal(classifyPhatic('help'), 'help');
});

test('classifyPhatic does not swallow real commands that share a word', () => {
  assert.equal(classifyPhatic('thanks, now fly to Paris'), null);
  assert.equal(classifyPhatic('cancel the tracking of that plane'), null);
  assert.equal(classifyPhatic('stop tracking'), null);
  assert.equal(classifyPhatic('nothing but flights please'), null);
});

test('normalizeCall rejects a tool that is not in the curated set', () => {
  assert.deepEqual(normalizeCall({ name: 'launch_missiles' }, toolsByName), {
    ok: false,
    reason: 'unknown',
  });
});

test('normalizeCall drops arguments the schema does not define', () => {
  const result = normalizeCall(
    { name: 'zoom_to_globe', arguments: { speed: 'fast', extra: 1 } },
    toolsByName,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.call.arguments, {});
});

test('normalizeCall fixes enum casing and coerces types', () => {
  const result = normalizeCall(
    {
      name: 'set_layer_visibility',
      arguments: { layerId: 'Flights', enabled: 'on' },
    },
    toolsByName,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.call.arguments, { layerId: 'flights', enabled: true });

  const radius = normalizeCall(
    { name: 'nearby_vehicles', arguments: { radiusKm: '2.5' } },
    toolsByName,
  );
  assert.deepEqual(radius.call.arguments, { radiusKm: 2.5 });
});

test('a layer name the runner can alias is passed through, not discarded', () => {
  // The action runner resolves "fires" → local-firms and "ships" →
  // ais-live-vessels itself; refusing them here would reject valid commands.
  const result = normalizeCall(
    { name: 'set_layer_visibility', arguments: { layerId: 'fires', enabled: false } },
    toolsByName,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.call.arguments, { layerId: 'fires', enabled: false });
});

test('normalizeCall discards an enum value the schema does not allow', () => {
  const result = normalizeCall(
    { name: 'adjust_camera_zoom', arguments: { direction: 'sideways' } },
    toolsByName,
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing');
  assert.deepEqual(result.missing, ['direction']);
});

test('normalizeCall fills what a person leaves implied instead of asking', () => {
  const zoom = normalizeCall(
    { name: 'adjust_camera_zoom', arguments: { direction: 'in' } },
    toolsByName,
  );
  assert.deepEqual(zoom.call.arguments, { direction: 'in', amount: 'medium' });

  const nearest = normalizeCall(
    { name: 'select_nearest_aircraft', arguments: {} },
    toolsByName,
  );
  assert.deepEqual(nearest.call.arguments, { layerId: 'flights' });
});

test('normalizeCall reports a missing required value so we can ask', () => {
  const result = normalizeCall(
    { name: 'track_entity', arguments: {} },
    toolsByName,
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['query']);
});

test('normalizeCall treats fly_to_location with no destination as missing a place', () => {
  const none = normalizeCall({ name: 'fly_to_location', arguments: {} }, toolsByName);
  assert.equal(none.ok, false);
  assert.deepEqual(none.missing, ['place']);
  for (const arguments_ of [
    { query: 'Reykjavik' },
    { locationId: 'tokyo' },
    { latitude: 10, longitude: 20 },
  ]) {
    assert.equal(
      normalizeCall({ name: 'fly_to_location', arguments: arguments_ }, toolsByName).ok,
      true,
    );
  }
});
