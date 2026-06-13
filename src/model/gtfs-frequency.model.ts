import { model, Schema } from "mongoose";

export interface IGtfsFrequency {
  tripId: string;
  startTime: string;
  endTime: string;
  headwaySecs: number;
}

const gtfsFrequencySchema = new Schema<IGtfsFrequency>({
  tripId: { type: String, required: true },
  startTime: { type: String, required: true },
  endTime: { type: String, required: true },
  headwaySecs: { type: Number, required: true },
});

gtfsFrequencySchema.index({ tripId: 1 });

export const GtfsFrequency = model<IGtfsFrequency>(
  "GtfsFrequency",
  gtfsFrequencySchema
);
