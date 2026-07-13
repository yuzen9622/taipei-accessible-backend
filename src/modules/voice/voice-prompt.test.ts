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
