// src/voice/localVoiceServer.test.mjs
// Server half of the local voice fallback: Piper speech prep + cache + handler,
// and the Ollama intent / reply endpoints' pure logic. No Piper binary, no
// Ollama, no network — synthesis and the model are injected or not reached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { prepareSpeechText } from '../../server/providers/piper/speechText.js';
import { createAudioCache } from '../../server/providers/piper/audioCache.js';
import {
  createSpeakHandler,
  prosodyArgsFromEnv,
} from '../../server/providers/piper/speak.js';
import {
  buildIntentMessages,
  parseIntentResponse,
  sanitizeHistory,
} from '../../server/providers/ollama/intent.js';
import {
  buildReplyMessages,
  compactResult,
  validateReply,
} from '../../server/providers/ollama/reply.js';

// ---- speech text ---------------------------------------------------------

test('speech prep expands units the way they are said aloud', () => {
  assert.equal(prepareSpeechText('12.5 km away'), '12.5 kilometers away.');
  assert.equal(prepareSpeechText('at 35,000 ft'), 'at 35,000 feet.');
  assert.equal(prepareSpeechText('1 ft'), '1 foot.');
  assert.equal(prepareSpeechText('420 kts'), '420 knots.');
  assert.equal(prepareSpeechText('80 mph'), '80 miles per hour.');
  assert.equal(prepareSpeechText('36 km/h'), '36 kilometers per hour.');
});

test('speech prep spells callsigns, registrations and flight levels', () => {
  assert.equal(prepareSpeechText('Following UAL123'), 'Following U A L 1 2 3.');
  assert.equal(prepareSpeechText('Selected N546PC'), 'Selected N 5 4 6 P C.');
  assert.equal(prepareSpeechText('climbing through FL350'), 'climbing through flight level 3 5 0.');
});

test('speech prep does not spell ordinary words or numbers', () => {
  assert.equal(prepareSpeechText('Heading to Tokyo'), 'Heading to Tokyo.');
  assert.equal(prepareSpeechText('I count 42 flights'), 'I count 42 flights.');
});

test('speech prep removes formatting a voice must never pronounce', () => {
  assert.equal(prepareSpeechText('**Done** — see https://example.com/x now'), 'Done, see now.');
  assert.equal(prepareSpeechText('`code` and [a link](http://x.y)'), 'code and a link.');
  assert.equal(prepareSpeechText('All set ✈️ 🚀'), 'All set.');
});

test('speech prep expands symbols', () => {
  assert.equal(prepareSpeechText('It is 21°C'), 'It is 21 degrees Celsius.');
  assert.equal(prepareSpeechText('90% cloud'), '90 percent cloud.');
  assert.equal(prepareSpeechText('ships & planes'), 'ships and planes.');
});

test('speech prep always ends with terminal punctuation and keeps existing', () => {
  assert.equal(prepareSpeechText('Okay'), 'Okay.');
  assert.equal(prepareSpeechText('Really?'), 'Really?');
  assert.equal(prepareSpeechText('Nice!'), 'Nice!');
});

test('speech prep returns nothing for text with nothing to say', () => {
  assert.equal(prepareSpeechText(''), '');
  assert.equal(prepareSpeechText(null), '');
  assert.equal(prepareSpeechText('*** ~~ ###'), '');
  assert.equal(prepareSpeechText('🚀'), '');
});

test('speech prep truncates at a sentence boundary, not mid-word', () => {
  const long = `${'First sentence is here. '.repeat(5)}Tail without end`;
  const out = prepareSpeechText(long, { maxLength: 60 });
  assert.ok(out.length <= 61, `too long: ${out.length}`);
  assert.match(out, /[.!?]$/);
  assert.doesNotMatch(out, /Tail/);
  assert.match(out, /First sentence is here\.$/);
});

// ---- audio cache ---------------------------------------------------------

test('audio cache evicts the least recently used entry past its size', () => {
  const cache = createAudioCache({ maxEntries: 2, maxBytes: 1e6 });
  cache.set('a', Buffer.from('1'));
  cache.set('b', Buffer.from('2'));
  cache.get('a'); // a is now most recent
  cache.set('c', Buffer.from('3'));
  assert.ok(cache.get('a'));
  assert.equal(cache.get('b'), null);
  assert.ok(cache.get('c'));
});

