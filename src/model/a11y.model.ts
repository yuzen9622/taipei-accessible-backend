import { model, Schema } from "mongoose";
import { IA11y } from "../types";

const a11yModel = new Schema<IA11y>({
  項次: { type: String, required: true },
  "出入口電梯/無障礙坡道名稱": { type: String, required: true },
  經度: { type: Number, required: true },
  緯度: { type: Number, required: true },
  location: {
    type: { type: String, enum: ["Point"], required: true, default: "Point" },
    coordinates: { type: [Number], required: true },
  },
});
a11yModel.index({ location: "2dsphere" });
const A11y = model<IA11y>("Accessibility", a11yModel);

export default A11y;
