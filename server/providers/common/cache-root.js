import path from 'node:path';
import { existsSync } from 'node:fs';

/** Default on-disk cache root: inside the checkout, unchanged for every install that doesn't opt in. */
const DEFAULT_CACHE_DIR = path.join(process.cwd(), '.gev-cache');

let _warnedUnreachable = false;

/**
 * Resolve the root directory every provider's on-disk cache lives under.
 * Defaults to `.gev-cache` inside the checkout. Set `GEV_CACHE_DIR` to
 * redirect all of it elsewhere — an external drive, for faster/larger
 * persistent caching that survives a reinstall — without touching any
 * individual provider.
 *
 * Falls back to the default when the configured location isn't currently
 * reachable (its own path, or its nearest existing ancestor, doesn't exist —
 * e.g. an external drive that's unplugged), so a missing drive degrades to
 * "cache starts cold this run" rather than every read/write failing all
 * session. Resolved once per process (matching how every consumer already
 * computes its own cache path once at module/factory load), so reconnecting
 * a drive mid-session needs a restart to pick back up.
 */
function resolveCacheRoot() {
  const configured = String(process.env.GEV_CACHE_DIR || '').trim();
  if (!configured) return DEFAULT_CACHE_DIR;
  const reachable = existsSync(configured) || existsSync(path.dirname(configured));
  if (reachable) return configured;
  if (!_warnedUnreachable) {
    _warnedUnreachable = true;
    console.warn(
      `[GEV cache] GEV_CACHE_DIR (${configured}) is not reachable; using ${DEFAULT_CACHE_DIR} instead`,
    );
  }
  return DEFAULT_CACHE_DIR;
}

/** Join path segments under the resolved cache root. */
function gevCacheDir(...segments) {
  return path.join(resolveCacheRoot(), ...segments);
}

export { gevCacheDir, resolveCacheRoot, DEFAULT_CACHE_DIR };
