import { sendResponse } from "../config/lib";
import { STAApiResponse } from "../types/air";
import { ApiResponse } from "../types/response";
import { Request, Response } from "express";
export async function getAirQualityInfo(
  req: Request,
  res: Response<ApiResponse<any>>
) {
  try {
    const { lat, lng } = req.params;
    const url = `https://sta.ci.taiwan.gov.tw/STA_AirQuality_EPAIoT/v1.0/Datastreams?$expand=Thing,Observations($orderby=phenomenonTime desc;$top=1)
  &$filter=name eq 'PM2.5'`;
    const response = await fetch(url);
    const data = (await response.json()) as STAApiResponse;
    const result = data.value
      .map((item) => {
        const coords = item.observedArea?.coordinates; // [lng, lat]
        const pm25 = item.Observations?.[0]?.result ?? null;
        const areaDescription = item.Thing?.properties?.areaDescription ?? null;
        const city = item.Thing?.properties?.areaType ?? null;
        return { areaDescription, coordinates: coords, pm25, city };
      })
      .filter((v) => v.pm25 !== null);
    console.log(result);
    sendResponse(res, true, "success", 200, "OK", { result });
  } catch (error) {
    console.error(error);
  }
}
