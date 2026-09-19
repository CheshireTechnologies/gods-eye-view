import {
  isAnalystZoomRetryEnabled,
  setAnalystZoomRetryEnabled,
} from '../data/analystZoomRetry.js';

/**
 * The "Auto-Retry" display-controls toggle for the analyst zoom-retry
 * feature (src/data/analystZoomRetry.js / analystRetryPolicy.js): whether an
 * empty "nearest flight from <origin>" query should pull the camera back and
 * retry once, then fall back to the last-known sighting. Self-contained —
 * owns its own click listener rather than depending on a shell-wide
 * generic-toggle dispatcher, since this preference lives entirely in
 * localStorage with no layer/camera coupling of its own.
 */
export class AnalystRetryToggle {
  constructor({
    button = document.getElementById('analyst-zoom-retry-toggle'),
  } = {}) {
    this._button = button;
    this._onClick = () => {
      const next = !isAnalystZoomRetryEnabled();
      setAnalystZoomRetryEnabled(next);
      this._sync();
    };
    this._button?.addEventListener('click', this._onClick);
    this._sync();
  }

  _sync() {
    const enabled = isAnalystZoomRetryEnabled();
    this._button?.classList.toggle('active', enabled);
    this._button?.setAttribute('aria-pressed', String(enabled));
  }

  destroy() {
    this._button?.removeEventListener('click', this._onClick);
  }
}
