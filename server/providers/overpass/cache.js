import { isOverpassBoundaryQuery } from './query.js';
import {
  OVERPASS_BOUNDARY_DISK_TTL_MS,
  OVERPASS_DISK_TTL_MS,
  overpassDiskDir,
  OVERPASS_CACHE_MS,
  OVERPASS_CACHE_MAX_ENTRIES,
} from './constants.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { overpassPayloadIsData } from './transport.js';

/** @type {Map<string,{status:number,body:string,contentType:string,endpoint:string,cachedAt:number}>} */
const _overpassCache = new Map();

/** Disk TTL for a query: boundary geometry keeps for a month, the rest 7 days. */
function overpassDiskTtlMs(cacheKey) {
  return isOverpassBoundaryQuery(cacheKey)
    ? OVERPASS_BOUNDARY_DISK_TTL_MS
    : OVERPASS_DISK_TTL_MS;
}

/** Normalized Overpass query -> stable disk-cache file path. */
function overpassDiskPath(cacheKey) {
  return path.join(
    overpassDiskDir(),
    `${createHash('sha1').update(cacheKey).digest('hex')}.json`,
  );
}

/**
 * Read a disk-cached Overpass payload. maxAgeMs Infinity = any age (the
 * serve-stale path when every mirror is down).
 * @returns {Promise<?Object>} Payload with cachedAt, or null.
 */
async function readOverpassDisk(cacheKey, maxAgeMs) {
  try {
    const raw = await fsp.readFile(overpassDiskPath(cacheKey), 'utf8');
    const payload = JSON.parse(raw);
    if (
      !payload ||
      typeof payload.body !== 'string' ||
      !Number.isFinite(payload.cachedAt)
    )
      return null;
    // Older versions persisted 4xx refusals with normal data TTLs. Ignore
    // them on both fresh and stale reads so an upgrade can recover immediately.
    if (!overpassPayloadIsData(payload)) return null;
    if (Date.now() - payload.cachedAt > maxAgeMs) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Fire-and-forget disk write for a successful Overpass payload. */
function writeOverpassDisk(cacheKey, payload) {
  fsp
    .mkdir(overpassDiskDir(), { recursive: true })
    .then(() =>
      fsp.writeFile(overpassDiskPath(cacheKey), JSON.stringify(payload)),
    )
    .catch((err) =>
      console.warn(
        '[Overpass Proxy] disk cache write failed:',
        err?.message || err,
      ),
    );
}

/**
 * Resolve every cache/coalescing layer before admitting a request to the local
 * upstream rate limiter. The injected limiter callback is invoked exactly once
 * for a complete cache miss and never for memory, in-flight, or disk hits.
 * Exported so the admission ordering can be tested without a Vite server.
 *
 * @param {object} options
 * @param {string} options.cacheKey
 * @param {Map<string, object>} options.memoryCache
 * @param {Map<string, Promise<object>>} options.inFlight
 * @param {()=>Promise<object|null>} options.readDisk
 * @param {()=>boolean} options.allowUpstream
 * @param {number} [options.now]
 * @param {number} [options.cacheMs]
 * @returns {Promise<{source:'HIT'|'INFLIGHT'|'DISK'|'UPSTREAM'|'RATE_LIMITED', payload:object|null}>}
 */
async function resolveOverpassPreflight({
  cacheKey,
  memoryCache,
  inFlight,
  readDisk,
  allowUpstream,
  now = Date.now(),
  cacheMs = OVERPASS_CACHE_MS,
}) {
  const cached = memoryCache.get(cacheKey);
  if (overpassPayloadIsData(cached) && now - cached.cachedAt <= cacheMs)
    return { source: 'HIT', payload: cached };

  const pending = inFlight.get(cacheKey);
  if (pending) return { source: 'INFLIGHT', payload: await pending };

  const disk = await readDisk();
  if (overpassPayloadIsData(disk)) return { source: 'DISK', payload: disk };

  return allowUpstream()
    ? { source: 'UPSTREAM', payload: null }
    : { source: 'RATE_LIMITED', payload: null };
}

/** Return only last-good Overpass data, regardless of its age. */
async function readStaleOverpass(cacheKey) {
  const cached = _overpassCache.get(cacheKey);
  return overpassPayloadIsData(cached)
    ? cached
    : readOverpassDisk(cacheKey, Infinity);
}

/** Evict oldest Overpass cache entries until size is within the cap. */
function trimOverpassCache() {
  while (_overpassCache.size > OVERPASS_CACHE_MAX_ENTRIES) {
    const oldestKey = _overpassCache.keys().next().value;
    if (!oldestKey) break;
    _overpassCache.delete(oldestKey);
  }
}

/** A single bbox 4-tuple `(s,w,n,e)`, captured — the literal viewport a road
 *  query was built for (source.js bakes it straight into the query text). */
const QUERY_BOUNDS_RE =
  /\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/;

/** Pull the `(south,west,north,east)` this query was scoped to, or null for
 *  non-viewport queries (is_in/pivot/around — not what the traffic layer sends).
 *  cacheKey is the URL-encoded `data=...` form body (sanitizeOverpassBody's
 *  output), so it must be decoded before the literal-paren regex can match. */
function extractQueryBounds(cacheKey) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(cacheKey || ''));
  } catch {
    decoded = String(cacheKey || '');
  }
  const m = QUERY_BOUNDS_RE.exec(decoded);
  if (!m) return null;
  const [south, west, north, east] = [m[1], m[2], m[3], m[4]].map(Number);
  if (![south, west, north, east].every(Number.isFinite)) return null;
  if (north <= south || east <= west) return null;
  return { south, west, north, east };
}

