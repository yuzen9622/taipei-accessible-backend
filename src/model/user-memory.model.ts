import { Schema, model } from "mongoose";

export interface IUserMemory {
  _id: string;
  userId: string;
  content: string;
  promptText: string;
  retrievalText: string;
  category: "preference" | "place" | "habit" | "context";
  sensitivity: "low" | "medium" | "high";
  source: "explicit_user" | "agent_suggested" | "distilled";
  embeddingId?: string;
  embeddingModel?: string;
  lastUsedAt?: Date;
  expiresAt?: Date;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const userMemorySchema = new Schema<IUserMemory>(
  {
    userId: { type: String, required: true },
    content: { type: String, required: true },
    promptText: { type: String, required: true },
    retrievalText: { type: String, required: true },
    category: {
      type: String,
      enum: ["preference", "place", "habit", "context"],
      required: true,
    },
    sensitivity: {
      type: String,
      enum: ["low", "medium", "high"],
      required: true,
      default: "medium",
    },
    source: {
      type: String,
      enum: ["explicit_user", "agent_suggested", "distilled"],
      required: true,
      default: "explicit_user",
    },
    embeddingId: { type: String },
    embeddingModel: { type: String },
    lastUsedAt: { type: Date },
    expiresAt: { type: Date },
    deletedAt: { type: Date },
  },
  { timestamps: true },
);

userMemorySchema.index({ userId: 1, updatedAt: -1 });
userMemorySchema.index({ userId: 1, category: 1, deletedAt: 1 });
userMemorySchema.index({ userId: 1, embeddingId: 1 });

const UserMemory = model<IUserMemory>("UserMemory", userMemorySchema);
export default UserMemory;
