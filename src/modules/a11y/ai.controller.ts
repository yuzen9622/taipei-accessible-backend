import axios from "axios";
import A11y from "../model/a11y.model";
import BathroomModel from "../model/bathroom.model";
import { getCoordinates } from "../config/lib";
const MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

/**
 * 使用 Google Maps Places API (New) 的 Text Search。
 *
 * @param query 搜尋關鍵字
 * @param latitude (選填) 參考中心點緯度
 * @param longitude (選填) 參考中心點經度
 * @returns 整理好的地點資訊 JSON 字串
 */
async function findGooglePlaces(
  query: string,
  latitude?: number,
  longitude?: number
): Promise<string> {
  if (!MAPS_API_KEY) {
    return JSON.stringify({ error: "Google Places API Key is not set." });
  }

  const url = "https://places.googleapis.com/v1/places:searchText";

  const headers = {
    "Content-Type": "application/json",
    "X-Goog-Api-Key": MAPS_API_KEY,
    "X-Goog-FieldMask":
      "places.id,places.displayName,places.formattedAddress,places.rating,places.location",
  };

  // 3. 準備 Request Body
  const body: any = {
    textQuery: query,
    languageCode: "zh-TW",
    locationBias: {
      circle: {
        center: {
          latitude: latitude,
          longitude: longitude,
        },
        radius: 1000.0,
      },
    },
    maxResultCount: 3, // 新版 API 可以直接指定回傳數量 (最多 20)
  };

  try {
    // 5. 發送 POST 請求
    const response = await axios.post(url, body, { headers });
    const data = response.data;

    // 新版 API 如果沒有結果，可能回傳空物件或沒有 places 欄位
    if (!data.places || data.places.length === 0) {
      return JSON.stringify({ status: "ZERO_RESULTS", places: [] });
    }

    // 6. 資料轉換
    // 注意：新版 API 的 displayName 是一個物件 { text: "...", languageCode: "..." }
    const results = data.places.map((place: any) => ({
      name: place.displayName?.text || "未知名稱", // 🌟 取得文字部分
      place_id: place.id, // 🌟 注意：欄位名稱是 id，不是 place_id
      formatted_address: place.formattedAddress, // 🌟 駝峰式命名
      rating: place.rating,
      location: place.location, // { latitude: ..., longitude: ... }
    }));

    return JSON.stringify({ status: "OK", places: results });
  } catch (error: any) {
    // 錯誤處理：印出詳細的 Response 錯誤訊息 (通常在 error.response.data)
    console.error(
      "Error calling Google Places API (New):",
      error.response?.data || error.message
    );

    return JSON.stringify({
      error: "Failed to fetch data from Google Maps API (New).",
      details: error.response?.data?.error?.message || error.message,
    });
  }
}

/**
 * 查詢無障礙設施 (支援 經緯度 或 地點名稱)
 * * @param params.query (選填) 地點名稱，如 "台北車站"
 * @param params.latitude (選填)
 * @param params.longitude (選填)
 * @param params.range (選填) 搜尋範圍
 */
async function findA11yPlaces(args: {
  query?: string;
  latitude?: number;
  longitude?: number;
  range?: number;
  center: { latitude: number; longitude: number };
}) {
  let searchLat = args.latitude;
  let searchLng = args.longitude;
  const searchRange = args.range || 300;

  // 🌟 關鍵邏輯：如果沒有座標，但有地名，先去偷查座標
  if (args.query) {
    console.log(`正在將地名轉為座標: ${args.query}`);
    const coords = await getCoordinates(
      args.query,
      args.center.latitude,
      args.center.longitude
    );
    if (coords) {
      searchLat = coords.latitude;
      searchLng = coords.longitude;
    } else {
      return JSON.stringify({
        ok: false,
        message: `找不到地點「${args.query}」的座標，無法查詢無障礙設施。`,
      });
    }
  }

  // 如果還是沒有座標 (也沒 query 或轉座標失敗)
  if (!searchLat || !searchLng) {
    return JSON.stringify({
      ok: false,
      error: "Missing location data (query or lat/lng required).",
    });
  }

  // --- 以下是您原本的資料庫查詢邏輯 (現在 searchLat/Lng 肯定有值了) ---
  try {
    const nearbyMetroA11y = await A11y.find({
      location: {
        $near: {
          $geometry: {
            type: "Point",
            coordinates: [Number(searchLng), Number(searchLat)],
          },
          $maxDistance: searchRange,
        },
      },
    });

    const nearbyBathroom = await BathroomModel.find({
      type: "無障礙廁所",
      location: {
        $near: {
          $geometry: {
            type: "Point",
            coordinates: [Number(searchLng), Number(searchLat)],
          },
          $maxDistance: 150, // 廁所通常要找更近的
        },
      },
    });

    return JSON.stringify({
      ok: true,
      searchLocation: { lat: searchLat, lng: searchLng, query: args.query },
      places: { nearbyMetroA11y, nearbyBathroom },
    });
  } catch (error) {
    console.error(error);
    return JSON.stringify({ error: "Database query failed." });
  }
}

async function planRoute(
  origin:
    | string
    | {
        latitude: number;
        longitude: number;
      },
  destination: string,
  travelMode?: string
) {
  try {
    let origin_location =
      origin && typeof origin === "object"
        ? origin
        : await getCoordinates(origin);

    const destination_location = await getCoordinates(
      destination,
      origin_location?.latitude,
      origin_location?.longitude
    );
    console.log(origin_location, destination_location);
    if (!origin_location || !destination_location) {
      return JSON.stringify({
        ok: false,
        error: "Origin or destination is not found.",
      });
    }
    return JSON.stringify({
      ok: true,
      origin: origin_location,
      destination: destination_location,
    });
  } catch (error) {
    console.error(error);
    return JSON.stringify({ ok: false, error: "Plan route error." });
  }
}

export { findGooglePlaces, findA11yPlaces, planRoute };
