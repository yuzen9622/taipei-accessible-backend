import { model, Schema } from "mongoose";
import { IWelfare } from "../types";

const capacitySchema = {
  residential: { type: Number, default: 0 },
  night: { type: Number, default: 0 },
  day: { type: Number, default: 0 },
};

const welfareSchema = new Schema<IWelfare>({
  name: { type: String, required: true },
  county: { type: String, required: true },
  district: { type: String },
  address: { type: String, required: true },
  phone: { type: String },
  type: { type: String, required: true },
  approvedCapacity: { type: capacitySchema, default: () => ({}) },
  actualServed: { type: capacitySchema, default: () => ({}) },
  evaluationTerm: { type: String },
  evaluationGrade: { type: String },
  geocoded: { type: Boolean, default: false },
  location: {
    type: { type: String, enum: ["Point"] },
    coordinates: { type: [Number] },
  },
  importedAt: { type: Date, default: Date.now },
});
welfareSchema.index({ location: "2dsphere" });
const WelfareModel = model<IWelfare>("Welfare", welfareSchema);

export default WelfareModel;
