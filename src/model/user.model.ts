import { Schema, model } from "mongoose";
import type { IUser } from "../types";
const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true },
    avatar: { type: String },
    email: { type: String, required: true, unique: true },
    client_id: { type: String, required: true, unique: true },
    lineUserId: { type: String, default: null },
    settings: {
      memoryEnabled: { type: Boolean, default: false },
    },
  },
  { timestamps: true }
);

userSchema.index({ lineUserId: 1 }, { unique: true, sparse: true });

const User = model<IUser>("User", userSchema);

export default User;
