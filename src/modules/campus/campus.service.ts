import CampusA11yModel from "../../model/campus-a11y.model";
import type { ICampusA11y, ICampusFacility } from "../../types";
import { codeToId, resolveFacType } from "./campus.fac-type";
import {
  cityFilter,
  escapeRegExp,
  normalizeName,
  taiwanClass,
  toPublicId,
  toRawId,
} from "./campus.util";

const SUMMARY_FIELDS =
  "schoolId branchId schoolName branchName city address phone location buildingCount facilityCount facilities.facTypeId facilities.facType";

export interface FacTypeCount {
  code: string;
  label: string;
  count: number;
}

export interface CampusSummary {
  campusId: number;
  schoolId: number;
  schoolName: string;
  branchName: string;
  city?: string;
  address?: string;
  phone?: string;
  location?: { type: "Point"; coordinates: [number, number] };
  buildingCount: number;
  facilityCount: number;
  facTypeSummary: FacTypeCount[];
}

export interface CampusFacilityOut {
  facUid: string;
  facTypeId?: number;
  type?: string;
  facType?: string;
  name?: string;
  building?: string;
  buildingUid?: string;
  floors: string[];
  floorIds: string[];
}

export interface CampusDetail {
  _id: string;
  campusId: number;
  schoolId: number;
  schoolName: string;
  branchName: string;
  city?: string;
  address?: string;
  phone?: string;
  buildingCount: number;
  facilityCount: number;
  facilities: CampusFacilityOut[];
  facTypeSummary: FacTypeCount[];
  location?: { type: "Point"; coordinates: [number, number] };
  importedAt: Date | string;
}

export interface CampusSchool {
  schoolId: number;
  schoolName: string;
  city?: string;
  branchCount: number;
  facilityCount: number;
}

export type CampusSort = "name" | "-name" | "facilities" | "-facilities";

export interface CampusListFilter {
  city?: string;
  type?: string;
  keyword?: string;
  schoolId?: number;
  sort?: CampusSort;
  page: number;
  limit: number;
}

export interface CampusListResult {
  items: CampusSummary[];
  totalCount: number;
  page: number;
  totalPages: number;
}

export interface CampusSchoolFilter {
  city?: string;
  keyword?: string;
  page: number;
  limit: number;
}

export interface CampusSchoolListResult {
  items: CampusSchool[];
  totalCount: number;
  page: number;
  totalPages: number;
}

const SORT_SPECS: Record<CampusSort, Record<string, 1 | -1>> = {
  name: { schoolName: 1, branchName: 1 },
  "-name": { schoolName: -1, branchName: -1 },
  facilities: { facilityCount: -1 },
  "-facilities": { facilityCount: 1 },
};

function makeGeoQuery(lng: number, lat: number, radiusM: number) {
  return {
    $near: {
      $geometry: { type: "Point", coordinates: [lng, lat] },
      $maxDistance: radiusM,
    },
  };
}

/** Aggregates per-type facility counts, keyed by canonical code and ordered by SEQ. */
function facTypeSummaryOf(
  facilities: Pick<ICampusFacility, "facTypeId" | "facType">[]
): FacTypeCount[] {
  const byId = new Map<
    number,
    { code: string; label: string; seq: number; count: number }
  >();
  for (const f of facilities ?? []) {
    const t = resolveFacType(f.facTypeId, f.facType);
    if (!t) continue;
    const cur = byId.get(t.id) ?? { code: t.code, label: t.label, seq: t.seq, count: 0 };
    cur.count += 1;
    byId.set(t.id, cur);
  }
  return [...byId.values()]
    .sort((a, b) => a.seq - b.seq)
    .map(({ code, label, count }) => ({ code, label, count }));
}

/**
 * Builds the keyword `$or` clause. Primary path matches the normalized
 * `searchName` / `aliasNames`; the raw schoolName / branchName clauses are a
 * legacy fallback (臺/台-insensitive substring) so documents not yet backfilled
 * with `searchName`/`aliasNames` still match on the common case.
 */
function keywordClause(keyword: string): Record<string, unknown>[] | null {
  const nk = normalizeName(keyword);
  if (!nk) return null;
  const rx = escapeRegExp(nk);
  const rawPat = taiwanClass(rx);
  return [
    { searchName: { $regex: rx } },
    { aliasNames: { $regex: rx } },
    { schoolName: { $regex: rawPat, $options: "i" } },
    { branchName: { $regex: rawPat, $options: "i" } },
  ];
}

/** Resolves an optional type code to a facTypeId filter fragment. */
function facTypeQuery(type?: string): Record<string, number> {
  if (!type) return {};
  const id = codeToId(type);
  return id != null ? { "facilities.facTypeId": id } : {};
}

function toSummary(
  doc: Pick<
    ICampusA11y,
    | "schoolId"
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
  >
): CampusSummary {
  return {
    campusId: toPublicId(doc.branchId),
    schoolId: toPublicId(doc.schoolId),
    schoolName: doc.schoolName,
    branchName: doc.branchName,
    city: doc.city,
    address: doc.address,
    phone: doc.phone,
    location: doc.location,
    buildingCount: doc.buildingCount,
    facilityCount: doc.facilityCount,
    facTypeSummary: facTypeSummaryOf(doc.facilities ?? []),
  };
}

