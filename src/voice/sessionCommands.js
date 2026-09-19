import { createVoiceControl } from './control.js';
import { createVoiceSession } from './session.js';

/** Bind common controls to a supplied voice-session adapter. */
export function createVoiceCommands({
  runner,
  dataManager,
  annotations = null,
  createSession,
  createController,
  backend,
  signal,
  debugSink,
  createControl = createVoiceControl,
  onFatalVoiceError,
  localFallback = null,
}) {
  window.__gevVoiceCommands?.stop?.({ removeUi: true });
  const ui = createControl({ reset: true });
  // LOCAL is the primary voice path now, not a fallback of last resort — the
  // pill button's job is to let the user explicitly opt INTO cloud (e.g. once
  // OpenAI billing is sorted), not the other way around.
  const syncFallbackButton = () => {
    if (!ui.fallbackButton) return;
    const cloudLive = session.isActive() && !localFallback?.active;
    ui.fallbackButton.setAttribute('aria-pressed', String(!cloudLive));
    ui.fallbackButton.textContent = cloudLive ? 'LOCAL' : 'CLOUD';
    ui.fallbackButton.title = cloudLive
      ? 'Switch to local Piper voice'
      : 'Switch to cloud OpenAI voice — bills your OpenAI account';
  };
  // Sticky once local is running: the mic button below resumes LOCAL on every
  // subsequent press instead of retrying CLOUD. Without this, turning LOCAL
  // off with the mic button just to pause listening meant the very next press
  // fell through to a doomed cloud reconnect — which fails, auto-reactivates
  // LOCAL again, and re-speaks the "switching to local" line. Defaults true:
  // LOCAL is what the mic button starts unless CLOUD is explicitly chosen.
  let preferLocal = true;
  const activateFallback = ({ announce = true } = {}) => {
    if (!localFallback) return;
    preferLocal = true;
    if (session.isActive()) session.stop();
    void localFallback.activate({ announce });
    syncFallbackButton();
  };
  const deactivateFallback = ({ reconnect = false } = {}) => {
    if (!localFallback) return;
    if (reconnect) preferLocal = false;
    localFallback.deactivate();
    syncFallbackButton();
    if (reconnect) void session.start({ pushToTalk: false });
  };
  const fallbackButtonHandler = () => {
    if (localFallback?.active) deactivateFallback({ reconnect: true });
    else if (session.isActive()) {
      session.stop();
      activateFallback({ announce: false });
    } else {
      preferLocal = false;
      void session.start({ pushToTalk: false });
    }
  };
  const session = createVoiceSession({
    runner,
    signal,
    createAdapter: (hooks) =>
      createSession({
        ...hooks,
        runner,
        ui,
        dataManager,
        backend,
        debugSink,
        createController,
        onFatalVoiceError: (record) => {
          onFatalVoiceError?.(record);
          activateFallback();
        },
        isLocalFallbackActive: () => Boolean(localFallback?.active),
        radioLayer: dataManager?.layers?.get('radio')?.module || null,
      }),
  });
  const adapter = session.adapter;
  const capabilities = adapter.capabilities || {};
  if (ui.tierButton) ui.tierButton.hidden = !capabilities.costControls;
  if (ui.costValue) ui.costValue.hidden = !capabilities.costControls;
  if (!capabilities.pushToTalk) {
    ui.button.setAttribute('aria-label', 'Toggle voice control');
    if (ui.helpDetail) ui.helpDetail.textContent = 'Activate to toggle voice';
  }
  // Retain the existing controller's inspection surface for browser tools.
  const controls = adapter.controller || session;
  controls.session = session;
  const updateStatus = session.subscribe((event) => {
    if (event.type !== 'state') return;
    ui.root.dataset.status = event.state;
    ui.status.textContent =
      event.state === 'idle' ? 'OFF' : event.state.toUpperCase();
    ui.detail.textContent =
      event.detail || (event.state === 'idle' ? 'Voice off' : 'Voice active');
    ui.button.setAttribute('aria-pressed', String(session.isActive()));
    if (ui.errorDetail)
      ui.errorDetail.textContent =
        event.state === 'error'
          ? event.detail || 'Voice could not be started.'
          : '';
    if (event.state === 'error') ui.root.classList?.remove('error-dismissed');
    syncFallbackButton();
  });
  const annotationUnsubscribe = annotations?.onOutlineEvent?.((event) => {
    session.sendMapEvent({ type: 'map_annotation_outline', ...event });
  });
  const buttonHandler = () => {
    if (adapter.ignoreButtonClick?.()) return;
    // While local is active this button owns ITS listening state only — it
    // must never fall through to the cloud branch below, or every mic press
    // while offline/rate-limited/out-of-credits silently kicks off another
    // doomed cloud reconnect attempt right after the user chose LOCAL.
    if (localFallback?.active) {
      deactivateFallback();
      return;
    }
    if (session.isActive()) session.stop();
    else if (preferLocal && localFallback)
      activateFallback({ announce: false });
    else void session.start({ pushToTalk: false });
  };
  ui.button.addEventListener('click', buttonHandler);
  if (ui.fallbackButton) {
    ui.fallbackButton.hidden = !localFallback;
    if (localFallback) {
      syncFallbackButton();
      ui.fallbackButton.addEventListener('click', fallbackButtonHandler);
      // The cloud session's own subscribe handler above owns ui.root's
      // dataset.status while it's live; once a fatal error hands off here,
      // this becomes the only thing still writing to it. Without this the
      // panel — and the big error tray, keyed off [data-status='error'] —
      // stay stuck on the cloud session's last ('error') state forever, even
      // though the fallback underneath is listening and working fine.
      localFallback.onStatus = (state, detail) => {
        ui.root.dataset.status = state;
        ui.status.textContent = state === 'idle' ? 'OFF' : state.toUpperCase();
        ui.detail.textContent = detail || '';
        if (ui.errorDetail)
          ui.errorDetail.textContent = state === 'error' ? detail || '' : '';
        ui.root.classList.toggle('error-dismissed', state !== 'error');
      };
    }
  }
  session.signal.addEventListener(
    'abort',
    () => {
      ui.button.removeEventListener('click', buttonHandler);
      ui.fallbackButton?.removeEventListener('click', fallbackButtonHandler);
      annotationUnsubscribe?.();
      updateStatus();
      ui.root.remove();
    },
    { once: true },
  );
  if (session.disposed) {
    ui.button.removeEventListener('click', buttonHandler);
    ui.fallbackButton?.removeEventListener('click', fallbackButtonHandler);
    annotationUnsubscribe?.();
    updateStatus();
    ui.root.remove();
  } else adapter.bindControls?.();
  window.__gevVoiceCommands = controls;
  return controls;
}
