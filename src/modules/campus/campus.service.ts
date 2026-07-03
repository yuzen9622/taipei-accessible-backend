import CampusA11yModel from "../../model/campus-a11y.model";
import type { ICampusA11y } from "../../types";

const SUMMARY_FIELDS =
  "branchId schoolName branchName city address phone location buildingCount facilityCount facilities.facType";

export interface CampusSummary {
  branchId: number;
  schoolName: string;
  branchName: string;
  city?: string;
  address?: string;
  phone?: string;
  location?: { type: "Point"; coordinates: [number, number] };
  buildingCount: number;
  facilityCount: number;
  facTypeSummary: Record<string, number>;
}

export interface CampusListResult {
  items: CampusSummary[];
  totalCount: number;
  page: number;
  totalPages: number;
}

export interface CampusListFilter {
  city?: string;
  facType?: string;
  keyword?: string;
  page: number;
  limit: number;
}

function makeGeoQuery(lng: number, lat: number, radiusM: number) {
  return {
    $near: {
      $geometry: { type: "Point", coordinates: [lng, lat] },
      $maxDistance: radiusM,
    },
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Aggregate the per-type facility counts for one campus from its `facilities`. */
function toSummary(doc: Pick<
  ICampusA11y,
  | "branchId"
  | "schoolName"
  | "branchName"
  | "city"
  | "address"
  | "phone"
  | "location"
  | "buildingCount"
  | "facilityCount"
  | "facilities"
>): CampusSummary {
  const facTypeSummary: Record<string, number> = {};
  for (const f of doc.facilities ?? []) {
    if (!f.facType) continue;
    facTypeSummary[f.facType] = (facTypeSummary[f.facType] ?? 0) + 1;
  }
  return {
    branchId: doc.branchId,
    schoolName: doc.schoolName,
    branchName: doc.branchName,
    city: doc.city,
    address: doc.address,
    phone: doc.phone,
    location: doc.location,
    buildingCount: doc.buildingCount,
    facilityCount: doc.facilityCount,
    facTypeSummary,
  };
}

/**
 * Campus summaries within `radiusM` of the point. When `facType` is given, only
 * campuses that own at least one facility of that type are returned.
 *
 * @param lat Latitude of the search centre.
 * @param lng Longitude of the search centre.
 * @param radiusM Search radius in metres.
 * @param facType Optional Chinese facility-type name to filter by.
 * @returns Campus summaries (no full `facilities` array).
 */
export async function findNearby(
  lat: number,
  lng: number,
  radiusM = 1000,
  facType?: string
): Promise<CampusSummary[]> {
  const query: Record<string, unknown> = {
    location: makeGeoQuery(lng, lat, radiusM),
  };
  if (facType) query["facilities.facType"] = facType;
  const docs = await CampusA11yModel.find(query).select(SUMMARY_FIELDS).lean();
  return docs.map(toSummary);
}

/**
 * Paginated campus directory. `city` / `facType` are exact-match filters and
 * `keyword` does a case-insensitive substring match on schoolName / branchName.
 *
 * @param filter City / facType / keyword filters plus pagination controls.
 * @returns Campus summaries with total count and page metadata.
 */
export async function findAll(filter: CampusListFilter): Promise<CampusListResult> {
  const { city, facType, keyword, page, limit } = filter;
  const query: Record<string, unknown> = {};
  if (city) query.city = city;
  if (facType) query["facilities.facType"] = facType;
  if (keyword) {
    const regex = new RegExp(escapeRegExp(keyword), "i");
    query.$or = [{ schoolName: regex }, { branchName: regex }];
  }

  const [docs, totalCount] = await Promise.all([
    CampusA11yModel.find(query)
      .select(SUMMARY_FIELDS)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    CampusA11yModel.countDocuments(query),
  ]);

  return {
    items: docs.map(toSummary),
    totalCount,
    page,
    totalPages: Math.ceil(totalCount / limit),
  };
}

/**
 * Single campus with its full `facilities` array, or null if not found.
 *
 * @param branchId The campus branchId (integer, may be negative).
 * @returns The full campus document or null.
 */
export async function findByBranchId(branchId: number) {
  return CampusA11yModel.findOne({ branchId }).lean();
}
