/**
 * Types local to the Google Routes API planner (google-routing.ts).
 */

/** Thrown when the Google Routes API is unreachable / errors upstream (→ 503). */
export class GoogleRoutingError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "GoogleRoutingError";
  }
}
