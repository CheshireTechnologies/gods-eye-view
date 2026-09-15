import { isExplicitLayerStateOrigin } from '../data/layerState.js';
import {
  registerCctvFocusRequestListener,
  routeCctvFocusRequest,
} from '../cctvFocusRequest.js';
import {
  flyToWorldTarget,
  registerWorldFocusRequestListener,
  routeWorldFocusRequest,
} from '../worldFocus.js';
import { registerNavigationAuthorityListener } from '../navigationPolicy.js';
/** Own manager subscriptions and the camera-entry events that outlive controls. */
export class LayerBindings {
  constructor({
    viewer,
    services,
    readControls,
    operations,
    feedback,
    shareRestoration,
  }) {
    Object.assign(
      this,
      {
        viewer,
        services,
        readControls,
        _feedback: feedback,
        _shareRestoration: shareRestoration,
      },
      operations,
    );
    this._disposed = false;
    this._dataManager = null;
    this._directionsShellModule = null;
    this._cctvRequestFocusHandler = null;
    this._removeCctvRequestFocusListener = null;
    this._worldRequestFocusHandler = null;
    this._removeWorldRequestFocusListener = null;
    this._removeNavigationAuthorityListener = null;
    this._navigationOwnerChangedRemover = null;
    this._awarenessSelectedHandler = null;
    this._awarenessClearedHandler = null;
    this._entitySelectedHandler = null;
    this._entityClearedHandler = null;
  }
  get hud() {
    return this.readControls().hud;
  }
  get _contextControls() {
    return this.readControls()._contextControls;
  }
  get _cctvControls() {
    return this.readControls()._cctvControls;
  }
  get _radioControls() {
    return this.readControls()._radioControls;
  }
  observeCamera() {
    this._cctvRequestFocusHandler = (event) =>
      routeCctvFocusRequest(
        event,
        (activate, focus) => this._runExplicitCctvFocus(activate, focus),
        (cameraId, durationSec) =>
          this.services.cctvLayer.focusCamera(cameraId, durationSec),
      );
    this._removeCctvRequestFocusListener = registerCctvFocusRequestListener(
      window,
      this._cctvRequestFocusHandler,
    );
    this._worldRequestFocusHandler = (event) =>
      routeWorldFocusRequest(
        event,
        (detail, fly) => this._runExplicitWorldFocus(detail, fly),
        (detail) => flyToWorldTarget(this.viewer, detail),
      );
    this._removeWorldRequestFocusListener = registerWorldFocusRequestListener(
      window,
      this._worldRequestFocusHandler,
    );
    this._navigationOwnerChangedRemover =
      this.viewer.trackedEntityChanged.addEventListener((entity) => {
        if (entity && !this._disposed)
          this._stampNavigation({ cancelPendingSelection: false });
      });
    // Vessel/installation focus flies without ever assigning a tracked entity,
    // so it cannot reach the listener above. It announces instead.
    this._removeNavigationAuthorityListener =
      registerNavigationAuthorityListener(window, (event) => {
        if (this._disposed) return;
        this._stampNavigation({
          cancelPendingSelection:
            event?.detail?.cancelPendingSelection !== false,
        });
      });
  }
  _connectDirectionsCamera() {
    if (!this._dataManager) {
      // Detaching: the layer outlives this shell, so it must not keep calling
      // a facade whose viewer is going away.
      this._directionsShellModule?.attachShellServices?.(null);
      this._directionsShellModule = null;
      return;
    }
    const directions = this._dataManager.layers?.get('directions')?.module;
    if (this._directionsShellModule !== directions) {
      this._directionsShellModule?.attachShellServices?.(null);
      this._directionsShellModule = null;
    }
    if (typeof directions?.attachShellServices !== 'function') return;
    this._directionsShellModule = directions;
    directions.attachShellServices({
      runNavigation: (navigate) =>
        this.runImmediateNavigation('route', navigate),
      floorFn: (lat, lon) => this.services.cachedGroundFloor(lat, lon),
      warmFn: (cells) => this.services.warmGroundFloor(cells),
      showToast: (message) => this._showToast(message),
    });
  }

  /**
   * Tracking-persistence UI feedback (configurable, see
   * src/data/trackingPersistence.js): every layer's refresh-restore latch
   * re-tracks with `origin: 'refresh-restore'` on success, or fires the
   * cleared event with `reason: 'refresh-expired'` on confirmed
   * disappearance (both flow through the same awareness-event channel
   * `_persistAwarenessSelection` already listens on, below). This is
   * deliberately separate from that method — durable-state persistence and
   * transient UI notices are different concerns, and a refresh-restore's
   * passive origin is intentionally excluded from durable state there.
   * @param {CustomEvent} event
   * @param {boolean} cleared
   */
  _handleRefreshTrackingNotice(event, cleared) {
    const detail = event?.detail || {};
    const label = String(detail.label || 'target').trim() || 'target';
    if (!cleared && detail.origin === 'refresh-restore') {
      this._feedback._showGlobalStatusNotice('TRACKING RESTORED', {
        state: 'complete',
        detail: label,
      });
      return;
    }
    if (cleared && detail.reason === 'refresh-expired') {
      this._feedback._showGlobalStatusNotice('TRACKING LOST', {
        state: 'error',
        detail: `${label} no longer detected`,
      });
    }
  }

