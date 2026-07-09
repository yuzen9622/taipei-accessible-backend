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

export interface CreateContactInput {
  userId: string;
  name: string;
}

export interface DeleteContactInput {
  userId: string;
  contactId: string;
}
