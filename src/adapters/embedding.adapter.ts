import { googleGenAi } from "../config/ai";

const EMBEDDING_MODEL = "gemini-embedding-2";
const MAX_EMBED_ATTEMPTS = 6;
const MAX_BACKOFF_MS = 60_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isRateLimitError(err: unknown): boolean {
  const e = err as { status?: number; code?: number; message?: string };
  if (e?.status === 429 || e?.code === 429) return true;
  return /RESOURCE_EXHAUSTED|429/.test(String(e?.message ?? ""));
}

/** Extract a server-suggested retry delay (ms) from a 429 payload, if present. */
function retryHintMs(err: unknown): number | null {
  const msg = String((err as { message?: string })?.message ?? "");
  const m = msg.match(/"?retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)s/i);
  if (m) return Math.round(parseFloat(m[1]) * 1000);
  return null;
}

/**
 * @param text The text to embed.
 * @returns A 3072-dimension embedding vector.
 */
export async function embedText(text: string): Promise<number[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_EMBED_ATTEMPTS; attempt += 1) {
    try {
      const result = await googleGenAi.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: text,
      });
      return result.embeddings![0].values!;
    } catch (err) {
      lastErr = err;
      if (!isRateLimitError(err) || attempt === MAX_EMBED_ATTEMPTS) throw err;
      const backoff = Math.min(5_000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
      const waitMs = retryHintMs(err) ?? backoff;
      console.warn(
        `[embedText] 429 rate-limited; retry ${attempt}/${MAX_EMBED_ATTEMPTS - 1} in ${waitMs}ms`,
      );
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

/**
 * @param texts Array of texts to embed in batch.
 * @returns Array of 3072-dimension embedding vectors, one per input text.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  for (const text of texts) {
    results.push(await embedText(text));
  }
  return results;
}