  _persistAwarenessSelection(event, cleared = false) {
    if (!this._dataManager) return;
    const origin = String(event?.detail?.origin || 'programmatic');
    if (!isExplicitLayerStateOrigin(origin)) return;
    const layerId = String(event?.detail?.layerId || '');
    const config = {
      flights: {
        key: 'selectedFlightsTrackingId',
        normalize: (value) =>
          String(value ?? '')
            .trim()
            .toLowerCase() || null,
      },
      military: {
        key: 'selectedMilitaryTrackingId',
        normalize: (value) =>
          String(value ?? '')
            .trim()
            .toLowerCase() || null,
      },
      satellites: {
        key: 'selectedSatTrackingId',
        normalize: (value) => {
          const candidate = Number(value);
          return Number.isFinite(candidate) && candidate > 0
            ? Math.trunc(candidate)
            : null;
        },
      },
    }[layerId];
    if (!config) return;
    const selectedValue = cleared ? null : config.normalize(event?.detail?.id);
    if (cleared || selectedValue === null) {
      this._dataManager.adoptLayerParams?.(
        layerId,
        {
          [config.key]: selectedValue,
        },
        { origin },
      );
      return;
    }
    // A direct selection promotes a Context-owned tracker dependency into
    // durable visibility before its selected ID is normalized. Context exit
    // also keeps this adopted layer instead of tearing down the user's track.
    const visibilityAdopted = this._dataManager.adoptLayerVisibility?.(
      layerId,
      true,
      { origin, adoptedFromSelection: true },
    );
    if (visibilityAdopted === false) return;
    // Clear the prior family before publishing the replacement. Otherwise the
    // coordinator briefly sees two IDs and correctly treats them as an
    // ambiguous incoming state, which would discard the new durable target.
    for (const [otherLayerId, otherKey] of [
      ['flights', 'selectedFlightsTrackingId'],
      ['military', 'selectedMilitaryTrackingId'],
      ['satellites', 'selectedSatTrackingId'],
    ]) {
      if (otherLayerId === layerId) continue;
      this._dataManager.setLayerParams(
        otherLayerId,
        { [otherKey]: null },
        { origin },
      );
    }
    this._dataManager.adoptLayerParams?.(
      layerId,
      {
        [config.key]: selectedValue,
      },
      { origin },
    );
  }

  attachDataManager(dataManager) {
    if (this._disposed) return;
    this._dataManager = dataManager || null;
    this.hud.attachDataManager(this._dataManager);
    this._updateTrafficSyncChip();
    if (this._dataManagerUnsubscribe) {
      this._dataManagerUnsubscribe();
      this._dataManagerUnsubscribe = null;
    }
    this._contextControls.connect(this._dataManager);
    if (typeof this._dataManager?.subscribe === 'function') {
      this._dataManagerUnsubscribe = this._dataManager.subscribe((change) => {
        this._feedback._loadingFeedbackEvent = change;
        this._updateGlobalLoadingFeedback(performance.now());
      });
    }
    this._updateGlobalLoadingFeedback(performance.now());
    this._syncContextModeButtons();
    this._cctvControls.connect();
    this._radioControls.connect();
    this._connectDirectionsCamera();
    if (!this._awarenessSelectedHandler) {
      this._awarenessSelectedHandler = (event) => {
        this._persistAwarenessSelection(event, false);
        this._handleRefreshTrackingNotice(event, false);
      };
      this._awarenessClearedHandler = (event) => {
        this._persistAwarenessSelection(event, true);
        this._handleRefreshTrackingNotice(event, true);
      };
      window.addEventListener(
        'gev:awareness-subject-selected',
        this._awarenessSelectedHandler,
      );
      window.addEventListener(
        'gev:awareness-subject-cleared',
        this._awarenessClearedHandler,
      );
      // Vessels are a selectable-but-not-camera-tracked layer, so they publish
      // through contextStore.js's separate entity-* lane instead of the
      // tracking layers' awareness-subject-* lane (see that file's header
      // comments). Tracking-persistence restore/expiry notices still need to
      // reach the SAME UI feedback, so listen here too — durable-state
      // persistence (_persistAwarenessSelection) does not apply to vessels
      // and is deliberately not called from these two handlers.
      this._entitySelectedHandler = (event) =>
        this._handleRefreshTrackingNotice(event, false);
      this._entityClearedHandler = (event) =>
        this._handleRefreshTrackingNotice(event, true);
      window.addEventListener('gev:entity-selected', this._entitySelectedHandler);
      window.addEventListener(
        'gev:entity-selection-cleared',
        this._entityClearedHandler,
      );
    }
    this._shareRestoration.connect(this._dataManager);
  }
  stop() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._awarenessSelectedHandler) {
      window.removeEventListener(
        'gev:awareness-subject-selected',
        this._awarenessSelectedHandler,
      );
      this._awarenessSelectedHandler = null;
    }
    if (this._awarenessClearedHandler) {
      window.removeEventListener(
        'gev:awareness-subject-cleared',
        this._awarenessClearedHandler,
      );
      this._awarenessClearedHandler = null;
    }
    if (this._entitySelectedHandler) {
      window.removeEventListener('gev:entity-selected', this._entitySelectedHandler);
      this._entitySelectedHandler = null;
    }
    if (this._entityClearedHandler) {
      window.removeEventListener(
        'gev:entity-selection-cleared',
        this._entityClearedHandler,
      );
      this._entityClearedHandler = null;
    }

    this._removeCctvRequestFocusListener?.();
    this._removeCctvRequestFocusListener = null;
    this._cctvRequestFocusHandler = null;
    this._removeWorldRequestFocusListener?.();
    this._removeWorldRequestFocusListener = null;
    this._worldRequestFocusHandler = null;
    this._navigationOwnerChangedRemover?.();
    this._navigationOwnerChangedRemover = null;
    this._removeNavigationAuthorityListener?.();
    this._removeNavigationAuthorityListener = null;
  }
  disconnect() {
    this._dataManagerUnsubscribe?.();
    this._dataManagerUnsubscribe = null;
    this._directionsShellModule?.attachShellServices?.(null);
    this._directionsShellModule = null;
    this._dataManager = null;
  }
}
