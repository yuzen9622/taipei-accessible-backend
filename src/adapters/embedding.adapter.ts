import { googleGenAi } from "../config/ai";

const EMBEDDING_MODEL = "text-embedding-004";

/**
 * @param text The text to embed.
 * @returns A 768-dimension embedding vector.
 */
export async function embedText(text: string): Promise<number[]> {
  const result = await googleGenAi.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: text,
  });
  return result.embeddings![0].values!;
}

/**
 * @param texts Array of texts to embed in batch.
 * @returns Array of 768-dimension embedding vectors, one per input text.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  for (const text of texts) {
    results.push(await embedText(text));
  }
  return results;
}
