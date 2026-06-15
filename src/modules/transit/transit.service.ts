import { detectBusApiType, getRouteDirectionImproved } from "../../utils/transit-text";
import { busUrl } from "../../config/transit";
import { tdxFetch } from "../../config/fetch";
import type { BusRoute } from "../../types/transit";
import type { TaiwanCityEn } from "../../types/transit";

type Lang = "Zh_tw" | "En";

export type BusEtaResult =
  | { ok: true; routeId: string; direction: number; city: TaiwanCityEn; etaData: any }
  | { ok: false; error: string; status: 400 | 500 };

export type BusPositionResult =
  | { ok: true; positionData: any }
  | { ok: false; error: string; status: 400 | 500 };

export async function getBusEta(params: {
  routeName: string;
  departureStop: string;
  arrivalStop: string;
  city: TaiwanCityEn;
  language?: Lang;
}): Promise<BusEtaResult> {
  const { routeName, departureStop, arrivalStop, city } = params;
  const lang: Lang = params.language ?? "Zh_tw";
  const fmt = detectBusApiType(routeName);

  const stopUrl =
    fmt.type === "City"
      ? `${busUrl.stopOfRouteUrl}/${city}?$format=JSON&$filter=SubRouteName/${lang} eq '${fmt.routeId}'`
      : `${busUrl.interCityStopOfRouteUrl}?$format=JSON&$filter=SubRouteName/${lang} eq '${fmt.routeId}'`;

  const stopRes = await tdxFetch(stopUrl);
  if (!stopRes.ok) return { ok: false, error: "TDX 公車路線資料查詢失敗", status: 500 };

  const stopJson = (await stopRes.json()) as BusRoute[];
  if (!stopJson || stopJson.length < 2) {
    return { ok: false, error: `找不到路線 ${routeName} 的站點資料`, status: 500 };
  }

  const direction = getRouteDirectionImproved(
    { 0: stopJson[0].Stops, 1: stopJson[1].Stops },
    departureStop,
    arrivalStop,
    lang,
  );
  if (direction === -1) {
    return { ok: false, error: "無法辨識路線方向，請確認站牌名稱是否正確", status: 400 };
  }

  const etaUrl =
    fmt.type === "City"
      ? `${busUrl.cityEstimatedTimeOfArrivalUrl}/${city}/${fmt.routeId}?$format=JSON&$filter=Direction eq ${direction} and contains(StopName/${lang},'${departureStop}') and RouteName/${lang} eq '${fmt.routeId}'`
      : `${busUrl.interCityEstimatedTimeOfArrivalUrl}/${fmt.routeId}?$format=JSON&$filter=Direction eq ${direction} and contains(StopName/${lang},'${departureStop}') and contains(SubRouteName/${lang},'${fmt.routeId}')`;

  const etaRes = await tdxFetch(etaUrl);
  const etaJson = (await etaRes.json()) as any;
  if (etaJson?.message) return { ok: false, error: etaJson.message, status: 500 };

  return { ok: true, routeId: fmt.routeId, direction, city, etaData: etaJson };
}

export async function getBusRealtimePosition(params: {
  plateNumber: string;
  routeName: string;
  city: TaiwanCityEn;
}): Promise<BusPositionResult> {
  const { plateNumber, routeName, city } = params;
  const fmt = detectBusApiType(routeName);

  const url =
    fmt.type === "City"
      ? `${busUrl.cityRealtimeByFrequencyUrl}/${city}?$format=JSON&$filter=PlateNumb eq '${plateNumber}'`
      : `${busUrl.interCityRealTimeByFrequencyUrl}?$format=JSON&$filter=PlateNumb eq '${plateNumber}'`;

  const res = await tdxFetch(url);
  if (!res.ok) return { ok: false, error: "TDX 公車位置查詢失敗", status: 400 };

  return { ok: true, positionData: await res.json() };
}
