/**
 * GTFS stop_times interpolation.
 *
 * The TDX GTFS feed fills times only at TIMEPOINT stops — 74% of stop_times
 * rows carry blank arrival/departure strings, which makes boarding/alighting
 * at mid-route stops impossible for the router (blank → NaN → row dropped).
 * Per the GTFS spec, consumers are expected to interpolate between timepoints.
 *
 * Strategy (no shape distances needed):
 *  • between two known timepoints — linear by stop count;
 *  • before the first / after the last timepoint — extrapolate with the
 *    nearest known segment's per-stop interval (fallback DEFAULT_GAP_SEC);
 *  • a row with one side blank copies the other side.
 *
 * Used by the one-off migration (src/scripts/interpolate-stop-times.ts) and
 * by import-gtfs-stop-times.ts so future re-imports stay interpolated.
 */

const DEFAULT_GAP_SEC = 60; // assumed inter-stop travel when no interval is known

function parseSec(t: string | undefined | null): number {
  if (!t) return NaN;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t.trim());
  if (!m) return NaN;
  return (
    parseInt(m[1], 10) * 3600 +
    parseInt(m[2], 10) * 60 +
    (m[3] ? parseInt(m[3], 10) : 0)
  );
}

function fmt(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(
    r
  ).padStart(2, "0")}`;
}

export interface TripTimeRow {
  arrivalTime: string;
  departureTime: string;
}

/**
 * Fill blank times for ONE trip's rows (already sorted by stop_sequence).
 * Mutates and returns the rows. Returns the count of rows that were filled.
 * Trips with no usable timepoint at all are left untouched (0 filled).
 */
export function interpolateTripTimes(rows: TripTimeRow[]): number {
  if (rows.length < 2) return 0;

  // Effective known time per row: departure, else arrival.
  const known: { idx: number; sec: number }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const sec = parseSec(rows[i].departureTime) || parseSec(rows[i].arrivalTime);
    if (!isNaN(sec) && sec > 0) known.push({ idx: i, sec });
    else if (parseSec(rows[i].departureTime) === 0 || parseSec(rows[i].arrivalTime) === 0) {
      // midnight "00:00:00" is a legitimate time
      known.push({ idx: i, sec: 0 });
    }
  }
  if (!known.length) return 0;

  const secs = new Array<number>(rows.length).fill(NaN);
  for (const k of known) secs[k.idx] = k.sec;

  // Between consecutive timepoints: linear by stop count.
  for (let k = 0; k + 1 < known.length; k++) {
    const a = known[k];
    const b = known[k + 1];
    const span = b.idx - a.idx;
    if (span <= 1) continue;
    const step = (b.sec - a.sec) / span;
    for (let i = a.idx + 1; i < b.idx; i++) {
      secs[i] = a.sec + step * (i - a.idx);
    }
  }

  // Leading extrapolation: use the first known segment's per-stop interval.
  const first = known[0];
  if (first.idx > 0) {
    let step = DEFAULT_GAP_SEC;
    if (known.length >= 2) {
      const next = known[1];
      const s = (next.sec - first.sec) / (next.idx - first.idx);
      if (s > 0) step = s;
    }
    for (let i = first.idx - 1; i >= 0; i--) {
      secs[i] = Math.max(0, secs[i + 1] - step);
    }
  }

  // Trailing extrapolation: use the last known segment's per-stop interval.
  const last = known[known.length - 1];
  if (last.idx < rows.length - 1) {
    let step = DEFAULT_GAP_SEC;
    if (known.length >= 2) {
      const prev = known[known.length - 2];
      const s = (last.sec - prev.sec) / (last.idx - prev.idx);
      if (s > 0) step = s;
    }
    for (let i = last.idx + 1; i < rows.length; i++) {
      secs[i] = secs[i - 1] + step;
    }
  }

  // Write back blanks only (keep original timepoint strings untouched).
  let filled = 0;
  for (let i = 0; i < rows.length; i++) {
    if (isNaN(secs[i])) continue;
    const t = fmt(secs[i]);
    let changed = false;
    if (isNaN(parseSec(rows[i].arrivalTime))) {
      rows[i].arrivalTime = t;
      changed = true;
    }
    if (isNaN(parseSec(rows[i].departureTime))) {
      rows[i].departureTime = t;
      changed = true;
    }
    if (changed) filled++;
  }
  return filled;
}
