import { createEmbeddingsHandler } from './embeddings.js';
import { createNarrateHandler } from './narrate.js';
import { createNewsKnowledgeHandler } from './newsKnowledge.js';
import { createIntentHandler } from './intent.js';
import { createReplyHandler } from './reply.js';

/**
 * Vite plugin: local Ollama intelligence backend for the semantic_query voice
 * tool. Entirely optional and entirely local — no API key, no cloud call, no
 * cost. Mounted unconditionally like the other local proxies; each handler
 * degrades to a clear ok:false error when Ollama isn't running or the
 * configured model isn't pulled, the same way the rest of the app's optional
 * providers degrade when unconfigured.
 */
function ollamaIntelligenceProxy({ baseUrl, embedModel, chatModel } = {}) {
  function install(middlewares) {
    middlewares.use(
      '/api/ollama/embeddings',
      createEmbeddingsHandler({ baseUrl, model: embedModel }),
    );
    middlewares.use(
      '/api/ollama/narrate',
      createNarrateHandler({ baseUrl, model: chatModel }),
    );
    middlewares.use(
      '/api/ollama/news-knowledge',
      createNewsKnowledgeHandler({ baseUrl, model: chatModel }),
    );
    middlewares.use(
      '/api/ollama/intent',
      createIntentHandler({ baseUrl, model: chatModel }),
    );
    middlewares.use(
      '/api/ollama/reply',
      createReplyHandler({ baseUrl, model: chatModel }),
    );
  }

  return {
    name: 'ollama-intelligence-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export { ollamaIntelligenceProxy };
