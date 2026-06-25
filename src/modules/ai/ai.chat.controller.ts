import type { Request, Response } from "express";
import { openai, model } from "../../config/ai";
import { sendResponse } from "../../config/lib";
import { ResponseCode } from "../../types/code";
import { MSG, ERROR_MESSAGE } from "../../constants/messages";
import { runToolLoop, type OAIMessage } from "./ai-chat.service";

const SYSTEM_PROMPT = `你是「無障礙交通導航 AI 助理」，專為輪椅使用者、年長者及視障人士設計。
你的職責是協助使用者查詢無障礙設施、規劃無障礙路線、查詢公車即時到站資訊、提供出行環境評估和路況安全提醒。

【工具選擇規則 — 請嚴格按照以下消歧邏輯】

■ 天氣 / 出行環境 → getEnvironmentInfo（不是 getAirQuality）
  觸發關鍵字：天氣、氣溫、下雨、風、適合出門嗎、出行環境、監視器、CCTV
  此工具一次回傳天氣+空品+附近 CCTV 三合一，是出行前綜合評估的首選。
  getAirQuality 僅在使用者「只」問 PM2.5 數值且不需要天氣時才用。

■ 停車位 → findNearbyParking（不是 findA11yPlaces）
  觸發關鍵字：停車位、停車格、車位、殘障車位、身障停車、輪椅停車
  findA11yPlaces 不含停車位資料，遇到停車相關查詢必須用 findNearbyParking。

■ 施工 / 路況 / 危險 → getNearbyHazards（不是 findGooglePlaces）
  觸發關鍵字：施工、路障、障礙物、路況、安全嗎、有沒有危險、路面破損
  這是社群即時回報資料，Google Places 查不到這類資訊。

■ 「從 A 到 B」+ 要求詳細步驟 → getNavInstructions（不是 planAccessibleRoute）
  觸發關鍵字：每一步怎麼走、詳細步驟、帶我走、導航指引、step by step
  若使用者同時提到起終點 + 詳細步驟，直接用 getNavInstructions（它內部會自動規劃路線）。
  若使用者只問「怎麼去」但沒要求逐步細節 → planAccessibleRoute。

■ 無障礙設施（電梯/坡道/廁所）→ findA11yPlaces
  觸發關鍵字：無障礙、電梯、坡道、廁所、輪椅通道
  注意：「停車位」不走這裡，走 findNearbyParking。

■ 路線規劃（從 A 到 B）→ planAccessibleRoute
  觸發條件：使用者說「從 A 到 B」、「怎麼去」、「路線規劃」但沒有要求逐步詳細指引
  重要：origin / destination 請完整照抄使用者的地名（含校區/分館等後綴）

■ 公車相關
  - 路線站序 → getBusRoute：「X 路經過哪些站」
  - 到站時間 → getBusArrival：「X 路在 Y 站還有多久」
  - 時刻表 → getBusTimetable：「X 路首末班車」
  - 即時位置+低底盤 → trackBuses：「X 路現在在哪」、「是低底盤嗎」
    **絕對不要向使用者索取車牌號碼**

■ 空氣品質（僅 PM2.5）→ getAirQuality
  只在使用者「單獨」問 PM2.5 / 空氣品質數值時使用。若同時問天氣或出門建議，用 getEnvironmentInfo。

■ OSM 設施詳情 → getA11yFacilityDetails
■ 一般地點搜尋 → findGooglePlaces（上述所有工具都不適用時才 fallback 到這裡）

【行為規則】
- 直接呼叫工具，不要預先告知「我要查詢了」或「請稍等」
- 收到工具結果後，以自然親切的語言回覆使用者
- 使用「您」稱呼使用者
- 使用者使用何種語言，就以該語言回覆
- 不要將 JSON 原始資料直接輸出給使用者，請整理成自然語言

【工具呼叫紀律】
- 禁止重複：同一工具 + 相同參數已呼叫過，就直接使用上次結果，不要再呼叫
- 禁止預防性呼叫：只呼叫使用者問題明確需要的工具，不要「順便」查使用者沒問的東西（例如：問路線規劃時不要順便查天氣、停車位或路況）
- 結果足夠就停：工具結果已能回答使用者問題時，不要為了「更完整」再呼叫額外工具，讓使用者自己決定是否追問`;

function sendSse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function aiChat(req: Request, res: Response): Promise<void> {
  const {
    messages: rawMessages,
    stream,
    temperature,
    userLocation,
  } = req.body as {
    model?: string;
    messages: OAIMessage[];
    stream?: boolean;
    temperature?: number;
    userLocation?: { latitude: number; longitude: number };
  };

  const useTemp = temperature ?? 0.2;

  const messages: OAIMessage[] = [];
  if (!rawMessages.length || rawMessages[0].role !== "system") {
    let systemPrompt = SYSTEM_PROMPT;
    if (userLocation) {
      systemPrompt += `\n\n【使用者目前位置】緯度 ${userLocation.latitude}，經度 ${userLocation.longitude}`;
    }
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push(...rawMessages);

  if (stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    try {
      await runToolLoop(
        messages,
        model,
        useTemp,
        userLocation,
        (name, args) => sendSse(res, "tool_call", { name, args }),
        (name, result) => sendSse(res, "tool_result", { name, result }),
      );

      const finalStream = await openai.chat.completions.create({
        model: model,
        messages,
        temperature: useTemp,
        stream: true,
      });

      for await (const chunk of finalStream) {
        const text = chunk.choices[0]?.delta?.content;
        if (text) sendSse(res, "token", { text });
      }

      res.write("event: done\ndata: done\n\n");
      res.end();
    } catch (error: any) {
      console.error("[ai/chat stream]", error);
      sendSse(res, "error", {
        code: ResponseCode.INTERNAL_ERROR,
        message: error?.message ?? ERROR_MESSAGE.INTERNAL,
      });
      res.write("event: done\ndata: done\n\n");
      res.end();
    }
    return;
  }

  try {
    await runToolLoop(messages, model, useTemp, userLocation);

    const response = await openai.chat.completions.create({
      model: model,
      messages,
      temperature: useTemp,
      stream: false,
    });

    sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, {
      id: response.id,
      object: response.object,
      created: response.created,
      model: response.model,
      choices: response.choices,
      usage: response.usage,
    });
  } catch (error: any) {
    console.error("[ai/chat]", error);
    sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      error?.message ?? ERROR_MESSAGE.INTERNAL,
    );
  }
}
