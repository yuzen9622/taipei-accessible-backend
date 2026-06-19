/**
 * Shared transit reference data — values consumed across more than one module.
 * Endpoint/URL config stays in `src/config/transit.ts`; only cross-cutting
 * lookup constants live here.
 */

import { TaiwanCityEn } from "../types/transit";

export const CITY_METRO_SYSTEMS: Partial<Record<TaiwanCityEn, string[]>> = {
  [TaiwanCityEn.Taipei]: ["TRTC"],
  [TaiwanCityEn.NewTaipei]: ["NTMC", "KLRT"],
  [TaiwanCityEn.Taoyuan]: ["TYMC"],
  [TaiwanCityEn.Taichung]: ["TMRT"],
  [TaiwanCityEn.Kaohsiung]: ["KRTC"],
};
