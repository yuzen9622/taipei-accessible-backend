import { Schema, model } from "mongoose";
import { IBathroom } from "../types";

const bathroomModel = new Schema<IBathroom>({
  county: { type: String, required: true },
  areacode: { type: String, required: true },
  village: { type: String, required: true },
  number: { type: String, required: true },
  name: { type: String, required: true },
  address: { type: String, required: true },
  administration: { type: String, required: true },
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  location: {
    type: { type: String, enum: ["Point"], required: true, default: "Point" },
    coordinates: { type: [Number], required: true },
  },
  grade: { type: String, required: true },
  type2: { type: String, required: true },
  type: { type: String, required: true },
  exec: { type: String, required: true },
  diaper: { type: String, required: true },
});
bathroomModel.index({ location: "2dsphere" });
const BathroomModel = model<IBathroom>("Bathroom", bathroomModel);

export default BathroomModel;
