import { embedText, embedBatch } from "../../adapters/embedding.adapter";
import {
  getOrCreateCollection,
  queryDocuments,
  upsertDocuments,
  type ChromaQueryResult,
} from "../../adapters/chroma.adapter";
import type { Collection } from "chromadb";

const COLLECTION_NAME = "accessibility_knowledge";

let cachedCollection: Collection | null = null;

async function getCollection(): Promise<Collection> {
  if (!cachedCollection) {
    cachedCollection = await getOrCreateCollection(COLLECTION_NAME);
  }
  return cachedCollection;
}

export interface KnowledgeResult {
  content: string;
  source: string;
  category: string;
  title: string;
  score: number;
}

/**
 * @param query Natural-language search query.
 * @param topK Number of results (default 3).
 * @returns Top-k knowledge chunks ranked by relevance.
 */
export async function searchKnowledge(
  query: string,
  topK = 3,
): Promise<KnowledgeResult[]> {
  const queryEmbedding = await embedText(query);
  const collection = await getCollection();
  const results = await queryDocuments(collection, queryEmbedding, topK);

  return results.map((r: ChromaQueryResult) => ({
    content: r.content,
    source: String(r.metadata.source ?? ""),
    category: String(r.metadata.category ?? ""),
    title: String(r.metadata.title ?? ""),
    score: 1 - r.distance,
  }));
}

/**
 * @param params Knowledge chunk to ingest.
 */
export async function ingestKnowledge(params: {
  id: string;
  content: string;
  source: string;
  category: string;
  title?: string;
}): Promise<void> {
  const embedding = await embedText(params.content);
  const collection = await getCollection();
  await upsertDocuments(collection, [
    {
      id: params.id,
      content: params.content,
      embedding,
      metadata: {
        source: params.source,
        category: params.category,
        title: params.title ?? "",
      },
    },
  ]);
}

/**
 * @param chunks Batch of knowledge chunks to ingest.
 */
export async function ingestKnowledgeBatch(
  chunks: Array<{
    id: string;
    content: string;
    source: string;
    category: string;
    title?: string;
  }>,
): Promise<void> {
  const collection = await getCollection();
  const BATCH_SIZE = 50;
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    // Sequential embedding (via embedBatch) avoids a concurrent request burst that
    // trips the embedding model's per-minute quota; each call self-throttles on 429.
    const embeddings = await embedBatch(batch.map((c) => c.content));
    await upsertDocuments(
      collection,
      batch.map((c, idx) => ({
        id: c.id,
        content: c.content,
        embedding: embeddings[idx],
        metadata: {
          source: c.source,
          category: c.category,
          title: c.title ?? "",
        },
      })),
    );
  }
}
