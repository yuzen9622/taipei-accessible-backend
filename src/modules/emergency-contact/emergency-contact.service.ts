import crypto from "crypto";
import { Types } from "mongoose";
import EmergencyContact from "../../model/emergency-contact.model";
import { buildBindUrl } from "../../adapters/line.adapter";
import { ResponseCode } from "../../types/code";
import { CONTACT_MSG, CONTACT_REASON } from "../../constants/messages";
import type {
  CreateContactInput,
  DeleteContactInput,
  ServiceResult,
} from "./emergency-contact.types";

const MAX_CONTACTS = 5;
const BIND_CODE_TTL_MS = 24 * 60 * 60 * 1000;
const BIND_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const BIND_CODE_LENGTH = 6;

function fail(
  httpCode: number,
  reason: keyof typeof CONTACT_REASON,
): ServiceResult {
  return { ok: false, httpCode, message: CONTACT_MSG[reason], data: { reason: CONTACT_REASON[reason] } };
}

/**
 * Generates a 6-char uppercase alphanumeric bind code that is not currently in
 * use by any contact (the model enforces a unique sparse index as a backstop).
 *
 * @returns A fresh, unused bind code.
 */
async function generateBindCode(): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    let code = "";
    for (let i = 0; i < BIND_CODE_LENGTH; i++) {
      code += BIND_CODE_ALPHABET[crypto.randomInt(BIND_CODE_ALPHABET.length)];
    }
    const exists = await EmergencyContact.exists({ bindCode: code });
    if (!exists) return code;
  }
  throw new Error("Failed to generate a unique bind code");
}

/**
 * Lists the caller's emergency contacts, newest first.
 *
 * @param userId Owner's user id (from `req.auth`).
 * @returns A 200 result carrying `{ contacts }`.
 */
export async function listContacts(userId: string): Promise<ServiceResult> {
  const contacts = await EmergencyContact.find({ userId })
    .sort({ createdAt: -1 })
    .select("name bindStatus lineUserId bindCodeExpiresAt createdAt")
    .lean();
  return { ok: true, httpCode: ResponseCode.OK, message: CONTACT_MSG.LIST_OK, data: { contacts } };
}

/**
 * Creates an emergency contact, enforcing the 5-contact cap and issuing a bind
 * code (24h TTL) plus the official add-friend URL to share with the contact.
 *
 * @param input Owner id and contact name.
 * @returns A 201 result with `{ contact, bindUrl, bindCode }`, or 400 on cap.
 */
export async function createContact(input: CreateContactInput): Promise<ServiceResult> {
  const count = await EmergencyContact.countDocuments({ userId: input.userId });
  if (count >= MAX_CONTACTS) {
    return fail(ResponseCode.INVALID_INPUT, "CONTACT_LIMIT_REACHED");
  }

  const bindCode = await generateBindCode();
  const bindCodeExpiresAt = new Date(Date.now() + BIND_CODE_TTL_MS);
  const contact = await EmergencyContact.create({
    userId: input.userId,
    name: input.name,
    bindStatus: "pending",
    bindCode,
    bindCodeExpiresAt,
  });

  return {
    ok: true,
    httpCode: ResponseCode.CREATED,
    message: CONTACT_MSG.CREATED,
    data: {
      contact: {
        _id: contact._id,
        name: contact.name,
        bindStatus: contact.bindStatus,
        bindCodeExpiresAt: contact.bindCodeExpiresAt,
      },
      bindUrl: buildBindUrl(),
      bindCode,
    },
  };
}

/**
 * Deletes an emergency contact owned by the caller.
 *
 * @param input Owner id and contact id.
 * @returns A 200 result, or 404/403 when missing / not owned.
 */
export async function deleteContact(input: DeleteContactInput): Promise<ServiceResult> {
  if (!Types.ObjectId.isValid(input.contactId)) {
    return fail(ResponseCode.NOT_FOUND, "CONTACT_NOT_FOUND");
  }
  const contact = await EmergencyContact.findById(input.contactId);
  if (!contact) {
    return fail(ResponseCode.NOT_FOUND, "CONTACT_NOT_FOUND");
  }
  if (String(contact.userId) !== input.userId) {
    return fail(ResponseCode.FORBIDDEN, "NOT_CONTACT_OWNER");
  }
  await contact.deleteOne();
  return { ok: true, httpCode: ResponseCode.OK, message: CONTACT_MSG.DELETED, data: null };
}
