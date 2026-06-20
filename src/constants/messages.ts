/**
 * Centralized user-facing message strings — clean-architecture invariant #5
 * (no magic literals). Only messages that repeat across call sites live here;
 * one-off per-endpoint messages stay inline where they are used.
 *
 * HTTP status codes are deliberately NOT duplicated here: they already live in
 * the `ResponseCode` enum (`src/types/code.ts`), which doubles as the HTTP
 * status and the response envelope's `code`. Pass `ResponseCode.*` to
 * `sendResponse`.
 */

export const MSG = {
  OK: "OK",
} as const;

export const ERROR_MESSAGE = {
  INTERNAL: "Internal Server Error",
  MISSING_PARAMS: "缺少必要參數",
  INTENT_PARSE_FAILED:
    "無法解析您的查詢，請改用『從 A 到 B』的描述或直接提供 origin/destination",
} as const;

/**
 * User-facing messages for the pre-trip environment aggregation endpoint. The
 * partial message is built from the number of sources that came back unavailable.
 */
export const ENV_MSG = {
  OK: "環境資訊查詢成功",
  partial: (unavailableCount: number): string =>
    `環境資訊部分查詢成功（${unavailableCount} 項來源不可用）`,
} as const;

/**
 * Domain reason codes for the hazard-report feature. These ride in
 * `data.reason` of the response envelope (the envelope `code` stays the HTTP
 * status from `ResponseCode`). Referenced by both the service and the OpenAPI
 * schema, so they are centralized here to avoid magic literals.
 */
export const HAZARD_REASON = {
  GEOFENCE_VIOLATION: "GEOFENCE_VIOLATION",
  EXIF_TOO_OLD: "EXIF_TOO_OLD",
  EXIF_GPS_MISMATCH: "EXIF_GPS_MISMATCH",
  PHOTO_REQUIRED: "PHOTO_REQUIRED",
  PHOTO_TOO_LARGE: "PHOTO_TOO_LARGE",
  INVALID_PHOTO_TYPE: "INVALID_PHOTO_TYPE",
  RATE_LIMITED: "RATE_LIMITED",
  UPLOAD_FAILED: "UPLOAD_FAILED",
  INVALID_ID: "INVALID_ID",
  REPORT_NOT_FOUND: "REPORT_NOT_FOUND",
  ALREADY_VOTED: "ALREADY_VOTED",
  REPORT_EXPIRED: "REPORT_EXPIRED",
} as const;

export const HAZARD_MSG = {
  GEOFENCE_VIOLATION: "使用者位置距回報地點超過 20 公尺",
  EXIF_TOO_OLD: "照片拍攝時間距回報時間超過 10 分鐘",
  EXIF_GPS_MISMATCH: "照片 GPS 位置與宣稱位置不符",
  PHOTO_REQUIRED: "未上傳照片",
  PHOTO_TOO_LARGE: "照片超過大小上限",
  INVALID_PHOTO_TYPE: "僅接受 JPEG 或 PNG",
  RATE_LIMITED: "回報提交過於頻繁，請稍後再試",
  UPLOAD_FAILED: "照片上傳失敗，請重試",
  INVALID_ID: "無效的回報 ID 格式",
  REPORT_NOT_FOUND: "找不到對應的回報",
  ALREADY_VOTED: "您已對此回報投過票",
  REPORT_EXPIRED: "此回報已過期，無法投票",
  CREATED: "回報已提交，正在進行影像驗證",
  MERGED: "已合併至附近的既有回報",
  CONFIRMED: "已確認此回報",
  DENIED: "已否認此回報",
} as const;
