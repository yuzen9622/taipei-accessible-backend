import { model, Schema } from "mongoose";

export interface IGtfsShape {
  shapeId: string;
  geometry: {
    type: "LineString";
    coordinates: [number, number][];
  };
}

const gtfsShapeSchema = new Schema<IGtfsShape>({
  shapeId: { type: String, required: true },
  geometry: {
    type: {
      type: String,
      enum: ["LineString"],
      required: true,
      default: "LineString",
    },
    coordinates: { type: [[Number]], required: true },
  },
});

gtfsShapeSchema.index({ shapeId: 1 }, { unique: true });

export const GtfsShape = model<IGtfsShape>("GtfsShape", gtfsShapeSchema);
