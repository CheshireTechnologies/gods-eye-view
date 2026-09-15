/**
 * Semantic search over live layer data — answers fuzzy, descriptive questions
 * ("ships behaving oddly near the coast") that analystEngine's exact filters
 * can't express ("speedKts < 1"). Reuses the analyst engine for record
 * gathering AND spatial scoping (same providers, same view/radius/region/
 * anywhere semantics, same Contacts-subject centering) so scoping never
 * drifts between the two tools — this module only adds a ranking pass on top,
 * via a locally-run Ollama embedding model.
 *
 * @module data/semanticEngine
 */

import { ANALYST_LAYERS } from './analystEngine.js';

/** Short one-line text description of a record, from its declared fields. */
function describeRecord(record) {
  const layerFields = ANALYST_LAYERS[record.layerKey];
  const parts = [record.layerKey];
  const label = record.label || record.callsign || record.name || record.id;
  if (label) parts.push(String(label));
  if (layerFields) {
    for (const field of [...layerFields.text, ...layerFields.numeric]) {
      const value = record[field];
      if (value === null || value === undefined || value === '') continue;
      parts.push(`${field}=${value}`);
    }
    for (const flag of layerFields.flags) {
      if (record[flag]) parts.push(flag);
    }
  }
  return parts.join(' ');
}

/** Cosine similarity between two equal-length numeric vectors. */
function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Create a semantic-search engine bound to an existing analyst engine (for
 * record gathering/scoping) and injected server calls (for embeddings and
 * narrative generation), so it stays node-testable without a live Ollama.
 *
 * @param {object} deps
 * @param {{query:Function}} deps.analystEngine - Shares scoping with analyst_query.
 * @param {(texts:string[])=>Promise<number[][]>} deps.embed
 * @param {(query:string, matches:Array)=>Promise<string>} deps.narrate
 */
export function createSemanticEngine({ analystEngine, embed, narrate }) {
  async function query(spec = {}) {
    const queryText = String(spec.query || '').trim();
    if (!queryText) {
      return { ok: false, error: 'semantic_query needs a free-text question to search for.' };
    }

    const candidateResult = await analystEngine.query({
      layers: Array.isArray(spec.layers) && spec.layers.length ? spec.layers : undefined,
      scope: spec.scope,
      filters: [],
      limit: 50,
    });
    if (!candidateResult.ok) {
      return { ok: false, error: candidateResult.error, coverage: candidateResult.coverage };
    }
    if (!candidateResult.items.length) {
      return {
        ok: true,
        matches: [],
        narrative: null,
        scopeLabel: candidateResult.scopeLabel,
        coverage: candidateResult.coverage,
      };
    }

    const descriptions = candidateResult.items.map(describeRecord);
    let vectors;
    try {
      vectors = await embed([queryText, ...descriptions]);
    } catch (error) {
      return {
        ok: false,
        error: `Local semantic search is unavailable: ${error?.message || 'Ollama request failed'}.`,
      };
    }
    const [queryVector, ...recordVectors] = vectors;
    const limit = Math.max(1, Math.min(20, Number(spec.limit) || 8));
    const ranked = candidateResult.items
      .map((record, i) => ({
        layerKey: record.layerKey,
        id: record.id,
        score: cosineSimilarity(queryVector, recordVectors[i]),
        summary: descriptions[i],
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    let narrative = null;
    try {
      narrative = await narrate(queryText, ranked);
    } catch {
      // Ranked matches still stand on their own — narrative is a nice-to-have.
      narrative = null;
    }

    return {
      ok: true,
      matches: ranked,
      narrative,
      scopeLabel: candidateResult.scopeLabel,
      coverage: candidateResult.coverage,
    };
  }

  return { query };
}
