import { model, Schema } from "mongoose";

export interface IGtfsLevel {
  levelId: string;
  levelIndex: number;
  levelName: string;
}

const gtfsLevelSchema = new Schema<IGtfsLevel>({
  levelId: { type: String, required: true },
  levelIndex: { type: Number, required: true },
  levelName: { type: String, required: true },
});

gtfsLevelSchema.index({ levelId: 1 }, { unique: true });

export const GtfsLevel = model<IGtfsLevel>("GtfsLevel", gtfsLevelSchema);
