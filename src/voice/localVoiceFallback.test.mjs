// src/voice/localVoiceFallback.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LocalVoiceFallback,
  boundForReply,
  curatedTools,
} from './localVoiceFallback.js';
import { createPhrasebook } from './localVoicePhrases.js';

test('curatedTools pulls real parameter schemas for every curated name', () => {
  const tools = curatedTools();
  assert.ok(tools.length >= 5);
  for (const tool of tools) {
    assert.equal(typeof tool.name, 'string');
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 0);
    assert.equal(tool.parameters?.type, 'object');
  }
  assert.ok(tools.some((t) => t.name === 'fly_to_location'));
  assert.ok(tools.some((t) => t.name === 'analyst_query'));
});

test('boundForReply keeps the facts and drops the bulk', () => {
  const bounded = boundForReply({
    ok: true,
    count: 400,
    skipped: null,
    items: Array.from({ length: 50 }, (_v, i) => ({ id: i, note: 'n'.repeat(500) })),
    deep: { a: { b: { c: { d: 1 } } } },
  });
  assert.equal(bounded.count, 400);
  assert.equal('skipped' in bounded, false);
  assert.equal(bounded.items.length, 5);
  assert.equal(bounded.items[0].note.length, 160);
  assert.deepEqual(bounded.deep.a.b, {});
});

/**
 * Build a fallback wired to a scripted server. `routes` maps an endpoint to a
 * function returning `{status?, body}`; Piper answers "not configured" so speech
 * degrades to a status line without touching browser-only Audio APIs.
 */
function harness({ routes = {}, runner = async () => ({ ok: true }), replyTimeoutMs } = {}) {
  const requests = [];
  const statuses = [];
  const fallback = new LocalVoiceFallback({
    runner,
    replyTimeoutMs,
    phrasebook: createPhrasebook({ random: () => 0 }),
    fetchImpl: async (url, init) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      requests.push({ url, body });
      const route = routes[url];
      if (!route) return { ok: false, json: async () => ({ ok: false }) };
      const response = await route(body);
      return {
        ok: (response.status ?? 200) < 400,
        json: async () => response.body,
      };
    },
  });
  fallback.active = true; // bypass activate()'s speech-recognition gate
  let listens = 0;
  fallback._listenOnce = () => {
    listens += 1;
  };
  fallback.onStatus = (state, detail) => statuses.push({ state, detail });
  return {
    fallback,
    requests,
    statuses,
    get listens() {
      return listens;
    },
    spoken: () => statuses.filter((s) => s.state === 'speaking').map((s) => s.detail),
  };
}

const intent = (body) => () => ({ body: { ok: true, ...body } });

test('_interpret posts the cleaned transcript, tools and history and reads a call list', async () => {
  const h = harness({
    routes: {
      '/api/ollama/intent': intent({
        calls: [{ name: 'fly_to_location', arguments: { query: 'Tokyo' } }],
        reply: null,
      }),
    },
  });
  const understood = await h.fallback._interpret('fly to Tokyo');
  const sent = h.requests[0];
  assert.equal(sent.url, '/api/ollama/intent');
  assert.equal(sent.body.text, 'fly to Tokyo');
  assert.ok(sent.body.tools.length > 0);
  assert.deepEqual(sent.body.history, []);
  assert.deepEqual(understood.calls, [{ name: 'fly_to_location', arguments: { query: 'Tokyo' } }]);
});

test('_interpret still understands an older single name/arguments response', async () => {
  const h = harness({
    routes: { '/api/ollama/intent': intent({ name: 'zoom_to_globe', arguments: {} }) },
  });
  assert.deepEqual((await h.fallback._interpret('globe')).calls, [
    { name: 'zoom_to_globe', arguments: {} },
  ]);
});

test('_interpret reports the model as unavailable instead of pretending nothing matched', async () => {
  const h = harness({
    routes: { '/api/ollama/intent': () => ({ status: 502, body: { ok: false } }) },
  });
  assert.equal((await h.fallback._interpret('anything')).unavailable, true);
});

