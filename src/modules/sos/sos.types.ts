export type SosType = "body" | "trapped" | "share_location";

/**
 * Uniform service-to-controller result. `httpCode` is the HTTP status (also the
 * envelope `code`); failures encode their domain reason inside `data.reason`.
 */
export interface ServiceResult<T = unknown> {
  ok: boolean;
  httpCode: number;
  message: string;
  data?: T;
}

export interface CreateSosInput {
  userId: string;
  type: SosType;
  lat: number;
  lng: number;
  address?: string;
}

export interface UpdateLocationInput {
  userId: string;
  sessionId: string;
  lat: number;
  lng: number;
  address?: string;
}

export interface ResolveSosInput {
  userId: string;
  sessionId: string;
}
