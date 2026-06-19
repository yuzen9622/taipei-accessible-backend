import { model, Schema } from "mongoose";
import type { IGtfsTrip } from "../types";

const gtfsTripSchema = new Schema<IGtfsTrip>({
  tripId: { type: String, required: true },
  routeId: { type: String, required: true },
  serviceId: { type: String, required: true },
  shapeId: { type: String },
  directionId: { type: Number, enum: [0, 1], required: true },
  bikesAllowed: { type: Number, enum: [0, 1, 2] },
});

gtfsTripSchema.index({ tripId: 1 }, { unique: true });
gtfsTripSchema.index({ routeId: 1 });
gtfsTripSchema.index({ serviceId: 1 });

export const GtfsTrip = model<IGtfsTrip>("GtfsTrip", gtfsTripSchema);
