import { createSpeakHandler } from './speak.js';

/**
 * Vite plugin: local Piper text-to-speech backend for the fully-local voice
 * fallback (see src/voice/localVoiceFallback.js), used automatically when
 * the OpenAI Realtime connection is unavailable. Entirely optional and
 * entirely local — no API key, no cloud call, no cost. Mounted
 * unconditionally like the other local proxies; the handler degrades to a
 * clear ok:false error when Piper isn't installed or GEV_PIPER_MODEL isn't
 * set, the same way Ollama's handlers degrade when unconfigured.
 */
function piperSpeechProxy({ bin, modelPath, timeoutMs } = {}) {
  function install(middlewares) {
    middlewares.use(
      '/api/piper/speak',
      createSpeakHandler({ bin, modelPath, timeoutMs }),
    );
  }

  return {
    name: 'piper-speech-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export { piperSpeechProxy };
