import User from "../../model/user.model";
import Config from "../../model/config.model";
import LineLinkCode from "../../model/line-link-code.model";
import { buildBindUrl } from "../../adapters/line.adapter";
import crypto from "crypto";
import type { IUser, IConfig } from "../../types";

const LINE_LINK_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const LINE_LINK_CODE_LENGTH = 6;
const LINE_LINK_CODE_TTL_MS = 24 * 60 * 60 * 1000;

async function generateLineLinkCode(): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    let code = "";
    for (let i = 0; i < LINE_LINK_CODE_LENGTH; i++) {
      code += LINE_LINK_CODE_ALPHABET[crypto.randomInt(LINE_LINK_CODE_ALPHABET.length)];
    }
    const exists = await LineLinkCode.exists({ code });
    if (!exists) return code;
  }
  throw new Error("Failed to generate a unique LINE link code");
}

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

export async function issueLineLinkCode(userId: string): Promise<{
  bindCode: string;
  bindCodeExpiresAt: Date;
  bindUrl: string;
}> {
  const user = await User.findById(userId);
  if (!user) {
    throw new Error("User not found");
  }

  const bindCode = await generateLineLinkCode();
  const bindCodeExpiresAt = new Date(Date.now() + LINE_LINK_CODE_TTL_MS);

  await LineLinkCode.findOneAndUpdate(
    { userId },
    { $set: { code: bindCode, expiresAt: bindCodeExpiresAt } },
    { upsert: true, new: true },
  );

  return {
    bindCode,
    bindCodeExpiresAt,
    bindUrl: buildBindUrl(),
  };
}
