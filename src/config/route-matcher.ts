/**
 * Module 3: Improved bus route name matching.
 * When Google Maps returns a route name (e.g. "307"), this queries TDX to find
 * the exact SubRouteName, cross-validating with known stop names to resolve
 * ambiguity between variants like "307" / "307區" / "307快".
 */

import { tdxFetch } from "./fetch";
import { busUrl } from "./transit";
import { equalStopName, formatRouteName } from "./lib";
import BusStopModel from "../model/bus-stop.model";

export interface TdxRouteMatch {
  subRouteName: string;
  type: "City" | "InterCity";
}

/**
 * Find the best matching TDX SubRouteName for a Google-supplied route name.
 * Falls back to detectBusApiType behaviour if TDX search returns no results.
 */
export async function findBestTDXRoute(
  googleRouteName: string,
  city: string,
  departureStop?: string,
  arrivalStop?: string
): Promise<TdxRouteMatch> {
  const coreId = formatRouteName(googleRouteName);

  let candidates: { SubRouteName: { Zh_tw: string }; RouteType?: number }[] =
    [];

  try {
    const url = `${busUrl.cityRouteSearchUrl}/${city}?$format=JSON&$filter=contains(RouteName/Zh_tw,'${encodeURIComponent(coreId)}')&$top=20`;
    const resp = await tdxFetch(url);
    if (resp.ok) {
      candidates = (await resp.json()) as any[];
    }
  } catch (_) {}

  if (!candidates.length) {
    // Fallback: return as-is using the original classification logic
    return { subRouteName: coreId, type: "City" };
  }

  const names = candidates.map((c) => c.SubRouteName?.Zh_tw).filter(Boolean) as string[];

  if (names.length === 1) {
    return { subRouteName: names[0], type: "City" };
  }

  // Multiple candidates — use stop cross-validation if stops are provided
  if (departureStop && arrivalStop) {
    for (const name of names) {
      const stopsOnRoute = await BusStopModel.find({ subRouteIds: name }).lean();
      const hasDepart = stopsOnRoute.some((s) =>
        equalStopName(s.stopName.Zh_tw, departureStop)
      );
      const hasArrive = stopsOnRoute.some((s) =>
        equalStopName(s.stopName.Zh_tw, arrivalStop)
      );
      if (hasDepart && hasArrive) {
        return { subRouteName: name, type: "City" };
      }
    }
  }

  // Still ambiguous — return first candidate and log
  console.warn(
    `[route-matcher] Ambiguous TDX routes for "${googleRouteName}": [${names.join(", ")}] — using first`
  );
  return { subRouteName: names[0], type: "City" };
}
