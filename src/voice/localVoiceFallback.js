import { GEV_ACTION_SCHEMAS } from './actionSchemas.js';
import {
  cleanTranscript,
  classifyPhatic,
  normalizeCall,
} from './localTranscript.js';
import {
  INFORMATIONAL_TOOLS,
  clarifyingQuestion,
  createPhrasebook,
  describeResult,
  joinSteps,
  situationPhrase,
} from './localVoicePhrases.js';

/**
 * The fully-local voice fallback, activated automatically when the OpenAI
 * Realtime connection fails (see GevRealtimeController's onFatalVoiceError
 * hook in realtimeController.js): browser SpeechRecognition for input, the
 * local Ollama model (already used for semantic_query) for picking a tool,
 * the SAME action runner the cloud path uses for execution, and local Piper
 * TTS for the spoken response — so a rate-limited/offline cloud connection
 * degrades to a reduced-capability assistant instead of silence.
 *
 * A curated tool subset rather than the full ~30-tool Realtime schema — a
 * local instruct model's function-calling reliability drops as the tool
 * list grows. Widened from an original 7 to these 15 after testing showed
 * the improved fuzzy-tolerant prompt (server/providers/ollama/intent.js)
 * held accuracy at this size on qwen2.5:3b-instruct, matching a 7B model on
 * 11/12 messy test phrases at a third of the latency — still covering the
 * large majority of practical voice commands (navigation, selection,
 * tracking, layers, context panels, and querying loaded data).
 * @module voice/localVoiceFallback
 */

/** name → short description. Parameters are pulled from GEV_ACTION_SCHEMAS. */
const FALLBACK_TOOL_DESCRIPTIONS = {
  fly_to_location:
    'Fly the camera to a known city, place name, or explicit latitude/longitude.',
  select_nearest_aircraft:
    'Answer "what is the closest / nearest plane": select and focus the single nearest aircraft (regular flights or military) to the camera, without following it.',
  adjust_camera_zoom:
    'Zoom the camera by a relative amount. direction "in" = closer, zoom in. direction "out" = back up, back away, pull back, farther, zoom out.',
  zoom_to_globe: 'Pull the camera all the way out to a full-Earth view.',
  set_layer_visibility:
    'Turn one data layer on or off — flights, ships, military, traffic, satellites, fires, and similar.',
  set_context_mode:
    'Switch the side context panel to a focus mode — contacts, flights, space missions, or off.',
  get_entity_context:
    'Get details about the currently selected entity, or a summary of what is visible nearby.',
  get_current_view_state:
    'Report where the camera is right now (position and altitude) and what, if anything, is being tracked.',
  track_entity:
    'Follow ONE specific aircraft, ship, or satellite the operator names — by callsign, registration, or name. Needs a name; not for "the closest plane".',
  stop_tracking:
    'Stop following/tracking whatever entity is currently tracked.',
  frame_overhead:
    'Snap/point the camera to a top-down overhead view centered on nearby flights, military aircraft, satellites, or vessels (ships/boats). Use this for "show me the ships/planes/satellites" or any request to look down at or over something.',
  move_camera:
    'Pan, tilt, rotate, or orbit the camera sideways or up/down in a direction, or stop ongoing camera motion. Not for zooming in or out.',
  analyst_query:
    'Answer "how many", "which", "nearest", "fastest", "highest" questions about flights, planes, military aircraft, ships, fires or earthquakes currently on the map.',
  nearby_vehicles:
    'ONLY for cars, trucks and road traffic on the ground near the camera. Never for aircraft or ships — use analyst_query to count those, or frame_overhead to look at them.',
  search_news: 'Search recent news about the current location or a topic.',
};

export function curatedTools() {
  const byName = new Map(
    GEV_ACTION_SCHEMAS.map((schema) => [schema.name, schema]),
  );
  return Object.entries(FALLBACK_TOOL_DESCRIPTIONS)
    .map(([name, description]) => {
      const schema = byName.get(name);
      return schema
        ? { name, description, parameters: schema.parameters }
        : null;
    })
    .filter(Boolean);
}

