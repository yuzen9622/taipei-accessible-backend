import { Schema, model } from "mongoose";

export interface IUserMemory {
  _id: string;
  userId: string;
  content: string;
  category: "preference" | "place" | "habit" | "context";
  createdAt: Date;
  updatedAt: Date;
}

const userMemorySchema = new Schema<IUserMemory>(
  {
    userId: { type: String, required: true },
    content: { type: String, required: true },
    category: {
      type: String,
      enum: ["preference", "place", "habit", "context"],
      required: true,
    },
  },
  { timestamps: true },
);

userMemorySchema.index({ userId: 1, updatedAt: -1 });

const UserMemory = model<IUserMemory>("UserMemory", userMemorySchema);
export default UserMemory;
