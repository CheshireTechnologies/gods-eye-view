import { gevCacheDir } from '../common/cache-root.js';

// ---------------------------------------------------------------------------
// Local Ollama intelligence proxy — embeddings + narrative generation for the
// semantic_query voice tool. Entirely optional, entirely local: no API key,
// no cloud call, no cost. Every constant below has a sensible localhost
// default so this works out of the box when Ollama is running with the
// configured models pulled.
// ---------------------------------------------------------------------------

/** Default Ollama server address (its own default bind address/port). */
const OLLAMA_BASE_URL_DEFAULT = 'http://127.0.0.1:11434';

/** Small, fast embedding model — exactly what semantic ranking needs. */
const OLLAMA_EMBED_MODEL_DEFAULT = 'nomic-embed-text';

/** Small, fast instruct model for turning ranked matches into one narrative. */
const OLLAMA_CHAT_MODEL_DEFAULT = 'qwen2.5:3b-instruct';

/** Per-request timeout against the local Ollama server (ms). */
const OLLAMA_REQUEST_TIMEOUT_MS = 15_000;

/** Cap on texts embedded in a single request — matches analyst_query's own 50-record cap plus the query itself. */
const OLLAMA_MAX_TEXTS_PER_REQUEST = 64;

/** Cap on a single text's length before embedding (record descriptions are short by construction). */
const OLLAMA_MAX_TEXT_LENGTH = 600;

/**
 * Memory TTL for cached embedding vectors (ms). Record descriptions for
 * slow-moving/static layers (datacenters, dams, fires) repeat often within a
 * session, so a cache hit here skips a local model call entirely.
 */
const OLLAMA_EMBED_CACHE_MS = 10 * 60_000;

/** Disk-cache TTL for embedding vectors (ms) — survives a dev-server restart. */
const OLLAMA_EMBED_DISK_TTL_MS = 7 * 86_400_000;

/** Disk-cache directory for embedding vectors. */
const OLLAMA_EMBED_DISK_DIR = gevCacheDir('ollama', 'embeddings');

/** Max entries in the embedding memory cache (oldest evicted first). */
const OLLAMA_EMBED_CACHE_MAX_ENTRIES = 2000;

/**
 * Memory TTL for cached narratives (ms). Short on purpose — live layer data
 * moves, so a stale narrative would describe positions that already changed.
 * Long enough that an immediate repeat/follow-up of the same question over an
 * unchanged data window answers instantly instead of re-prompting the model.
 */
const OLLAMA_NARRATIVE_CACHE_MS = 25_000;

/** Disk-cache directory for narratives. */
const OLLAMA_NARRATIVE_DISK_DIR = gevCacheDir('ollama', 'narratives');

/** Max entries in the narrative memory cache. */
const OLLAMA_NARRATIVE_CACHE_MAX_ENTRIES = 200;

export {
  OLLAMA_BASE_URL_DEFAULT,
  OLLAMA_EMBED_MODEL_DEFAULT,
  OLLAMA_CHAT_MODEL_DEFAULT,
  OLLAMA_REQUEST_TIMEOUT_MS,
  OLLAMA_MAX_TEXTS_PER_REQUEST,
  OLLAMA_MAX_TEXT_LENGTH,
  OLLAMA_EMBED_CACHE_MS,
  OLLAMA_EMBED_DISK_TTL_MS,
  OLLAMA_EMBED_DISK_DIR,
  OLLAMA_EMBED_CACHE_MAX_ENTRIES,
  OLLAMA_NARRATIVE_CACHE_MS,
  OLLAMA_NARRATIVE_DISK_DIR,
  OLLAMA_NARRATIVE_CACHE_MAX_ENTRIES,
};
