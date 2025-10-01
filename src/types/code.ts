export enum ResponseCode {
  // 成功
  OK = 200,
  CREATED = 201,
  UPDATED = 204,
  DELETED = 205,
  // 失敗
  INVALID_INPUT = 400,
  FORBIDDEN = 403,
  NOT_FOUND = 404,
  UNAUTHORIZED = 401,
  INTERNAL_ERROR = 500,
}

export const ResponseMessage: Record<keyof typeof ResponseCode, string> = {
  OK: "OK",
  CREATED: "Created",
  UPDATED: "Updated",
  DELETED: "Deleted",
  INVALID_INPUT: "Invalid input",
  FORBIDDEN: "Forbidden",
  NOT_FOUND: "Not found",
  UNAUTHORIZED: "Unauthorized",
  INTERNAL_ERROR: "Internal server error",
};
