import { model, Schema } from "mongoose";
import type { IGtfsLevel } from "../types";

const gtfsLevelSchema = new Schema<IGtfsLevel>({
  levelId: { type: String, required: true },
  levelIndex: { type: Number, required: true },
  levelName: { type: String, required: true },
});

gtfsLevelSchema.index({ levelId: 1 }, { unique: true });

export const GtfsLevel = model<IGtfsLevel>("GtfsLevel", gtfsLevelSchema);