/**
 * Bound a tool result before it is sent to the local model: depth-limited,
 * arrays cut to a handful of entries, long strings shortened. A full analyst
 * payload or view-state dump would blow the request size limit and slow the
 * spoken answer without making it any better.
 */
export function boundForReply(value, depth = 0) {
  if (typeof value === 'string') return value.slice(0, 160);
  if (Array.isArray(value)) {
    return depth >= 3
      ? []
      : value.slice(0, 5).map((item) => boundForReply(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    if (depth >= 3) return {};
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== null && item !== undefined) {
        out[key] = boundForReply(item, depth + 1);
      }
    }
    return out;
  }
  return value;
}

/**
 * A short factual note of what happened, kept as conversation memory. Names the
 * specific contact when there is one, because that is what a follow-up like
 * "follow that one" needs to resolve against.
 */
function outcomeOf(result) {
  if (!result || result.ok === false) {
    return `failed: ${String(result?.error || 'unknown').slice(0, 80)}`;
  }
  const first = result.items?.[0];
  const subject =
    first?.callsign || first?.label || first?.name || result.label;
  if (Number.isFinite(result.count)) {
    return subject
      ? `count ${result.count}; nearest ${subject}`
      : `count ${result.count}`;
  }
  return String(subject || 'ok').slice(0, 80);
}

const HISTORY_TURNS = 4;
// Enough for a small local model to phrase a sentence, short enough that the
// operator is not left in silence: past this the template answer is used.
const REPLY_TIMEOUT_MS = 4500;

function speechRecognitionCtor() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

// Errors where retrying immediately can never succeed and would spin the loop.
const FATAL_RECOGNITION_ERRORS = new Set([
  'not-allowed',
  'service-not-allowed',
  'audio-capture',
]);

/** Own the local fallback's listen → understand → run → speak loop. */
export class LocalVoiceFallback {
  constructor({
    runner,
    onStatus = null,
    // A bare `fetch` reference throws "Illegal invocation" once stored on
    // `this` and called as `this.fetchImpl(...)` — that method-style call
    // sets `this` inside native fetch to the LocalVoiceFallback instance,
    // and fetch requires it to be the window/global scope. Wrapped the same
    // way realtimeBackend.js already does for its own transport defaults.
    fetchImpl = (...args) => fetch(...args),
    phrasebook = createPhrasebook(),
    replyTimeoutMs = REPLY_TIMEOUT_MS,
  } = {}) {
    if (typeof runner !== 'function') {
      throw new TypeError('LocalVoiceFallback requires an action runner');
    }
    this.runner = runner;
    this.onStatus = onStatus;
    this.fetchImpl = fetchImpl;
    this.phrasebook = phrasebook;
    this.replyTimeoutMs = replyTimeoutMs;
    this.tools = curatedTools();
    this.toolsByName = new Map(this.tools.map((tool) => [tool.name, tool]));
    this.active = false;
    this.recognition = null;
    // True from "the operator finished speaking" until we are done answering.
    // The microphone stays closed for all of it, so the assistant never hears
    // (and then acts on) its own voice.
    this.busy = false;
    this.audio = null;
    this.history = [];
    this.lastSpoken = '';
    this.unrecognizedStreak = 0;
  }

  get available() {
    return typeof speechRecognitionCtor() === 'function';
  }

  _setStatus(state, detail) {
    try {
      this.onStatus?.(state, detail);
    } catch (error) {
      console.error('[GEV local voice fallback] status hook failed', error);
    }
  }

  _say(kind, options) {
    return situationPhrase(this.phrasebook, kind, options);
  }

