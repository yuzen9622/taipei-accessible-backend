import { model, Schema } from "mongoose";
import { ITdxBusStop } from "../types";

const busStopSchema = new Schema<ITdxBusStop>({
  stopUid: { type: String, required: true, unique: true },
  stopName: {
    Zh_tw: { type: String, required: true },
    En: { type: String },
  },
  city: { type: String, required: true },
  subRouteIds: { type: [String], default: [] },
  location: {
    type: { type: String, enum: ["Point"], required: true, default: "Point" },
    coordinates: { type: [Number], required: true },
  },
  importedAt: { type: Date, default: Date.now },
});

busStopSchema.index({ location: "2dsphere" });

const BusStopModel = model<ITdxBusStop>("BusStop", busStopSchema);
export default BusStopModel;
