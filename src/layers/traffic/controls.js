import {
  trafficBucketTier,
  trafficStyleProfile,
} from '../../data/trafficPresetStyle.js';
import { TRAFFIC_TIMING_ENABLED } from './policy.js';

/**
 * Derive a 4-char display code from an opaque session token — same label
 * width as the legacy sequential index, still non-sequential per rotation
 * since it's sliced straight from the random token.
 */
function shortVehicleCode(token) {
  const cleaned = String(token).replace(/-/g, '').toUpperCase();
  return (cleaned.slice(0, 4) || '0000').padEnd(4, '0');
}

// Stable per-dot handle for the detection arbiter's row-continuity tracking
// (`obj.sourceId` in detection.js) — deliberately SEPARATE from the rotating
// anonymous display token in `id`. The arbiter fades a row out/in whenever
// its tracking key changes, so if the privacy token itself were the key, a
// vehicle would visibly flicker every time its token rotated. This handle
// never appears on screen, is never derived from any real vehicle attribute,
// and — being a WeakMap — is dropped automatically once a dot leaves `_dots`
// and becomes unreachable, so it carries no more persistence than the dot
// simulation already does.
let _nextRenderId = 1;
const _dotRenderIds = new WeakMap();
function renderIdFor(dot) {
  let id = _dotRenderIds.get(dot);
  if (id === undefined) {
    id = _nextRenderId++;
    _dotRenderIds.set(dot, id);
  }
  return id;
}

