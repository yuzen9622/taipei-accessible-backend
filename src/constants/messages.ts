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
  /** Generic 500 fallback message. */
  INTERNAL: "Internal Server Error",
  /** Base for missing-parameter 400s; append the field name(s) at the call site. */
  MISSING_PARAMS: "缺少必要參數",
  /** A natural-language route query that couldn't be parsed into origin/destination. */
  INTENT_PARSE_FAILED:
    "無法解析您的查詢，請改用『從 A 到 B』的描述或直接提供 origin/destination",
} as const;
