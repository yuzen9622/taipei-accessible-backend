import crypto from "crypto";
import { Types } from "mongoose";
import SosSession from "../../model/sos-session.model";
import EmergencyContact from "../../model/emergency-contact.model";
import User from "../../model/user.model";
import { sendSosNotification, sendSosResolved } from "../../adapters/line.adapter";
import { ResponseCode } from "../../types/code";
import { SOS_MSG, SOS_REASON } from "../../constants/messages";
import type {
  CreateSosInput,
  ResolveSosInput,
  ServiceResult,
  UpdateLocationInput,
} from "./sos.types";

const TRACKING_EXPIRY_MS = 24 * 60 * 60 * 1000;

function fail(httpCode: number, reason: keyof typeof SOS_REASON): ServiceResult {
  return { ok: false, httpCode, message: SOS_MSG[reason], data: { reason: SOS_REASON[reason] } };
}

/**
 * Builds the public tracking URL for a share token.
 *
 * @param shareToken The session's high-entropy share token.
 * @returns The full tracking URL for LINE notifications / browsers.
 */
function trackingUrl(sessionId: string): string {
  const base = process.env.PUBLIC_TRACKING_BASE_URL ?? "";
  return `${base}/zh-TW?sos=${sessionId}`;
}

/**
 * Returns the LINE user ids of the caller's bound emergency contacts.
 *
 * @param userId Owner's user id.
 * @returns Array of bound `lineUserId` strings.
 */
async function boundLineUserIds(userId: string): Promise<string[]> {
  const contacts = await EmergencyContact.find({
    userId,
    bindStatus: "bound",
    lineUserId: { $ne: null },
  })
    .select("lineUserId")
    .lean();
  return contacts.map((c) => c.lineUserId).filter((id): id is string => Boolean(id));
}

/**
 * Creates an SOS session. Attempts a direct insert so the unique partial index
 * (`{userId} where status=active`) is the single source of truth against
 * double-tap races; on `E11000` it returns the existing active session (200,
 * no re-notification), otherwise 201 + best-effort multicast.
 *
 * @param input Requester id, SOS type and location.
 * @returns 201 (new) or 200 (existing active) with `{ sessionId, shareToken, notifiedCount }`.
 */
export async function createSession(input: CreateSosInput): Promise<ServiceResult> {
  const shareToken = crypto.randomBytes(16).toString("hex");
  const now = new Date();

  try {
    const session = await SosSession.create({
      userId: input.userId,
      type: input.type,
      status: "active",
      lat: input.lat,
      lng: input.lng,
      address: input.address ?? null,
      shareToken,
      locationUpdatedAt: now,
    });

    const lineUserIds = await boundLineUserIds(input.userId);
    let userName: string | undefined;
    try {
      const user = await User.findById(input.userId).select("name").lean();
      userName = (user as { name?: string } | null)?.name;
    } catch {
      userName = undefined;
    }
    const notifiedCount = await sendSosNotification(lineUserIds, {
      userName,
      type: input.type,
      trackingUrl: trackingUrl(String(session._id)),
      address: session.address,
    });

    return {
      ok: true,
      httpCode: ResponseCode.CREATED,
      message: SOS_MSG.CREATED,
      data: { sessionId: session._id, shareToken: session.shareToken, notifiedCount },
    };
  } catch (err) {
    if ((err as { code?: number })?.code === 11000) {
      const existing = await SosSession.findOne({ userId: input.userId, status: "active" }).lean();
      if (existing) {
        const notifiedCount = (await boundLineUserIds(input.userId)).length;
        return {
          ok: true,
          httpCode: ResponseCode.OK,
          message: SOS_MSG.ALREADY_ACTIVE,
          data: { sessionId: existing._id, shareToken: existing.shareToken, notifiedCount },
        };
      }
    }
    throw err;
  }
}

/**
 * Updates the location of an active SOS session owned by the caller. Resets the
 * stale-alert flag so the background job can warn again after a fresh gap.
 *
 * @param input Owner id, session id and new location.
 * @returns 200, or 404/403/400 per ownership and state guards.
 */
