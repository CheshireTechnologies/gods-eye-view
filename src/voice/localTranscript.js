/**
 * Everything the local voice fallback does to a transcript BEFORE and AFTER the
 * local model sees it, kept pure and synchronous so it is testable without a
 * browser, a microphone, or Ollama:
 *
 *  - cleanTranscript   strip wake words, filler and self-corrections
 *  - classifyPhatic    answer thanks / hello / "never mind" / "say that again"
 *                      instantly, with no model round-trip
 *  - normalizeCall     repair a model-picked call against the tool schema
 *                      (defaults, enum casing, type coercion, unknown args) and
 *                      report what is missing so we can ask instead of guess
 * @module voice/localTranscript
 */

const WAKE_PREFIX =
  /^(?:(?:hey|ok|okay|yo|hi)[\s,]+)?(?:god'?s[\s-]?eye(?:[\s-]?view)?|g\.?e\.?v\.?|assistant|computer)\b[\s,:.-]*/i;

const LEADING_FILLER =
  /^(?:um+|uh+|er+|erm|hmm+|mm+|like|so|well|okay|ok|alright|yeah|please|go ahead and|(?:could|can|would|will) you please|i(?:'d| would) like you to|i want you to|i need you to|i(?:'d| would) like to|let'?s)\b[\s,.-]*/i;

const TRAILING_FILLER =
  /[\s,.-]*\b(?:please|thanks|thank you|for me|right now|if you can|if possible)\s*[.!?]*$/i;

const INTERNAL_FILLER = /\b(?:um+|uh+|er+|erm|hmm+)\b[\s,]*/gi;

// A spoken self-correction: everything before the marker was abandoned.
const SELF_CORRECTION =
  /(?:,|\.|\s)\s*(?:no+,?\s+wait|wait,?\s+no|sorry,?|i mean|scratch that|or rather|actually,?\s+no)\b[\s,:-]*/i;

/**
 * Reduce a raw speech-recognition transcript to the command it carries.
 * Conservative on purpose: when stripping would leave nothing meaningful, the
 * original wording is kept and the model gets to interpret it whole.
 * @param {unknown} raw
 * @returns {string}
 */
export function cleanTranscript(raw) {
  const original = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!original) return '';
  let text = original;

  // Keep only what follows the last self-correction — but only if it is a real
  // clause. "turn it off, no wait, on" leaves a bare "on", which is meaningless
  // alone; that case is left for the model to resolve with the full sentence.
  const parts = text.split(SELF_CORRECTION);
  const lastClause = parts[parts.length - 1]?.trim() || '';
  if (parts.length > 1 && lastClause.split(/\s+/).length >= 2) {
    text = lastClause;
  }

  // Wake words and filler interleave ("um, hey god's eye, could you please…"),
  // so peel both until neither changes anything.
  let previous;
  do {
    previous = text;
    text = text.replace(WAKE_PREFIX, '').replace(LEADING_FILLER, '');
  } while (text !== previous && text);
  text = text.replace(INTERNAL_FILLER, ' ').replace(TRAILING_FILLER, '');
  text = text.replace(/\s+/g, ' ').trim();
  return text || original;
}

const PHATIC = [
  [
    'cancel',
    /^(?:never ?mind|cancel(?: that)?|forget (?:it|that)|scratch that|that'?s (?:all|it)|it'?s fine|nothing)[.!]*$/i,
  ],
  [
    'thanks',
    /^(?:thanks?|thank you|cheers|great|perfect|nice|awesome|cool|sweet|good (?:job|work)|that'?s (?:great|perfect|good))(?: (?:so|very) much| a lot)?[.!]*$/i,
  ],
  [
    'greeting',
    /^(?:hi|hello|hey|howdy|good (?:morning|afternoon|evening))(?: there)?[.!]*$/i,
  ],
  [
    'help',
    /^(?:help(?: me)?|what can you (?:do|help (?:me )?with)|what do you do|what are you (?:able|capable) (?:of|to do)|what (?:commands|things) (?:can|do) (?:i|you) (?:say|know|understand)|how do (?:you|i) (?:work|use (?:you|this)))[.!?]*$/i,
  ],
  [
    'repeat',
    /^(?:say (?:that|it) again|repeat (?:that|yourself)?|what did you (?:just )?say|come again|pardon(?: me)?|sorry\?)[.!?]*$/i,
  ],
];

/**
 * @param {string} cleaned - Output of cleanTranscript.
 * @returns {'cancel'|'thanks'|'greeting'|'help'|'repeat'|null}
 */
export function classifyPhatic(cleaned) {
  const text = String(cleaned ?? '').trim();
  for (const [kind, pattern] of PHATIC) {
    if (pattern.test(text)) return kind;
  }
  return null;
}

// What a person means when they leave a parameter out. Filling these beats
// asking "how much?" after "zoom in".
const IMPLIED_DEFAULTS = {
  adjust_camera_zoom: { amount: 'medium' },
  select_nearest_aircraft: { layerId: 'flights' },
  move_camera: { mode: 'once' },
};

// Enum-typed arguments the ACTION RUNNER resolves itself (it keeps an alias
// table: "fires" → local-firms, "ships" → ais-live-vessels). A value that misses
// the enum is passed through for the runner to resolve — or to reject with its
// own explanation — rather than discarded here, which would refuse commands the
// app understands. Genuine closed enums (zoom direction, camera motion) stay strict.
const RUNNER_RESOLVED = new Set(['layerId']);

function coerce(value, spec, key) {
  if (value === null || value === undefined || value === '') return undefined;
  switch (spec?.type) {
    case 'number': {
      const number = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(number) ? number : undefined;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (/^(true|yes|on|enable[d]?)$/i.test(String(value))) return true;
      if (/^(false|no|off|disable[d]?)$/i.test(String(value))) return false;
      return undefined;
    case 'string': {
      const text = String(value).trim();
      if (!text) return undefined;
      if (!Array.isArray(spec.enum)) return text;
      const match = spec.enum.find(
        (option) => String(option).toLowerCase() === text.toLowerCase(),
      );
      return match ?? (RUNNER_RESOLVED.has(key) ? text : undefined);
    }
    default:
      return value;
  }
}

/**
 * Repair one model-picked call against its schema.
 * @param {{name: string, arguments?: object}} call
 * @param {Map<string, {name: string, parameters: object}>} toolsByName
 * @returns {{ok: true, call: {name: string, arguments: object}}
 *   | {ok: false, reason: 'unknown'}
 *   | {ok: false, reason: 'missing', missing: string[], call: object}}
 */
export function normalizeCall(call, toolsByName) {
  const tool = toolsByName.get(call?.name);
  if (!tool) return { ok: false, reason: 'unknown' };
  const properties = tool.parameters?.properties || {};
  const required = tool.parameters?.required || [];
  const args = {};
  for (const [key, spec] of Object.entries(properties)) {
    const value = coerce(call.arguments?.[key], spec, key);
    if (value !== undefined) args[key] = value;
  }
  for (const [key, value] of Object.entries(
    IMPLIED_DEFAULTS[call.name] || {},
  )) {
    if (args[key] === undefined && key in properties) args[key] = value;
  }
  const missing = required.filter((key) => args[key] === undefined);
  // fly_to_location has no required field, yet is meaningless without a place.
  if (
    call.name === 'fly_to_location' &&
    args.locationId === undefined &&
    args.query === undefined &&
    args.latitude === undefined
  ) {
    missing.push('place');
  }
  const normalized = { name: call.name, arguments: args };
  return missing.length
    ? { ok: false, reason: 'missing', missing, call: normalized }
    : { ok: true, call: normalized };
}