function toDetail(doc: ICampusA11y): CampusDetail {
  return {
    _id: String(doc._id),
    campusId: toPublicId(doc.branchId),
    schoolId: toPublicId(doc.schoolId),
    schoolName: doc.schoolName,
    branchName: doc.branchName,
    city: doc.city,
    address: doc.address,
    phone: doc.phone,
    buildingCount: doc.buildingCount,
    facilityCount: doc.facilityCount,
    facilities: (doc.facilities ?? []).map((f) => ({
      facUid: f.facUid,
      facTypeId: f.facTypeId,
      type: resolveFacType(f.facTypeId, f.facType)?.code,
      facType: f.facType,
      name: f.name,
      building: f.building,
      buildingUid: f.buildingUid,
      floors: f.floors,
      floorIds: f.floorIds,
    })),
    facTypeSummary: facTypeSummaryOf(doc.facilities ?? []),
    location: doc.location,
    importedAt: doc.importedAt,
  };
}

/**
 * Campus summaries within `radiusM` of the point. When `type` is given, only
 * campuses that own at least one facility of that type are returned.
 *
 * @param lat Latitude of the search centre.
 * @param lng Longitude of the search centre.
 * @param radiusM Search radius in metres.
 * @param type Optional facility-type code to filter by.
 * @returns Campus summaries (no full `facilities` array).
 */
export async function findNearby(
  lat: number,
  lng: number,
  radiusM = 1000,
  type?: string
): Promise<CampusSummary[]> {
  const query: Record<string, unknown> = {
    location: makeGeoQuery(lng, lat, radiusM),
    ...facTypeQuery(type),
  };
  const docs = await CampusA11yModel.find(query).select(SUMMARY_FIELDS).lean();
  return docs.map(toSummary);
}

/**
 * Paginated campus directory. `city` is matched 臺/台-insensitively, `type`
 * filters on the facility-type code, `keyword` matches the normalized
 * searchName / aliasNames, and `schoolId` (public) lists one school's campuses.
 *
 * @param filter City / type / keyword / schoolId filters plus sort + pagination.
 * @returns Campus summaries with total count and page metadata.
 */
export async function findAll(filter: CampusListFilter): Promise<CampusListResult> {
  const { city, type, keyword, schoolId, sort, page, limit } = filter;
  const query: Record<string, unknown> = { ...facTypeQuery(type) };
  if (city) query.city = cityFilter(city);
  if (schoolId != null) query.schoolId = toRawId(schoolId);
  if (keyword) {
    const clause = keywordClause(keyword);
    if (clause) query.$or = clause;
  }

  const sortSpec = { ...SORT_SPECS[sort ?? "name"], _id: 1 as const };
  const [docs, totalCount] = await Promise.all([
    CampusA11yModel.find(query)
      .select(SUMMARY_FIELDS)
      .sort(sortSpec)
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
 * Single campus with its full `facilities` array (each carrying its type code),
 * or null if not found.
 *
 * @param campusId The positive public campus id.
 * @returns The full campus detail or null.
 */
export async function findByCampusId(campusId: number): Promise<CampusDetail | null> {
  const doc = await CampusA11yModel.findOne({ branchId: toRawId(campusId) }).lean();
  return doc ? toDetail(doc as ICampusA11y) : null;
}

/**
 * Paginated school directory — one row per institution with its campus and
 * facility totals — for a school-first browsing UI.
 *
 * @param filter City / keyword filters plus pagination.
 * @returns Schools with total count and page metadata.
 */
export async function listSchools(
  filter: CampusSchoolFilter
): Promise<CampusSchoolListResult> {
  const { city, keyword, page, limit } = filter;
  const match: Record<string, unknown> = {};
  if (city) match.city = cityFilter(city);
  if (keyword) {
    const clause = keywordClause(keyword);
    if (clause) match.$or = clause;
  }

  const [result] = await CampusA11yModel.aggregate<{
    items: {
      _id: number;
      schoolName: string;
      city?: string;
      branchCount: number;
      facilityCount: number;
    }[];
    total: { n: number }[];
  }>([
    { $match: match },
    {
      $group: {
        _id: "$schoolId",
        schoolName: { $first: "$schoolName" },
        city: { $first: "$city" },
        branchCount: { $sum: 1 },
        facilityCount: { $sum: "$facilityCount" },
      },
    },
    { $sort: { schoolName: 1, _id: 1 } },
    {
      $facet: {
        items: [{ $skip: (page - 1) * limit }, { $limit: limit }],
        total: [{ $count: "n" }],
      },
    },
  ]);

  const totalCount = result?.total[0]?.n ?? 0;
  const items: CampusSchool[] = (result?.items ?? []).map((s) => ({
    schoolId: toPublicId(s._id),
    schoolName: s.schoolName,
    city: s.city,
    branchCount: s.branchCount,
    facilityCount: s.facilityCount,
  }));

  return { items, totalCount, page, totalPages: Math.ceil(totalCount / limit) };
}
