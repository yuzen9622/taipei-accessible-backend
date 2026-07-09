import mongoose from "mongoose";
import { getRoutePreview } from "../modules/line/line.service";

const uri = process.env.DATABASE_URL || "";

async function main() {
  if (!uri) {
    console.error("No DATABASE_URL found");
    return;
  }
  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  const sessionId = "6a4f4dfab1929adea6183cbb";
  console.log(`Getting route preview for: ${sessionId}`);
  const result = await getRoutePreview(sessionId);
  console.log("Result:", JSON.stringify(result, null, 2));

  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  mongoose.disconnect();
});
