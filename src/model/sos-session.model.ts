import { Schema, model } from "mongoose";
import type { ISosSession } from "../types";

const sosSessionSchema = new Schema<ISosSession>(
  {
    userId: { type: String, required: true },
    type: {
      type: String,
      enum: ["body", "trapped", "share_location"],
      required: true,
    },
    status: {
      type: String,
      enum: ["active", "resolved"],
      default: "active",
    },
    lat: { type: Number, required: true, min: -90, max: 90 },
    lng: { type: Number, required: true, min: -180, max: 180 },
    address: { type: String, default: null },
    shareToken: { type: String, required: true },
    locationUpdatedAt: { type: Date, required: true },
    resolvedAt: { type: Date, default: null },
    claimedBy: { type: String, default: null },
    staleAlertSent: { type: Boolean, default: false },
  },
  { timestamps: true },
);

sosSessionSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { status: "active" } },
);
sosSessionSchema.index({ shareToken: 1 }, { unique: true });
sosSessionSchema.index({ status: 1, createdAt: 1 });
sosSessionSchema.index({ status: 1, locationUpdatedAt: 1 });

const SosSession = model<ISosSession>("SosSession", sosSessionSchema);

export default SosSession;
