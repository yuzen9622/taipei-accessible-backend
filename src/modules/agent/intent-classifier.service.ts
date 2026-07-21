/**
 * Deterministic-first intent classifier. Tier 1 applies cheap, ordered rules
 * (short-reply inheritance → bind context → SOS reference → bare bus route);
 * Tier 2 falls back to a single structured LLM call. The classifier only
 * classifies — it never runs a tool. It is surface-neutral and must not import
 * `modules/line/*`.
 */
import { Type } from "@google/genai";
import { googleGenAi, model as defaultModel } from "../../config/ai";
import {
  ALL_ACTIONS,
  domainOf,
  type Action,
  type ClassifierPending,
  type IntentResult,
} from "./agent-intent.types";

/** Injected dependencies, allowing tests to stub the LLM + bind probe. */
export interface ClassifyDeps {
  runLlmClassification?: (text: string) => Promise<IntentResult | null>;
  probeBindCode?: (code: string) => Promise<boolean>;
  model?: string;
}

export interface ClassifyInput {
  text: string;
  pending?: ClassifierPending;
}

const DOMAIN_KEYWORDS: Record<string, RegExp> = {
  weather: /天氣|氣溫|下雨|降雨|溫度|氣候/,
  air: /空氣|空品|pm2\.?5|空污|霾/i,
  bus: /公車|巴士|路線|站牌|幾號車/,
  train: /火車|台鐵|臺鐵|高鐵|自強|區間|時刻/,
  a11y: /無障礙|電梯|坡道|輪椅|導盲/,
  place: /餐廳|美食|咖啡|商店|景點|哪裡有|附近有/,
  route: /怎麼去|路線規劃|導航|前往|帶我去|怎麼走/,
  parking: /停車|車位/,
  campus: /校園|學校|大學|校區/,
  hazard: /施工|障礙物|路況|危險/,
};

function normalizeCode(text: string): string {
  return text.trim().toUpperCase().replace(/[\s-]/g, "");
}

function cleanShortReply(text: string): string {
  return text
    .trim()
    .replace(/^(是|在|要|去|到)/, "")
    .replace(/[的呢啊嗎吧喔哦囉了]+$/, "")
    .trim();
}

function hasOtherDomainKeyword(text: string, ownerAction: Action): boolean {
  const own = domainOf(ownerAction);
  for (const [domain, pattern] of Object.entries(DOMAIN_KEYWORDS)) {
    if (domain !== own && pattern.test(text)) return true;
  }
  return false;
}

function isShortReply(text: string, ownerAction: Action): boolean {
  if (hasOtherDomainKeyword(text, ownerAction)) return false;
  const cleaned = cleanShortReply(text);
  return cleaned.length > 0 && cleaned.length <= 6;
}

function isBusRouteToken(text: string): boolean {
  const token = text.trim();
  if (token.length === 0 || token.length > 5) return false;
  return /^(紅|藍|綠|橘|棕|黃|F|R|G)?\d{1,4}[A-Za-z]{0,2}$/.test(token);
}

function subClassifySos(text: string): Action {
  if (/天氣|環境|空氣|氣溫/.test(text)) return "sos.environment";
  if (/無障礙|電梯|坡道|廁所/.test(text)) return "sos.nearby_a11y";
  if (/醫院|警局|警察|超商|便利商店|附近/.test(text)) return "sos.nearby";
  if (/過去|前往|帶我去|路線|怎麼走|導航/.test(text)) return "sos.route";
  return "sos.location";
}

function matchCandidate(
  text: string,
  candidates: { id: string; label: string }[],
): string | undefined {
  const trimmed = text.trim();
  const asIndex = Number(trimmed.replace(/[^\d]/g, ""));
  if (!Number.isNaN(asIndex) && asIndex >= 1 && asIndex <= candidates.length) {
    return candidates[asIndex - 1].id;
  }
  const byId = candidates.find((candidate) => candidate.id === trimmed);
  if (byId) return byId.id;
  const byLabel = candidates.find((candidate) =>
    candidate.label.includes(trimmed),
  );
  return byLabel?.id;
}

const SLOT_PROPS: Record<string, { type: Type; description: string }> = {
  query: { type: Type.STRING, description: "地點/搜尋關鍵字" },
  city: { type: Type.STRING, description: "縣市" },
  routeName: { type: Type.STRING, description: "公車路線號" },
  stopName: { type: Type.STRING, description: "站牌名稱" },
  originStation: { type: Type.STRING, description: "出發車站" },
  destinationStation: { type: Type.STRING, description: "抵達車站" },
  station: { type: Type.STRING, description: "車站名稱" },
  origin: { type: Type.STRING, description: "路線起點" },
  destination: { type: Type.STRING, description: "路線終點" },
  osmId: { type: Type.STRING, description: "OSM 設施 ID" },
};

