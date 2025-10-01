import type { ResponseCode, ResponseMessage } from "./code";
export interface ApiResponse<T> {
  ok: boolean;
  status: "success" | "error";
  code: ResponseCode;
  message: string;
  data?: T;
  accessToken?: string;
}
