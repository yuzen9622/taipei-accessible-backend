import { describe, expect, it } from "vitest";
import { buildVoiceSystemPrompt } from "./voice-prompt";

describe("buildVoiceSystemPrompt nearest-place policy", () => {
  it("directs the model to search and route without asking for a station when GPS exists", () => {
    const prompt = buildVoiceSystemPrompt({ latitude: 25.0478, longitude: 121.517 });

    expect(prompt).toContain("不要反問要去哪個 X");
    expect(prompt).toContain("先呼叫 findGooglePlaces");
    expect(prompt).toContain("再呼叫 planAccessibleRoute");
    expect(prompt).toContain("【使用者目前位置】");
  });

  it("keeps nearby exploration separate from route planning", () => {
    const prompt = buildVoiceSystemPrompt({ latitude: 25.0478, longitude: 121.517 });

    expect(prompt).toContain("附近有哪些 X");
    expect(prompt).toContain("不要自動規劃路線");
    expect(prompt).toContain("只有使用者接著要求帶路時才呼叫 planAccessibleRoute");
  });

  it("directs the model to request location instead of a station when GPS is absent", () => {
    const prompt = buildVoiceSystemPrompt();

    expect(prompt).toContain("只詢問是否能取得位置");
    expect(prompt).not.toContain("【使用者目前位置】緯度");
  });
});

describe("buildVoiceSystemPrompt multi-tool chaining guidance", () => {
  it("adopts the shared chaining principle so it keeps calling tools until it can fully answer", () => {
    const prompt = buildVoiceSystemPrompt();

    expect(prompt).toContain("依序串接多個工具，直到能完整回答再停");
    expect(prompt).toContain("全部查完再一次講結果");
  });

  it("no longer carries the announce-before-every-tool rule that forced one-tool-at-a-time replies", () => {
    const prompt = buildVoiceSystemPrompt();

    expect(prompt).not.toContain("呼叫任何工具之前");
    expect(prompt).not.toContain("一次只講重點");
  });
});