async function defaultLlmClassification(
  text: string,
  useModel: string,
): Promise<IntentResult | null> {
  const systemInstruction = `你是意圖分類器。把使用者訊息分類到一個 action，並抽取需要的 slots。只輸出 JSON，不要多餘文字。
action 必須是以下之一：${ALL_ACTIONS.join(", ")}。
分類規則：天氣/空品且含地名→weather.query；只問 PM2.5 數值→air.query；找一般地點→place.find；無障礙設施→a11y.find；公車路線→bus.route_info；公車到站→bus.arrival；火車兩站間→train.od；單一車站時刻→train.station；路線規劃→route.plan；一般閒聊→smalltalk；問這個 App/服務是什麼→app_info；無法判斷→unknown。
不確定時 confidence 用 low。`;
  const response = await googleGenAi.models.generateContent({
    model: useModel,
    contents: [{ role: "user", parts: [{ text }] }],
    config: {
      systemInstruction,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          action: { type: Type.STRING, enum: [...ALL_ACTIONS] },
          slots: { type: Type.OBJECT, properties: SLOT_PROPS },
          confidence: { type: Type.STRING, enum: ["high", "low"] },
        },
        required: ["action", "confidence"],
      },
      temperature: 0,
    },
  });
  const raw = response.text ?? "";
  if (!raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const action = ALL_ACTIONS.includes(obj.action as Action)
    ? (obj.action as Action)
    : "unknown";
  const confidence = obj.confidence === "high" ? "high" : "low";
  const slots: Record<string, string | number> = {};
  if (obj.slots && typeof obj.slots === "object") {
    for (const [key, value] of Object.entries(
      obj.slots as Record<string, unknown>,
    )) {
      if (typeof value === "string" && value.trim()) slots[key] = value.trim();
      else if (typeof value === "number") slots[key] = value;
    }
  }
  return { action, slots, confidence };
}

/**
 * Classify a user message into an action + slots + confidence.
 *
 * @param input The message text and any agent-neutral pending state.
 * @param deps Injected LLM classification + bind-probe (stubbed in tests).
 * @returns The resolved intent; `unknown`/`low` triggers a fail-closed clarify.
 */
export async function classifyIntent(
  input: ClassifyInput,
  deps: ClassifyDeps = {},
): Promise<IntentResult> {
  const { text, pending } = input;
  const useModel = deps.model ?? defaultModel;

  // Tier 1, rule 1: short-reply inheritance of a pending slot-collection.
  if (
    pending?.kind === "collecting_slots" &&
    isShortReply(text, pending.action)
  ) {
    if (pending.candidates && pending.candidates.length > 0) {
      const chosen = matchCandidate(text, pending.candidates);
      if (chosen) {
        return {
          action: pending.action,
          slots: { [pending.awaitingSlot]: chosen },
          confidence: "high",
        };
      }
      // Invalid/expired selection: re-run the action so it re-clarifies.
      return { action: pending.action, slots: {}, confidence: "high" };
    }
    return {
      action: pending.action,
      slots: { [pending.awaitingSlot]: cleanShortReply(text) },
      confidence: "high",
    };
  }

  // Tier 1, rule 2: explicit bind context + 6-char code.
  const code = normalizeCode(text);
  const bindContext = pending?.kind === "awaiting_bind_code" || /綁定/.test(text);
  if (bindContext && /^[A-Z0-9]{6}$/.test(code)) {
    return { action: "bind.code", slots: { code }, confidence: "high" };
  }

  // Tier 1, rule 3: family / SOS reference.
  if (/他|她|那邊|那裡|求救|家人|SOS|受困|出事/i.test(text)) {
    return { action: subClassifySos(text), slots: {}, confidence: "high" };
  }

  // Tier 1, rule 4: bare bus-route token heuristic.
  if (isBusRouteToken(text)) {
    return {
      action: "bus.route_info",
      slots: { routeName: text.trim() },
      confidence: "high",
    };
  }

  // Tier 2: LLM fallback.
  let result: IntentResult;
  try {
    const llm = deps.runLlmClassification
      ? await deps.runLlmClassification(text)
      : await defaultLlmClassification(text, useModel);
    result = llm ?? { action: "unknown", slots: {}, confidence: "low" };
  } catch {
    result = { action: "unknown", slots: {}, confidence: "low" };
  }

  // Non-consuming bind probe for a bare 6-char code with no bind context.
  if (
    (result.action === "unknown" || result.confidence === "low") &&
    /^[A-Z0-9]{6}$/.test(code) &&
    deps.probeBindCode
  ) {
    const hit = await deps.probeBindCode(code);
    if (hit) {
      return { action: "bind.code", slots: { code }, confidence: "high" };
    }
  }

  return result;
}