  /**
   * Enter fallback mode: announce it, then start listening for a command.
   * @param {{announce?: boolean}} [options] - `announce: false` resumes
   *   straight into listening with no spoken line — for a manual mic-button
   *   restart after the user paused LOCAL, where "switching to local
   *   fallback" would be a stale, misleading thing to say again.
   */
  async activate({ announce = true } = {}) {
    if (this.active) return;
    this.active = true;
    if (!this.available) {
      this.active = false;
      this._setStatus(
        'error',
        'Local fallback has no speech recognition in this browser',
      );
      if (announce) await this._speak(this._say('no-recognition'));
      return;
    }
    if (!announce) {
      this._setStatus('listening', 'Local fallback listening');
      this._listenOnce();
      return;
    }
    this.busy = true;
    try {
      await this._speak(this._say('takeover'));
    } finally {
      this.busy = false;
      if (this.active) this._listenOnce();
    }
  }

  deactivate() {
    this.active = false;
    this.busy = false;
    this.recognition?.stop?.();
    this.recognition = null;
    // Cut off a sentence that is still playing — the operator just switched us off.
    try {
      this.audio?.pause?.();
    } catch {
      // Audio teardown is best-effort.
    }
    this.audio = null;
    this._setStatus('idle', 'Local fallback off');
  }

  _listenOnce() {
    if (!this.active || this.busy) return;
    const Ctor = speechRecognitionCtor();
    if (!Ctor) {
      this._setStatus(
        'error',
        'Local fallback has no speech recognition in this browser',
      );
      return;
    }
    const recognition = new Ctor();
    this.recognition = recognition;
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    const resume = (delayMs = 0) => {
      if (!this.active || this.recognition !== recognition) return;
      if (delayMs) setTimeout(() => this._listenOnce(), delayMs);
      else this._listenOnce();
    };
    recognition.onresult = (event) => {
      const transcript = event.results?.[0]?.[0]?.transcript;
      if (!transcript) return;
      // Claim the turn synchronously: onend fires right after onresult, and
      // must not reopen the mic while we are still thinking or speaking.
      this.busy = true;
      void this._handleTranscript(transcript);
    };
    // 'no-speech'/mic blips are routine — keep listening through them rather
    // than dropping out of fallback mode on the first quiet moment. Errors
    // that can never succeed on retry stop the loop instead of spinning it,
    // and a network hiccup (browser recognition is a remote service in some
    // browsers) backs off instead of hammering.
    recognition.onerror = (event) => {
      if (FATAL_RECOGNITION_ERRORS.has(event?.error)) {
        this.active = false;
        this._setStatus(
          'error',
          'Microphone unavailable — check the browser permission',
        );
        return;
      }
      if (this.busy) return;
      resume(event?.error === 'network' ? 1500 : 0);
    };
    recognition.onend = () => {
      if (!this.busy) resume();
    };
    this._setStatus('listening', 'Local fallback listening');
    recognition.start();
  }

  _remember(said, did, outcome) {
    this.history.push({ said, did, outcome });
    if (this.history.length > HISTORY_TURNS) this.history.shift();
  }

  /**
   * One full turn. Holds `busy` for its whole length and reopens the
   * microphone only when the reply has finished playing.
   */
  async _handleTranscript(raw) {
    if (!this.active) {
      this.busy = false;
      return;
    }
    this.busy = true;
    try {
      const text = cleanTranscript(raw);
      this._setStatus('thinking', `Heard: "${String(raw).trim()}"`);
      const phatic = classifyPhatic(text);
      if (phatic) {
        await this._speak(
          phatic === 'repeat'
            ? this.lastSpoken || this._say('nothing-to-repeat')
            : this._say(phatic),
        );
        return;
      }
      const understood = await this._interpret(text);
      if (understood.unavailable) {
        await this._speak(this._say('model-down'));
        return;
      }
      const lines = [];
      const did = [];
      let outcome = '';
      for (const proposed of understood.calls) {
        const checked = normalizeCall(proposed, this.toolsByName);
        if (!checked.ok) {
          // Missing a required value: ask for exactly that, then stop — running
          // the remaining steps out of order would be worse than pausing.
          if (checked.reason === 'missing') {
            lines.push(
              clarifyingQuestion(
                this.phrasebook,
                checked.call.name,
                checked.missing,
              ),
            );
            did.push(`asked for ${checked.missing[0]}`);
            break;
          }
          continue;
        }
        const { name, arguments: args } = checked.call;
        const result = await this._run(name, args);
        lines.push(await this._describe(text, name, args, result));
        did.push(`${name}(${JSON.stringify(args)})`);
        outcome = outcomeOf(result);
        if (result?.ok === false) break;
      }
      if (!lines.length) {
        if (understood.reply) {
          this.unrecognizedStreak = 0;
          this._remember(text, '', '');
          await this._speak(understood.reply);
          return;
        }
        this.unrecognizedStreak += 1;
        await this._speak(
          this._say('unrecognized', { streak: this.unrecognizedStreak }),
        );
        return;
      }
      this.unrecognizedStreak = 0;
      this._remember(text, did.join(', '), outcome);
      await this._speak(joinSteps(lines));
    } catch (error) {
      console.error('[GEV local voice fallback]', error);
      await this._speak(this._say('error'));
    } finally {
      this.busy = false;
      if (this.active) this._listenOnce();
    }
  }

