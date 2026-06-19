import exifr from "exifr";
import { haversineMeters } from "../../utils/geo";
import type { AiVerifyResult, ExifValidationResult } from "./hazard-report.types";

const EXIF_MAX_AGE_MS = 10 * 60 * 1000;
const EXIF_CLOCK_SKEW_MS = 10 * 60 * 1000;
const EXIF_GPS_MATCH_M = 50;

/**
 * Reads a photo's EXIF and maps it to the report's `exifValidation` shape:
 * whether the capture time is fresh (within 10 minutes of `now`), whether GPS
 * is present, and whether that GPS sits within 50m of the claimed location.
 *
 * @param buffer Raw photo bytes.
 * @param claimedLat Latitude the reporter claims to be at.
 * @param claimedLng Longitude the reporter claims to be at.
 * @param now Reference time the request arrived (UTC).
 * @returns The mapped EXIF validation result; all flags false when EXIF is absent or unreadable.
 */
export async function parsePhotoExif(
  buffer: Buffer,
  claimedLat: number,
  claimedLng: number,
  now: Date,
): Promise<ExifValidationResult> {
  const [timeData, gps] = await Promise.all([
    exifr
      .parse(buffer, { pick: ["DateTimeOriginal", "CreateDate", "ModifyDate"] })
      .catch(() => null),
    exifr.gps(buffer).catch(() => null),
  ]);

  const rawTime =
    timeData?.DateTimeOriginal ?? timeData?.CreateDate ?? timeData?.ModifyDate ?? null;
  const exifDate =
    rawTime instanceof Date ? rawTime : rawTime ? new Date(rawTime) : null;
  const ageMs =
    exifDate && !Number.isNaN(exifDate.getTime())
      ? now.getTime() - exifDate.getTime()
      : Number.POSITIVE_INFINITY;
  const timestampFresh =
    Number.isFinite(ageMs) && ageMs <= EXIF_MAX_AGE_MS && ageMs >= -EXIF_CLOCK_SKEW_MS;

  const lat = typeof gps?.latitude === "number" ? gps.latitude : undefined;
  const lng = typeof gps?.longitude === "number" ? gps.longitude : undefined;
  const gpsPresent = lat !== undefined && lng !== undefined;
  const gpsMatchesClaimed =
    gpsPresent && haversineMeters(lat, lng, claimedLat, claimedLng) <= EXIF_GPS_MATCH_M;

  return {
    timestampFresh,
    gpsPresent,
    gpsMatchesClaimed,
    rawExifTime:
      exifDate && !Number.isNaN(exifDate.getTime()) ? exifDate.toISOString() : undefined,
    rawExifLat: lat,
    rawExifLng: lng,
  };
}

function skipped(reason = "AI 服務暫時不可用"): AiVerifyResult {
  return { verdict: "skipped", confidence: 0, reason };
}

/**
 * Parses the Gemini verdict JSON (tolerating code fences and surrounding prose)
 * into an `AiVerifyResult`. Any malformed or unexpected payload degrades to a
 * `skipped` verdict so the report stays `pending`.
 *
 * @param text Raw model response text.
 * @returns The parsed verdict, or a skipped result on any parse failure.
 */
export function parseAiVerifyResult(text: string): AiVerifyResult {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return skipped();

  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const verdict =
      obj.verdict === "verified" || obj.verdict === "suspicious" || obj.verdict === "rejected"
        ? obj.verdict
        : "skipped";
    if (verdict === "skipped") return skipped();
    const confidence =
      typeof obj.confidence === "number"
        ? Math.max(0, Math.min(1, obj.confidence))
        : 0;
    const reason =
      typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim().slice(0, 200) : "";
    return { verdict, confidence, reason };
  } catch {
    return skipped();
  }
}