export function createControls({ state: layerState, services, parts, source }) {
  const { getFlowSessionStats } = source;

  const methods = {
    id: 'traffic',

    name: 'Street Traffic',

    icon: '🚗',

    source: 'OpenStreetMap',

    /** @type {number} Zero — layer is self-managed via camera listener + preRender */
    updateInterval: 0,

    /**
     * Update user-adjustable parameters (density and speed scaling).
     *
     * @param {Object}  [params]
     * @param {number}  [params.densityScale] - Dot density multiplier (clamped 0.2–2.5).
     * @param {number}  [params.speedScale]   - Dot speed multiplier (clamped 0.3–3.0).
     */
    setParams(params = {}) {
      if (typeof params.densityScale === 'number') {
        layerState._densityScale = Math.max(
          0.2,
          Math.min(2.5, params.densityScale),
        );
      }
      if (typeof params.speedScale === 'number') {
        layerState._speedScale = Math.max(
          0.3,
          Math.min(3.0, params.speedScale),
        );
      }
      // Live-mode treatment of roads TomTom has no flow data for:
      // 'sim' (default) keeps them as today's white ambient dots — colored =
      // real data, white = simulation; 'hide' spawns nothing on them (strict
      // data-integrity view). Owner-explorable; re-render applies on the next
      // camera-driven load.
      if (params.uncoveredRoads === 'sim' || params.uncoveredRoads === 'hide') {
        layerState._uncoveredMode = params.uncoveredRoads;
      }
      // Jam-viz prototype toggle (owner A/B): 'none' = shipped main behavior;
      // live mode only, applies on the next camera-driven load like the
      // uncoveredRoads param above.
      if (['none', 'density', 'heatline', 'both'].includes(params.jamViz)) {
        layerState._jamViz = params.jamViz;
      }
      // Preset-aware dot styling kill switch (owner A/B): 'off' forces the
      // shipped palette under every post-FX preset. Applies immediately via
      // in-place restyle — no refetch — so A/B legs share identical dots.
      if (params.presetDots === 'on' || params.presetDots === 'off') {
        if (params.presetDots !== layerState._presetDots) {
          layerState._presetDots = params.presetDots;
          parts.style.restyleDotsInPlace();
        }
      }
    },

    /**
     * Return the current user-adjustable parameters.
     * @returns {{densityScale:number, speedScale:number}}
     */
    getParams() {
      return {
        densityScale: layerState._densityScale,
        speedScale: layerState._speedScale,
        uncoveredRoads: layerState._uncoveredMode,
        jamViz: layerState._jamViz,
        presetDots: layerState._presetDots,
      };
    },

    /**
     * Return a sub-sampled list of active dot positions for detection overlays
     * (e.g. CCTV bounding-box rendering).
     *
     * Uses a deterministic stride-based sampling so different seeds yield
     * non-overlapping subsets without sorting or shuffling. Each label's
     * VEH-XXXX suffix is sliced from that dot's rotating anonymous session
     * token (see anonymousVehicleTracking.js) rather than its array index —
     * it ages out and reshuffles on the token's TTL instead of staying
     * pinned to one dot indefinitely, and falls back to the plain index if
     * anonymous tracking is disabled. `sourceId` is a SEPARATE, non-rotating
     * per-dot handle — detection.js's arbiter keys row continuity off it, so
     * a token rotation updates the visible text without the detection box
     * fading out and back in as if the vehicle had disappeared.
     *
     * @param {Object}  [options]
     * @param {number}  [options.maxCount] - Maximum objects to return (defaults to all).
     * @param {number}  [options.seed]     - Integer seed to offset the sampling start.
     * @returns {Array<{position:Cesium.Cartesian3, id:string, sourceId:number, type:string}>}
     */
    getDetectableObjects(options = {}) {
      if (!layerState._enabled || layerState._dots.length === 0) return [];
      const maxCount = Number.isFinite(options.maxCount)
        ? Math.max(1, Math.floor(options.maxCount))
        : layerState._dots.length;
      const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 0;
      // Stride-based sampling: step through dots evenly to get ~maxCount samples
      const stride = Math.max(1, Math.ceil(layerState._dots.length / maxCount));
      const start = seed % stride;

      const sampled = [];
      for (let i = start; i < layerState._dots.length; i += stride) {
        const dot = layerState._dots[i];
        if (!dot.point.position) continue;
        sampled.push({ dot, index: i });
        if (sampled.length >= maxCount) break;
      }

      const tokens =
        parts.anonymousVehicleTracking.methods.getVehicleLabelTokens(
          sampled.map((s) => s.dot),
        );

      return sampled.map(({ dot, index }) => {
        const token = tokens.get(dot);
        const entry = {
          position: dot.point.position,
          id: token
            ? `VEH-${shortVehicleCode(token)}`
            : `VEH-${String(index).padStart(4, '0')}`,
          sourceId: renderIdFor(dot),
          type: 'VEH',
        };
        // Live mode: the detection bracket carries the congestion signal —
        // its canvas sits ABOVE the post-FX chain, so tier colors survive
        // every preset (owner round 2: "bounding boxes do the heavy
        // lifting"). Keyless mode sets no tier: contacts keep the stock
        // 'vehicle' bracket and the keyless experience stays untouched.
        if (layerState._liveMode) {
          const tier = trafficBucketTier(dot.bucket || 'sim');
          if (tier) entry.tier = tier;
        }
        return entry;
      });
    },

    /**
     * Return current layer statistics for UI status chips.
     * `mode` is the CONFIGURED source — 'live' (a TomTom key is present) or
     * 'sim' (keyless simulation, which the manager renders as a FALLBACK chip);
     * `error` carries this instant's health, so a live-configured layer whose
     * flow feed went down reads DEGRADED with the reason instead of a stale
     * LIVE coverage number. `flowCoveragePct` is matched roads / roads with any
     * flow candidates (0–100 int); `tilesFetched` counts flow-tile requests
     * issued to the proxy this session (decode-cache hits excluded).
     * @returns {{count:number, lastUpdate:number|null, loading:boolean,
     *   mode:'live'|'sim', error:string|null, flowCoveragePct:number,
     *   tilesFetched:number}}
     */
    getStats() {
      // Outstanding flow work counts as loading: the paint race can leave a
      // TomTom request in flight after the roads have settled, and the shared
      // loading batch has to stay open long enough to announce its failure.
      const loading = layerState._fetching || layerState._flowPending > 0;
      const feed = parts.model.trafficFeedPresentation({
        liveMode: layerState._liveMode,
        fetching: loading,
        flowError: layerState._flowError,
        coveragePct: layerState._flowCoveragePct,
        statusUnavailable: layerState._flowStatusUnavailable,
      });
      return {
        count: layerState._count,
        lastUpdate: layerState._lastUpdate,
        loading,
        mode: feed.mode,
        error: layerState._roadError || feed.error,
        flowCoveragePct: layerState._flowCoveragePct,
        tilesFetched: getFlowSessionStats().tilesFetched,
        ...(TRAFFIC_TIMING_ENABLED
          ? { trafficTiming: parts.timing.getTrafficTimingDiagnostics() }
          : {}),
        // Per-bucket rendered-dot counts (sim = white ambient). Drives the
        // qa-traffic color assertions and the sync-chip mode label below.
        flowBuckets: { ...layerState._bucketCounts },
        closedRoads: layerState._closedRoads,
        // Jam-viz prototype diagnostics (additive — harness contract untouched).
        heatLines: layerState._heatLineCount,
        jamViz: layerState._jamViz,
        // Preset-styling diagnostics (additive): active style + profile.
        stylePreset: layerState._stylePreset,
        styleProfile:
          layerState._presetDots === 'on'
            ? trafficStyleProfile(layerState._stylePreset)
            : 'normal',
        // Sync-chip text: shown while busy, and flashed on its own for 1.5 s
        // after each completed load (ui.js _updateTrafficSyncChip semantics).
        // The settled flash carries NO progress number beside it — this label's
        // coverage figure is the chip's only percentage — so a label that ends
        // in one had better be the honest one. This is also where LIVE vs
        // SIMULATED mode is surfaced, and it must never imply a live feed the
        // layer does not have.
        loadingLabel: feed.loadingLabel,
      };
    },
  };

  return { methods };
}