test('audio cache is bounded by total bytes too', () => {
  const cache = createAudioCache({ maxEntries: 100, maxBytes: 10 });
  cache.set('a', Buffer.alloc(6));
  cache.set('b', Buffer.alloc(6));
  assert.equal(cache.get('a'), null);
  assert.ok(cache.get('b'));
  assert.ok(cache.bytes <= 10);
});

test('audio cache refuses a single entry larger than its whole budget', () => {
  const cache = createAudioCache({ maxEntries: 5, maxBytes: 4 });
  cache.set('big', Buffer.alloc(9));
  assert.equal(cache.size, 0);
});

test('replacing a cached key does not double count its bytes', () => {
  const cache = createAudioCache({ maxEntries: 5, maxBytes: 100 });
  cache.set('a', Buffer.alloc(10));
  cache.set('a', Buffer.alloc(10));
  assert.equal(cache.bytes, 10);
  assert.equal(cache.size, 1);
});

// ---- prosody flags -------------------------------------------------------

test('prosody defaults to a slightly longer sentence pause and nothing else', () => {
  assert.deepEqual(prosodyArgsFromEnv({}), ['--sentence_silence', '0.35']);
});

test('prosody overrides are forwarded only when valid', () => {
  assert.deepEqual(
    prosodyArgsFromEnv({
      GEV_PIPER_SENTENCE_SILENCE: '0.5',
      GEV_PIPER_LENGTH_SCALE: '1.1',
      GEV_PIPER_NOISE_SCALE: 'loud',
      GEV_PIPER_NOISE_W: '0',
    }),
    ['--sentence_silence', '0.5', '--length_scale', '1.1'],
  );
});

// ---- speak handler -------------------------------------------------------

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(payload) {
      this.body = payload;
    },
  };
  return res;
}

function post(handler, payload) {
  // A real IncomingMessage emits Buffers, not strings.
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(payload))]), {
    method: 'POST',
  });
  const res = fakeRes();
  return handler(req, res).then(() => res);
}

test('the speak handler synthesizes speakable text once, then serves repeats from cache', async () => {
  const calls = [];
  const handler = createSpeakHandler({
    modelPath: '/voices/x.onnx',
    prosodyArgs: ['--sentence_silence', '0.35'],
    synthesize: async (text, options) => {
      calls.push({ text, options });
      return Buffer.from('RIFFwav');
    },
  });
  const first = await post(handler, { text: 'Following UAL123 at 35,000 ft' });
  const second = await post(handler, { text: 'Following UAL123 at 35,000 ft' });
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['Content-Type'], 'audio/wav');
  assert.equal(first.headers['X-GEV-Piper-Cache'], 'miss');
  assert.equal(second.headers['X-GEV-Piper-Cache'], 'hit');
  assert.equal(calls.length, 1, 'the model ran once');
  assert.equal(calls[0].text, 'Following U A L 1 2 3 at 35,000 feet.');
  assert.deepEqual(calls[0].options.prosodyArgs, ['--sentence_silence', '0.35']);
  assert.equal(String(second.body), 'RIFFwav');
});

test('different text is a different cache entry', async () => {
  let runs = 0;
  const handler = createSpeakHandler({
    modelPath: '/voices/x.onnx',
    synthesize: async () => Buffer.from(`w${++runs}`),
  });
  await post(handler, { text: 'One' });
  const two = await post(handler, { text: 'Two' });
  assert.equal(two.headers['X-GEV-Piper-Cache'], 'miss');
  assert.equal(runs, 2);
});

test('the speak handler degrades to a clear error when unconfigured', async () => {
  const handler = createSpeakHandler({ modelPath: '', synthesize: async () => assert.fail('no synth') });
  const res = await post(handler, { text: 'hi' });
  assert.equal(res.statusCode, 501);
  assert.match(JSON.parse(res.body).error, /GEV_PIPER_MODEL/);
});

test('the speak handler rejects text with nothing pronounceable', async () => {
  const handler = createSpeakHandler({
    modelPath: '/v.onnx',
    synthesize: async () => assert.fail('must not synthesize'),
  });
  const res = await post(handler, { text: '🚀 ***' });
  assert.equal(res.statusCode, 400);
});

test('the speak handler reports a synthesis failure as 502 without caching it', async () => {
  let fail = true;
  const handler = createSpeakHandler({
    modelPath: '/v.onnx',
    synthesize: async () => {
      if (fail) throw new Error('Piper binary not found: piper');
      return Buffer.from('ok');
    },
  });
  const bad = await post(handler, { text: 'Hello' });
  assert.equal(bad.statusCode, 502);
  fail = false;
  const good = await post(handler, { text: 'Hello' });
  assert.equal(good.statusCode, 200);
  assert.equal(good.headers['X-GEV-Piper-Cache'], 'miss');
});

