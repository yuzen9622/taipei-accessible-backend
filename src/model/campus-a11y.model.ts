import { model, Schema } from "mongoose";
import { ICampusA11y } from "../types";

const facilitySchema = {
  facUid: { type: String, required: true },
  facTypeId: { type: Number },
  facType: { type: String },
  name: { type: String },
  building: { type: String },
  buildingUid: { type: String },
  floors: { type: [String], default: [] },
  floorIds: { type: [String], default: [] },
};

const campusA11ySchema = new Schema<ICampusA11y>({
  schoolId: { type: Number, required: true },
  schoolName: { type: String, required: true },
  branchId: { type: Number, required: true, unique: true },
  branchName: { type: String, required: true },
  city: { type: String },
  address: { type: String },
  phone: { type: String },
  buildingCount: { type: Number, default: 0 },
  facilityCount: { type: Number, default: 0 },
  facilities: { type: [facilitySchema], default: [] },
  location: {
    type: { type: String, enum: ["Point"] },
    coordinates: { type: [Number] },
  },
  importedAt: { type: Date, default: Date.now },
});
campusA11ySchema.index({ location: "2dsphere" });
campusA11ySchema.index({ "facilities.facType": 1 });
const CampusA11yModel = model<ICampusA11y>("CampusA11y", campusA11ySchema);

export default CampusA11yModel;
