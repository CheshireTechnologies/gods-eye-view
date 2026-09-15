// OVERPASS NEARBY FALLBACK — when every mirror is unreachable for the exact
// viewport asked (an IP-level block, not a retryable failure) and there is no
// exact-match cache entry either, the proxy falls back to the best-overlapping
// road data already on disk from a previously-visited viewport, instead of an
// empty layer. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { extractQueryBounds, findNearbyOverpassDisk } from '../vite.config.js';

const DIR = path.join(process.cwd(), '.gev-cache', 'overpass');

/** A minimal real-shaped `out geom` payload: one way with the given bounds. */
function roadPayload(bounds, cachedAt = Date.now()) {
  const body = JSON.stringify({
    elements: [{ type: 'way', id: 1, bounds, geometry: [] }],
  });
  return { status: 200, body, contentType: 'application/json', endpoint: 'https://example/api', cachedAt };
}

async function writeDiskEntry(cacheKey, payload) {
  const file = path.join(DIR, `${createHash('sha1').update(cacheKey).digest('hex')}.json`);
  await mkdir(DIR, { recursive: true });
  await writeFile(file, JSON.stringify(payload));
  return file;
}

/** Build a cache key the way overpass.js actually does: `data=` + encoded QL. */
function encKey(rawQuery) {
  return `data=${encodeURIComponent(rawQuery)}`;
}

test('extractQueryBounds parses the (s,w,n,e) tuple out of the URL-encoded cache key the proxy actually stores', () => {
  // What resolveOverpassPreflight / overpass.js actually pass as cacheKey:
  // sanitizeOverpassBody's `data=${encodeURIComponent(...)}` output, not raw QL.
  const rawQuery = '[out:json][timeout:25];(way["highway"~"^(motorway)$"](30.26,-97.76,30.29,-97.72););out geom qt;';
  const cacheKey = `data=${encodeURIComponent(rawQuery)}`;
  assert.deepEqual(extractQueryBounds(cacheKey), { south: 30.26, west: -97.76, north: 30.29, east: -97.72 });
});

test('extractQueryBounds returns null for non-viewport (no bbox tuple) queries', () => {
  assert.equal(extractQueryBounds('[out:json];is_in(30.2,-97.7)->.a;area.a[admin_level];out;'), null);
  assert.equal(extractQueryBounds(''), null);
  assert.equal(extractQueryBounds(undefined), null);
});

test('findNearbyOverpassDisk returns null with no overlapping cache entries on disk', async () => {
  const away = `overpass-nearby-away-${randomUUID()}`;
  const file = await writeDiskEntry(away, roadPayload({ minlat: 10, minlon: 10, maxlat: 10.1, maxlon: 10.1 }));
  try {
    const target = encKey('[out:json];(way["highway"~"x"](30.26,-97.76,30.29,-97.72););out geom qt;');
    assert.equal(await findNearbyOverpassDisk(target), null);
  } finally {
    await unlink(file).catch(() => {});
  }
});

test('findNearbyOverpassDisk serves the best-overlapping cached viewport, skipping a barely-touching one', async () => {
  // Target viewport: a 0.03° box around (30.275, -97.74).
  const target = encKey('[out:json];(way["highway"~"x"](30.26,-97.76,30.29,-97.72););out geom qt;');

  // Candidate A: a small sliver just clipping the target's SW corner (<10% overlap) — must be skipped.
  const sliverFile = await writeDiskEntry(
    `overpass-nearby-sliver-${randomUUID()}`,
    roadPayload({ minlat: 30.255, minlon: -97.765, maxlat: 30.262, maxlon: -97.758 }),
  );
  // Candidate B: fully covers the target viewport — the one that should win.
  const goodKey = `overpass-nearby-good-${randomUUID()}`;
  const good = roadPayload({ minlat: 30.2, minlon: -97.8, maxlat: 30.35, maxlon: -97.68 });
  const goodFile = await writeDiskEntry(goodKey, good);

  try {
    const nearby = await findNearbyOverpassDisk(target);
    assert.ok(nearby, 'a nearby fallback was found');
    assert.equal(nearby.status, 200);
    assert.equal(nearby.body, good.body);
  } finally {
    await Promise.all([unlink(sliverFile).catch(() => {}), unlink(goodFile).catch(() => {})]);
  }
});

test('findNearbyOverpassDisk ignores a non-data (refusal) disk entry', async () => {
  const target = encKey('[out:json];(way["highway"~"x"](30.26,-97.76,30.29,-97.72););out geom qt;');
  const file = await writeDiskEntry(`overpass-nearby-refusal-${randomUUID()}`, {
    status: 406,
    body: 'refused',
    contentType: 'text/html',
    endpoint: 'https://example/api',
    cachedAt: Date.now(),
  });
  try {
    assert.equal(await findNearbyOverpassDisk(target), null);
  } finally {
    await unlink(file).catch(() => {});
  }
});
