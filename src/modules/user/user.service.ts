import User from "../../model/user.model";
import Config from "../../model/config.model";
import type { IUser, IConfig } from "../../types";

/**
 * Look up a user by client_id, creating the user and a default config on first
 * login.
 *
 * @param input User details ({ name, email, avatar?, client_id }) from the OAuth provider.
 * @returns The user document and its config (a fresh default for new users).
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
