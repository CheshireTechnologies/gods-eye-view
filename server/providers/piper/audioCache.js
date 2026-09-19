import { PIPER_CACHE_MAX_ENTRIES, PIPER_CACHE_MAX_BYTES } from './constants.js';

/**
 * Small in-memory LRU for synthesized WAV bytes. The local assistant says the
 * same short acknowledgements over and over; re-running the ONNX model for
 * each is wasted latency, and instant playback is a large part of sounding
 * responsive. Bounded by entry count AND total bytes so a long session of
 * unique replies cannot grow the dev server without limit.
 */
export function createAudioCache({
  maxEntries = PIPER_CACHE_MAX_ENTRIES,
  maxBytes = PIPER_CACHE_MAX_BYTES,
} = {}) {
  // Map preserves insertion order: the first key is always the least recent.
  const entries = new Map();
  let totalBytes = 0;

  function evict() {
    while (
      entries.size > maxEntries ||
      (totalBytes > maxBytes && entries.size > 1)
    ) {
      const oldest = entries.keys().next().value;
      totalBytes -= entries.get(oldest).length;
      entries.delete(oldest);
    }
  }

  return {
    get(key) {
      const hit = entries.get(key);
      if (!hit) return null;
      entries.delete(key);
      entries.set(key, hit);
      return hit;
    },
    set(key, wav) {
      if (wav.length > maxBytes) return;
      const prior = entries.get(key);
      if (prior) totalBytes -= prior.length;
      entries.delete(key);
      entries.set(key, wav);
      totalBytes += wav.length;
      evict();
    },
    get size() {
      return entries.size;
    },
    get bytes() {
      return totalBytes;
    },
  };
}
