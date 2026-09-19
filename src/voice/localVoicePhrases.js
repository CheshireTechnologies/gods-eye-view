/**
 * What the local assistant SAYS. Pure text generation, no I/O, so the wording
 * is unit-testable and the fallback class stays about control flow.
 *
 * Three ideas make it sound like a person rather than a status line:
 *  1. Variety — every situation has several phrasings, and the same one is never
 *     picked twice in a row (a voice that repeats itself verbatim sounds broken).
 *  2. Substance — replies carry the specifics that matter (the place, the
 *     contact, how far, how many) in the words a person would use ("just one",
 *     "a few"), instead of "3 results in view."
 *  3. Honesty — failures are stated plainly, and a stale or widened answer says
 *     so, matching the rule the cloud assistant is given for analyst_query.
 * @module voice/localVoicePhrases
 */

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
];

/** 0–10 as words ("three flights"), larger as digits ("42 flights"). */
export function spokenNumber(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return '';
  return number >= 0 && number <= 10
    ? NUMBER_WORDS[number]
    : number.toLocaleString('en-US');
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

function upperFirst(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function lowerFirst(text) {
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}

/** Trim a technical error to something worth saying aloud. */
function speakableError(error) {
  const text = String(error ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[.!\s]+$/, '')
    .trim();
  return text.length > 110 ? text.slice(0, 110).replace(/\s+\S*$/, '') : text;
}

/**
 * A phrase picker that avoids repeating itself.
 * @param {{random?: () => number}} [options]
 */
export function createPhrasebook({ random = Math.random } = {}) {
  const last = new Map();
  return {
    /**
     * @param {string} key - Situation id; repeats are tracked per key.
     * @param {string[]} variants
     */
    pick(key, variants) {
      if (variants.length === 1) return variants[0];
      const previous = last.get(key);
      const pool = variants.filter((_v, index) => index !== previous);
      const choice = Math.min(
        pool.length - 1,
        Math.floor(random() * pool.length),
      );
      const picked = pool[choice];
      last.set(key, variants.indexOf(picked));
      return picked;
    },
  };
}

const TARGET_NOUNS = {
  flights: ['flight', 'flights'],
  military: ['military aircraft', 'military aircraft'],
  satellites: ['satellite', 'satellites'],
  vessels: ['ship', 'ships'],
};

function feetFromMeters(meters) {
  return Math.round((meters * 3.28084) / 100) * 100;
}

function describeItem(item) {
  if (!item) return '';
  const name = item.callsign || item.label || item.name || item.registration;
  if (!name) return '';
  const distance = Number.isFinite(item.distanceKm)
    ? `about ${Math.round(item.distanceKm)} kilometers away`
    : '';
  return [String(name), distance].filter(Boolean).join(', ');
}

function describeFailure(pb, name, result, args) {
  if (result?.cancelled) {
    return pb.pick('cancelled', [
      'Okay, I stopped that.',
      'Alright, cancelled.',
    ]);
  }
  const error = speakableError(result?.error);
  if (/nothing matched/i.test(error) && args?.query) {
    return pb.pick('nomatch', [
      `I couldn't find anything matching ${args.query}.`,
      `Sorry, nothing came up for ${args.query}.`,
      `I looked, but there's nothing matching ${args.query} right now.`,
    ]);
  }
  if (!error) {
    return pb.pick('fail-generic', [
      "Sorry, that didn't work.",
      "I couldn't get that to work.",
      "Hmm, that didn't go through.",
    ]);
  }
  return pb.pick('fail', [
    `Sorry, ${lowerFirst(error)}.`,
    `I couldn't do that — ${lowerFirst(error)}.`,
    `That didn't work. ${upperFirst(error)}.`,
  ]);
}

function describeAnalyst(pb, result) {
  const count = Number.isFinite(result.count) ? result.count : 0;
  const first = result.items?.[0];
  const lead = result.zoomRetried
    ? `${pb.pick('widened', ['I widened the view.', 'I pulled the camera back a bit.'])} `
    : '';
  if (result.usedHistoricalFallback && first) {
    const ago = Number.isFinite(first.staleSecondsAgo)
      ? `about ${spokenNumber(Math.max(1, Math.round(first.staleSecondsAgo / 60)))} ${plural(Math.max(1, Math.round(first.staleSecondsAgo / 60)), 'minute')} ago`
      : 'a little while ago';
    const who = describeItem(first) || 'one';
    return `${lead}I can't see one live, but the last one I saw was ${who}, ${ago}. That's a last known position, not live.`;
  }
  if (count === 0) {
    return `${lead}${pb.pick('analyst-none', [
      "I'm not seeing any right now.",
      'Nothing matching that at the moment.',
      "There's nothing there right now.",
    ])}`;
  }
  const detail = describeItem(first);
  if (count === 1) {
    return `${lead}${pb.pick('analyst-one', [
      `Just one${detail ? ` — ${detail}` : ''}.`,
      `Only one${detail ? `: ${detail}` : ''}.`,
    ])}`;
  }
  const number = spokenNumber(count);
  // The engine names its scope in words ("in view", "within 50 km of Austin");
  // a bare number is what made two honest answers sound contradictory.
  const scope = result.scopeLabel ? ` ${result.scopeLabel}` : '';
  const nearest = detail ? ` The closest is ${detail}.` : '';
  return `${lead}${pb.pick('analyst-many', [
    `I count ${number}${scope}.${nearest}`,
    `There are ${number}${scope}.${nearest}`,
    `Looks like ${number}${scope}.${nearest}`,
  ])}`;
}

/**
 * Words for the outcome of one tool call.
 * @param {ReturnType<typeof createPhrasebook>} pb
 * @param {string} name - Tool name.
 * @param {object} result - What the action runner returned.
 * @param {object} [args] - The arguments the tool was run with.
 * @returns {string}
 */
export function describeResult(pb, name, result, args = {}) {
  if (!result || result.ok === false) {
    return describeFailure(pb, name, result, args);
  }
  switch (name) {
    case 'fly_to_location': {
      const where = result.label;
      if (result.arrived && where) return `We're over ${where} now.`;
      return where
        ? pb.pick('fly', [
            `Heading to ${where}.`,
            `On our way to ${where}.`,
            `Flying to ${where} now.`,
            `Off to ${where}.`,
          ])
        : pb.pick('fly-bare', ['On our way.', 'Heading there now.']);
    }
    case 'set_layer_visibility': {
      const label = result.label || args.layerId || 'that layer';
      return args.enabled === false
        ? pb.pick('layer-off', [
            `Turning off ${label}.`,
            `${upperFirst(label)} are off.`,
            `Okay, hiding ${label}.`,
          ])
        : pb.pick('layer-on', [
            `Turning on ${label}.`,
            `${upperFirst(label)} coming up.`,
            `Okay, ${label} are on.`,
          ]);
    }
    case 'adjust_camera_zoom':
      return args.direction === 'out'
        ? pb.pick('zoom-out', [
            'Zooming out.',
            'Pulling back.',
            'Backing out a bit.',
          ])
        : pb.pick('zoom-in', [
            'Zooming in.',
            'Coming in closer.',
            'Getting closer.',
          ]);
    case 'zoom_to_globe':
      return pb.pick('globe', [
        "Here's the whole planet.",
        'Pulling all the way out.',
        'Full Earth view.',
      ]);
    case 'set_context_mode': {
      const mode = String(args.mode || result.mode || '').replace(/-/g, ' ');
      if (!mode || mode === 'off') {
        return pb.pick('context-off', [
          'Context panel closed.',
          'Okay, closing that panel.',
        ]);
      }
      return pb.pick('context', [
        `Switching to ${mode}.`,
        `Okay, ${mode} view.`,
        `Bringing up ${mode}.`,
      ]);
    }
    case 'select_nearest_aircraft': {
      const who = result.label || result.aircraft?.callsign;
      if (!who) return 'I have the nearest one selected.';
      const distance = Number.isFinite(result.aircraft?.distanceKm)
        ? `, about ${Math.round(result.aircraft.distanceKm)} kilometers out`
        : '';
      const altitude = Number.isFinite(result.aircraft?.altitudeM)
        ? `, at ${feetFromMeters(result.aircraft.altitudeM).toLocaleString('en-US')} feet`
        : '';
      return pb.pick('nearest', [
        `The closest is ${who}${distance}${altitude}.`,
        `That's ${who}${distance}${altitude}.`,
        `Got it — ${who}${distance}${altitude}.`,
      ]);
    }
    case 'track_entity':
      return result.label
        ? pb.pick('track', [
            `Following ${result.label}.`,
            `Locked on to ${result.label}.`,
            `I've got ${result.label}. Following it now.`,
          ])
        : 'Tracking started.';
    case 'stop_tracking':
      return Array.isArray(result.released) && result.released.length === 0
        ? "I wasn't following anything."
        : pb.pick('untrack', [
            "Okay, I've stopped following.",
            'Letting go of that one.',
            'Tracking stopped.',
          ]);
    case 'frame_overhead': {
      const count = Number.isFinite(result.count) ? result.count : 0;
      const [one, many] = TARGET_NOUNS[args.target] || ['one', 'of them'];
      if (count === 0) {
        return pb.pick('overhead-none', [
          `I don't see any ${many} nearby.`,
          `No ${many} around right now.`,
        ]);
      }
      return count === 1
        ? pb.pick('overhead-one', [
            `Looking down at just one ${one}.`,
            `Framing the one ${one} nearby.`,
          ])
        : pb.pick('overhead-many', [
            `Looking down at ${spokenNumber(count)} ${many}.`,
            `Framing ${spokenNumber(count)} ${many} nearby.`,
          ]);
    }
    case 'nearby_vehicles': {
      const count = Number.isFinite(result.count) ? result.count : 0;
      if (count === 0) return 'No vehicles around right now.';
      const speed = Number.isFinite(result.averageSpeedMps)
        ? ` averaging ${Math.round(result.averageSpeedMps * 3.6)} kilometers per hour`
        : '';
      return `${upperFirst(spokenNumber(count))} ${plural(count, 'vehicle')} nearby${speed}.`;
    }
    case 'move_camera': {
      if (args.motion === 'stop') return 'Stopped.';
      const verb =
        {
          orbit: 'Orbiting',
          pan: 'Panning',
          tilt: 'Tilting',
          rotate: 'Rotating',
        }[args.motion] || 'Moving';
      return `${verb}${args.direction ? ` ${args.direction}` : ''}.`;
    }
    case 'analyst_query':
      return describeAnalyst(pb, result);
    case 'search_news': {
      const articles = Array.isArray(result.articles) ? result.articles : [];
      if (!articles.length) {
        return pb.pick('news-none', [
          "I didn't find any recent news on that.",
          'Nothing recent came up.',
        ]);
      }
      const headline = articles[0]?.title;
      const more =
        articles.length > 1
          ? ` and ${spokenNumber(articles.length - 1)} more`
          : '';
      return headline
        ? `Top story: ${headline}${more ? `,${more}` : ''}.`
        : `I found ${spokenNumber(articles.length)} ${plural(articles.length, 'article')}.`;
    }
    case 'get_entity_context':
      return Number.isFinite(result.count)
        ? `I see ${spokenNumber(result.count)} nearby.`
        : 'Here are the details.';
    case 'get_current_view_state':
      return "Here's where we are.";
    default:
      return pb.pick('done', ['Done.', 'All set.', 'Okay.']);
  }
}

/** Tools whose answer is DATA — worth composing into a sentence, not a template. */
export const INFORMATIONAL_TOOLS = new Set([
  'analyst_query',
  'get_entity_context',
  'get_current_view_state',
  'search_news',
  'nearby_vehicles',
]);

const CLARIFY = {
  'fly_to_location:place': [
    'Where would you like to go?',
    'Sure — where to?',
    'Which place?',
  ],
  'track_entity:query': [
    'Which aircraft, ship, or satellite should I follow?',
    'What should I follow? A callsign or a name works.',
  ],
  'set_layer_visibility:layerId': [
    'Which layer do you mean?',
    'Which layer should I change?',
  ],
  'set_layer_visibility:enabled': ['Should I turn it on or off?', 'On or off?'],
  'set_context_mode:mode': [
    'Which mode — contacts, flights, or space missions?',
  ],
  'frame_overhead:target': [
    'What should I look at — flights, military, satellites, or ships?',
  ],
  'move_camera:motion': [
    'How should I move the camera — orbit, pan, tilt, or rotate?',
  ],
  'adjust_camera_zoom:direction': ['In or out?', 'Zoom in, or zoom out?'],
  'search_news:query': [
    'What topic should I look up?',
    'What should I search the news for?',
  ],
};

/** Ask for the one thing that is missing instead of guessing or failing. */
export function clarifyingQuestion(pb, toolName, missing) {
  const param = missing?.[0];
  const variants = CLARIFY[`${toolName}:${param}`];
  if (variants) return pb.pick(`clarify:${toolName}:${param}`, variants);
  return `I need a bit more — what should I use for ${String(param || 'that')
    .replace(/([A-Z])/g, ' $1')
    .toLowerCase()}?`;
}

/** Fixed situations: greeting on takeover, small talk, and dead ends. */
export function situationPhrase(pb, kind, { streak = 0 } = {}) {
  switch (kind) {
    case 'takeover':
      return pb.pick('takeover', [
        "Cloud voice dropped out, so I'm running locally now. What can I do for you?",
        "The cloud connection isn't available, but I'm still here — I'm on local mode. What do you need?",
        "I've switched to local voice. It's a bit more limited, but I'm listening.",
      ]);
    case 'no-recognition':
      return "Cloud voice is unavailable, and this browser doesn't support local speech recognition, so I can't hear you.";
    case 'cancel':
      return pb.pick('cancel', ['No problem.', 'Okay, forget it.', 'Sure.']);
    case 'thanks':
      return pb.pick('thanks', [
        'Anytime.',
        'You got it.',
        'Happy to help.',
        'No problem.',
      ]);
    case 'greeting':
      return pb.pick('greeting', [
        'Hey. What can I do for you?',
        'Hi there — what do you need?',
        "Hello. I'm listening.",
      ]);
    case 'help':
      return pb.pick('help', [
        'I can fly you to places, zoom and move the camera, turn layers on and off, count flights and ships, follow one, and look up the news. Try fly to Tokyo, or how many flights are in view.',
        'Ask me to fly somewhere, zoom in or out, switch layers on or off, find the nearest plane, follow a flight, or check the news. For example, show me the ships.',
      ]);
    case 'nothing-to-repeat':
      return "I haven't said anything yet.";
    case 'unrecognized':
      return streak >= 2
        ? pb.pick('unrecognized-again', [
            "I'm still not getting it. Could you say it a different way?",
            "Sorry, that's not clicking for me. Try something simpler, like fly to Tokyo.",
          ])
        : pb.pick('unrecognized', [
            "Sorry, I didn't catch what to do with that. You could try fly to Tokyo, or show me the ships.",
            "I'm not sure what you'd like me to do there. Try something like zoom in, or turn on satellites.",
            "Hmm, I didn't quite get that. Could you say it another way?",
          ]);
    case 'model-down':
      return pb.pick('model-down', [
        "I can't reach my local language model. Is Ollama running?",
        "My local model isn't answering right now. Check that Ollama is running.",
      ]);
    case 'error':
      return pb.pick('error', [
        'Something went wrong on my end. Could you try that again?',
        'Sorry, I hit a snag. Give it another try?',
      ]);
    default:
      return '';
  }
}

/** Join several step outcomes so each lands as its own sentence. */
export function joinSteps(lines) {
  return lines
    .map((line) => String(line).trim())
    .filter(Boolean)
    .join(' ');
}
