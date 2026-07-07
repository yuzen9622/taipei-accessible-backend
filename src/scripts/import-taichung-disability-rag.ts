/**
 * One-shot import: scraped Taichung "身心障礙" (disability) Markdown → RAG.
 *
 * Reads the Markdown files produced by `scripts/rag/scrape_taichung_disability.py`
 * (under data/rag/taichung-disability/), chunks each article's body, and ingests
 * the chunks into the existing Chroma collection `accessibility_knowledge` via the
 * ai module's `ingestKnowledgeBatch` (which embeds with text-embedding-004 and
 * upserts). Retrieval is already wired through `searchKnowledge` in the AI agent.
 *
 * Requires: GEMINI_API_KEY (embeddings) + a running Chroma at CHROMA_URL.
 * Run: npm run import:taichung-disability-rag
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import {
  ingestKnowledgeBatch,
  searchKnowledge,
} from "../modules/ai/knowledge.service";

const DATA_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "data",
  "rag",
  "taichung-disability",
);

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 100;

interface ParsedDoc {
  postId: string;
  title: string;
  url: string;
  category: string;
  body: string;
}

interface Chunk {
  id: string;
  content: string;
  source: string;
  category: string;
  title: string;
}

/** Read every *.md file under DATA_DIR (recursively). */
function listMarkdownFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => path.join(e.parentPath ?? (e as unknown as { path: string }).path, e.name));
}

/** Parse our own fixed frontmatter format; returns null if unusable. */
function parseDoc(raw: string): ParsedDoc | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  const [, front, rest] = match;

  const scalar = (key: string): string => {
    const m = front.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
    if (!m) return "";
    return m[1].trim().replace(/^"(.*)"$/, "$1");
  };

  const postId = scalar("post_id");
  const title = scalar("title");
  const url = scalar("url");
  const category = scalar("category");

  // Strip the leading "# <title>" H1 that duplicates the title.
  let body = rest.replace(/^\s*#\s+.*\n+/, "");
  body = body.replace(/\n{3,}/g, "\n\n").trim();

  if (!postId || !body) return null;
  return { postId, title, url, category, body };
}

/**
 * Split text into ~CHUNK_SIZE-char chunks with ~CHUNK_OVERLAP overlap, preferring
 * paragraph then line boundaries. CJK-safe (character based).
 */
function chunkText(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + CHUNK_SIZE, text.length);

    if (end < text.length) {
      // Prefer to break on a paragraph, then a line, within the window.
      const window = text.slice(start, end);
      const paraBreak = window.lastIndexOf("\n\n");
      const lineBreak = window.lastIndexOf("\n");
      if (paraBreak > CHUNK_SIZE * 0.5) {
        end = start + paraBreak;
      } else if (lineBreak > CHUNK_SIZE * 0.5) {
        end = start + lineBreak;
      }
    }

    const piece = text.slice(start, end).trim();
    if (piece) chunks.push(piece);

    if (end >= text.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }

  return chunks;
}

async function main(): Promise<void> {
  if (!fs.existsSync(DATA_DIR)) {
    console.error(
      `Data directory not found: ${DATA_DIR}\n` +
        `Run the scraper first: python scripts/rag/scrape_taichung_disability.py`,
    );
    process.exit(1);
  }

  const files = listMarkdownFiles(DATA_DIR);
  if (files.length === 0) {
    console.error(`No .md files under ${DATA_DIR}. Run the scraper first.`);
    process.exit(1);
  }
  console.log(`Found ${files.length} markdown files`);

  const allChunks: Chunk[] = [];
  let skipped = 0;

  for (const file of files) {
    const raw = fs.readFileSync(file, "utf-8");
    const doc = parseDoc(raw);
    if (!doc) {
      console.warn(`  skip (unparsable/empty): ${path.relative(DATA_DIR, file)}`);
      skipped += 1;
      continue;
    }

    const pieces = chunkText(doc.body);
    pieces.forEach((content, idx) => {
      allChunks.push({
        id: `taichung-disability-${doc.postId}-${idx}`,
        content,
        source: doc.url,
        category: doc.category,
        title: pieces.length > 1 ? `${doc.title}｜第${idx + 1}段` : doc.title,
      });
    });
    console.log(
      `  ${doc.postId} ${doc.title} → ${pieces.length} chunk(s)`,
    );
  }

  console.log(
    `\nIngesting ${allChunks.length} chunks from ${files.length - skipped} files ` +
      `(skipped ${skipped})...`,
  );
  await ingestKnowledgeBatch(allChunks);
  console.log(`✓ Ingested ${allChunks.length} chunks into accessibility_knowledge`);

  // Smoke-test retrieval.
  const query = "身心障礙者生活補助費 申請資格";
  console.log(`\nSmoke test — searchKnowledge("${query}"):`);
  const results = await searchKnowledge(query, 3);
  for (const r of results) {
    console.log(
      `  [${r.score.toFixed(3)}] ${r.title}  (${r.category})  ${r.source}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
