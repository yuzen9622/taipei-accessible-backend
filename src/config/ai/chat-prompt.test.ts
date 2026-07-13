import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CHAT_SYSTEM_PROMPT } from "./chat-prompt";

describe("CHAT_SYSTEM_PROMPT byte-identity", () => {
  it("stays byte-identical to the golden captured before the shared-fragment refactor", () => {
    const golden = readFileSync(
      "src/config/ai/__fixtures__/chat-system-prompt.golden.txt",
      "utf8",
    );
    expect(CHAT_SYSTEM_PROMPT).toBe(golden);
  });
});
