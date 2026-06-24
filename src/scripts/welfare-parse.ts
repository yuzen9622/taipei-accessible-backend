import { IWelfare } from "../types";

/** The non-geo fields of a welfare doc; the import script adds location/geocoded/importedAt. */
export type WelfareBase = Omit<
  IWelfare,
  "_id" | "location" | "geocoded" | "importedAt"
>;

function num(s: string | undefined): number {
  const n = Number((s ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Map one parsed CSV row (14 columns) to a welfare document's non-geo fields.
 * Geocoding is intentionally NOT done here (kept as pure, testable logic).
 * @param cols Fields from `parseCsvLine` (expects ≥14 columns).
 * @returns The base document, or `null` if required fields are missing.
 */
export function rowToWelfare(cols: string[]): WelfareBase | null {
  if (cols.length < 14) return null;

  const name = cols[0]?.trim();
  const county = cols[1]?.trim();
  const address = cols[3]?.trim();
  if (!name || !county || !address) return null;

  return {
    name,
    county,
    district: cols[2]?.trim(),
    address,
    phone: cols[4]?.trim(),
    type: cols[5]?.trim(),
    approvedCapacity: {
      residential: num(cols[6]),
      night: num(cols[7]),
      day: num(cols[8]),
    },
    actualServed: {
      residential: num(cols[9]),
      night: num(cols[10]),
      day: num(cols[11]),
    },
    evaluationTerm: cols[12]?.trim(),
    evaluationGrade: cols[13]?.trim(),
  };
}