// ---- intent parsing ------------------------------------------------------

const allowed = new Set(['fly_to_location', 'zoom_to_globe', 'set_layer_visibility']);

function completion(message) {
  return { choices: [{ message }] };
}

test('intent parsing keeps calls in spoken order with parsed arguments', () => {
  const { calls, reply } = parseIntentResponse(
    completion({
      tool_calls: [
        { function: { name: 'fly_to_location', arguments: '{"query":"Paris"}' } },
        {
          function: {
            name: 'set_layer_visibility',
            arguments: { layerId: 'satellites', enabled: true },
          },
        },
      ],
    }),
    allowed,
  );
  assert.deepEqual(calls, [
    { name: 'fly_to_location', arguments: { query: 'Paris' } },
    { name: 'set_layer_visibility', arguments: { layerId: 'satellites', enabled: true } },
  ]);
  assert.equal(reply, null);
});

test('intent parsing drops a tool the model invented', () => {
  const { calls } = parseIntentResponse(
    completion({ tool_calls: [{ function: { name: 'delete_everything', arguments: '{}' } }] }),
    allowed,
  );
  assert.deepEqual(calls, []);
});

test('intent parsing collapses duplicates and caps the number of steps', () => {
  const dupes = Array.from({ length: 6 }, (_v, i) => ({
    function: { name: 'fly_to_location', arguments: JSON.stringify({ query: `p${i % 5}` }) },
  }));
  dupes.push(dupes[0]);
  const { calls } = parseIntentResponse(completion({ tool_calls: dupes }), allowed);
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map((c) => c.arguments.query)).size, 3);
});

test('malformed tool arguments become an empty object, not an exception', () => {
  const { calls } = parseIntentResponse(
    completion({ tool_calls: [{ function: { name: 'zoom_to_globe', arguments: '{oops' } }] }),
    allowed,
  );
  assert.deepEqual(calls, [{ name: 'zoom_to_globe', arguments: {} }]);
});

test('with no tool call, a short conversational reply is passed through cleaned', () => {
  const { calls, reply } = parseIntentResponse(
    completion({ content: '**Sure!**   I can help with the map.\n' }),
    allowed,
  );
  assert.deepEqual(calls, []);
  assert.equal(reply, 'Sure! I can help with the map.');
});

test('a reply never accompanies a real tool call', () => {
  const both = parseIntentResponse(
    completion({
      content: 'Sure, doing it.',
      tool_calls: [{ function: { name: 'zoom_to_globe', arguments: '{}' } }],
    }),
    allowed,
  );
  assert.equal(both.reply, null);
  assert.equal(both.calls.length, 1);
});

test('a rambling or third-person reply is dropped, not truncated into speech', () => {
  const none = new Set(['zoom_to_globe']);
  const rambling = 'word '.repeat(200);
  const meta =
    'This request is not related to the map. It seems the operator is looking for a restaurant.';
  for (const content of [rambling, meta, 'The user wants a pizza.']) {
    assert.equal(parseIntentResponse(completion({ content }), none).reply, null, content);
  }
  assert.equal(
    parseIntentResponse(
      completion({ content: "I can't order food, but I can fly you anywhere on the map." }),
      none,
    ).reply,
    "I can't order food, but I can fly you anywhere on the map.",
  );
});

test('intent history is clamped and rendered for follow-up resolution', () => {
  const history = [
    { said: 'fly to Paris', did: 'fly_to_location({"query":"Paris"})', outcome: 'Paris' },
    ...Array.from({ length: 8 }, (_v, i) => ({ said: `turn ${i}`, did: 'x', outcome: 'ok' })),
    { said: '', did: 'ignored', outcome: '' },
    { said: 'x'.repeat(500), did: 'y', outcome: 'z' },
  ];
  const clean = sanitizeHistory(history);
  assert.equal(clean.length, 4);
  assert.ok(clean.every((turn) => turn.said.length <= 160));

  const [system, user] = buildIntentMessages('and the ships?', clean);
  assert.equal(system.role, 'system');
  assert.match(user.content, /RECENT CONVERSATION/);
  assert.match(user.content, /OPERATOR NOW SAYS: and the ships\?/);
  // No history: the utterance goes through untouched.
  assert.equal(buildIntentMessages('hi', [])[1].content, 'hi');
  assert.deepEqual(sanitizeHistory('not an array'), []);
});

