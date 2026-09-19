import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRequestBody } from '../common/request.js';
import {
  PIPER_BIN_DEFAULT,
  PIPER_MODEL_PATH_DEFAULT,
  PIPER_REQUEST_TIMEOUT_MS,
  PIPER_MAX_TEXT_LENGTH,
  PIPER_SENTENCE_SILENCE_DEFAULT,
  PIPER_PROSODY_ENV,
} from './constants.js';
import { createAudioCache } from './audioCache.js';
import { prepareSpeechText } from './speechText.js';

/**
 * Prosody flags from the environment. Only finite, positive numbers are
 * forwarded — an unparsable value falls back to the voice's own trained
 * default rather than reaching the Piper CLI as garbage.
 * @returns {string[]} Flat argv fragment, e.g. ['--sentence_silence', '0.35'].
 */
function prosodyArgsFromEnv(env = process.env) {
  const args = [];
  const silence = Number(env.GEV_PIPER_SENTENCE_SILENCE);
  args.push(
    '--sentence_silence',
    String(
      Number.isFinite(silence) && silence >= 0 && env.GEV_PIPER_SENTENCE_SILENCE
        ? silence
        : PIPER_SENTENCE_SILENCE_DEFAULT,
    ),
  );
  for (const [envName, flag] of PIPER_PROSODY_ENV) {
    const value = Number(env[envName]);
    if (env[envName] && Number.isFinite(value) && value > 0) {
      args.push(flag, String(value));
    }
  }
  return args;
}

/**
 * Run one Piper synthesis: pipe `text` to the CLI's stdin, read the WAV back
 * from a real temp file. `--output_file -` (and stdout's own default) is
 * documented as "write to stdout", but the newer Python piper-tts rewrite
 * silently writes zero bytes there in WAV mode (only --output-raw actually
 * streams) — a real file path is the one thing that works across piper
 * builds, so that's what we use instead of trusting stdout. Uses spawn
 * (never a shell) so text can never reach a shell interpreter — args are
 * passed directly to execve.
 * @returns {Promise<Buffer>} Complete WAV file bytes.
 */
async function synthesizeOnce(
  text,
  { bin, modelPath, timeoutMs, prosodyArgs = [] },
) {
  const outputPath = join(tmpdir(), `gev-piper-${randomUUID()}.wav`);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        bin,
        ['--model', modelPath, '--output_file', outputPath, ...prosodyArgs],
        {
          stdio: ['pipe', 'ignore', 'pipe'],
        },
      );
      const stderr = [];
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error('Piper synthesis timed out'));
      }, timeoutMs);

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // ENOENT means the binary isn't installed/on PATH — the same
        // "not configured, degrade cleanly" shape as Ollama being unreachable.
        reject(
          error?.code === 'ENOENT'
            ? new Error(`Piper binary not found: ${bin}`)
            : error,
        );
      });
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          reject(
            new Error(
              `Piper exited with code ${code}: ${Buffer.concat(stderr).toString('utf8').slice(0, 300)}`,
            ),
          );
          return;
        }
        resolve();
      });
      child.stdin.write(text);
      child.stdin.end();
    });
    const wav = await readFile(outputPath);
    if (!wav.length) throw new Error('Piper produced no audio');
    return wav;
  } finally {
    await unlink(outputPath).catch(() => {});
  }
}

/**
 * Node middleware factory: POST /api/piper/speak.
 * Body: { text: string }. Response: audio/wav bytes, or a JSON
 * { ok:false, error } when Piper isn't installed/configured — the same
 * degrade-cleanly contract as the Ollama handlers.
 */
function createSpeakHandler({
  bin = process.env.GEV_PIPER_BIN || PIPER_BIN_DEFAULT,
  modelPath = process.env.GEV_PIPER_MODEL || PIPER_MODEL_PATH_DEFAULT,
  timeoutMs = PIPER_REQUEST_TIMEOUT_MS,
  prosodyArgs = prosodyArgsFromEnv(),
  cache = createAudioCache(),
  synthesize = synthesizeOnce,
} = {}) {
  // The cache key covers everything that changes the audio, so a model or
  // prosody change can never serve stale speech.
  const cacheScope = [modelPath, ...prosodyArgs].join('\u0000');
  return async function handlePiperSpeak(req, res) {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    if (!modelPath) {
      res.statusCode = 501;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          ok: false,
          error:
            'Piper is not configured — set GEV_PIPER_MODEL to a downloaded .onnx voice model path.',
        }),
      );
      return;
    }
    try {
      const body = await readRequestBody(req, 8 * 1024);
      const { text } = JSON.parse(body || '{}');
      // Normalize the written form into what a person would say (units,
      // callsigns, symbols, markdown) before Piper ever sees it.
      const safeText = prepareSpeechText(text, {
        maxLength: PIPER_MAX_TEXT_LENGTH,
      });
      if (!safeText) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: 'text is required' }));
        return;
      }
      const cacheKey = `${cacheScope}\u0000${safeText}`;
      let wav = cache.get(cacheKey);
      const cacheHit = Boolean(wav);
      if (!wav) {
        wav = await synthesize(safeText, {
          bin,
          modelPath,
          timeoutMs,
          prosodyArgs,
        });
        cache.set(cacheKey, wav);
      }
      res.statusCode = 200;
      res.setHeader('X-GEV-Piper-Cache', cacheHit ? 'hit' : 'miss');
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Length', String(wav.length));
      res.end(wav);
    } catch (error) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          ok: false,
          error: error?.message || 'Piper synthesis failed',
        }),
      );
    }
  };
}

export { createSpeakHandler, prosodyArgsFromEnv };
