#!/usr/bin/env node
/**
 * Local, Ollama-powered coding assistant for this repo — a small "agentic
 * loop" (read files, search, propose full-file replacements) matching the
 * shape of how an AI pair programmer edits code, but entirely local: no API
 * key, no cloud call, no cost, same free/optional Ollama provider the
 * semantic_query voice tool uses.
 *
 * SAFETY MODEL (deliberate, not a placeholder to relax later):
 *   - The model NEVER writes to disk directly. It can only *propose* a full
 *     replacement for a file via the propose_edit tool; every proposal is
 *     diffed, syntax-checked where possible, and shown to a human who must
 *     approve it file-by-file before anything is written.
 *   - Scope is otherwise the whole repo (like asking Claude Code), except a
 *     small denylist this script itself enforces regardless of the
 *     instruction: .git/, node_modules/, dist/, .gev-cache/, .gev-logs/, and
 *     .env (the real one, not .env.example) — none of those are "the user's
 *     source", and a small local model has no business rewriting secrets,
 *     VCS internals, or generated output.
 *   - There is no non-interactive/auto-apply mode. This is deliberate: the
 *     whole point is a human reviews every change before it lands.
 *
 * Usage:
 *   npm run ai-edit -- "add a loading spinner to the CCTV panel"
 *   OLLAMA_EDIT_MODEL=qwen2.5:7b-instruct npm run ai-edit -- "..."
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { projectRoot } from './project-root.mjs';

const ROOT = projectRoot(import.meta.url);
const SCRATCH_DIR = path.join(ROOT, '.gev-cache', 'ai-edit-tmp');

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
// Code editing is a harder task than the narration/embeddings semantic_query
// uses, so this defaults to the larger pulled model rather than the 3b one.
const OLLAMA_EDIT_MODEL = process.env.OLLAMA_EDIT_MODEL || process.env.OLLAMA_CHAT_MODEL || 'qwen2.5:7b-instruct';

const MAX_ROUNDS = 16;
const MAX_READ_CHARS = 6000;
const MAX_LIST_ENTRIES = 400;
const MAX_SEARCH_MATCHES = 60;
const REQUEST_TIMEOUT_MS = 120_000;

// Directories never walked (listing/search noise) and never eligible to be
// re-created inside by a proposed edit path either.
const IGNORED_DIR_NAMES = new Set([
  'node_modules', '.git', 'dist', '.gev-cache', '.gev-logs', '.DS_Store',
  'screenshots', 'qa-shots', 'output', '.gstack', '3d-models',
]);

// Paths propose_edit refuses to touch, independent of the instruction.
const EDIT_DENYLIST = [
  /^\.git(\/|$)/,
  /^node_modules(\/|$)/,
  /^dist(\/|$)/,
  /^\.gev-cache(\/|$)/,
  /^\.gev-logs(\/|$)/,
  /^\.env$/,
];

function fail(message) {
  console.error(`[ai-edit] ${message}`);
  process.exit(1);
}

/** Resolve + validate a repo-relative path, rejecting escapes and denylisted targets. */
function resolveRepoPath(relPath, { forWrite = false } = {}) {
  const clean = String(relPath || '').trim().replace(/^\/+/, '');
  if (!clean) throw new Error('A path is required');
  const abs = path.resolve(ROOT, clean);
  const rel = path.relative(ROOT, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes the repo root: ${relPath}`);
  }
  if (forWrite && EDIT_DENYLIST.some((re) => re.test(rel))) {
    throw new Error(`Refusing to edit denylisted path: ${rel}`);
  }
  return { abs, rel };
}

async function listFiles(dirArg) {
  const { abs, rel } = resolveRepoPath(dirArg || '.');
  const out = [];
  async function walk(dir) {
    if (out.length >= MAX_LIST_ENTRIES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      out.push(`(error reading ${path.relative(ROOT, dir)}: ${error.message})`);
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (IGNORED_DIR_NAMES.has(entry.name)) continue;
      const entryAbs = path.join(dir, entry.name);
      const entryRel = path.relative(ROOT, entryAbs);
      if (entry.isDirectory()) {
        await walk(entryAbs);
      } else {
        out.push(entryRel);
      }
      if (out.length >= MAX_LIST_ENTRIES) {
        out.push(`... truncated at ${MAX_LIST_ENTRIES} entries`);
        return;
      }
    }
  }
  await walk(abs);
  return { dir: rel || '.', entries: out };
}

async function readRepoFile(pathArg) {
  const { abs, rel } = resolveRepoPath(pathArg);
  if (!existsSync(abs)) return { path: rel, error: 'File does not exist' };
  const raw = await readFile(abs, 'utf8').catch((error) => {
    throw new Error(`Could not read ${rel} as text: ${error.message}`);
  });
  const truncated = raw.length > MAX_READ_CHARS;
  return {
    path: rel,
    content: truncated ? `${raw.slice(0, MAX_READ_CHARS)}\n... (truncated, ${raw.length} chars total)` : raw,
    truncated,
    totalChars: raw.length,
  };
}

async function searchFiles(pattern, dirArg) {
  if (!pattern) throw new Error('A search pattern is required');
  const { abs: searchRoot } = resolveRepoPath(dirArg || '.');
  let regex;
  try {
    regex = new RegExp(pattern, 'i');
  } catch {
    // Fall back to a literal substring match if the pattern isn't valid regex.
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    regex = new RegExp(escaped, 'i');
  }
  const matches = [];
  async function walk(dir) {
    if (matches.length >= MAX_SEARCH_MATCHES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIR_NAMES.has(entry.name)) continue;
      const entryAbs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryAbs);
      } else {
        let text;
        try {
          text = await readFile(entryAbs, 'utf8');
        } catch {
          continue; // binary or unreadable — skip
        }
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            matches.push(`${path.relative(ROOT, entryAbs)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            if (matches.length >= MAX_SEARCH_MATCHES) return;
          }
        }
      }
    }
  }
  await walk(searchRoot);
  return { pattern, matches, truncated: matches.length >= MAX_SEARCH_MATCHES };
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files under a directory in the repo (recursive, bounded). Use this first to orient yourself.',
      parameters: {
        type: 'object',
        properties: { dir: { type: 'string', description: 'Directory relative to repo root, e.g. "src/ui". Omit or "." for repo root.' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the full current contents of one file, so any edit you propose is a complete, correct replacement.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path relative to repo root.' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search file contents for a regex or plain substring, returning matching file:line and the line text.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          dir: { type: 'string', description: 'Restrict the search to this directory. Defaults to repo root.' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_edit',
      description: "Stage a full replacement of one file's contents for human review. Call once per file you want to change. Nothing is written to disk until a human approves it — you are proposing, not applying.",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to repo root. Can be a new file.' },
          content: { type: 'string', description: 'The COMPLETE new file content — not a diff, not a snippet, not "... rest unchanged".' },
          description: { type: 'string', description: 'One sentence: what changed in this file and why.' },
        },
        required: ['path', 'content', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Call this when you are done proposing edits, or if you determine no change is needed. Always call this last.',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string', description: 'One or two sentences summarizing what you proposed and why, for the human reviewer.' } },
        required: ['summary'],
      },
    },
  },
];

