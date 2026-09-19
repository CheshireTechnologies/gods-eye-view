import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';

/** Stable sha1 hex digest for a cache key string. */
function hashKey(key) {
  return createHash('sha1').update(key).digest('hex');
}

/**
 * Small memory+disk cache shared by the Ollama embeddings and narrative
 * endpoints. Same tiered idiom as server/providers/overpass/cache.js (memory
 * Map -> in-flight coalescing -> disk JSON -> compute), simplified for this
 * use: no boundary-vs-not TTL split, and no serve-stale-on-failure — a local
 * Ollama miss degrades honestly (ok:false) rather than serving a stale answer.
 */
function createOllamaCache({ diskDir, memoryTtlMs, maxEntries }) {
  const memory = new Map();
  const inFlight = new Map();

  function diskPath(key) {
    return path.join(diskDir, `${hashKey(key)}.json`);
  }

  async function readDisk(key) {
    try {
      const raw = await fsp.readFile(diskPath(key), 'utf8');
      const payload = JSON.parse(raw);
      return payload && Number.isFinite(payload.cachedAt) ? payload : null;
    } catch {
      return null;
    }
  }

  function writeDisk(key, payload) {
    fsp
      .mkdir(diskDir, { recursive: true })
      .then(() => fsp.writeFile(diskPath(key), JSON.stringify(payload)))
      .catch((err) =>
        console.warn(
          '[Ollama Proxy] disk cache write failed:',
          err?.message || err,
        ),
      );
  }

  function trim() {
    while (memory.size > maxEntries) {
      const oldestKey = memory.keys().next().value;
      if (!oldestKey) break;
      memory.delete(oldestKey);
    }
  }

  /**
   * Get a cached value for `key`, or compute it with `computeFn` and cache
   * the result. Concurrent calls for the same key share one in-flight
   * computation instead of issuing duplicate Ollama requests.
   */
  async function getOrCompute(key, computeFn, now = Date.now()) {
    const cached = memory.get(key);
    if (cached && now - cached.cachedAt <= memoryTtlMs) return cached.value;

    const pending = inFlight.get(key);
    if (pending) return pending;

    const disk = await readDisk(key);
    if (disk) {
      memory.set(key, { value: disk.value, cachedAt: disk.cachedAt });
      trim();
      return disk.value;
    }

    const promise = (async () => {
      const value = await computeFn();
      const payload = { value, cachedAt: Date.now() };
      memory.set(key, payload);
      trim();
      writeDisk(key, payload);
      return value;
    })();
    inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(key);
    }
  }

  return { getOrCompute };
}

export { createOllamaCache, hashKey };