test('a command runs through the runner and is answered in words, then the mic reopens', async () => {
  const runs = [];
  const h = harness({
    runner: async (name, args) => {
      runs.push({ name, args });
      return { ok: true, label: 'Tokyo' };
    },
    routes: {
      '/api/ollama/intent': intent({
        calls: [{ name: 'fly_to_location', arguments: { query: 'Tokyo' } }],
      }),
    },
  });
  await h.fallback._handleTranscript("um, hey god's eye view, could you please fly to Tokyo");
  assert.deepEqual(runs, [{ name: 'fly_to_location', args: { query: 'Tokyo' } }]);
  assert.equal(h.requests[0].body.text, 'fly to Tokyo', 'filler and wake word were stripped');
  assert.deepEqual(h.spoken(), ['Heading to Tokyo.']);
  assert.equal(h.fallback.busy, false);
  assert.equal(h.listens, 1, 'listening resumes exactly once, after the reply');
});

test('the microphone stays closed while the turn is in flight', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness({
    routes: {
      '/api/ollama/intent': async () => {
        await gate;
        return { body: { ok: true, calls: [{ name: 'zoom_to_globe', arguments: {} }] } };
      },
    },
  });
  // Exercise the REAL guard. With no SpeechRecognition in Node, an ungated
  // _listenOnce reports an 'error' status, so that status is the tell.
  delete h.fallback._listenOnce;
  const turn = h.fallback._handleTranscript('show me the globe');
  assert.equal(h.fallback.busy, true);
  // What recognition.onend does the instant a result arrives:
  h.fallback._listenOnce();
  assert.equal(
    h.statuses.some((s) => s.state === 'error'),
    false,
    'the mic must not reopen mid-turn',
  );
  release();
  await turn;
  assert.equal(
    h.statuses.some((s) => s.state === 'error'),
    true,
    'listening is retried once the reply has finished',
  );
});

test('thanks, hello and never-mind are answered instantly without asking the model', async () => {
  const h = harness();
  await h.fallback._handleTranscript('thanks');
  await h.fallback._handleTranscript('never mind');
  assert.equal(h.requests.filter((r) => r.url === '/api/ollama/intent').length, 0);
  assert.equal(h.spoken().length, 2);
  assert.match(h.spoken()[0], /Anytime|You got it|Happy to help|No problem/);
});

test('"say that again" repeats the last thing that was said', async () => {
  const h = harness({
    routes: {
      '/api/ollama/intent': intent({ calls: [{ name: 'zoom_to_globe', arguments: {} }] }),
    },
  });
  await h.fallback._handleTranscript('show the globe');
  const said = h.spoken()[0];
  await h.fallback._handleTranscript('say that again');
  assert.equal(h.spoken()[1], said);
});

test('a missing required value is asked for, and nothing is run', async () => {
  const runs = [];
  const h = harness({
    runner: async (...args) => {
      runs.push(args);
      return { ok: true };
    },
    routes: {
      '/api/ollama/intent': intent({ calls: [{ name: 'track_entity', arguments: {} }] }),
    },
  });
  await h.fallback._handleTranscript('follow that plane');
  assert.equal(runs.length, 0);
  assert.match(h.spoken()[0], /follow/i);
  assert.match(h.spoken()[0], /\?$/);
});

test('several commands in one breath run in order and are answered together', async () => {
  const order = [];
  const h = harness({
    runner: async (name) => {
      order.push(name);
      return name === 'fly_to_location'
        ? { ok: true, label: 'Paris' }
        : { ok: true, label: 'Satellites' };
    },
    routes: {
      '/api/ollama/intent': intent({
        calls: [
          { name: 'fly_to_location', arguments: { query: 'Paris' } },
          { name: 'set_layer_visibility', arguments: { layerId: 'satellites', enabled: true } },
        ],
      }),
    },
  });
  await h.fallback._handleTranscript('fly to Paris and turn on satellites');
  assert.deepEqual(order, ['fly_to_location', 'set_layer_visibility']);
  const said = h.spoken()[0];
  assert.match(said, /Paris/);
  assert.match(said, /Satellites/);
});

test('a failing step stops the remaining steps and says why', async () => {
  const order = [];
  const h = harness({
    runner: async (name) => {
      order.push(name);
      return name === 'fly_to_location'
        ? { ok: false, error: 'Nothing matched "Atlantis"' }
        : { ok: true };
    },
    routes: {
      '/api/ollama/intent': intent({
        calls: [
          { name: 'fly_to_location', arguments: { query: 'Atlantis' } },
          { name: 'zoom_to_globe', arguments: {} },
        ],
      }),
    },
  });
  await h.fallback._handleTranscript('fly to Atlantis then zoom out');
  assert.deepEqual(order, ['fly_to_location']);
});