export async function updateLocation(input: UpdateLocationInput): Promise<ServiceResult> {
  if (!Types.ObjectId.isValid(input.sessionId)) {
    return fail(ResponseCode.NOT_FOUND, "SESSION_NOT_FOUND");
  }
  const session = await SosSession.findById(input.sessionId);
  if (!session) return fail(ResponseCode.NOT_FOUND, "SESSION_NOT_FOUND");
  if (String(session.userId) !== input.userId) {
    return fail(ResponseCode.FORBIDDEN, "NOT_SESSION_OWNER");
  }
  if (session.status !== "active") {
    return fail(ResponseCode.INVALID_INPUT, "SESSION_NOT_ACTIVE");
  }

  session.lat = input.lat;
  session.lng = input.lng;
  if (input.address !== undefined) session.address = input.address;
  session.locationUpdatedAt = new Date();
  session.staleAlertSent = false;
  await session.save();

  return { ok: true, httpCode: ResponseCode.OK, message: SOS_MSG.PUBLIC_OK, data: { sessionId: session._id } };
}

/**
 * Resolves an active SOS session owned by the caller and pushes the resolved
 * notice to bound contacts (best-effort).
 *
 * @param input Owner id and session id.
 * @returns 200 with `{ sessionId, status }`, or 404/403/400 per guards.
 */
export async function resolveSession(input: ResolveSosInput): Promise<ServiceResult> {
  if (!Types.ObjectId.isValid(input.sessionId)) {
    return fail(ResponseCode.NOT_FOUND, "SESSION_NOT_FOUND");
  }
  const session = await SosSession.findById(input.sessionId);
  if (!session) return fail(ResponseCode.NOT_FOUND, "SESSION_NOT_FOUND");
  if (String(session.userId) !== input.userId) {
    return fail(ResponseCode.FORBIDDEN, "NOT_SESSION_OWNER");
  }
  if (session.status !== "active") {
    return fail(ResponseCode.INVALID_INPUT, "SESSION_NOT_ACTIVE");
  }

  session.status = "resolved";
  session.resolvedAt = new Date();
  await session.save();

  let userName: string | undefined;
  try {
    const user = await User.findById(input.userId).select("name").lean();
    userName = (user as { name?: string } | null)?.name;
  } catch {
    userName = undefined;
  }
  await sendSosResolved(await boundLineUserIds(input.userId), userName);

  return {
    ok: true,
    httpCode: ResponseCode.OK,
    message: SOS_MSG.RESOLVED,
    data: { sessionId: session._id, status: session.status },
  };
}

/**
 * Public tracking lookup by share token (no auth). Resolved sessions older than
 * 24h are treated as expired (410).
 *
 * @param token The 32-char share token.
 * @returns 200 with a minimal location view, 404 unknown, or 410 expired.
 */
export async function getPublicById(sessionId: string): Promise<ServiceResult> {
  if (!Types.ObjectId.isValid(sessionId)) {
    return { ok: false, httpCode: ResponseCode.NOT_FOUND, message: SOS_MSG.TRACKING_NOT_FOUND, data: { reason: SOS_REASON.SESSION_NOT_FOUND } };
  }
  const session = await SosSession.findById(sessionId).lean();
  if (!session) {
    return { ok: false, httpCode: ResponseCode.NOT_FOUND, message: SOS_MSG.TRACKING_NOT_FOUND, data: { reason: SOS_REASON.SESSION_NOT_FOUND } };
  }
  if (
    session.status === "resolved" &&
    session.resolvedAt &&
    Date.now() - new Date(session.resolvedAt).getTime() > TRACKING_EXPIRY_MS
  ) {
    return fail(ResponseCode.GONE, "TRACKING_EXPIRED");
  }
  return {
    ok: true,
    httpCode: ResponseCode.OK,
    message: SOS_MSG.PUBLIC_OK,
    data: {
      type: session.type,
      status: session.status,
      lat: session.lat,
      lng: session.lng,
      address: session.address ?? null,
      updatedAt: session.locationUpdatedAt,
    },
  };
}
