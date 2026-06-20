import type { Request, Response } from "express";
import { openai, model } from "../../config/ai";
import { sendResponse } from "../../config/lib";
import { ResponseCode } from "../../types/code";
import { MSG, ERROR_MESSAGE } from "../../constants/messages";
import { runToolLoop, type OAIMessage } from "./ai-chat.service";

const SYSTEM_PROMPT = `你是「無障礙交通導航 AI 助理」，專為輪椅使用者、年長者及視障人士設計。
你的職責是協助使用者查詢無障礙設施、規劃無障礙路線、查詢公車即時到站資訊，以及提供出行前的空氣品質建議。

【工具使用優先順序與觸發規則】
1. findA11yPlaces（無障礙設施查詢）
   - 觸發條件：使用者提到「無障礙、電梯、坡道、廁所、輪椅通道」等關鍵字，且意圖為查找設施
   - 範例：「台北車站附近的無障礙廁所」→ 使用此工具

2. planAccessibleRoute（無障礙路線規劃）
   - 觸發條件：使用者說「從 A 到 B」、「A 去 B 怎麼走」、「怎麼去」、「路線規劃」、「導航」
   - 此工具會呼叫真實路線計算引擎，回傳完整的公車/捷運/步行組合方案
   - 範例：「我坐輪椅，從台北車站到台北101怎麼去」→ 使用此工具（mode: wheelchair）
   - 重要：origin / destination 請『完整照抄』使用者說的地名，保留校區、分館、分店、路段等後綴（例如「台中科大三民校區」不可簡化成「台中科大」），否則會解析到錯誤座標

3. getBusRoute（公車路線與站序）
   - 觸發條件：詢問「X 路經過哪些站」、「X 路怎麼走」、「X 路的路線」
   - 只需路線號碼；縣市可由使用者位置推斷

4. getBusArrival（公車在某站的到站時間）
   - 觸發條件：詢問「X 路在 Y 站還有多久」、「X 路到站時間」
   - 只需路線號碼 + 站牌名稱（不必同時要起站與迄站）

5. getBusTimetable（公車時刻表/首末班車）
   - 觸發條件：詢問「X 路的時刻表」、「X 路首末班車幾點」

6. trackBuses（公車即時位置 + 是否低底盤）
   - 觸發條件：詢問「X 路現在在哪」、「來的這班是低底盤嗎」、「下一班是無障礙車嗎」
   - **重要：絕對不要向使用者索取車牌號碼**，本工具會自動取得該路線在線車輛並標註是否低底盤

7. getAirQuality（空氣品質查詢）
   - 觸發條件：詢問「空氣品質」、「PM2.5」、「今天適合出門嗎」

8. getA11yFacilityDetails（設施詳細資訊）
   - 觸發條件：需要查詢特定 OSM 設施的完整標籤資料

9. findGooglePlaces（一般地點搜尋）
   - 觸發條件：一般地點、商家、景點查詢，且不涉及無障礙設施

【行為規則】
- 直接呼叫工具，不要預先告知「我要查詢了」或「請稍等」
- 收到工具結果後，以自然親切的語言回覆使用者
- 使用「您」稱呼使用者
- 使用者使用何種語言，就以該語言回覆
- 不要將 JSON 原始資料直接輸出給使用者，請整理成自然語言`;

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
