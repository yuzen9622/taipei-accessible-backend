import { describe, it, expect } from "vitest";
import { withCurrentDate, CHAT_SYSTEM_PROMPT } from "./chat-prompt";

// 2026-07-10T02:00:00Z → Asia/Taipei 2026-07-10 10:00, which is a Friday.
const FRIDAY = new Date("2026-07-10T02:00:00Z");

describe("withCurrentDate", () => {
  it("appends the Taipei date and weekday", () => {
    const out = withCurrentDate("BASE", FRIDAY);
    expect(out).toContain("BASE");
    expect(out).toContain("【今天日期】2026-07-10（Asia/Taipei，週五）");
  });

  it("includes the relative-date resolution rule", () => {
    const out = withCurrentDate(CHAT_SYSTEM_PROMPT, FRIDAY);
    expect(out).toContain("相對日期");
    expect(out).toContain("若今天就是週X 則指今天");
  });
});
