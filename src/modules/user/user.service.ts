import User from "../../model/user.model";
import Config from "../../model/config.model";
import type { IUser, IConfig } from "../../types";

/**
 * Look up a user by client_id, creating the user + a default config on first
 * login. Returns both documents. Mirrors the original login flow: an existing
 * user's stored config is returned as-is; a new user gets a fresh default config.
 */
export async function findOrCreateUser(input: {
  name: string;
  email: string;
  avatar?: string;
  client_id: string;
}): Promise<{ user: IUser; config: IConfig | null }> {
  let user = await User.findOne({ client_id: input.client_id });
  let config = await Config.findOne({ user_id: user?._id });
  if (!user) {
    user = new User(input);
    config = new Config({ user_id: user._id });
    await Promise.all([config.save(), user.save()]);
  }
  return { user, config };
}

export async function getUserWithConfig(
  client_id: string,
): Promise<{ user: IUser | null; config: IConfig | null }> {
  const user = await User.findOne({ client_id });
  const config = await Config.findOne({ user_id: user?._id });
  return { user, config };
}

export async function getConfig(user_id: string): Promise<IConfig | null> {
  return Config.findOne({ user_id });
}

export async function updateConfig(
  user_id: string,
  fields: Record<string, unknown>,
): Promise<IConfig | null> {
  const updateFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) updateFields[key] = value;
  }
  return Config.findOneAndUpdate({ user_id }, { $set: updateFields }, { new: true });
}
