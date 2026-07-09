import { Schema, model } from "mongoose";
import type { ILineLinkCode } from "../types";

const lineLinkCodeSchema = new Schema<ILineLinkCode>(
  {
    userId: { type: String, required: true, unique: true },
    code: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true },
);

lineLinkCodeSchema.index({ userId: 1 }, { unique: true });
lineLinkCodeSchema.index({ code: 1 }, { unique: true });

const LineLinkCode = model<ILineLinkCode>("LineLinkCode", lineLinkCodeSchema);

export default LineLinkCode;