test('the system prompt never varies with history, so the model can cache it', () => {
  const none = buildIntentMessages('zoom in', [])[0].content;
  const some = buildIntentMessages('zoom in', [
    { said: 'fly to Paris', did: 'fly_to_location', outcome: 'Paris' },
  ])[0].content;
  assert.equal(none, some);
});

test('a tool call written into the message text is recovered as a real call', () => {
  const names = new Set(['adjust_camera_zoom', 'nearby_vehicles', 'track_entity', 'get_entity_context']);
  const parse = (content) => parseIntentResponse(completion({ content }), names);
  assert.deepEqual(parse('adjust_camera_zoom {"direction": "out", "amount": "little"}').calls, [
    { name: 'adjust_camera_zoom', arguments: { direction: 'out', amount: 'little' } },
  ]);
  assert.deepEqual(parse('nearby_vehicles {}').calls, [{ name: 'nearby_vehicles', arguments: {} }]);
  assert.deepEqual(parse('get_entity_context').calls, [{ name: 'get_entity_context', arguments: {} }]);
  assert.deepEqual(
    parse('{"name":"track_entity","arguments":{"query":"DAL9"}}').calls,
    [{ name: 'track_entity', arguments: { query: 'DAL9' } }],
  );
  assert.deepEqual(parse('trackentity({"query":"DAL9"})').calls, [
    { name: 'track_entity', arguments: { query: 'DAL9' } },
  ]);
});

test('a mangled tool name is repaired only when it is unambiguous', () => {
  const { calls } = parseIntentResponse(
    completion({ tool_calls: [{ function: { name: 'TrackEntity', arguments: '{"query":"x"}' } }] }),
    new Set(['track_entity']),
  );
  assert.equal(calls[0].name, 'track_entity');
  const none = parseIntentResponse(
    completion({ tool_calls: [{ function: { name: 'trackentities', arguments: '{}' } }] }),
    new Set(['track_entity']),
  );
  assert.deepEqual(none.calls, []);
});

test('leaked code is never offered as a spoken reply', () => {
  for (const content of [
    'trackentity({"layerId": "flights"})',
    'I would call adjust_camera_zoom now',
    '{"unknown": true}',
    'function_call: something',
  ]) {
    const { calls, reply } = parseIntentResponse(completion({ content }), new Set(['zoom_to_globe']));
    assert.deepEqual(calls, [], content);
    assert.equal(reply, null, content);
  }
});

// ---- reply grounding -----------------------------------------------------

test('a reply built only from the data is accepted', () => {
  const source = 'how many flights {"count":12,"nearest":{"distanceKm":4.6}}';
  assert.equal(
    validateReply('I count 12 flights, the closest about 5 kilometers away.', source),
    'I count 12 flights, the closest about 5 kilometers away.',
  );
});

test('a reply with a number that is not in the data is rejected', () => {
  assert.equal(validateReply('There are 40 flights.', 'how many {"count":12}'), null);
});

test('a spelled-out number is checked against the data too', () => {
  assert.equal(validateReply('I see twelve flights.', '{"count":12}'), 'I see twelve flights.');
  assert.equal(validateReply('I see fifteen flights.', '{"count":12}'), null);
});

test('a reply that leaks implementation words or runs long is rejected', () => {
  assert.equal(validateReply('The JSON says 12.', '{"count":12}'), null);
  assert.equal(validateReply('The result field is null.', '{}'), null);
  assert.equal(validateReply('word '.repeat(80), '{}'), null);
  assert.equal(validateReply('   ', '{}'), null);
});

test('reply cleanup strips markdown and quotes', () => {
  assert.equal(validateReply('**Three** flights, "all" in view.', '{"count":3}'), 'Three flights, all in view.');
});

test('the result shown to the model is bounded', () => {
  const big = { ok: true, items: Array.from({ length: 400 }, (_v, i) => ({ id: `item-${i}`, note: 'x'.repeat(40) })) };
  const json = compactResult(big);
  assert.ok(json.length <= 2000);
  const [system, user] = buildReplyMessages('what is nearby', big);
  assert.equal(system.role, 'system');
  assert.match(user.content, /OPERATOR SAID: "what is nearby"/);
});
