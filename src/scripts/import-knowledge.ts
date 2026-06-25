import fs from "fs";
import path from "path";
import { ingestKnowledgeBatch } from "../modules/ai/knowledge.service";

interface KnowledgeEntry {
  id: string;
  category: string;
  title: string;
  source: string;
  content: string;
}

async function main() {
  const dataDir = path.resolve(__dirname, "../../data/knowledge");
  const files = fs.readdirSync(dataDir).filter((f) => f.endsWith(".json"));

  if (!files.length) {
    console.log("No JSON files found in", dataDir);
    process.exit(0);
  }

  let total = 0;
  for (const file of files) {
    const filePath = path.join(dataDir, file);
    const raw = fs.readFileSync(filePath, "utf-8");
    const entries: KnowledgeEntry[] = JSON.parse(raw);
    console.log(`[${file}] ${entries.length} entries`);

    await ingestKnowledgeBatch(
      entries.map((e) => ({
        id: e.id,
        content: e.content,
        source: e.source,
        category: e.category,
        title: e.title,
      })),
    );
    total += entries.length;
    console.log(`[${file}] ingested`);
  }

  console.log(`Done. Total: ${total} knowledge chunks ingested.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