  /** A runner that throws (unknown layer, bad state) is an answer, not a crash. */
  async _run(name, args) {
    try {
      return await this.runner(name, args, {});
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Words for a result. Actions get an instant, varied template. Informational
   * answers are phrased by the local model from the real data, then discarded
   * in favour of the template if the model is slow, down, or made up a figure.
   * Anything carrying a "widened the view" / "last known position" caveat
   * always uses the template, which states that caveat itself.
   */
  async _describe(request, name, args, result) {
    const template = describeResult(this.phrasebook, name, result, args);
    if (
      result?.ok === false ||
      !INFORMATIONAL_TOOLS.has(name) ||
      result?.zoomRetried ||
      result?.usedHistoricalFallback
    ) {
      return template;
    }
    return (await this._composeReply(request, result)) || template;
  }

  async _composeReply(request, result) {
    try {
      const response = await this.fetchImpl('/api/ollama/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(this.replyTimeoutMs),
        body: JSON.stringify({ request, result: boundForReply(result) }),
      });
      const data = await response.json().catch(() => null);
      return response.ok && data?.ok && data.reply ? String(data.reply) : null;
    } catch {
      return null;
    }
  }

  /**
   * Ask the local model what the operator wants.
   * @returns {Promise<{calls: {name: string, arguments: object}[],
   *   reply: string|null, unavailable?: boolean}>}
   */
  async _interpret(text) {
    let data = null;
    let ok = false;
    try {
      const response = await this.fetchImpl('/api/ollama/intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          tools: this.tools,
          history: this.history,
        }),
      });
      data = await response.json().catch(() => null);
      ok = Boolean(response.ok && data?.ok);
    } catch {
      ok = false;
    }
    if (!ok) return { calls: [], reply: null, unavailable: true };
    // Older servers answered with a single name/arguments pair.
    const calls = Array.isArray(data.calls)
      ? data.calls
      : data.name
        ? [{ name: data.name, arguments: data.arguments || {} }]
        : [];
    return { calls, reply: data.reply || null };
  }

  /** Speak via local Piper TTS; degrades to a status-only update if Piper
   *  isn't installed/configured. Resolves when playback has finished. */
  async _speak(text) {
    if (!text) return;
    this.lastSpoken = text;
    this._setStatus('speaking', text);
    let url = null;
    try {
      const response = await this.fetchImpl('/api/piper/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!response.ok || !this.active) return;
      const blob = await response.blob();
      url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this.audio = audio;
      await new Promise((resolve) => {
        audio.addEventListener('ended', resolve, { once: true });
        audio.addEventListener('error', resolve, { once: true });
        audio.addEventListener('pause', resolve, { once: true });
        audio.play().catch(resolve);
      });
    } catch (error) {
      console.error('[GEV local voice fallback] speak failed', error);
    } finally {
      if (url) URL.revokeObjectURL(url);
      this.audio = null;
    }
  }
}
