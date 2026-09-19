import { PIPER_MAX_TEXT_LENGTH } from './constants.js';

// ---------------------------------------------------------------------------
// Text → speakable text. Piper reads what it is given literally, so "FL350",
// "12.5 km", "UAL123" or "**Done**" come out as mangled letters, symbols or
// nothing. This normalizes the written form into the words a person would say,
// and guarantees terminal punctuation so the voice lands its final intonation
// instead of trailing off mid-phrase. Pure and synchronous: no I/O.
// ---------------------------------------------------------------------------

const UNIT_WORDS = new Map([
  ['ft', ['foot', 'feet']],
  ['km', ['kilometer', 'kilometers']],
  ['mi', ['mile', 'miles']],
  ['nm', ['nautical mile', 'nautical miles']],
  ['kt', ['knot', 'knots']],
  ['kts', ['knot', 'knots']],
  ['m', ['meter', 'meters']],
  ['s', ['second', 'seconds']],
  ['min', ['minute', 'minutes']],
  ['hr', ['hour', 'hours']],
  ['hrs', ['hour', 'hours']],
]);

const COMPOUND_UNITS = [
  [/(\d)\s?km\/h\b/gi, '$1 kilometers per hour'],
  [/(\d)\s?kph\b/gi, '$1 kilometers per hour'],
  [/(\d)\s?mph\b/gi, '$1 miles per hour'],
  [/(\d)\s?m\/s\b/gi, '$1 meters per second'],
  [/(\d)\s?ft\/min\b/gi, '$1 feet per minute'],
];

const ABBREVIATIONS = [
  [/\bUTC\b/g, 'U T C'],
  [/\bGPS\b/g, 'G P S'],
  [/\bADS-?B\b/g, 'A D S B'],
  [/\bAIS\b/g, 'A I S'],
  [/\bETA\b/g, 'E T A'],
  [/\bISS\b/g, 'the I S S'],
  [/\bvs\.?(?=\s)/gi, 'versus'],
  [/\be\.g\./gi, 'for example'],
  [/\bi\.e\./gi, 'that is'],
];

const SPELLED_TOKEN = [
  // Airline callsign: 2–4 letters + 1–4 digits + optional letter (UAL123, DAL42A).
  /\b([A-Z]{2,4})(\d{1,4})([A-Z]?)\b/g,
  // US registration: N + 1–5 digits + up to 2 letters (N546PC).
  /\b(N)(\d{1,5})([A-Z]{0,2})\b/g,
];

function spell(chars) {
  return chars.split('').join(' ');
}

function pluralUnit(value, [one, many]) {
  return Math.abs(Number(value)) === 1 ? one : many;
}

/** "5 km" → "5 kilometers", "1 ft" → "1 foot". Only after a number. */
function expandUnits(text) {
  let out = text;
  for (const [pattern, replacement] of COMPOUND_UNITS) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(
    /(\d(?:[\d,]*\.?\d+)?)\s?(ft|km|mi|nm|kts?|hrs?|min|m|s)\b(?![-/\w])/gi,
    (match, value, unit) => {
      const words = UNIT_WORDS.get(unit.toLowerCase());
      return words
        ? `${value} ${pluralUnit(value.replace(/,/g, ''), words)}`
        : match;
    },
  );
}

/** "FL350" → "flight level 3 5 0". Bare thousands commas are left to the voice. */
function expandAviation(text) {
  return text.replace(
    /\bFL\s?(\d{2,3})\b/g,
    (_m, level) => `flight level ${spell(level)}`,
  );
}

/** Callsigns and registrations are read character by character. */
function spellIdentifiers(text) {
  let out = text;
  for (const pattern of SPELLED_TOKEN) {
    out = out.replace(pattern, (_m, a, b, c) =>
      [spell(a), spell(b), c ? spell(c) : ''].filter(Boolean).join(' '),
    );
  }
  return out;
}

/**
 * Strip formatting a voice must never pronounce: markdown, URLs, emoji,
 * bracketed asides, and characters that make espeak-style front-ends stutter.
 * Slashes are handled separately, AFTER unit expansion, because "km/h" needs
 * its slash to be recognised.
 */
function stripMarkup(text) {
  return (
    text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      // Markdown links first: their URL is what the bare-URL rule would eat.
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[*_~#>|]+/g, ' ')
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ')
      .replace(/\(([^)]{0,80})\)/g, ', $1,')
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/[–—]/g, ', ')
  );
}

/** Whatever slashes survive unit expansion ("and/or") read as a space. */
function dropSlashes(text) {
  return text.replace(/\s*[/\\]\s*/g, ' ');
}

function expandSymbols(text) {
  return text
    .replace(/°\s?C\b/g, ' degrees Celsius')
    .replace(/°\s?F\b/g, ' degrees Fahrenheit')
    .replace(/°/g, ' degrees')
    .replace(/%/g, ' percent')
    .replace(/&/g, ' and ')
    .replace(/\+(?=\d)/g, 'plus ')
    .replace(/(?<=\d)\s?×\s?(?=\d)/g, ' times ');
}

/** Tidy commas/whitespace left behind by the passes above. */
function tidy(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/,\s*,+/g, ',')
    .replace(/^[,;:\s]+/, '')
    .replace(/[,;:\s]+$/, '')
    .trim();
}

/** Every spoken utterance ends in terminal punctuation so the pitch resolves. */
function ensureTerminalPunctuation(text) {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/**
 * Turn written text into the words a person would say aloud.
 * @param {unknown} input
 * @param {{maxLength?: number}} [options]
 * @returns {string} Speakable text; '' when nothing pronounceable remains.
 */
export function prepareSpeechText(
  input,
  { maxLength = PIPER_MAX_TEXT_LENGTH } = {},
) {
  let text = String(input ?? '');
  text = stripMarkup(text);
  text = expandSymbols(text);
  text = expandAviation(text);
  text = expandUnits(text);
  text = dropSlashes(text);
  for (const [pattern, replacement] of ABBREVIATIONS) {
    text = text.replace(pattern, replacement);
  }
  text = spellIdentifiers(text);
  text = tidy(text);
  if (text.length > maxLength) {
    // Cut at the last sentence/clause boundary inside the budget rather than
    // mid-word, so a truncated reply still sounds finished.
    const window = text.slice(0, maxLength);
    const boundary = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('! '),
      window.lastIndexOf('? '),
      window.lastIndexOf(', '),
    );
    text = tidy(
      boundary > maxLength * 0.5 ? window.slice(0, boundary) : window,
    );
  }
  return text ? ensureTerminalPunctuation(text) : '';
}
