import { Schema, model } from "mongoose";
import { IConfig } from "../types";

const ConfigSchema = new Schema<IConfig>({
  language: { type: String, default: "zh" },
  darkMode: { type: String, default: "system" },
  themeColor: { type: String, default: "default" },
  fontSize: { type: String, default: "medium" },
  notifications: { type: Boolean, default: true },
  user_id: { type: Schema.Types.ObjectId, ref: "User", required: true },
});

const Config = model<IConfig>("Config", ConfigSchema);
export default Config;
