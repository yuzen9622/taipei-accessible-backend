import type { STAApiResponse } from "../../types/air";

export interface AirReading {
  area: string | null;
  pm25: number;
  coordinates: [number, number] | undefined;
  city: string | null;
}

export interface AirData {
  city: string;
  readings: AirReading[];
}

export async function getAirData(lat: number, lng: number): Promise<AirData | null> {
  const geocode = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${process.env.GOOGLE_MAPS_API_KEY}&language=zh-TW`,
  );
  const geocodeData = (await geocode.json()) as any;

  let city = "臺北市";
  const cityComp = geocodeData?.results?.[0]?.address_components?.find((c: any) =>
    c.types.includes("administrative_area_level_1"),
  );
  if (cityComp) city = (cityComp.long_name as string).replace("台", "臺");

  const staUrl =
    `https://sta.ci.taiwan.gov.tw/STA_AirQuality_EPAIoT/v1.0/Datastreams` +
    `?$expand=Thing,Observations($orderby=phenomenonTime desc;$top=1)` +
    `&$filter=name eq 'PM2.5' and Thing/properties/areaType eq '${city}'`;

  const staRes = await fetch(staUrl);
  const staData = (await staRes.json()) as STAApiResponse;

  const readings: AirReading[] = staData.value
    .map((item) => ({
      area: item.Thing?.properties?.areaDescription ?? null,
      pm25: item.Observations?.[0]?.result ?? null,
      coordinates: item.observedArea?.coordinates,
      city: item.Thing?.properties?.areaType ?? null,
    }))
    .filter((v): v is AirReading => v.pm25 !== null);

  if (!readings.length) return null;

  return { city, readings };
}

export function classifyPm25(pm25: number): { quality: string; advice: string } {
  if (pm25 <= 12) return { quality: "良好", advice: "空氣品質良好，適合戶外活動" };
  if (pm25 <= 35.4) return { quality: "普通", advice: "空氣品質尚可，敏感族群可考慮減少長時間戶外活動" };
  if (pm25 <= 55.4) return { quality: "對敏感族群不健康", advice: "輪椅使用者及呼吸道敏感者建議配戴口罩，減少戶外停留時間" };
  if (pm25 <= 150.4) return { quality: "不健康", advice: "建議所有人減少戶外活動，出門配戴口罩" };
  return { quality: "非常不健康", advice: "強烈建議不要外出，若必須外出請配戴 N95 口罩" };
}
