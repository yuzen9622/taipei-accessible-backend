import OpenCC from "opencc-js";

const toTaiwanTraditional = OpenCC.Converter({ from: "cn", to: "twp" });

/**
 * Normalizes Gemini Live transcripts to Taiwan Traditional Chinese without
 * changing non-Chinese text, tool arguments, or the model's audio stream.
 */
export function normalizeVoiceTranscript(text: string): string {
  return toTaiwanTraditional(text);
}
