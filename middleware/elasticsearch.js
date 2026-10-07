// src/middleware/elasticsearch.js
//
// Manages the Elasticsearch connection and the dense-vector index used
// to store chunk embeddings.  text-embedding-3-small produces 1536-dim vectors.

import { Client } from '@elastic/elasticsearch';

const INDEX = process.env.ELASTICSEARCH_INDEX || 'rag_documents';
const DIMS  = 1536; // OpenAI text-embedding-3-small output dimension

const clientConfig = {
  node: process.env.ELASTICSEARCH_URL || 'http://localhost:9200',
};

if (process.env.ELASTICSEARCH_USERNAME) {
  clientConfig.auth = {
    username: process.env.ELASTICSEARCH_USERNAME,
    password: process.env.ELASTICSEARCH_PASSWORD,
  };
}

export const elasticsearchClient = new Client(clientConfig);

/**
 * Create the index with a dense_vector mapping if it doesn't already exist.
 * Called once at server start.
 */
export async function ensureIndex() {
  const exists = await elasticsearchClient.indices.exists({ index: INDEX });
  if (exists) {
    console.log(`[ES] Index "${INDEX}" already exists — skipping creation.`);
    return;
  }

  await elasticsearchClient.indices.create({
    index: INDEX,
    mappings: {
      properties: {
        // The chunk text itself
        text: { type: 'text' },

        // The embedding vector — cosine similarity gives the best results for
        // semantic search with OpenAI embeddings
        embedding: {
          type: 'dense_vector',
          dims: DIMS,
          index: true,
          similarity: 'cosine',
        },

        // Metadata
        documentId:   { type: 'keyword' },
        originalName: { type: 'keyword' },
        page:         { type: 'integer' },
        chunkIndex:   { type: 'integer' },
        createdAt:    { type: 'date' },
      },
    },
  });

  console.log(`[ES] Created index "${INDEX}" with ${DIMS}-dim dense_vector mapping.`);
}

export { INDEX };