/**
 * What fraction of `target`'s area is covered by `candidate`. Mirrors the
 * client's own viewport-overlap check (traffic/viewport.js) so "close enough"
 * means the same thing on both sides.
 */
function overlapFraction(target, candidate) {
  const overlapS = Math.max(target.south, candidate.south);
  const overlapN = Math.min(target.north, candidate.north);
  const overlapW = Math.max(target.west, candidate.west);
  const overlapE = Math.min(target.east, candidate.east);
  const overlapArea =
    Math.max(0, overlapN - overlapS) * Math.max(0, overlapE - overlapW);
  const targetArea =
    (target.north - target.south) * (target.east - target.west);
  return targetArea > 0 ? overlapArea / targetArea : 0;
}

/** filename -> {mtimeMs, bounds: {south,west,north,east}|null} — the actual
 *  bbox of a cached payload's elements, derived once per file per process
 *  (not the query bbox: a road query can return elements clipped tighter
 *  than what it asked for, and this is what the fallback should match on). */
const _diskBoundsIndex = new Map();

/** Union of each `way` element's own `bounds` field — cheap (no geometry
 *  walk) since `out geom` already attaches one per way. */
function payloadElementBounds(bodyText) {
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!Array.isArray(data?.elements)) return null;
  let south = Infinity,
    west = Infinity,
    north = -Infinity,
    east = -Infinity;
  for (const el of data.elements) {
    const b = el?.bounds;
    if (
      !b ||
      !Number.isFinite(b.minlat) ||
      !Number.isFinite(b.minlon) ||
      !Number.isFinite(b.maxlat) ||
      !Number.isFinite(b.maxlon)
    )
      continue;
    if (b.minlat < south) south = b.minlat;
    if (b.minlon < west) west = b.minlon;
    if (b.maxlat > north) north = b.maxlat;
    if (b.maxlon > east) east = b.maxlon;
  }
  return Number.isFinite(south) && Number.isFinite(west)
    ? { south, west, north, east }
    : null;
}

/** Bounds of one disk-cached payload, memoized on (filename, mtime) so a
 *  fallback scan only ever re-parses a file once per process lifetime. */
async function diskEntryBounds(filePath, mtimeMs) {
  const cached = _diskBoundsIndex.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.bounds;
  let bounds = null;
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const payload = JSON.parse(raw);
    if (overpassPayloadIsData(payload))
      bounds = payloadElementBounds(payload.body);
  } catch {
    bounds = null;
  }
  _diskBoundsIndex.set(filePath, { mtimeMs, bounds });
  return bounds;
}

/**
 * Last-resort fallback for a live road-viewport query with no exact-match
 * cache/stale entry: when every Overpass mirror is unreachable (an IP-level
 * block, not something a retry fixes), serve the best-overlapping ROAD data
 * already on disk from a previous viewport instead of an empty layer. Only
 * used for viewport-shaped (s,w,n,e) queries — boundary/is_in lookups return
 * null immediately, since "nearby" doesn't mean anything for those.
 *
 * @param {string} cacheKey - The failed query's normalized cache key.
 * @param {number} [minOverlap=0.1] - Skip candidates covering less than this
 *   fraction of the requested viewport (a sliver in one corner reads as
 *   "broken", not "nearby").
 * @param {number} [scanLimit=300] - Cap on directory entries inspected, so a
 *   cache directory that has grown over months can't turn a failed fetch
 *   into an unbounded disk scan.
 */
async function findNearbyOverpassDisk(
  cacheKey,
  minOverlap = 0.1,
  scanLimit = 300,
) {
  const target = extractQueryBounds(cacheKey);
  if (!target) return null;

  const diskDir = overpassDiskDir();
  let names;
  try {
    names = await fsp.readdir(diskDir);
  } catch {
    return null;
  }

  let best = null;
  let bestFraction = minOverlap;
  for (const name of names.slice(0, scanLimit)) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.join(diskDir, name);
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      continue;
    }
    const bounds = await diskEntryBounds(filePath, stat.mtimeMs);
    if (!bounds) continue;
    const fraction = overlapFraction(target, bounds);
    if (fraction > bestFraction) {
      bestFraction = fraction;
      best = filePath;
    }
  }
  if (!best) return null;

  try {
    const raw = await fsp.readFile(best, 'utf8');
    const payload = JSON.parse(raw);
    return overpassPayloadIsData(payload) ? payload : null;
  } catch {
    return null;
  }
}

export {
  readOverpassDisk,
  resolveOverpassPreflight,
  _overpassCache,
  overpassDiskTtlMs,
  readStaleOverpass,
  trimOverpassCache,
  writeOverpassDisk,
  extractQueryBounds,
  findNearbyOverpassDisk,
};
