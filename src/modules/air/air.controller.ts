import { googleGenAi } from "../config/ai";
import { sendResponse } from "../config/lib";
import { AIResponse, STAApiResponse } from "../types/air";
import { ApiResponse } from "../types/response";
import { Request, Response } from "express";
import { model } from "../config/ai";
import { rankConfig } from "../config/ai/config";
import { rankContents } from "../config/ai/contents";
export async function getAirQualityInfo(
  req: Request,
  res: Response<ApiResponse<AIResponse>>
) {
  try {
    const { lat, lng } = req.query;

    const geocode = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${process
        .env.GOOGLE_MAPS_API_KEY!}&language=zh-TW`
    );

    const geocodeData = (await geocode.json()) as any;
    let city = "臺北市";

    if (geocodeData) {
      city = geocodeData.results[0].address_components.find((c: any) => {
        return c.types.includes("administrative_area_level_1");
      }).long_name as string;

      city = city.replace("台", "臺");
    }
    const url = `https://sta.ci.taiwan.gov.tw/STA_AirQuality_EPAIoT/v1.0/Datastreams?$expand=Thing,Observations($orderby=phenomenonTime desc;$top=1)
  &$filter=name eq 'PM2.5' and Thing/properties/areaType eq '${city}'
`;
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

    const aiResponse = await googleGenAi.models.generateContent({
      model,
      contents: [
        ...rankContents,
        {
          role: "user",
          parts: [
            {
              text: `感測器座標：${JSON.stringify(
                result[0]
              )}\n路線位置：{lat: ${lat}, lng: ${lng}}`,
            },
          ],
        },
      ],
      config: rankConfig,
    });

    sendResponse(
      res,
      true,
      "success",
      200,
      "OK",
      JSON.parse(
        aiResponse?.candidates?.[0].content?.parts?.[0].text ??
          '{"description":"此區域沒有空氣品質監測器喔!","quality":""}'
      )
    );
  } catch (error) {
    console.error(error);
  }
}
