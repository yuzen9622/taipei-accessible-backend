import { describe, expect, it } from "vitest";
import { normalizeVoiceTranscript } from "./transcript-normalizer";

describe("normalizeVoiceTranscript", () => {
  it("converts simplified Chinese transcripts to Taiwan Traditional Chinese", () => {
    expect(normalizeVoiceTranscript("带我去最近的火车站，怎么走？"))
      .toBe("帶我去最近的火車站，怎麼走？");
  });

  it("preserves existing Traditional Chinese and non-Chinese text", () => {
    expect(normalizeVoiceTranscript("帶我去臺北車站，ETA 5 min"))
      .toBe("帶我去臺北車站，ETA 5 min");
  });
});