const SYSTEM_PROMPT = [
  "You are a careful local coding assistant for the God's Eye View repo (a Cesium-based geospatial intelligence web app).",
  'You cannot write files directly — you can only read/search the repo, then call propose_edit with the COMPLETE new content of each file you want to change.',
  'Always read a file with read_file before proposing a change to it, so your replacement is complete and correct, not a guess.',
  'Prefer the smallest change that fulfills the request. Do not rewrite unrelated code, and do not add features nobody asked for.',
  'When you are done, call finish with a short summary. If you cannot find anything reasonable to change, call finish and say so — do not invent a change just to have done something.',
].join(' ');

async function ollamaChat(messages) {
  const response = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_EDIT_MODEL,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      stream: false,
      temperature: 0.1,
      options: { num_ctx: 8192 },
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Ollama chat request failed (${response.status}): ${text.slice(0, 300)}`);
  }
  const data = await response.json();
  const message = data?.choices?.[0]?.message;
  if (!message) throw new Error('Ollama returned no message');
  return message;
}

function parseToolArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { __parseError: true, raw: String(raw).slice(0, 500) };
  }
}

async function runAgentLoop(instruction) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: instruction },
  ];
  const proposals = new Map(); // rel path -> { content, description }
  let summary = '';
  let finished = false;

  for (let round = 0; round < MAX_ROUNDS && !finished; round++) {
    let message;
    try {
      message = await ollamaChat(messages);
    } catch (error) {
      console.error(`[ai-edit] Ollama request failed on round ${round + 1}: ${error.message}`);
      break;
    }
    messages.push(message);
    const toolCalls = message.tool_calls || [];
    if (!toolCalls.length) {
      // Plain text with no tool call — treat it as the model's final word.
      summary = message.content || summary;
      break;
    }
    for (const call of toolCalls) {
      const name = call.function?.name;
      const args = parseToolArgs(call.function?.arguments);
      const callId = call.id || `call_${randomUUID()}`;
      let result;
      try {
        if (args.__parseError) {
          result = { error: `Could not parse arguments as JSON: ${args.raw}` };
        } else if (name === 'list_files') {
          result = await listFiles(args.dir);
        } else if (name === 'read_file') {
          result = await readRepoFile(args.path);
        } else if (name === 'search_files') {
          result = await searchFiles(args.pattern, args.dir);
        } else if (name === 'propose_edit') {
          const { rel } = resolveRepoPath(args.path, { forWrite: true });
          proposals.set(rel, { content: String(args.content ?? ''), description: String(args.description || '') });
          result = { ok: true, staged: rel };
        } else if (name === 'finish') {
          finished = true;
          summary = args.summary || summary;
          result = { ok: true };
        } else {
          result = { error: `Unknown tool: ${name}` };
        }
      } catch (error) {
        result = { error: error.message };
      }
      messages.push({ role: 'tool', tool_call_id: callId, content: JSON.stringify(result).slice(0, MAX_READ_CHARS) });
    }
  }
  if (!finished && proposals.size === 0 && !summary) {
    console.warn('[ai-edit] Stopped without the model calling finish — it may need a more specific instruction, or a stronger OLLAMA_EDIT_MODEL.');
  }
  return { proposals, summary };
}

function syntaxCheck(rel, content) {
  if (!/\.(mjs|cjs|js)$/.test(rel)) return null;
  mkdirSync(SCRATCH_DIR, { recursive: true });
  const checkFile = path.join(SCRATCH_DIR, `check-${randomUUID()}.mjs`);
  try {
    writeFileSync(checkFile, content);
    execFileSync(process.execPath, ['--check', checkFile], { stdio: 'pipe' });
    return { ok: true };
  } catch (error) {
    const stderr = error.stderr ? error.stderr.toString() : error.message;
    return { ok: false, error: stderr.replace(checkFile, rel) };
  } finally {
    rmSync(checkFile, { force: true });
  }
}

function diffAgainstDisk(abs, rel, newContent) {
  mkdirSync(SCRATCH_DIR, { recursive: true });
  const newFile = path.join(SCRATCH_DIR, `new-${randomUUID()}.txt`);
  writeFileSync(newFile, newContent);
  const oldSide = existsSync(abs) ? abs : '/dev/null';
  try {
    // Custom -L labels so the diff shows the real repo-relative path instead
    // of the scratch temp-file path the new content was staged under.
    const out = execFileSync('diff', ['-u', '-L', `a/${rel}`, '-L', `b/${rel}`, oldSide, newFile], {
      encoding: 'utf8',
    });
    return out || '(no textual difference)';
  } catch (error) {
    // `diff` exits 1 when there ARE differences — that's normal, not a failure.
    if (typeof error.status === 'number' && error.status === 1) return error.stdout;
    return `(could not diff: ${error.message})`;
  } finally {
    rmSync(newFile, { force: true });
  }
}

async function reviewAndApply(proposals) {
  if (proposals.size === 0) {
    console.log('[ai-edit] No changes were proposed.');
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let applyAllRemaining = false;
  let applied = 0;
  try {
    let index = 0;
    for (const [rel, { content, description }] of proposals) {
      index += 1;
      const abs = path.resolve(ROOT, rel);
      console.log(`\n${'─'.repeat(72)}`);
      console.log(`[${index}/${proposals.size}] ${rel}${existsSync(abs) ? '' : ' (new file)'}`);
      console.log(`  ${description}`);
      const check = syntaxCheck(rel, content);
      if (check && !check.ok) {
        console.log(`  ⚠ SYNTAX ERROR in proposed content:\n${check.error.split('\n').map((l) => `    ${l}`).join('\n')}`);
      }
      console.log(diffAgainstDisk(abs, rel, content));
      let answer = applyAllRemaining ? 'y' : '';
      while (!applyAllRemaining && !['y', 'n', 'a', 'q'].includes(answer)) {
        answer = (await rl.question('  Apply this change? [y]es / [n]o / [a]ll remaining / [q]uit: ')).trim().toLowerCase();
      }
      if (answer === 'q') break;
      if (answer === 'a') applyAllRemaining = true;
      if (answer === 'n') continue;
      // y, or a-triggered/all-remaining
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      applied += 1;
      console.log(`  ✓ written`);
    }
  } finally {
    rl.close();
  }
  console.log(`\n[ai-edit] Applied ${applied}/${proposals.size} proposed change(s).`);
}

async function main() {
  const instruction = process.argv.slice(2).join(' ').trim();
  if (!instruction) {
    fail('Usage: npm run ai-edit -- "describe the change you want"');
  }
  let tagsResponse;
  try {
    tagsResponse = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
  } catch {
    fail(`Ollama is not reachable at ${OLLAMA_BASE_URL} — start it (e.g. \`ollama serve\`) and make sure ${OLLAMA_EDIT_MODEL} is pulled.`);
  }
  if (!tagsResponse.ok) fail(`Ollama at ${OLLAMA_BASE_URL} responded with ${tagsResponse.status}.`);

  console.log(`[ai-edit] Using ${OLLAMA_EDIT_MODEL} at ${OLLAMA_BASE_URL} — local, read/propose only, nothing is written without your approval.`);
  console.log(`[ai-edit] Instruction: ${instruction}\n`);

  const { proposals, summary } = await runAgentLoop(instruction);
  if (summary) console.log(`[ai-edit] Model summary: ${summary}`);
  await reviewAndApply(proposals);
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
}

main().catch((error) => {
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
  fail(error.stack || error.message);
});