test('a hallucinated tool is never dispatched', async () => {
  const runs = [];
  const h = harness({
    runner: async (...args) => {
      runs.push(args);
      return { ok: true };
    },
    routes: {
      '/api/ollama/intent': intent({ calls: [{ name: 'format_disk', arguments: {} }] }),
    },
  });
  await h.fallback._handleTranscript('do something odd');
  assert.equal(runs.length, 0);
  assert.match(h.spoken()[0], /didn't|not sure|say it another way/i);
});

test('arguments are repaired against the schema before the runner sees them', async () => {
  const runs = [];
  const h = harness({
    runner: async (name, args) => {
      runs.push({ name, args });
      return { ok: true, label: 'Ships' };
    },
    routes: {
      '/api/ollama/intent': intent({
        calls: [
          {
            name: 'set_layer_visibility',
            arguments: { layerId: 'Ships', enabled: 'off', junk: 1 },
          },
        ],
      }),
    },
  });
  await h.fallback._handleTranscript('hide the ships');
  // "Ships" is an alias the runner resolves; the string "off" becomes a
  // boolean; the argument the schema does not define is dropped.
  assert.deepEqual(runs, [
    { name: 'set_layer_visibility', args: { layerId: 'Ships', enabled: false } },
  ]);
});

test('an invalid closed-enum value is asked about instead of being run', async () => {
  const runs = [];
  const h = harness({
    runner: async (...args) => {
      runs.push(args);
      return { ok: true };
    },
    routes: {
      '/api/ollama/intent': intent({
        calls: [{ name: 'adjust_camera_zoom', arguments: { direction: 'sideways' } }],
      }),
    },
  });
  await h.fallback._handleTranscript('zoom sideways');
  assert.equal(runs.length, 0);
  assert.match(h.spoken()[0], /in or out|zoom in/i);
});

test('"what can you do" is answered instantly with examples, without the model', async () => {
  const h = harness();
  await h.fallback._handleTranscript('what can you do');
  assert.equal(h.requests.filter((r) => r.url === '/api/ollama/intent').length, 0);
  assert.match(h.spoken()[0], /fly|zoom|layers/i);
});

test('small talk gets the model\'s own short reply', async () => {
  const h = harness({
    routes: {
      '/api/ollama/intent': intent({ calls: [], reply: 'I can help you explore the map.' }),
    },
  });
  await h.fallback._handleTranscript('what do you think of pineapple on pizza');
  assert.deepEqual(h.spoken(), ['I can help you explore the map.']);
});

test('repeated misses escalate, and a success resets the streak', async () => {
  let respond = { calls: [], reply: null };
  const h = harness({ routes: { '/api/ollama/intent': () => ({ body: { ok: true, ...respond } }) } });
  await h.fallback._handleTranscript('blah');
  await h.fallback._handleTranscript('blah blah');
  await h.fallback._handleTranscript('blah blah blah');
  const [one, , three] = h.spoken();
  assert.notEqual(one, three);
  assert.match(three, /still|different way|simpler/i);
  respond = { calls: [{ name: 'zoom_to_globe', arguments: {} }], reply: null };
  await h.fallback._handleTranscript('globe');
  assert.equal(h.fallback.unrecognizedStreak, 0);
});

test('an unreachable local model is reported honestly', async () => {
  const h = harness({
    routes: { '/api/ollama/intent': () => ({ status: 502, body: { ok: false } }) },
  });
  await h.fallback._handleTranscript('show me flights');
  assert.match(h.spoken()[0], /Ollama|language model/i);
});

test('a runner that throws becomes a spoken reason, not a generic crash line', async () => {
  const h = harness({
    runner: async () => {
      throw new Error('Unknown data layer: cheese');
    },
    routes: {
      '/api/ollama/intent': intent({ calls: [{ name: 'zoom_to_globe', arguments: {} }] }),
    },
  });
  await h.fallback._handleTranscript('zoom to the globe');
  assert.match(h.spoken()[0], /unknown data layer: cheese/i);
});

test('history from earlier turns is sent so follow-ups can be resolved', async () => {
  const h = harness({
    runner: async () => ({ ok: true, label: 'Paris' }),
    routes: {
      '/api/ollama/intent': intent({
        calls: [{ name: 'fly_to_location', arguments: { query: 'Paris' } }],
      }),
    },
  });
  await h.fallback._handleTranscript('fly to Paris');
  await h.fallback._handleTranscript('and now the ships');
  const second = h.requests.filter((r) => r.url === '/api/ollama/intent')[1];
  assert.equal(second.body.history.length, 1);
  assert.equal(second.body.history[0].said, 'fly to Paris');
  assert.match(second.body.history[0].did, /fly_to_location/);
});

test('history is capped so the prompt cannot grow without bound', async () => {
  const h = harness({
    routes: { '/api/ollama/intent': intent({ calls: [{ name: 'zoom_to_globe', arguments: {} }] }) },
  });
  for (let i = 0; i < 9; i += 1) await h.fallback._handleTranscript(`globe ${i}`);
  assert.equal(h.fallback.history.length, 4);
});

test('an informational answer is phrased by the model from the real data', async () => {
  const h = harness({
    runner: async () => ({ ok: true, count: 12, scopeLabel: 'in view', items: [] }),
    routes: {
      '/api/ollama/intent': intent({ calls: [{ name: 'analyst_query', arguments: {} }] }),
      '/api/ollama/reply': (body) => {
        assert.equal(body.result.count, 12);
        return { body: { ok: true, reply: 'There are 12 flights in view.' } };
      },
    },
  });
  await h.fallback._handleTranscript('how many flights are there');
  assert.deepEqual(h.spoken(), ['There are 12 flights in view.']);
});

test('if the model reply is rejected or unavailable the template answer is used', async () => {
  for (const reply of [
    () => ({ body: { ok: true, reply: null } }),
    () => ({ status: 502, body: { ok: false } }),
    () => {
      throw new Error('network down');
    },
  ]) {
    const h = harness({
      runner: async () => ({ ok: true, count: 3, scopeLabel: 'in view', items: [] }),
      routes: {
        '/api/ollama/intent': intent({ calls: [{ name: 'analyst_query', arguments: {} }] }),
        '/api/ollama/reply': reply,
      },
    });
    await h.fallback._handleTranscript('how many flights');
    assert.match(h.spoken()[0], /three in view/);
  }
});

test('action tools never wait on the model for their reply', async () => {
  const h = harness({
    runner: async () => ({ ok: true }),
    routes: {
      '/api/ollama/intent': intent({ calls: [{ name: 'zoom_to_globe', arguments: {} }] }),
    },
  });
  await h.fallback._handleTranscript('globe');
  assert.equal(h.requests.some((r) => r.url === '/api/ollama/reply'), false);
});

test('answers carrying a widened-view or last-known caveat keep their own honest wording', async () => {
  for (const flag of ['zoomRetried', 'usedHistoricalFallback']) {
    const h = harness({
      runner: async () => ({
        ok: true,
        count: 1,
        [flag]: true,
        items: [{ callsign: 'SWA77', staleSecondsAgo: 120 }],
      }),
      routes: {
        '/api/ollama/intent': intent({ calls: [{ name: 'analyst_query', arguments: {} }] }),
        '/api/ollama/reply': () => ({ body: { ok: true, reply: 'Just one plane, all good.' } }),
      },
    });
    await h.fallback._handleTranscript('nearest flight from Austin');
    assert.equal(h.requests.some((r) => r.url === '/api/ollama/reply'), false, flag);
    assert.match(h.spoken()[0], /widened|pulled the camera back|not live/i, flag);
  }
});

test('deactivate stops the loop and reopens nothing', async () => {
  const h = harness({
    routes: { '/api/ollama/intent': intent({ calls: [{ name: 'zoom_to_globe', arguments: {} }] }) },
  });
  h.fallback.deactivate();
  await h.fallback._handleTranscript('globe');
  assert.equal(h.requests.length, 0, 'an inactive fallback ignores late transcripts');
  assert.equal(h.fallback.busy, false);
  assert.equal(h.listens, 0);
});

test('activate without speech recognition says so and stays inactive', async () => {
  const h = harness();
  h.fallback.active = false;
  await h.fallback.activate();
  assert.equal(h.fallback.active, false);
  assert.ok(h.statuses.some((s) => s.state === 'error'));
  assert.match(h.spoken()[0], /speech recognition|hear you/i);
});
