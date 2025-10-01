import { Schema, model } from "mongoose";
import type { IUser } from "../types";
const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true },
    avatar: { type: String },
    email: { type: String, required: true, unique: true },
    client_id: { type: String, required: true, unique: true },
  },
  { timestamps: true }
);

const User = model<IUser>("User", userSchema);

export default User;
