/**
 * GTFS time-string helpers.
 *
 * GTFS encodes stop times as "HH:MM:SS" where the hour MAY exceed 24 for trips
 * that run past midnight (e.g. "25:10:00" = 01:10 the next service day). These
 * two converters are the only piece of the former GTFS router still needed on
 * the active path — realtime-transit.service.ts uses them to rebase a leg's
 * scheduled times onto a live ETA.
 */

const SECONDS_PER_DAY = 24 * 3600;

/**
 * Convert a GTFS time string to seconds since service-day midnight.
 *
 * @param t "HH:MM:SS" (may exceed "24:00:00" for after-midnight trips).
 * @returns Seconds since service-day midnight, or NaN when unparseable.
 */
export function gtfsTimeToSeconds(t: string): number {
  const parts = t.split(":");
  if (parts.length < 2) return NaN;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const s = parts[2] ? parseInt(parts[2], 10) : 0;
  if (isNaN(h) || isNaN(m) || isNaN(s)) return NaN;
  return h * 3600 + m * 60 + s;
}

/**
 * Convert seconds since midnight to an "HH:mm" string (wraps past 24h for display).
 *
 * @param sec Seconds since midnight.
 * @returns The "HH:mm" formatted time.
 */
export function secondsToHHmm(sec: number): string {
  const wrapped = ((sec % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
  const h = Math.floor(wrapped / 3600);
  const m = Math.floor((wrapped % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
