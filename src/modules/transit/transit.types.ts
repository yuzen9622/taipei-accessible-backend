/**
 * transit module type declarations — the result envelopes the transit service
 * returns for bus ETA / position queries.
 */

import type { TaiwanCityEn } from "../../types/transit";

export type Lang = "Zh_tw" | "En";

export type BusEtaResult =
  | { ok: true; routeId: string; direction: number; city: TaiwanCityEn; etaData: any }
  | { ok: false; error: string; status: 400 | 500 };

export type BusPositionResult =
  | { ok: true; positionData: any }
  | { ok: false; error: string; status: 400 | 500 };
