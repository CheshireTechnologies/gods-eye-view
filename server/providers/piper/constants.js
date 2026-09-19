// ---------------------------------------------------------------------------
// Local Piper text-to-speech proxy — the voice half of the fully-local
// fallback path used when the OpenAI Realtime connection is unavailable
// (rate-limited, offline, no key). Entirely optional, entirely local: no API
// key, no cloud call, no cost. Piper ships as a CLI binary + a downloaded
// .onnx voice model, not a persistent server, so this shells out to it
// per-request rather than proxying HTTP like the Ollama provider does.
// ---------------------------------------------------------------------------

/** Piper CLI binary — must be on PATH, or point GEV_PIPER_BIN at it. */
const PIPER_BIN_DEFAULT = 'piper';

/**
 * Path to the downloaded .onnx voice model (e.g. en_US-lessac-medium.onnx).
 * No sensible default exists — Piper voices are separate downloads — so this
 * is required; the handler degrades to a clear ok:false when it's unset.
 */
const PIPER_MODEL_PATH_DEFAULT = '';

/** Per-request timeout for the Piper subprocess (ms). */
const PIPER_REQUEST_TIMEOUT_MS = 15_000;

/** Cap on synthesized text length — a spoken tool result is always short. */
const PIPER_MAX_TEXT_LENGTH = 600;

/**
 * Seconds of silence Piper leaves after each sentence. Its own default (0.2)
 * runs multi-sentence replies together; a slightly longer beat reads as a
 * person finishing a thought. Override with GEV_PIPER_SENTENCE_SILENCE.
 */
const PIPER_SENTENCE_SILENCE_DEFAULT = 0.35;

/**
 * Optional prosody overrides, unset by default so each voice keeps the values
 * it was trained with. Piper's flag spellings differ between the C++ and
 * Python builds only in dashes vs underscores; the underscore forms are
 * accepted by both, so they are what we pass.
 *   GEV_PIPER_LENGTH_SCALE  >1 slower, <1 faster (voice default 1.0)
 *   GEV_PIPER_NOISE_SCALE   expressiveness of pitch/energy
 *   GEV_PIPER_NOISE_W       rhythm/phoneme-length variation
 */
const PIPER_PROSODY_ENV = [
  ['GEV_PIPER_LENGTH_SCALE', '--length_scale'],
  ['GEV_PIPER_NOISE_SCALE', '--noise_scale'],
  ['GEV_PIPER_NOISE_W', '--noise_w'],
];

/** Repeated phrases ("Okay.", "Done.") are served from memory, not re-synthesized. */
const PIPER_CACHE_MAX_ENTRIES = 48;
const PIPER_CACHE_MAX_BYTES = 12 * 1024 * 1024;

export {
  PIPER_BIN_DEFAULT,
  PIPER_MODEL_PATH_DEFAULT,
  PIPER_REQUEST_TIMEOUT_MS,
  PIPER_MAX_TEXT_LENGTH,
  PIPER_SENTENCE_SILENCE_DEFAULT,
  PIPER_PROSODY_ENV,
  PIPER_CACHE_MAX_ENTRIES,
  PIPER_CACHE_MAX_BYTES,
};
