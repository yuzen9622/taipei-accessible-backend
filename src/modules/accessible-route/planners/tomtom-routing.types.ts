/**
 * Types local to the TomTom Routing API planner (tomtom-routing.ts).
 */

/** Thrown when the TomTom Routing API is unreachable / errors upstream (→ 503). */
export class TomTomRoutingError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "TomTomRoutingError";
  }
}
