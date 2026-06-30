import type { Request, Response } from "express";
import { googleGenAi, model } from "../../config/ai";
import { sendResponse } from "../../config/lib";
import { ResponseCode } from "../../types/code";
import { MSG, ERROR_MESSAGE } from "../../constants/messages";
import { verifyAccessToken } from "../../config/jwt";
import { runToolLoop, toGeminiHistory, type OAIMessage } from "./ai-chat.service";
import { loadMemories } from "./memory.service";
import type { IUser } from "../../types";

const SYSTEM_PROMPT = `你是「無障礙交通導航 AI 助理」，服務輪椅使用者、年長者與視障人士。
用使用者的語言回覆、稱呼「您」，把工具回傳的 JSON 整理成自然、簡潔的話，不要把原始 JSON 丟給使用者。

# 流程
1. 先判斷使用者的「主要意圖」，再選「一個」最合適的工具直接呼叫——不要先說「我來查」「請稍等」。
2. 一次呼叫一個工具，拿到結果再決定下一步。
3. 結果夠回答就停，別查使用者沒問的東西；同一工具配相同參數，用上次結果、不要重複呼叫。

# 意圖 → 工具
- 電梯／坡道／無障礙廁所／輪椅通道（找位置）→ findA11yPlaces
- 身障停車位 → findNearbyParking
- 從 A 到 B、想知道怎麼去（路線摘要）→ planAccessibleRoute
- 從 A 到 B 且要逐步指引（每一步怎麼走／帶我走／step by step）→ getNavInstructions
- 公車：
    路線經過哪些站 → getBusRoute
    站點＋到站時間＋班表全部要 → getBusRouteDetail
    某站還有幾分鐘到 → getBusArrival
    首末班車／發車時刻 → getBusTimetable
    車現在在哪、是不是低底盤 → trackBuses（不要跟使用者要車牌）
- 天氣／適不適合出門／附近 CCTV → getEnvironmentInfo；單純只問 PM2.5 數值 → getAirQuality
- 施工／路障／路況安不安全 → getNearbyHazards
- 無障礙知識／SOP／法規／申請方式 → searchAccessibilityGuide
- 已知 osmId、要某設施的詳細資料 → getA11yFacilityDetails
- 其他一般地點、商家、景點 → findGooglePlaces（以上都不適用才用）
- （限已登入）使用者透露住處／常去地點／行動模式／偏好 → 主動 saveMemory；要求忘記 → deleteMemory

# 參數
- origin／destination 完整照抄使用者說的地名（含校區／分館／分店後綴）；說「這裡／目前位置」填 current_location。
- 公車縣市沒講就用使用者位置推斷。

# 範例
「台北車站有無障礙廁所嗎」→ findA11yPlaces(query="台北車站")
「台中車站到高鐵台中站怎麼走」→ planAccessibleRoute(origin="台中車站", destination="高鐵台中站")
「307 來的這班是低底盤嗎」→ trackBuses(routeName="307")
「等等出門天氣如何」→ getEnvironmentInfo(query=使用者位置或提到的地點)`;

function sendSse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function resolveAuthUser(req: Request): IUser | null {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return null;
  const v = verifyAccessToken(token);
  if (!v.success || !v.decoded) return null;
  return (v.decoded as { user?: IUser }).user ?? null;
}

const CATEGORY_LABELS: Record<string, string> = {
  preference: "偏好",
  place: "地點",
  habit: "習慣",
  context: "情境",
};

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
  const authUser = resolveAuthUser(req);
  const userId = authUser ? String(authUser._id) : undefined;

  let systemPrompt = SYSTEM_PROMPT;
  if (userLocation) {
    systemPrompt += `\n\n【使用者目前位置】緯度 ${userLocation.latitude}，經度 ${userLocation.longitude}`;
  }
  if (userId) {
    try {
      const memories = await loadMemories(userId);
      if (memories.length) {
        systemPrompt += `\n\n【使用者記憶】以下是你對這位使用者的了解，請自然地運用：`;
        for (const m of memories) {
          const label = CATEGORY_LABELS[m.category] ?? m.category;
          systemPrompt += `\n- [${label}] ${m.content} (id:${m._id})`;
        }
        systemPrompt += `\n\n當使用者說「回家」「去上班」「老地方」等，根據記憶推斷地點。路線規劃自動套用記憶中的無障礙模式。`;
      }
    } catch (err) {
      console.error("[ai/chat] loadMemories failed:", err);
    }
  }

  const messages: OAIMessage[] = [{ role: "system", content: systemPrompt }];
  messages.push(...rawMessages.filter((m) => m.role !== "system"));

  const { systemInstruction, contents } = toGeminiHistory(messages);

  if (stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    try {
      await runToolLoop(
        contents,
        systemInstruction,
        model,
        userLocation,
        (name, args) => sendSse(res, "tool_call", { name, args }),
        (name, result) => sendSse(res, "tool_result", { name, result }),
        userId,
      );

      const finalStream = await googleGenAi.models.generateContentStream({
        model,
        contents,
        config: { systemInstruction, temperature: useTemp },
      });

      for await (const chunk of finalStream) {
        const text = chunk.text;
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
    await runToolLoop(contents, systemInstruction, model, userLocation, undefined, undefined, userId);

    const response = await googleGenAi.models.generateContent({
      model,
      contents,
      config: { systemInstruction, temperature: useTemp },
    });

    const text = response.text ?? "";
    const usage = response.usageMetadata;
    sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, {
      id: `chatcmpl-${Date.now().toString(36)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: usage?.promptTokenCount ?? 0,
        completion_tokens: usage?.candidatesTokenCount ?? 0,
        total_tokens: usage?.totalTokenCount ?? 0,
      },
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
