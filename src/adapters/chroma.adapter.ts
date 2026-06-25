import { ChromaClient, type Collection } from "chromadb";

let client: ChromaClient | null = null;

function getClient(): ChromaClient {
  if (!client) {
    const url = process.env.CHROMA_URL || "http://localhost:8100";
    const parsed = new URL(url);
    client = new ChromaClient({
      host: parsed.hostname,
      port: Number(parsed.port) || 8000,
      ssl: parsed.protocol === "https:",
    });
  }
  return client;
}

/**
 * @param name Collection name.
 * @returns A Chroma collection (created if not exists).
 */
export async function getOrCreateCollection(
  name: string,
): Promise<Collection> {
  return getClient().getOrCreateCollection({
    name,
    embeddingFunction: null,
  });
}

/**
 * @param collection The collection.
 * @param docs Documents to upsert: id, content, embedding, and metadata.
 */
export async function upsertDocuments(
  collection: Collection,
  docs: Array<{
    id: string;
    content: string;
    embedding: number[];
    metadata: Record<string, string>;
  }>,
): Promise<void> {
  await collection.upsert({
    ids: docs.map((d) => d.id),
    documents: docs.map((d) => d.content),
    embeddings: docs.map((d) => d.embedding),
    metadatas: docs.map((d) => d.metadata),
  });
}

export interface ChromaQueryResult {
  id: string;
  content: string;
  metadata: Record<string, string>;
  distance: number;
}

/**
 * @param collection The collection.
 * @param queryEmbedding The query vector.
 * @param topK Number of results to return.
 * @returns Ranked results with distance (lower = more similar).
 */
export async function queryDocuments(
  collection: Collection,
  queryEmbedding: number[],
  topK: number,
): Promise<ChromaQueryResult[]> {
  const results = await collection.query({
    queryEmbeddings: [queryEmbedding],
    nResults: topK,
    include: ["documents", "metadatas", "distances"],
  });

  const ids = results.ids?.[0] ?? [];
  const documents = results.documents?.[0] ?? [];
  const metadatas = results.metadatas?.[0] ?? [];
  const distances = results.distances?.[0] ?? [];

  return ids.map((id, i) => ({
    id: id ?? "",
    content: (documents[i] as string) ?? "",
    metadata: (metadatas[i] as Record<string, string>) ?? {},
    distance: (distances[i] as number) ?? 0,
  }));
}
